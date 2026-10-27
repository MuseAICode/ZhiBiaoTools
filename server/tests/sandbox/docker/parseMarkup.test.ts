// 文本类格式（路线图第 6 步 6.7）在 parse 沙箱中的端到端测试：RTF、HTML、MHT、Word 2003 XML、SpreadsheetML。
// 1. XML 类格式：外部实体读本地文件（/etc/passwd）、请求远程地址、参数实体、实体递归膨胀（billion laughs）、二次膨胀、XInclude、
//    UTF-7 声明，经解析入口一律被拒绝（错误代码），用时很短、没有任何连接；对照组：去掉 DTD 的同一文档能解析，正文中原样含
//    /etc/passwd 特征的文档能在输出中看到该特征（证明“输出中没有”的断言有效），去掉检查直接交给 SheetJS 时文档会被解析。
// 2. HTML / MHT / RTF（及 Word 2003 XML）禁止加载远程资源：沙箱内只有 lo，在 127.0.0.1 上起一个记录一切连接的监听端口，
//    样本中所有远程地址都指向它；断言解析过程中没有任何连接（断网之外，解析器本身也不尝试加载）。对照组：同一镜像中把未经清理的
//    同一 HTML 直接交给 LibreOffice（镜像的安全设置已加载），监听收到样式表与背景图片的请求——证明监听有效、镜像中的 LibreOffice
//    确实会加载远程资源，“没有连接”来自清理而不是别的原因（例如缺少 CA 证书包：宿主的 LibreOffice 24.2 没有证书包时不发请求，
//    bookworm 的 7.4 照样发，所以对照组必须在正式镜像中做）。
// 3. MHT 的 MIME 边界情况（畸形、嵌套过深、部分过多、超大）经解析入口的错误代码。
// LibreOffice 的转换超时与进程组终止（沿用 6.6）见 parse.test.ts。需要 LibreOffice 的用例只在 TEST_SANDBOX_OFFICE=1 时运行。
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCommandArgs, type ParseFormat } from '../../../src/parse/dispatch.ts';
import { entryErrorCode, validateParseOutput, type ParsedOutput } from '../../../src/parse/output.ts';
import { createDockerSandboxDriver } from '../../../src/sandbox/docker.ts';
import type { SandboxRef } from '../../../src/sandbox/driver.ts';
import {
  base64Lines,
  billionLaughsProlog,
  markupSample,
  mimeMessage,
  PASSWD_MARKER,
  quadraticBlowupProlog,
  remoteHtml,
  remoteMht,
  remoteRtf,
  remoteSheetHtml,
  remoteWordXml,
  spreadsheetXml,
  wordXml,
  xxeProlog,
} from '../markupFixtures.ts';
import { docker, sandboxEnv, silentLog } from './env.ts';

const driver = createDockerSandboxDriver({ docker, runtime: sandboxEnv.runtime, images: { parse: sandboxEnv.image }, maxActive: 32, log: silentLog });
const created: Array<{ owner: typeof driver; ref: SandboxRef }> = [];

afterEach(async () => {
  for (const { owner, ref } of created.splice(0)) await owner.destroy(ref);
});

const PORT = 18080;
const BASE = `http://127.0.0.1:${PORT}`;

/** 沙箱内 127.0.0.1 上的监听：记录每个连接和请求的第一行，回 404。 */
const LISTENER = `import net from 'node:net';
import { appendFileSync, writeFileSync } from 'node:fs';
const log = (line) => appendFileSync('/tmp/zhibiao-connections.log', line + '\\n');
const server = net.createServer((socket) => {
  log('connection');
  socket.once('data', (data) => {
    log('request ' + data.toString('latin1').split('\\r\\n')[0]);
    socket.end('HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n');
  });
  socket.on('error', () => {});
});
server.listen(${PORT}, '127.0.0.1', () => writeFileSync('/tmp/zhibiao-listening', '1'));
`;

interface ListenedRun {
  exitCode: number | null;
  /** 监听端口记录的连接与请求行。 */
  connections: string[];
  /** 命令的标准输出。 */
  stdout: string;
  /** 命令用时（毫秒）。 */
  ms: number;
  ref: SandboxRef;
}

