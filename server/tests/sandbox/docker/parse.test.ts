// 解析入口在 parse 沙箱中的端到端测试（路线图第 6 步 6.6）：按 parse 模板创建真实的沙箱（CI 中为 gVisor），放入原件、
// 执行解析入口、取回结果并按 worker 的规则校验（src/sandbox/archive.ts、src/parse/output.ts）。覆盖 6.6 开放的格式、
// ZIP 炸弹与 PDF 页数检查、解析入口的错误代码，以及镜像中 LibreOffice 的安全设置。需要 LibreOffice 的用例只在
// TEST_SANDBOX_OFFICE=1（CI 构建的完整镜像）时运行。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCommandArgs, type ParseCharset, type ParseFormat } from '../../../src/parse/dispatch.ts';
import { entryErrorCode, validateParseOutput, type ParsedOutput } from '../../../src/parse/output.ts';
import { createDockerSandboxDriver } from '../../../src/sandbox/docker.ts';
import type { SandboxRef } from '../../../src/sandbox/driver.ts';
import { buildPdf } from '../pdfFixtures.ts';
import { buildZip } from '../zipFixtures.ts';
import { docker, sandboxEnv, silentLog } from './env.ts';

const driver = createDockerSandboxDriver({ docker, runtime: sandboxEnv.runtime, images: { parse: sandboxEnv.image }, maxActive: 32, log: silentLog });
const created: SandboxRef[] = [];
const samples = new URL('../samples/', import.meta.url);
const sample = (name: string) => readFileSync(new URL(name, samples));

afterEach(async () => {
  for (const ref of created.splice(0)) await driver.destroy(ref);
});

type Outcome = { ok: true; output: ParsedOutput } | { ok: false; exitCode: number | null; code: string; stdout: string };

async function parseIn(source: Buffer, format: ParseFormat, options: { images?: boolean; charset?: ParseCharset } = {}): Promise<Outcome> {
  const ref = await driver.create('parse', { jobId: randomUUID() });
  created.push(ref);
  await driver.copyIn(ref, [{ path: 'source', data: source }]);
  const result = await driver.exec(ref, 'parse', parseCommandArgs({ format, charset: options.charset ?? null }, options.images ?? false));
  if (result.exitCode !== 0) return { ok: false, exitCode: result.exitCode, code: entryErrorCode(result.stdout), stdout: result.stdout };
  return { ok: true, output: validateParseOutput(await driver.copyOut(ref)) };
}

function success(outcome: Outcome): ParsedOutput {
  if (!outcome.ok) throw new Error(`parse failed: ${outcome.code} (${outcome.exitCode}) ${outcome.stdout}`);
  return outcome.output;
}

function failure(outcome: Outcome): { exitCode: number | null; code: string } {
  if (outcome.ok) throw new Error('expected the parse to fail');
  return { exitCode: outcome.exitCode, code: outcome.code };
}

