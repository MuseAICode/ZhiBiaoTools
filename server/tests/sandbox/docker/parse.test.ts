// 解析入口在 parse 沙箱中的端到端测试（路线图第 6 步 6.6）：按 parse 模板创建真实的沙箱（CI 中为 gVisor），放入原件、
// 执行解析入口、取回结果并按 worker 的规则校验（src/sandbox/archive.ts、src/parse/output.ts）。覆盖 6.6 开放的格式、
// ZIP 炸弹与 PDF 页数检查、解析入口的错误代码，以及镜像中 LibreOffice 的安全设置。需要 LibreOffice 的用例只在
// TEST_SANDBOX_OFFICE=1（CI 构建的完整镜像）时运行；宏安全的对照组另需 TEST_SANDBOX_CONTROL_IMAGE（去掉 xcd 的同一镜像）。
// 6.10：标书查重的逐文档提取（analysis=duplicate-check，输出 analysis.json，HTML 表格经镜像中的 cheerio 读取）。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DuplicateAnalysisError, parseDuplicateAnalysis } from '../../../src/duplicateCheck/analysis.ts';
import { parseCommandArgs, type ParseCharset, type ParseFormat } from '../../../src/parse/dispatch.ts';
import { entryErrorCode, validateParseOutput, type ParsedOutput } from '../../../src/parse/output.ts';
import { createDockerSandboxDriver } from '../../../src/sandbox/docker.ts';
import type { SandboxRef } from '../../../src/sandbox/driver.ts';
import { buildPdf } from '../pdfFixtures.ts';
import { markupSample } from '../markupFixtures.ts';
import { buildZip } from '../zipFixtures.ts';
import { docker, sandboxEnv, silentLog } from './env.ts';
import { STUCK_OFFICE_STATS, stuckOfficeScript } from './stuckOffice.ts';

const driver = createDockerSandboxDriver({ docker, runtime: sandboxEnv.runtime, images: { parse: sandboxEnv.image }, maxActive: 32, log: silentLog });
const created: Array<{ owner: typeof driver; ref: SandboxRef }> = [];
const samples = new URL('../samples/', import.meta.url);
const sample = (name: string) => readFileSync(new URL(name, samples));

afterEach(async () => {
  for (const { owner, ref } of created.splice(0)) await owner.destroy(ref);
});

type Outcome = { ok: true; output: ParsedOutput } | { ok: false; exitCode: number | null; code: string; stdout: string };

