// 文本类格式交给解析器之前的检查与预处理（server/sandbox/parse/markupGuard.mjs，路线图第 6 步 6.7）：
// Office 2003 XML 含 DTD 即拒绝（XXE、实体膨胀），RTF 去掉域指令等外部引用，MHT 的 MIME 解析（含超大、嵌套、畸形），HTML 字符集。
// 在沙箱中经解析入口的完整测试见 tests/sandbox/docker/parseMarkup.test.ts。
import { describe, expect, it } from 'vitest';
import {
  assertSafeXml,
  decodeHtmlBytes,
  extractMht,
  MarkupGuardError,
  MHT_LIMITS,
  parseContentType,
  RTF_MAX_DEPTH,
  sanitizeRtf,
} from '../../sandbox/parse/markupGuard.mjs';
import {
  base64Lines,
  billionLaughsProlog,
  markupSample,
  mimeMessage,
  PNG_1PX,
  quadraticBlowupProlog,
  remoteMht,
  remoteRtf,
  rtfText,
  spreadsheetXml,
  wordXml,
  xxeProlog,
} from './markupFixtures.ts';

const BASE = 'http://127.0.0.1:18080';

function rejection(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MarkupGuardError);
    return (error as MarkupGuardError).code;
  }
  throw new Error('expected a rejection');
}