describe('parse entry in the sandbox', () => {
  it('converts docx and keeps tables; images only when asked', async () => {
    const withImages = success(await parseIn(sample('sample.docx'), 'docx', { images: true }));
    expect(withImages.markdown).toContain('# 招标文件样本');
    expect(withImages.markdown).toContain('<table>');
    expect(withImages.markdown).toContain('交换机');
    expect(withImages.markdown).toContain('![](images/image-0001.png)');
    expect(withImages.images.map((image) => [image.path, image.mime])).toEqual([['images/image-0001.png', 'image/png']]);

    const withoutImages = success(await parseIn(sample('sample.docx'), 'docx'));
    expect(withoutImages.images).toEqual([]);
    expect(withoutImages.markdown).not.toContain('images/');
    expect(withoutImages.markdown).toContain('结束段落 ABC123。');
  });

  it('converts pdf, xlsx and OLE xls', async () => {
    expect(success(await parseIn(sample('sample.pdf'), 'pdf')).markdown).toContain('结束段落 ABC123');
    for (const [name, format] of [['sample.xlsx', 'xlsx'], ['sample.xls', 'xls-ole']] as const) {
      const markdown = success(await parseIn(sample(name), format)).markdown;
      expect(markdown).toContain('## 工作表：sample');
      expect(markdown).toContain('|1|服务器|2|');
    }
  });

  it('decodes text by the recorded charset and strips images from markdown', async () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a, 0x41]); // “中文\r\nA”（GB18030）
    expect(success(await parseIn(gbk, 'text', { charset: 'gb18030' })).markdown).toBe('中文\nA\n');
    expect(failure(await parseIn(gbk, 'text', { charset: 'utf-8' }))).toEqual({ exitCode: 65, code: 'text_decode_failed' });
    const markdown = Buffer.from('# 标题\n\n![远程](https://example.com/a.png)\n![本地](../../etc/passwd)\n正文\n', 'utf8');
    expect(success(await parseIn(markdown, 'markdown', { charset: 'utf-8' })).markdown).toBe('# 标题\n\n正文\n');
  });

  it('rejects zip bombs before the parser sees them', async () => {
    const document = (data: Buffer, declaredSize?: number) =>
      buildZip([
        { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
        { name: 'word/document.xml', data, ...(declaredSize !== undefined ? { declaredSize } : {}) },
      ]);
    expect(failure(await parseIn(document(Buffer.alloc(8 * 1024 * 1024)), 'docx'))).toEqual({ exitCode: 65, code: 'zip_ratio' });
    expect(failure(await parseIn(document(Buffer.alloc(512 * 1024), 100), 'docx'))).toEqual({ exitCode: 65, code: 'zip_too_large' });
    const many = buildZip(Array.from({ length: 10_001 }, (_, index) => ({ name: `x/${index}.xml`, data: Buffer.from('x'), method: 0 as const })));
    expect(failure(await parseIn(many, 'xlsx'))).toEqual({ exitCode: 65, code: 'zip_too_many_entries' });
  });

  it('checks the PDF page count before parsing', async () => {
    expect(success(await parseIn(buildPdf(3), 'pdf')).markdown).toContain('Sandbox parse test page');
    expect(failure(await parseIn(buildPdf(3_001), 'pdf'))).toEqual({ exitCode: 65, code: 'pdf_too_many_pages' });
  });

  it('reports a code (never document text) when the content does not match the format', async () => {
    expect(failure(await parseIn(sample('sample.docx'), 'pdf'))).toEqual({ exitCode: 65, code: 'pdf_invalid' });
    expect(failure(await parseIn(Buffer.from('not a zip'), 'docx'))).toEqual({ exitCode: 65, code: 'zip_invalid' });
  });

  it('ships the LibreOffice security settings in the image', async () => {
    const ref = await driver.create('parse', { jobId: randomUUID() });
    created.push(ref);
    const result = await driver.execArgv(ref, ['cat', '/usr/lib/libreoffice/share/registry/zhibiao-security.xcd'], { timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    for (const fragment of [
      '<prop oor:name="MacroSecurityLevel" oor:finalized="true"><value>3</value></prop>',
      '<prop oor:name="DisableMacrosExecution" oor:finalized="true"><value>true</value></prop>',
      '<prop oor:name="BlockUntrustedRefererLinks" oor:finalized="true"><value>true</value></prop>',
      '<prop oor:name="Link" oor:finalized="true"><value>2</value></prop>',
      '<prop oor:name="Field" oor:finalized="true"><value>false</value></prop>',
    ]) {
      expect(result.stdout).toContain(fragment);
    }
  });

  it.runIf(sandboxEnv.office)('converts OLE Word through LibreOffice with the security settings loaded', async () => {
    const output = success(await parseIn(sample('sample.doc'), 'word-ole', { images: true }));
    expect(output.markdown).toContain('招标文件样本');
    expect(output.markdown).toContain('交换机');
    expect(output.images.length).toBeGreaterThanOrEqual(1);
  });
});