async function parseIn(source: Buffer, format: ParseFormat, options: { images?: boolean; charset?: ParseCharset } = {}): Promise<Outcome> {
  const ref = await driver.create('parse', { jobId: randomUUID() });
  created.push({ owner: driver, ref });
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
    created.push({ owner: driver, ref });
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

  // 6.7 的文本类 Word 格式（RTF、HTML、MHT、Word 2003 XML）经同一个转换函数调用 LibreOffice，沿用同样的超时与进程组终止。
  it.runIf(sandboxEnv.office).each([
    ['word-ole', () => sample('sample.doc')],
    ['rtf', () => markupSample('rtf-word.doc')],
    ['html-word', () => markupSample('html-word.doc')],
    ['mht', () => markupSample('mht-word.doc')],
    ['word-xml', () => markupSample('word2003-xml.wps')],
  ] as const)('kills the whole LibreOffice process group when the conversion times out (LibreOffice stuck, %s)', async (format, source) => {
    // soffice 是 shell 脚本，exec 成 oosplash，转换由其子进程 soffice.bin 进行。转换上限（生产 8 分钟，这里调为 5 秒）到时，
    // 入口对整个进程组发 SIGKILL（不依赖 SIGTERM），返回 office_conversion_timeout；之后沙箱中没有活着的 LibreOffice 进程。
    const ref = await driver.create('parse', { jobId: randomUUID() });
    created.push({ owner: driver, ref });
    await driver.copyIn(ref, [{ path: 'source', data: source() }]);
    const result = await driver.execArgv(ref, ['sh', '-c', stuckOfficeScript([`format=${format}`, 'images=0'], 5_000)], { timeoutMs: 100_000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(65);
    expect(entryErrorCode(result.stdout)).toBe('office_conversion_timeout');
    const stats = STUCK_OFFICE_STATS.exec(result.stderr);
    expect(stats, result.stderr).not.toBeNull();
    expect(stats![1]).toBe('yes');
    // 5 秒上限 + 进程组结束与入口退出的开销。
    expect(Number(stats![2])).toBeGreaterThanOrEqual(5_000);
    expect(Number(stats![2])).toBeLessThan(20_000);
    expect(stats![3]).toBe('0');
  });

  it.runIf(sandboxEnv.office)('converts OLE Word through LibreOffice with the security settings loaded', async () => {
    const output = success(await parseIn(sample('sample.doc'), 'word-ole', { images: true }));
    expect(output.markdown).toContain('招标文件样本');
    expect(output.markdown).toContain('交换机');
    expect(output.images.length).toBeGreaterThanOrEqual(1);
  });
});

describe('duplicate-check analysis in the sandbox', () => {
  async function analyze(source: Buffer, format: ParseFormat, options: { charset?: ParseCharset; title?: string } = {}) {
    const ref = await driver.create('parse', { jobId: randomUUID() });
    created.push({ owner: driver, ref });
    await driver.copyIn(ref, [{ path: 'source', data: source }, ...(options.title ? [{ path: 'title', data: Buffer.from(options.title, 'utf8') }] : [])]);
    const result = await driver.exec(ref, 'parse', parseCommandArgs({ format, charset: options.charset ?? null }, true, 'duplicate-check'));
    if (result.exitCode !== 0) throw new Error(`parse failed: ${entryErrorCode(result.stdout)}`);
    const output = validateParseOutput(await driver.copyOut(ref), { analysis: true });
    return { output, analysis: parseDuplicateAnalysis(output.analysis!, new Set(output.images.map((image) => image.path))) };
  }

  it('writes analysis.json next to the markdown: outline, sentences and image positions that pass the worker checks', async () => {
    const { output, analysis } = await analyze(sample('sample.docx'), 'docx');
    expect(output.markdown).toContain('![](images/image-0001.png)');
    expect(analysis.outline).toMatchObject({ source: 'heading', items: [{ id: 'O00001', title: '招标文件样本', level: 1 }] });
    expect(analysis.sentences.map((item) => item.normalized)).toEqual(['项目概况：本项目为智标解析测试样本，用于验证沙箱中的文档解析。']);
    expect(analysis.tenderSentences.map((item) => item.normalized)).toContain('序号名称1服务器2交换机');
    expect(analysis.images).toEqual([{ path: 'images/image-0001.png', index: 1, directory: '招标文件样本', previousSentence: '交换机' }]);
  });

  it('reads text inside HTML tables with cheerio (cells and their paragraphs)', async () => {
    const markdown = '# 技术响应\n\n<table><tr><th>要求</th><th>响应</th></tr><tr><td><p>采用国产化服务器</p></td><td>完全满足招标文件的全部技术要求<br>并提供原厂质保服务</td></tr></table>\n\n正文段落写在这里，用于测试。\n';
    const { analysis } = await analyze(Buffer.from(markdown, 'utf8'), 'markdown', { charset: 'utf-8' });
    expect(analysis.sentences.map((item) => item.sentence)).toEqual(['完全满足招标文件的全部技术要求并提供原厂质保服务', '正文段落写在这里，用于测试。']);
  });

  it('uses the title file as the top heading for spreadsheets, without changing content.md', async () => {
    const { output, analysis } = await analyze(sample('sample.xlsx'), 'xlsx', { title: '报价表.xlsx' });
    expect(output.markdown.startsWith('## 工作表：sample')).toBe(true);
    expect(analysis.outline.items.map((item) => [item.title, item.level])).toEqual([
      ['报价表.xlsx', 1],
      ['工作表:sample', 2],
    ]);
  });

  it('rejects an unknown analysis and does not write analysis.json unless asked', async () => {
    const ref = await driver.create('parse', { jobId: randomUUID() });
    created.push({ owner: driver, ref });
    await driver.copyIn(ref, [{ path: 'source', data: sample('sample.docx') }]);
    const bad = await driver.exec(ref, 'parse', ['format=docx', 'analysis=other']);
    expect([bad.exitCode, entryErrorCode(bad.stdout)]).toEqual([64, 'bad_arguments']);
    const plain = success(await parseIn(sample('sample.docx'), 'docx'));
    expect(plain.analysis).toBeNull();
    expect(() => parseDuplicateAnalysis(Buffer.from('{}'), new Set())).toThrow(DuplicateAnalysisError);
  });
});

// LibreOffice 的宏与链接更新设置（server/sandbox/parse/libreoffice/zhibiao-security.xcd）在 parse 镜像中实际生效（#30 确认前补充）。
// 样本 macro-autorun.odt（samples/make-macro-sample.py 生成）的 Basic 宏绑定在“打开文档”等事件上，执行时写 /tmp/zhibiao-macro-marker。
// 实测：LibreOffice 以 --convert-to 转换时（解析入口的路径）不触发任何文档事件宏，即使宏安全级别为 0、没有 xcd 也不执行，
// 所以这条路径上做不出对照组；对照组改在“打开文档”的路径上做：用户配置写成最宽松（级别 0、允许执行），对照镜像（去掉 xcd）中宏执行，
// 正式镜像中不执行。有效配置用用户配置中的应用级 Basic 宏读取（xcd 禁止的是文档中的宏），同样叠加最宽松的用户配置。
describe.runIf(sandboxEnv.office)('LibreOffice macro and link-update settings in the parse image', () => {
  const MARKER = '/tmp/zhibiao-macro-marker';
  const inputs = () => [
    { path: 'source', data: sample('macro-autorun.odt') },
    { path: 'permissive.xcu', data: sample('libreoffice-permissive.xcu') },
    { path: 'dump.xba', data: sample('libreoffice-dump-config.xba') },
  ];
  // 用最宽松的用户配置“打开”样本（不是转换），20 秒后结束 LibreOffice，之后看标记文件。打开文档后 LibreOffice 不会自己退出；
  // gVisor 下它不响应 SIGTERM（timeout 会一直等），所以 5 秒后改发 SIGKILL（-k 5）。宏在加载时执行，标记文件此时已写好。
  const OPEN_SCRIPT = `P=/tmp/zhibiao-lo-open
mkdir -p "$P/user"
cp /input/permissive.xcu "$P/user/registrymodifications.xcu"
cp /input/source /tmp/zhibiao-macro-doc.odt
timeout -k 5 20 soffice --headless --norestore "-env:UserInstallation=file://$P" /tmp/zhibiao-macro-doc.odt >/dev/null 2>&1
if [ -e ${MARKER} ]; then echo marker=present; else echo marker=absent; fi`;
  // 初始化用户配置 → 放入读取配置的宏 → 叠加最宽松的用户设置 → 以 macro:/// 调用，输出有效配置。
  const CONFIG_SCRIPT = `P=/tmp/zhibiao-lo-config
timeout -k 5 40 soffice --headless --norestore "-env:UserInstallation=file://$P" --terminate_after_init >/dev/null 2>&1
cp /input/dump.xba "$P/user/basic/Standard/Module1.xba"
items=$(sed -n '/^<item /p' /input/permissive.xcu | tr -d '\\n')
sed -i "s|</oor:items>|$items</oor:items>|" "$P/user/registrymodifications.xcu"
timeout -k 5 40 soffice --headless --norestore "-env:UserInstallation=file://$P" "macro:///Standard.Module1.Dump" >/dev/null 2>&1
cat /tmp/zhibiao-effective-config`;

  const controlDriver = sandboxEnv.controlImage
    ? createDockerSandboxDriver({ docker, runtime: sandboxEnv.runtime, images: { parse: sandboxEnv.controlImage }, maxActive: 32, log: silentLog })
    : null;

  async function inSandbox(owner: typeof driver, script: string): Promise<string> {
    const ref = await owner.create('parse', { jobId: randomUUID() });
    created.push({ owner, ref });
    await owner.copyIn(ref, inputs());
    // 比用例的超时短：卡住时报“沙箱命令超时”，而不是只报用例超时。
    const result = await owner.execArgv(ref, ['sh', '-c', script], { timeoutMs: 100_000 });
    expect(result.timedOut, 'sandbox command timed out').toBe(false);
    return result.stdout.trim();
  }

  function config(output: string): Record<string, string> {
    return Object.fromEntries(output.split('\n').map((line) => line.trim().split('=') as [string, string]));
  }

  it('parses the auto-run macro sample through the parse entry without running the macro', async () => {
    const ref = await driver.create('parse', { jobId: randomUUID() });
    created.push({ owner: driver, ref });
    await driver.copyIn(ref, [{ path: 'source', data: sample('macro-autorun.odt') }]);
    // 解析入口按老式 Word 分派（LibreOffice 按内容识别格式，转成 docx 后由 mammoth 解析）。
    const result = await driver.exec(ref, 'parse', parseCommandArgs({ format: 'word-ole', charset: null }, false));
    expect(result.exitCode, result.stdout).toBe(0);
    const output = validateParseOutput(await driver.copyOut(ref));
    expect(output.markdown).toContain('宏样本：打开文档时自动运行的宏不应执行。');
    const marker = await driver.execArgv(ref, ['sh', '-c', `test -e ${MARKER} && echo present || echo absent`], { timeoutMs: 30_000 });
    expect(marker.stdout.trim()).toBe('absent');
  });

  it('does not run the macro when the document is opened, even with the most permissive user profile', async () => {
    expect(await inSandbox(driver, OPEN_SCRIPT)).toBe('marker=absent');
  });

  it('reads the effective configuration: macro security and link updates are enforced over the user profile', async () => {
    expect(config(await inSandbox(driver, CONFIG_SCRIPT))).toEqual({
      MacroSecurityLevel: '3',
      DisableMacrosExecution: 'True',
      BlockUntrustedRefererLinks: 'True',
      WriterLink: '2',
      WriterField: 'False',
      WriterChart: 'False',
      CalcLink: '2',
    });
  });

  it.runIf(sandboxEnv.controlImage !== null)('control: without zhibiao-security.xcd the same macro runs and the user profile wins', async () => {
    expect(await inSandbox(controlDriver!, 'test -e /usr/lib/libreoffice/share/registry/zhibiao-security.xcd && echo present || echo absent')).toBe('absent');
    expect(await inSandbox(controlDriver!, OPEN_SCRIPT)).toBe('marker=present');
    expect(config(await inSandbox(controlDriver!, CONFIG_SCRIPT))).toEqual({
      MacroSecurityLevel: '0',
      DisableMacrosExecution: 'False',
      BlockUntrustedRefererLinks: 'False',
      WriterLink: '0',
      WriterField: 'True',
      WriterChart: 'True',
      CalcLink: '0',
    });
  });
});