/** 起监听 → 执行命令 → 等 1 秒（让迟到的连接也被记录）→ 输出连接记录、命令的退出码、用时与标准输出。 */
async function runListened(source: Buffer, command: string, owner = driver): Promise<ListenedRun & { owner: typeof driver }> {
  const ref = await owner.create('parse', { jobId: randomUUID() });
  created.push({ owner, ref });
  await owner.copyIn(ref, [
    { path: 'source', data: source },
    { path: 'listener.mjs', data: Buffer.from(LISTENER) },
  ]);
  const script = `touch /tmp/zhibiao-connections.log
node /input/listener.mjs & L=$!
i=0; while [ ! -e /tmp/zhibiao-listening ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
[ -e /tmp/zhibiao-listening ] || { echo listener-failed; exit 99; }
start=$(date +%s%N)
${command} > /tmp/zhibiao-command.out 2>/dev/null; code=$?
end=$(date +%s%N)
sleep 1
kill $L
echo "@@exit=$code ms=$(( (end - start) / 1000000 ))"
cat /tmp/zhibiao-connections.log
echo "@@stdout"
cat /tmp/zhibiao-command.out`;
  const result = await owner.execArgv(ref, ['sh', '-c', script], { timeoutMs: 110_000 });
  expect(result.timedOut, 'sandbox command timed out').toBe(false);
  const match = /^@@exit=(\d+) ms=(\d+)\n([\s\S]*?)@@stdout\n([\s\S]*)$/m.exec(result.stdout);
  expect(match, result.stdout).not.toBeNull();
  return {
    exitCode: Number(match![1]),
    ms: Number(match![2]),
    connections: match![3]!.split('\n').filter(Boolean),
    stdout: match![4]!,
    ref,
    owner,
  };
}

const entry = (format: ParseFormat) => `node /opt/parse/entry.mjs ${parseCommandArgs({ format, charset: null }, true).join(' ')}`;

/** 经解析入口解析，返回监听记录和（成功时）校验过的输出。 */
async function parseListened(source: Buffer, format: ParseFormat, owner = driver): Promise<ListenedRun & { output: ParsedOutput | null; code: string | null }> {
  const run = await runListened(source, entry(format), owner);
  if (run.exitCode !== 0) return { ...run, output: null, code: entryErrorCode(run.stdout) };
  return { ...run, output: validateParseOutput(await owner.copyOut(run.ref)), code: null };
}

/** 在沙箱中运行一段 Node 模块代码（可导入 /opt/parse 下的模块与依赖），返回标准输出。 */
async function nodeInSandbox(source: Buffer, code: string, owner = driver): Promise<string> {
  const ref = await owner.create('parse', { jobId: randomUUID() });
  created.push({ owner, ref });
  await owner.copyIn(ref, [
    { path: 'source', data: source },
    { path: 'script.mjs', data: Buffer.from(code) },
  ]);
  const result = await owner.execArgv(ref, ['node', '/input/script.mjs'], { timeoutMs: 120_000 });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout;
}