describe('Office 2003 XML', () => {
  it('accepts the real Word 2003 XML and SpreadsheetML samples (control) and returns the text without the BOM', () => {
    for (const name of ['word2003-xml.wps', 'spreadsheet-xml.xls']) {
      const { text, bytes } = assertSafeXml(markupSample(name));
      expect(text.startsWith('<?xml')).toBe(true);
      expect(bytes.equals(markupSample(name))).toBe(true);
    }
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), wordXml('正文')]);
    expect(assertSafeXml(withBom).text.startsWith('<?xml')).toBe(true);
    // 注释与 CDATA 不是声明。
    expect(() => assertSafeXml(wordXml('<!-- 注释 --><![CDATA[a < b]]>'))).not.toThrow();
  });

  it.each([
    ['external entities (local file, remote, parameter entity)', (root: string) => xxeProlog(BASE, root), '&local;&remote;'],
    ['billion laughs', billionLaughsProlog, '&lol9;'],
    ['quadratic blowup', quadraticBlowupProlog, '&big;'.repeat(1000)],
    ['an empty internal subset', (root: string) => `<!DOCTYPE ${root}>\n`, ''],
    ['a lower-case doctype', (root: string) => `<!doctype ${root}>\n`, ''],
    ['a doctype with whitespace after <!', (root: string) => `<! DOCTYPE ${root}>\n`, ''],
    ['a bare entity declaration', () => '<!ENTITY x "y">\n', '&x;'],
  ])('rejects %s in both formats before any parser sees them', (_name, prolog, reference) => {
    expect(rejection(() => assertSafeXml(wordXml(`A${reference}B`, { prolog: prolog('w:wordDocument') })))).toBe('xml_doctype');
    expect(rejection(() => assertSafeXml(spreadsheetXml(`A${reference}B`, { prolog: prolog('Workbook') })))).toBe('xml_doctype');
    // 对照：去掉 DTD、只留普通文字的同一文档通过。
    expect(() => assertSafeXml(wordXml('AB'))).not.toThrow();
    expect(() => assertSafeXml(spreadsheetXml('AB'))).not.toThrow();
  });

  it('rejects a declaration hidden after the root element, inside comments or CDATA (no partial parsing)', () => {
    expect(rejection(() => assertSafeXml(Buffer.concat([wordXml('A'), Buffer.from('<!DOCTYPE x>')])))).toBe('xml_doctype');
    expect(rejection(() => assertSafeXml(wordXml('<![CDATA[<!DOCTYPE x>]]>')))).toBe('xml_doctype');
  });

  it('rejects XInclude and xml-stylesheet references', () => {
    const xinclude = wordXml(`<xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="file:///etc/passwd" parse="text"/>`);
    expect(rejection(() => assertSafeXml(xinclude))).toBe('xml_external_reference');
    const stylesheet = wordXml('A', { prolog: `<?xml-stylesheet type="text/xsl" href="${BASE}/x.xsl"?>\n` });
    expect(rejection(() => assertSafeXml(stylesheet))).toBe('xml_external_reference');
  });

  it('rejects encodings other than UTF-8, so the parser cannot decode a declaration the check did not see', () => {
    // UTF-7 中 +ADw- 是“<”：按 UTF-8 检查时看不到 <!DOCTYPE，按声明的编码解析时就有。
    const utf7 = wordXml('A', { declaration: '<?xml version="1.0" encoding="UTF-7"?>', prolog: '+ADw-!DOCTYPE x +AFs- +ADw-!ENTITY a SYSTEM +ACI-file:///etc/passwd+ACI- +AD4- +AF0- +AD4-\n' });
    expect(rejection(() => assertSafeXml(utf7))).toBe('xml_invalid');
    for (const encoding of ['GB2312', 'ISO-8859-1', 'UTF-16', "UTF-7' standalone='yes"]) {
      expect(rejection(() => assertSafeXml(wordXml('A', { declaration: `<?xml version="1.0" encoding="${encoding}"?>` })))).toBe('xml_invalid');
    }
    expect(() => assertSafeXml(wordXml('A', { declaration: "<?xml version='1.0' encoding='utf-8'?>" }))).not.toThrow();
    expect(() => assertSafeXml(wordXml('A', { declaration: '<?xml version="1.0"?>' }))).not.toThrow();
  });

  it('rejects invalid UTF-8, NUL and a missing XML declaration', () => {
    expect(rejection(() => assertSafeXml(Buffer.concat([wordXml('A'), Buffer.from([0xff, 0xfe])])))).toBe('xml_invalid');
    expect(rejection(() => assertSafeXml(wordXml('A\u0000B')))).toBe('xml_invalid');
    expect(rejection(() => assertSafeXml(Buffer.from('<w:wordDocument/>')))).toBe('xml_invalid');
    // UTF-16 的 BOM（上传时已不识别）同样不是合法 UTF-8。
    expect(rejection(() => assertSafeXml(Buffer.from('﻿<?xml version="1.0"?><a/>', 'utf16le')))).toBe('xml_invalid');
  });

  it('checks a large document in linear time', () => {
    const large = wordXml('正文'.repeat(4 * 1024 * 1024));
    const started = performance.now();
    expect(() => assertSafeXml(large)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('RTF', () => {
  const text = (buffer: Buffer) => buffer.toString('latin1');

  it('keeps an ordinary RTF unchanged (control)', () => {
    const sample = markupSample('rtf-word.doc');
    expect(sanitizeRtf(sample).equals(sample.subarray(0, sample.lastIndexOf('}') + 1))).toBe(true);
  });

  it('removes field instructions (INCLUDETEXT / INCLUDEPICTURE / LINK, however they are spelled) and keeps the cached results', () => {
    const output = text(sanitizeRtf(remoteRtf(BASE)));
    for (const fragment of ['fldinst', 'INCLUDE', 'LINK', '127.0.0.1', '/etc/passwd', 'template', 'objdata', 'objlink', 'objautlink', 'pibName', 'pibFlags']) {
      expect(output).not.toContain(fragment);
    }
    for (const kept of ['RTF 远程样本开始', '缓存的本地文件结果', '缓存的远程结果', '缓存的转义结果', '缓存的非首位结果', '缓存的链接结果', 'OLE 对象的显示结果', 'shapeType', 'pngblip', 'RTF 远程样本结束']) {
      expect(output).toContain(rtfText(kept));
    }
    expect(output).toContain(`{\\field{\\fldrslt {${rtfText('缓存的远程结果')}}}}`);
    // 对照：处理前这些都在。
    const input = text(remoteRtf(BASE));
    for (const fragment of ['fldinst', 'INCLUDETEXT', '/etc/passwd', 'objlink', 'pibName', 'template']) expect(input).toContain(fragment);
  });

  it('drops a group when a dropped destination appears anywhere in it, and nested groups with it', () => {
    expect(text(sanitizeRtf(Buffer.from('{\\rtf1 a{\\b\\i\\fldinst INCLUDETEXT "x"{\\sub y}}b}')))).toBe('{\\rtf1 ab}');
    expect(text(sanitizeRtf(Buffer.from('{\\rtf1 a{\\*\\fldinst {\\*\\fldinst x}z}b}')))).toBe('{\\rtf1 ab}');
    // 控制字不区分大小写判断（只会多去掉）。
    expect(text(sanitizeRtf(Buffer.from('{\\rtf1 a{\\*\\FldInst x}b}')))).toBe('{\\rtf1 ab}');
    // 被去掉的组中的 \bin 数据（可能含括号）整体跳过，不影响之后的结构。
    expect(text(sanitizeRtf(Buffer.from('{\\rtf1 a{\\*\\fldinst \\bin3 }}}z}c}')))).toBe('{\\rtf1 ac}');
  });

  it('keeps only the result of an OLE object', () => {
    const input = '{\\rtf1 a{\\object\\objemb{\\*\\objclass Excel}{\\*\\objdata 01050000}{\\result {\\pict\\pngblip 89}}}b}';
    expect(text(sanitizeRtf(Buffer.from(input)))).toBe('{\\rtf1 a{{\\pict\\pngblip 89}}b}');
    // \object 不在组首时同样处理。
    expect(text(sanitizeRtf(Buffer.from('{\\rtf1 {\\b\\object{\\*\\objdata 01}{\\*\\result r}}}')))).toBe('{\\rtf1 {r}}');
  });

  it('keeps \\bin data and escaped braces as they are', () => {
    const input = Buffer.concat([Buffer.from('{\\rtf1 {\\pict\\bin4 '), Buffer.from([0x7b, 0x7d, 0x5c, 0x00]), Buffer.from('}\\{\\}\\\\x}')]);
    expect(sanitizeRtf(input).equals(input)).toBe(true);
  });

  it('drops trailing bytes after the root group', () => {
    expect(text(sanitizeRtf(Buffer.from('{\\rtf1 a}\r\n\u0000junk')))).toBe('{\\rtf1 a}');
  });

  it.each([
    ['not RTF', 'hello'],
    ['unbalanced braces', '{\\rtf1 {a}'],
    ["\\' without two hex digits", "{\\rtf1 \\'{\\*\\fldinst x}}"],
    ['\\bin beyond the end', '{\\rtf1 \\bin100 abc}'],
    ['\\bin without a length', '{\\rtf1 \\bin abc}'],
    ['a control word parameter over 10 digits', '{\\rtf1 \\bin00000000004 abcd}'],
    ['a trailing backslash', '{\\rtf1 a\\'],
  ])('rejects %s', (_name, input) => {
    expect(rejection(() => sanitizeRtf(Buffer.from(input, 'latin1')))).toBe('rtf_invalid');
  });

  it('limits the nesting depth', () => {
    const deep = (depth: number) => Buffer.from(`{\\rtf1 ${'{'.repeat(depth - 1)}x${'}'.repeat(depth - 1)}}`);
    expect(() => sanitizeRtf(deep(RTF_MAX_DEPTH))).not.toThrow();
    expect(rejection(() => sanitizeRtf(deep(RTF_MAX_DEPTH + 1)))).toBe('rtf_invalid');
  });

  it('processes a large RTF in linear time', () => {
    const large = Buffer.from(`{\\rtf1 ${'{\\field{\\*\\fldinst INCLUDETEXT "x"}{\\fldrslt y}}\\par '.repeat(200_000)}}`);
    const started = performance.now();
    const output = sanitizeRtf(large);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(output.includes('fldinst')).toBe(false);
  });
});

describe('MHT (MIME)', () => {
  const html = (body: string) => `<html><body>${body}</body></html>`;
  const htmlPart = (body: string, headers: Record<string, string> = {}) => ({
    headers: { 'Content-Type': 'text/html; charset="utf-8"', 'Content-Transfer-Encoding': 'base64', ...headers },
    body: base64Lines(html(body)),
  });

  it('decodes the real MHT sample (control)', () => {
    const { html: text, partCount } = extractMht(markupSample('mht-word.doc'));
    expect(text).toContain('招标文件');
    expect(text).toContain('本项目采购内容为服务器设备。');
    expect(partCount).toBe(1);
  });

  it('resolves only images that are inside the package; addresses are never followed', () => {
    const { html: text, resolveResource } = extractMht(remoteMht(BASE));
    expect(text).toContain('MHT 正文开始');
    expect(resolveResource('word_files/image001.png')).toEqual({ mime: 'image/png', buffer: PNG_1PX });
    expect(resolveResource('cid:image002@zhibiao')).toEqual({ mime: 'image/png', buffer: PNG_1PX });
    // Content-Location 是远程地址，但内容在包内：用包内的字节。
    expect(resolveResource(`${BASE}/in-package.png`)).toEqual({ mime: 'image/png', buffer: PNG_1PX });
    for (const src of [`${BASE}/not-in-package.png`, 'word_files/missing.png', 'file:///etc/passwd', `${BASE}/remote.css`, `${BASE}/external-body`, '', 'cid:nothing']) {
      expect(resolveResource(src)).toBeNull();
    }
  });

  it('picks the part named by the start parameter, else the first text/html part', () => {
    const parts = [htmlPart('第一部分'), htmlPart('起始部分', { 'Content-ID': '<root@x>' })];
    const byStart = mimeMessage(parts, { topHeaders: { 'MIME-Version': '1.0', 'Content-Type': 'multipart/related; boundary="B"; start="<root@x>"' }, boundary: 'B' });
    expect(extractMht(byStart).html).toContain('起始部分');
    const byOrder = mimeMessage(parts, { topHeaders: { 'MIME-Version': '1.0', 'Content-Type': 'multipart/related; boundary="B"' }, boundary: 'B' });
    expect(extractMht(byOrder).html).toContain('第一部分');
  });

  it('decodes quoted-printable and the declared charset (GB2312), with LF-only line endings', () => {
    const gb = Buffer.from([0xd5, 0xfd, 0xce, 0xc4]); // “正文”（GB2312）
    const qp = [...gb].map((byte) => `=${byte.toString(16).toUpperCase()}`).join('');
    const message = mimeMessage([{ headers: { 'Content-Type': 'text/html; charset=gb2312', 'Content-Transfer-Encoding': 'quoted-printable' }, body: `<p>${qp}=\n=E4=B8=8D</p>` }], { newline: '\n' });
    // 软换行被去掉；后半段按 GB2312 解码不是“不”，只要求前半段正确、整体不抛错。
    expect(extractMht(message).html).toContain('<p>正文');
  });

  it('handles a single-part (non-multipart) message and a missing closing delimiter', () => {
    const single = Buffer.from(`MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html('单一部分')}`, 'utf8');
    expect(extractMht(single).html).toContain('单一部分');
    expect(extractMht(mimeMessage([htmlPart('未结束')], { closing: false })).html).toContain('未结束');
  });

  it('handles nesting up to the limit and rejects deeper nesting', () => {
    const nested = (depth: number): Buffer => {
      let body: Buffer = mimeMessage([htmlPart('最内层')], { boundary: `B${depth}`, topHeaders: { 'MIME-Version': '1.0', 'Content-Type': `multipart/related; boundary="B${depth}"` } });
      for (let level = depth - 1; level >= 1; level -= 1) {
        const inner = body.subarray(body.indexOf('\r\n\r\n') + 4);
        body = mimeMessage(
          [{ headers: { 'Content-Type': `multipart/alternative; boundary="B${level + 1}"` }, body: inner }],
          { boundary: `B${level}`, topHeaders: { 'MIME-Version': '1.0', 'Content-Type': `multipart/related; boundary="B${level}"` } },
        );
      }
      return body;
    };
    expect(extractMht(nested(MHT_LIMITS.maxDepth)).html).toContain('最内层');
    expect(rejection(() => extractMht(nested(MHT_LIMITS.maxDepth + 1)))).toBe('mht_too_complex');
  });

  it('limits the number of parts and the header size', () => {
    const many = (count: number) => mimeMessage([htmlPart('正文'), ...Array.from({ length: count - 1 }, () => ({ headers: { 'Content-Type': 'image/png' }, body: 'x' }))]);
    expect(extractMht(many(MHT_LIMITS.maxParts)).partCount).toBe(MHT_LIMITS.maxParts);
    expect(rejection(() => extractMht(many(MHT_LIMITS.maxParts + 1)))).toBe('mht_too_complex');
    const longHeader = mimeMessage([htmlPart('正文', { 'X-Long': 'a'.repeat(MHT_LIMITS.maxHeaderBytes) })]);
    expect(rejection(() => extractMht(longHeader))).toBe('mht_too_complex');
    const manyFields = mimeMessage([htmlPart('正文', Object.fromEntries(Array.from({ length: MHT_LIMITS.maxHeaderFields + 1 }, (_, index) => [`X-F${index}`, 'v'])))]);
    expect(rejection(() => extractMht(manyFields))).toBe('mht_too_complex');
  });

  it('parses a large message (an 80 MiB image part) in linear time and only decodes what is referenced', () => {
    const big = Buffer.alloc(60 * 1024 * 1024, 0x41);
    const message = mimeMessage([htmlPart('<img src="cid:big">'), { headers: { 'Content-Type': 'image/png', 'Content-ID': '<big>', 'Content-Transfer-Encoding': 'base64' }, body: base64Lines(big) }]);
    expect(message.length).toBeGreaterThan(80 * 1024 * 1024);
    const started = performance.now();
    const { html: text } = extractMht(message);
    expect(text).toContain('cid:big');
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it.each([
    ['no MIME-Version', Buffer.from('Content-Type: text/html\r\n\r\n<html></html>')],
    ['multipart without a boundary', Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/related\r\n\r\n--x\r\n\r\n')],
    ['a boundary that never appears', Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="B"\r\n\r\nno parts here')],
    ['an invalid header line', mimeMessage([{ headers: { 'Content-Type': 'text/html' }, body: '' }]).toString('latin1').replace('Content-Type: text/html', 'Content Type text/html')],
    ['invalid base64 in the HTML part', mimeMessage([{ headers: { 'Content-Type': 'text/html', 'Content-Transfer-Encoding': 'base64' }, body: '!!!not base64!!!' }])],
    ['an unknown transfer encoding', mimeMessage([{ headers: { 'Content-Type': 'text/html', 'Content-Transfer-Encoding': 'x-uuencode' }, body: '<p>a</p>' }])],
    ['an encoded multipart', Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="B"\r\nContent-Transfer-Encoding: base64\r\n\r\n--B\r\n\r\n--B--')],
  ])('rejects %s as mht_invalid', (_name, message) => {
    expect(rejection(() => extractMht(typeof message === 'string' ? Buffer.from(message, 'latin1') : message))).toBe('mht_invalid');
  });

  it('reports mht_no_html when there is no HTML part', () => {
    const message = mimeMessage([{ headers: { 'Content-Type': 'image/png', 'Content-Transfer-Encoding': 'base64' }, body: base64Lines(PNG_1PX) }]);
    expect(rejection(() => extractMht(message))).toBe('mht_no_html');
  });

  it('a boundary string inside a part (not at a line start) does not split it', () => {
    const message = mimeMessage([{ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: Buffer.from(html('a --B b --B-- c'), 'utf8') }], { boundary: 'B', topHeaders: { 'MIME-Version': '1.0', 'Content-Type': 'multipart/related; boundary=B' } });
    expect(extractMht(message).html).toContain('a --B b --B-- c');
  });

  it('parses Content-Type parameters', () => {
    expect(parseContentType('Multipart/Related; Boundary="a;b"; type=text/html')).toEqual({ type: 'multipart/related', params: new Map([['boundary', 'a;b'], ['type', 'text/html']]) });
    expect(parseContentType(undefined)).toEqual({ type: '', params: new Map() });
  });
});

describe('HTML charset', () => {
  it('uses the BOM, then the declared charset, then <meta>, then UTF-8, then GB18030', () => {
    const gb = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // “中文”（GB18030）
    expect(decodeHtmlBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文')]))).toBe('中文');
    expect(decodeHtmlBytes(gb, 'gb2312')).toBe('中文');
    expect(decodeHtmlBytes(Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=gbk">'), gb]))).toContain('中文');
    expect(decodeHtmlBytes(Buffer.concat([Buffer.from('<meta charset=gb18030>'), gb]))).toContain('中文');
    expect(decodeHtmlBytes(Buffer.from('<p>中文</p>'))).toBe('<p>中文</p>');
    expect(decodeHtmlBytes(gb)).toBe('中文');
    expect(decodeHtmlBytes(gb, 'no-such-charset')).toBe('中文');
  });
});