describe('Office 2003 XML: DTD and external entities are rejected before the parser', () => {
  const MALICIOUS = [
    ['external entities (file:///etc/passwd, remote, parameter entity)', (root: string) => xxeProlog(BASE, root), '&local;&remote;', 'xml_doctype'],
    ['billion laughs', billionLaughsProlog, '&lol9;', 'xml_doctype'],
    ['quadratic blowup', quadraticBlowupProlog, '&big;'.repeat(2000), 'xml_doctype'],
    ['XInclude of /etc/passwd', () => '', `<xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="file:///etc/passwd" parse="text"/><xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="${BASE}/xinclude" parse="text"/>`, 'xml_external_reference'],
  ] as const;

  // SpreadsheetML 由 SheetJS 读取，不需要 LibreOffice；Word 2003 XML 的拒绝同样发生在 LibreOffice 之前。
  for (const [format, build, root] of [
    ['spreadsheet-xml', spreadsheetXml, 'Workbook'],
    ['word-xml', wordXml, 'w:wordDocument'],
  ] as const) {
    it.each(MALICIOUS)(`${format}: rejects %s quickly, without any connection`, async (_name, prolog, reference, code) => {
      const run = await parseListened(build(`A${reference}B`, { prolog: prolog(root) }), format);
      expect(run.exitCode).toBe(65);
      expect(run.code).toBe(code);
      expect(run.connections).toEqual([]);
      expect(run.stdout).not.toContain(PASSWD_MARKER);
      expect(run.ms).toBeLessThan(5_000);
    });

    it(`${format}: rejects a UTF-7 declaration that would hide <!DOCTYPE from a UTF-8 check`, async () => {
      const utf7 = build('A', { declaration: '<?xml version="1.0" encoding="UTF-7"?>', prolog: `+ADw-!DOCTYPE ${root} +AFs- +ADw-!ENTITY a SYSTEM +ACI-file:///etc/passwd+ACI- +AD4- +AF0- +AD4-\n` });
      const run = await parseListened(utf7, format);
      expect([run.exitCode, run.code]).toEqual([65, 'xml_invalid']);
      expect(run.connections).toEqual([]);
    });
  }

  it('control: the same SpreadsheetML without a DTD parses, and text that looks like /etc/passwd does show up in the output', async () => {
    const run = await parseListened(spreadsheetXml(`A ${PASSWD_MARKER} B`), 'spreadsheet-xml');
    expect(run.code).toBeNull();
    expect(run.output!.markdown).toContain('## 工作表：清单');
    expect(run.output!.markdown).toContain(`A ${PASSWD_MARKER} B`);
    expect(run.connections).toEqual([]);
  });

  it('control: without the check, SheetJS parses the XXE workbook (the rejection comes from the check, not from the parser)', async () => {
    const output = await nodeInSandbox(
      spreadsheetXml('A&local;&remote;B', { prolog: xxeProlog(BASE, 'Workbook') }),
      `import { readFileSync } from 'node:fs';
import * as XLSX from '/opt/parse/node_modules/xlsx/xlsx.mjs';
const workbook = XLSX.read(readFileSync('/input/source', 'utf8'), { type: 'string' });
const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
process.stdout.write(JSON.stringify(rows));`,
    );
    const rows = JSON.parse(output) as string[][];
    expect(rows[0]![0]).toBe('名称');
    // SheetJS 0.20.3 不展开外部实体（原样留下实体引用）：这是解析器的现状，6.7 不依赖它。
    expect(rows[0]![1]).not.toContain(PASSWD_MARKER);
  });

  it.runIf(sandboxEnv.office)('control: the same Word 2003 XML without a DTD converts through LibreOffice, and passwd-like text shows up', async () => {
    const run = await parseListened(wordXml(`A ${PASSWD_MARKER} B`), 'word-xml');
    expect(run.code).toBeNull();
    expect(run.output!.markdown).toContain(`A ${PASSWD_MARKER} B`);
    expect(run.connections).toEqual([]);
  });
});

describe('HTML / MHT / RTF: no remote resource is ever requested', () => {
  it('the sanitized HTML keeps only text structure, outbound links and data: images', async () => {
    const output = await nodeInSandbox(
      Buffer.from(remoteHtml(BASE)),
      `import { readFileSync } from 'node:fs';
import { sanitizeHtml } from '/opt/parse/htmlSanitize.mjs';
process.stdout.write(sanitizeHtml(readFileSync('/input/source', 'utf8')));`,
    );
    expect(output).toContain('远程资源样本开始');
    expect(output).toContain('远程资源样本结束');
    expect(output).toContain('表格单元格');
    expect(output).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="内嵌图片">/);
    // 唯一保留的地址是普通链接（不会被加载）；去掉它之后不再有任何地址、本地路径、可加载资源的元素或属性。
    const withoutLink = output.replace(`<a href="${BASE}/link">外部链接</a>`, '');
    for (const fragment of ['127.0.0.1', 'file:', '/etc/passwd', 'javascript:', 'relative.png', '<script', '<style', '<link', '<base', '<meta http-equiv', '<iframe', '<frame', '<object', '<embed', '<applet', '<video', '<audio', '<source', '<svg', '<input', '<form', 'url(', '@import', 'srcset', 'background', 'style=', 'svg+xml', 'v:imagedata']) {
      expect(withoutLink).not.toContain(fragment);
    }
    expect((output.match(/<img /g) ?? []).length).toBe(1);
  });

  it('MHT: only images inside the package become data: images', async () => {
    const output = await nodeInSandbox(
      remoteMht(BASE),
      `import { readFileSync } from 'node:fs';
import { extractMht } from '/opt/parse/markupGuard.mjs';
import { sanitizeHtml } from '/opt/parse/htmlSanitize.mjs';
const { html, resolveResource } = extractMht(readFileSync('/input/source'));
process.stdout.write(sanitizeHtml(html, { resolveImage: resolveResource }));`,
    );
    expect(output).toContain('MHT 正文开始');
    expect((output.match(/<img src="data:image\/png;base64,/g) ?? []).length).toBe(3);
    for (const fragment of ['127.0.0.1', 'file:', 'word_files', 'cid:', '<iframe', '<link']) expect(output).not.toContain(fragment);
  });

  it('html-sheet (SheetJS): parses the table without any connection', async () => {
    const run = await parseListened(Buffer.from(remoteSheetHtml(BASE)), 'html-sheet');
    expect(run.code).toBeNull();
    expect(run.output!.markdown).toContain('|服务器|2|');
    expect(run.connections).toEqual([]);
  });

  it.runIf(sandboxEnv.office)('html-word: converts through LibreOffice without any connection; the data: image is kept', async () => {
    const run = await parseListened(Buffer.from(remoteHtml(BASE)), 'html-word');
    expect(run.code, run.stdout).toBeNull();
    expect(run.connections).toEqual([]);
    expect(run.output!.markdown).toContain('远程资源样本开始');
    expect(run.output!.markdown).toContain('远程资源样本结束');
    expect(run.output!.markdown).not.toContain(PASSWD_MARKER);
    expect(run.output!.images.map((image) => image.mime)).toEqual(['image/png']);
  });

  it.runIf(sandboxEnv.office)('mht: converts through LibreOffice without any connection; the three in-package images are kept', async () => {
    const run = await parseListened(remoteMht(BASE), 'mht');
    expect(run.code, run.stdout).toBeNull();
    expect(run.connections).toEqual([]);
    expect(run.output!.markdown).toContain('MHT 正文开始');
    expect(run.output!.markdown).toContain('MHT 正文结束');
    expect(run.output!.images).toHaveLength(3);
  });

  it.runIf(sandboxEnv.office)('rtf: converts through LibreOffice without any connection; field results are kept, /etc/passwd is not read', async () => {
    const run = await parseListened(remoteRtf(BASE), 'rtf');
    expect(run.code, run.stdout).toBeNull();
    expect(run.connections).toEqual([]);
    for (const text of ['RTF 远程样本开始', '缓存的本地文件结果', '缓存的远程结果', 'OLE 对象的显示结果', 'RTF 远程样本结束']) expect(run.output!.markdown).toContain(text);
    expect(run.output!.markdown).not.toContain(PASSWD_MARKER);
  });

  it.runIf(sandboxEnv.office)('word-xml: converts through LibreOffice without any connection; /etc/passwd is not read', async () => {
    const run = await parseListened(remoteWordXml(BASE), 'word-xml');
    expect(run.code, run.stdout).toBeNull();
    expect(run.connections).toEqual([]);
    expect(run.output!.markdown).toContain('Word XML 远程样本开始');
    expect(run.output!.markdown).toContain('Word XML 远程样本结束');
    expect(run.output!.markdown).not.toContain(PASSWD_MARKER);
  });

  const RAW_HTML_CONVERSION =
    'timeout -k 5 60 soffice --headless --norestore -env:UserInstallation=file:///tmp/zhibiao-lo "--infilter=HTML (StarWriter)" --convert-to "docx:MS Word 2007 XML" --outdir /tmp/zhibiao-out /input/source';

  it.runIf(sandboxEnv.office)('control: the unsanitized HTML given straight to LibreOffice in the same image (security settings loaded) does connect', async () => {
    const run = await runListened(Buffer.from(remoteHtml(BASE)), RAW_HTML_CONVERSION);
    expect(run.exitCode).toBe(0);
    expect(run.connections.filter((line) => line === 'connection').length).toBeGreaterThan(0);
    // 镜像的安全设置（BlockUntrustedRefererLinks 等）挡住了 <img>，挡不住样式表和 CSS 背景图片。
    expect(run.connections.some((line) => line.startsWith('request ') && /\/(style\.css|background\.png) /.test(line))).toBe(true);
  });

  it.runIf(sandboxEnv.office)('control: the unsanitized RTF keeps its INCLUDETEXT field through LibreOffice; the sanitized one does not', async () => {
    const output = await nodeInSandbox(
      remoteRtf(BASE),
      `import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { sanitizeRtf } from '/opt/parse/markupGuard.mjs';
const JSZip = createRequire('/opt/parse/package.json')('jszip');
const original = readFileSync('/input/source');
const result = {};
for (const [name, data] of [['raw', original], ['sanitized', sanitizeRtf(original)]]) {
  mkdirSync('/tmp/' + name);
  writeFileSync('/tmp/' + name + '/doc.rtf', data);
  execFileSync('soffice', ['--headless', '--norestore', '-env:UserInstallation=file:///tmp/lo-' + name, '--infilter=Rich Text Format', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', '/tmp/' + name, '/tmp/' + name + '/doc.rtf'], { stdio: 'ignore', timeout: 60000 });
  const zip = await JSZip.loadAsync(readFileSync('/tmp/' + name + '/doc.docx'));
  const xml = await zip.file('word/document.xml').async('string');
  result[name] = { includeText: xml.includes('INCLUDETEXT'), includePicture: xml.includes('INCLUDEPICTURE'), passwd: xml.includes('/etc/passwd') };
}
process.stdout.write(JSON.stringify(result));`,
    );
    const result = JSON.parse(output) as Record<'raw' | 'sanitized', Record<string, boolean>>;
    // 未经处理时域指令（指向 /etc/passwd 的 INCLUDETEXT）原样进入 docx，之后任何会更新域的程序都可能执行它。
    expect(result.raw.includeText || result.raw.passwd).toBe(true);
    expect(result.sanitized).toEqual({ includeText: false, includePicture: false, passwd: false });
  });
});

describe('MHT: MIME edge cases through the parse entry', () => {
  const htmlPart = { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Transfer-Encoding': 'base64' }, body: base64Lines('<html><body><p>正文</p></body></html>') };

  it.each([
    ['malformed (no boundary)', Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/related\r\n\r\n--x\r\n'), 'mht_invalid'],
    ['malformed (invalid base64)', mimeMessage([{ headers: { 'Content-Type': 'text/html', 'Content-Transfer-Encoding': 'base64' }, body: '!!!' }]), 'mht_invalid'],
    ['no HTML part', mimeMessage([{ headers: { 'Content-Type': 'image/png' }, body: 'x' }]), 'mht_no_html'],
    ['too many parts', mimeMessage([htmlPart, ...Array.from({ length: 2_000 }, () => ({ headers: { 'Content-Type': 'image/png' }, body: 'x' }))]), 'mht_too_complex'],
    [
      'nesting deeper than 8 levels',
      (() => {
        let message = `Content-Type: text/html\r\n\r\n<p>x</p>`;
        for (let level = 9; level >= 1; level -= 1) message = `Content-Type: multipart/related; boundary="B${level}"\r\n\r\n--B${level}\r\n${message}\r\n--B${level}--\r\n`;
        return Buffer.from(`MIME-Version: 1.0\r\n${message}`);
      })(),
      'mht_too_complex',
    ],
  ])('rejects %s with a code', async (_name, message, code) => {
    const run = await parseListened(message, 'mht');
    expect([run.exitCode, run.code]).toEqual([65, code]);
    expect(run.connections).toEqual([]);
  });

  it.runIf(sandboxEnv.office)('parses a 90 MiB MHT (a large unreferenced part) within the limits', async () => {
    const large = mimeMessage([htmlPart, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Transfer-Encoding': 'base64' }, body: base64Lines(Buffer.alloc(66 * 1024 * 1024, 7)) }]);
    expect(large.length).toBeGreaterThan(90 * 1024 * 1024);
    const run = await parseListened(large, 'mht');
    expect(run.code, run.stdout).toBeNull();
    expect(run.output!.markdown).toContain('正文');
    expect(run.ms).toBeLessThan(60_000);
  });
});

describe('text-based formats: real samples', () => {
  it.each([
    ['html-table.xls', 'html-sheet'],
    ['spreadsheet-xml.xls', 'spreadsheet-xml'],
  ] as const)('%s (%s) parses with SheetJS', async (name, format) => {
    const run = await parseListened(markupSample(name), format);
    expect(run.code).toBeNull();
    expect(run.output!.markdown).toContain('|1|服务器|2|');
  });

  it.runIf(sandboxEnv.office).each([
    ['rtf-word.doc', 'rtf'],
    ['html-word.doc', 'html-word'],
    ['mht-word.doc', 'mht'],
    ['word2003-xml.wps', 'word-xml'],
  ] as const)('%s (%s) converts through LibreOffice', async (name, format) => {
    const run = await parseListened(markupSample(name), format);
    expect(run.code, run.stdout).toBeNull();
    expect(run.output!.markdown).toContain('第一章 投标须知');
    expect(run.output!.markdown).toContain('本项目采购内容为服务器设备。');
    expect(run.connections).toEqual([]);
  });
});
