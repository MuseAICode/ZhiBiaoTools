// 文本类格式交给解析器之前的检查与预处理（路线图第 6 步 6.7；docs/MIGRATION_PLAN.md“第 6 步解析要求”）。只用 Node 内置模块，
// 由沙箱中的解析入口调用，也供宿主上的单元测试使用（server/tests/sandbox/markupGuard.test.ts）：
// - Office 2003 XML（Word 2003 XML、SpreadsheetML）：含 DTD 等声明（<!DOCTYPE、<!ENTITY 等）一律拒绝，不尝试安全地解析 DTD；
//   没有 DTD 就不存在外部实体和实体膨胀。另拒绝 XInclude、xml-stylesheet 和非 UTF-8 编码（声明的编码与检查时的解码不一致，
//   可能让解析器读出检查时看不到的声明，例如 UTF-7 的 +ADw-!DOCTYPE）；
// - RTF：按组结构去掉域指令（fldinst，INCLUDEPICTURE / INCLUDETEXT / LINK / DDE 等都在其中）、OLE 对象（只留其显示结果）、
//   附加模板、子文档、嵌入字体文件、超链接目标和链接图片的形状属性，域的显示结果保留；
// - MHT：解开 MIME，取 text/html 部分（按其 Content-Transfer-Encoding 与 charset 解码），图片只取包内的部分；
//   Content-Location 只用来在包内查找，指向的地址一律不跟随。嵌套层数、部分数、头部大小有上限，结构不合法即拒绝；
// - HTML 的字符集识别（BOM、<meta charset>，否则 UTF-8，不合法时 GB18030）。
// 都只在内存中处理字节，不读写文件、不访问网络。

export class MarkupGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarkupGuardError';
    this.code = code;
  }
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function stripUtf8Bom(buffer) {
  return buffer.subarray(0, 3).equals(UTF8_BOM) ? buffer.subarray(3) : buffer;
}

// ---------------------------------------------------------------- Office 2003 XML

const XML_DECLARATION = /^\s*<\?xml(?<attributes>\s[^?]*)?\?>/;
const XML_ENCODING = /\sencoding\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)')/;
/** 注释（<!--）与 CDATA（<![CDATA[）以外的一切 <! 声明：DOCTYPE、ENTITY、ELEMENT、ATTLIST、NOTATION 及条件节。 */
const XML_MARKUP_DECLARATION = /<!(?!--|\[CDATA\[)/;
const XINCLUDE_NAMESPACE = 'http://www.w3.org/2001/XInclude';
const XML_STYLESHEET = /<\?xml-stylesheet\b/i;

/**
 * 检查 Word 2003 XML / SpreadsheetML，通过时返回去掉 BOM 的 UTF-8 文本与字节。
 * 拒绝：xml_invalid（不是合法 UTF-8、没有 XML 声明、声明的编码不是 UTF-8、含 NUL），
 * xml_doctype（含 DTD 等声明），xml_external_reference（XInclude、xml-stylesheet）。
 * 检查对整个文件进行（注释、CDATA 中出现的同样拒绝），宁可误拒，不做部分解析。
 */
export function assertSafeXml(buffer) {
  const bytes = stripUtf8Bom(buffer);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new MarkupGuardError('xml_invalid', 'XML 不是合法的 UTF-8');
  }
  if (text.includes('\u0000')) throw new MarkupGuardError('xml_invalid', 'XML 含 NUL');
  const declaration = XML_DECLARATION.exec(text);
  if (!declaration) throw new MarkupGuardError('xml_invalid', '缺少 XML 声明');
  const encoding = XML_ENCODING.exec(declaration.groups.attributes ?? '');
  if (encoding) {
    const name = (encoding.groups.double ?? encoding.groups.single).trim().toLowerCase();
    if (name !== 'utf-8' && name !== 'utf8') throw new MarkupGuardError('xml_invalid', 'XML 编码不是 UTF-8');
  }
  if (XML_MARKUP_DECLARATION.test(text)) throw new MarkupGuardError('xml_doctype', 'XML 含 DTD 声明');
  if (text.includes(XINCLUDE_NAMESPACE) || XML_STYLESHEET.test(text)) {
    throw new MarkupGuardError('xml_external_reference', 'XML 含外部引用');
  }
  return { text, bytes };
}

// ---------------------------------------------------------------- RTF

/** RTF 组的嵌套层数上限（正常文档远小于此）。 */
export const RTF_MAX_DEPTH = 512;

/**
 * 整组去掉的目标（destination，按组的第一个控制字判断，不区分大小写）：
 * fldinst 域指令（INCLUDEPICTURE、INCLUDETEXT、INCLUDE、IMPORT、LINK、DDE、DDEAUTO、HYPERLINK 等全部在其中，去掉后域只剩显示结果
 * fldrslt，不论指令如何用 \'hh、\uN 或分组拆写都不影响）；datafield 域数据；template 附加模板；filetbl / subdocument 子文档；
 * fontemb / fontfile 嵌入或外部字体文件；hl / hlsrc / hlloc / hlfr 超链接目标；objdata / objlink / linkval 对象数据与链接；
 * htmltag / mhtmltag 封装的 HTML。object 单独处理（只留显示结果）。
 */
const RTF_DROPPED_DESTINATIONS = new Set([
  'fldinst',
  'datafield',
  'template',
  'filetbl',
  'subdocument',
  'fontemb',
  'fontfile',
  'hl',
  'hlsrc',
  'hlloc',
  'hlfr',
  'objdata',
  'objlink',
  'linkval',
  'htmltag',
  'mhtmltag',
]);
/** 形状属性中指向外部图片或链接的（{\sp{\sn 名称}{\sv 值}}）：整个属性去掉。 */
const RTF_LINKED_SHAPE_PROPERTY = /^(pib|fillBlip|lineBlip|lineFillBlip|lineStartArrowBlip|lineEndArrowBlip)(Name|Flags)$|^pihlShape$|^wzHyperlink/i;

const BRACE_OPEN = 0x7b;
const BRACE_CLOSE = 0x7d;
const BACKSLASH = 0x5c;

function isLetter(byte) {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function isDigit(byte) {
  return byte >= 0x30 && byte <= 0x39;
}

/**
 * 按组结构处理 RTF，返回处理后的字节。结构不合法（不以 {\rtf 开头、括号不配对、\bin 越界、\' 后不是两位十六进制、嵌套过深）
 * 时 rtf_invalid。上面列出的目标控制字出现在组内**任何位置**都去掉整个组（LibreOffice 不要求目标控制字在组首），连同其中的一切
 * （嵌套组、\bin 数据）；object 组只输出其中以 \result 开头的子组的内容。控制字按字母不区分大小写判断（只会多去掉）。
 * 解析规则与 RTF 规范一致：控制字是字母串加可选的数字参数和一个可选的空格分隔，\binN 之后 N 个原始字节，\'hh 占 4 个字节，
 * 其他控制符号占 2 个字节；字节流的切分与 LibreOffice 不一致的写法（\' 后不是十六进制、参数超过 10 位）直接拒绝。
 */
export function sanitizeRtf(buffer) {
  const input = stripUtf8Bom(buffer);
  let start = 0;
  while (start < input.length && (input[start] === 0x20 || input[start] === 0x09 || input[start] === 0x0d || input[start] === 0x0a)) start += 1;
  if (input.subarray(start, start + 5).toString('latin1') !== '{\\rtf') throw new MarkupGuardError('rtf_invalid', '不是 RTF');

  const output = Buffer.alloc(input.length);
  let length = 0;
  // 组栈。outStart：组开始时的输出长度（去掉该组时截回）；first：是否还没有遇到决定种类的内容（\* 不算）；
  // mode：'keep' 原样输出，'object' 组本身不输出、只输出 result 子组，'sp' 形状属性（待看属性名），'sn' 形状属性名。
  const stack = [];
  // 正在跳过的组的深度（该组在栈中时 stack.length 的值），-1 表示没有跳过。跳过期间只跟踪结构，不做任何判断。
  let skipDepth = -1;
  let snText = '';
  let i = start;
  let closedRoot = false;

  const emit = (from, to) => {
    if (skipDepth !== -1 || stack.at(-1)?.mode === 'object') return;
    input.copy(output, length, from, to);
    length += to - from;
  };
  const skipCurrentGroup = () => {
    length = stack.at(-1).outStart;
    skipDepth = stack.length;
  };
  /** 组内第一个决定种类的内容：object 的子组只有以 \result 开头的保留。返回 true 表示当前字节已处理。 */
  const decide = (group, word) => {
    if (!group.first) return false;
    group.first = false;
    if (stack.at(-2)?.mode !== 'object') {
      if (word === 'sp') group.mode = 'sp';
      else if (word === 'sn' && stack.at(-2)?.mode === 'sp') {
        group.mode = 'sn';
        snText = '';
      }
      return false;
    }
    if (word !== 'result') {
      skipCurrentGroup();
      return false;
    }
    // 只输出 result 的内容：截回组开始处，补上左括号，不输出 \* 与 \result 本身。
    length = group.outStart;
    output[length] = BRACE_OPEN;
    length += 1;
    return true;
  };

  while (i < input.length && !closedRoot) {
    const byte = input[i];
    if (byte === BRACE_OPEN) {
      if (stack.length >= RTF_MAX_DEPTH) throw new MarkupGuardError('rtf_invalid', 'RTF 嵌套过深');
      emit(i, i + 1);
      stack.push({ outStart: length - (skipDepth === -1 && stack.at(-1)?.mode !== 'object' ? 1 : 0), first: true, mode: 'keep' });
      i += 1;
      continue;
    }
    if (byte === BRACE_CLOSE) {
      if (stack.length === 0) throw new MarkupGuardError('rtf_invalid', 'RTF 括号不配对');
      const group = stack.at(-1);
      emit(i, i + 1);
      stack.pop();
      if (skipDepth !== -1) {
        if (stack.length + 1 === skipDepth) skipDepth = -1;
      } else if (group.mode === 'sn' && stack.at(-1)?.mode === 'sp') {
        if (RTF_LINKED_SHAPE_PROPERTY.test(snText.trim())) skipCurrentGroup();
        else stack.at(-1).mode = 'keep';
      }
      // 被跳过的 sp 组在其右括号处结束跳过（上面 skipCurrentGroup 之后，后续字节按跳过处理）。
      if (stack.length === 0) closedRoot = true;
      i += 1;
      continue;
    }
    if (stack.length === 0) throw new MarkupGuardError('rtf_invalid', 'RTF 组外有内容');
    const group = stack.at(-1);

    if (byte === BACKSLASH) {
      const next = input[i + 1];
      if (next === undefined) throw new MarkupGuardError('rtf_invalid', 'RTF 以反斜杠结尾');
      if (isLetter(next)) {
        let end = i + 1;
        while (end < input.length && isLetter(input[end])) end += 1;
        const word = input.subarray(i + 1, end).toString('latin1').toLowerCase();
        const paramStart = end;
        if (input[end] === 0x2d) end += 1;
        const digitsStart = end;
        while (end < input.length && isDigit(input[end])) end += 1;
        if (end - digitsStart > 10) throw new MarkupGuardError('rtf_invalid', 'RTF 控制字参数过长');
        const hasParam = end > digitsStart;
        if (!hasParam) end = paramStart;
        const param = hasParam ? Number(input.subarray(paramStart, end).toString('latin1')) : null;
        if (input[end] === 0x20) end += 1;
        if (word === 'bin') {
          // \binN 之后是 N 个原始字节（可能含括号），整体跳过解析。
          if (param === null || param < 0 || end + param > input.length) throw new MarkupGuardError('rtf_invalid', 'RTF 的 \\bin 越界');
          if (skipDepth === -1) decide(group, word);
          emit(i, end + param);
          i = end + param;
          continue;
        }
        if (skipDepth === -1) {
          if (decide(group, word)) {
            i = end;
            continue;
          }
          if (skipDepth === -1) {
            if (RTF_DROPPED_DESTINATIONS.has(word)) {
              skipCurrentGroup();
            } else if (word === 'object' && group.mode !== 'object') {
              length = group.outStart;
              group.mode = 'object';
            }
          }
        }
        emit(i, end);
        i = end;
        continue;
      }
      // 控制符号：\'hh 占 4 个字节，其他（\\、\{、\}、\*、\~ 等）占 2 个字节。\* 不决定组的种类。
      let width = 2;
      if (next === 0x27) {
        if (!/^[0-9A-Fa-f]{2}$/.test(input.subarray(i + 2, i + 4).toString('latin1'))) {
          throw new MarkupGuardError('rtf_invalid', "RTF 的 \\' 后不是十六进制");
        }
        width = 4;
      }
      if (skipDepth === -1 && next !== 0x2a) decide(group, null);
      if (skipDepth === -1 && group.mode === 'sn') snText += input.subarray(i, i + width).toString('latin1');
      emit(i, i + width);
      i += width;
      continue;
    }

    // 普通字节（正文、空白、十六进制数据）；换行不决定组的种类。
    if (skipDepth === -1 && byte !== 0x0d && byte !== 0x0a) decide(group, null);
    if (skipDepth === -1 && group.mode === 'sn') snText += String.fromCharCode(byte);
    emit(i, i + 1);
    i += 1;
  }
  if (!closedRoot) throw new MarkupGuardError('rtf_invalid', 'RTF 括号不配对');
  // 根组之后的内容（空白、NUL 等）丢弃。
  return Buffer.from(output.subarray(0, length));
}

// ---------------------------------------------------------------- MHT（MIME）

export const MHT_LIMITS = Object.freeze({
  /** multipart 的嵌套层数（含最外层）。 */
  maxDepth: 8,
  /** 叶子部分总数。 */
  maxParts: 2_000,
  /** 单个头部块的字节数。 */
  maxHeaderBytes: 64 * 1024,
  /** 单个头部块的字段数。 */
  maxHeaderFields: 200,
});

/** 包内图片只收这些类型（与解析入口的 imageSink 一致）。 */
const MHT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp']);

function mhtInvalid(message) {
  return new MarkupGuardError('mht_invalid', message);
}

/** 找到头部与正文的分隔（空行），返回 { headerEnd, bodyStart }；没有空行时整段都是头部，以空行开头时没有头部。 */
function splitHeader(buffer, from, to) {
  if (buffer[from] === 0x0a) return { headerEnd: from, bodyStart: from + 1 };
  if (buffer[from] === 0x0d && buffer[from + 1] === 0x0a) return { headerEnd: from, bodyStart: Math.min(from + 2, to) };
  for (let index = from; index < to; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    if (buffer[index + 1] === 0x0a && index + 1 < to) return { headerEnd: index + 1, bodyStart: index + 2 };
    if (buffer[index + 1] === 0x0d && buffer[index + 2] === 0x0a && index + 2 < to) return { headerEnd: index + 1, bodyStart: index + 3 };
  }
  return { headerEnd: to, bodyStart: to };
}

function parseHeaders(buffer, from, to, limits) {
  if (to - from > limits.maxHeaderBytes) throw new MarkupGuardError('mht_too_complex', 'MIME 头部过大');
  const lines = buffer.subarray(from, to).toString('latin1').split(/\r?\n/);
  const fields = new Map();
  let current = null;
  let count = 0;
  for (const line of lines) {
    if (line === '') continue;
    if ((line[0] === ' ' || line[0] === '\t') && current) {
      current.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0 || !/^[!-9;-~]+$/.test(line.slice(0, colon))) throw mhtInvalid('MIME 头部格式不正确');
    count += 1;
    if (count > limits.maxHeaderFields) throw new MarkupGuardError('mht_too_complex', 'MIME 头部字段过多');
    const name = line.slice(0, colon).toLowerCase();
    current = { value: line.slice(colon + 1).trim() };
    // 同名字段只取第一个。
    if (!fields.has(name)) fields.set(name, current);
  }
  return new Map([...fields].map(([name, field]) => [name, field.value]));
}

/** 解析 Content-Type：类型（小写）与参数（名称小写，值去掉引号）。 */
export function parseContentType(value) {
  const text = String(value ?? '');
  const semicolon = text.indexOf(';');
  const type = (semicolon === -1 ? text : text.slice(0, semicolon)).trim().toLowerCase();
  const params = new Map();
  const pattern = /;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s"]*))/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1].toLowerCase();
    const raw = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3];
    if (!params.has(name)) params.set(name, raw);
  }
  return { type, params };
}

function decodeBase64(buffer) {
  const text = buffer.toString('latin1').replace(/[\r\n\t ]+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw mhtInvalid('base64 不合法');
  return Buffer.from(text, 'base64');
}

function decodeQuotedPrintable(buffer) {
  const output = Buffer.alloc(buffer.length);
  let length = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte !== 0x3d) {
      output[length] = byte;
      length += 1;
      continue;
    }
    // 软换行（=\r\n 或 =\n）。
    if (buffer[index + 1] === 0x0a) {
      index += 1;
      continue;
    }
    if (buffer[index + 1] === 0x0d && buffer[index + 2] === 0x0a) {
      index += 2;
      continue;
    }
    const hex = buffer.subarray(index + 1, index + 3).toString('latin1');
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      output[length] = Number.parseInt(hex, 16);
      length += 1;
      index += 2;
      continue;
    }
    // 不合法的 = 原样保留（RFC 2045 建议的宽松处理）。
    output[length] = byte;
    length += 1;
  }
  return Buffer.from(output.subarray(0, length));
}

function decodeBody(buffer, encoding) {
  const name = String(encoding ?? '').trim().toLowerCase();
  if (name === 'base64') return decodeBase64(buffer);
  if (name === 'quoted-printable') return decodeQuotedPrintable(buffer);
  if (name === '' || name === '7bit' || name === '8bit' || name === 'binary') return Buffer.from(buffer);
  throw mhtInvalid('不支持的 Content-Transfer-Encoding');
}

/** 在 [from, to) 中找所有以 --boundary 开头的行，返回各部分的范围；没有找到开始分隔行时不合法。 */
function splitMultipart(buffer, from, to, boundary) {
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  const parts = [];
  let partStart = -1;
  let index = from;
  let closed = false;
  while (index < to) {
    const found = buffer.indexOf(delimiter, index);
    if (found === -1 || found + delimiter.length > to) break;
    const atLineStart = found === from || buffer[found - 1] === 0x0a;
    if (!atLineStart) {
      index = found + 1;
      continue;
    }
    let after = found + delimiter.length;
    const closing = buffer[after] === 0x2d && buffer[after + 1] === 0x2d;
    if (closing) after += 2;
    // 分隔行之后只允许空白直到行尾。
    let lineEnd = after;
    while (lineEnd < to && (buffer[lineEnd] === 0x20 || buffer[lineEnd] === 0x09 || buffer[lineEnd] === 0x0d)) lineEnd += 1;
    if (lineEnd < to && buffer[lineEnd] !== 0x0a) {
      index = found + 1;
      continue;
    }
    if (partStart !== -1) {
      // 分隔行之前的换行属于分隔行。
      let partEnd = found;
      if (partEnd > partStart && buffer[partEnd - 1] === 0x0a) partEnd -= 1;
      if (partEnd > partStart && buffer[partEnd - 1] === 0x0d) partEnd -= 1;
      parts.push([partStart, partEnd]);
    }
    if (closing) {
      closed = true;
      break;
    }
    partStart = Math.min(lineEnd + 1, to);
    index = partStart;
  }
  if (partStart === -1) throw mhtInvalid('multipart 中没有分隔行');
  // 没有结束分隔行（截断的文件）：最后一部分到末尾为止。
  if (!closed) parts.push([partStart, to]);
  return parts;
}

function walkPart(buffer, from, to, depth, state, limits) {
  const { headerEnd, bodyStart } = splitHeader(buffer, from, to);
  const headers = parseHeaders(buffer, from, headerEnd, limits);
  const { type, params } = parseContentType(headers.get('content-type') ?? 'text/plain');
  if (type.startsWith('multipart/')) {
    if (depth >= limits.maxDepth) throw new MarkupGuardError('mht_too_complex', 'multipart 嵌套过深');
    const boundary = params.get('boundary');
    if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw mhtInvalid('multipart 缺少合法的 boundary');
    const encoding = String(headers.get('content-transfer-encoding') ?? '').trim().toLowerCase();
    if (encoding && encoding !== '7bit' && encoding !== '8bit' && encoding !== 'binary') throw mhtInvalid('multipart 不能编码');
    const node = { type, params, children: [] };
    for (const [partFrom, partTo] of splitMultipart(buffer, bodyStart, to, boundary)) {
      node.children.push(walkPart(buffer, partFrom, partTo, depth + 1, state, limits));
    }
    return node;
  }
  state.parts += 1;
  if (state.parts > limits.maxParts) throw new MarkupGuardError('mht_too_complex', 'MIME 部分过多');
  const leaf = {
    type,
    params,
    location: headers.get('content-location')?.trim() || null,
    contentId: normalizeContentId(headers.get('content-id')),
    encoding: headers.get('content-transfer-encoding') ?? null,
    range: [bodyStart, to],
  };
  state.leaves.push(leaf);
  return leaf;
}

function normalizeContentId(value) {
  if (!value) return null;
  const text = String(value).trim().replace(/^<|>$/g, '').trim();
  return text || null;
}

/** 解析 URL；不是合法的绝对 URL 时返回 null。只做字符串计算，不访问任何地址。 */
function tryUrl(value, base) {
  try {
    return new URL(value, base ?? undefined).href;
  } catch {
    return null;
  }
}

/**
 * 解开 MHT（MIME，message/rfc822 或 multipart/related），取出正文 HTML 与包内图片。
 * 正文：multipart/related 的 start 参数指定的部分，否则第一个 text/html 部分；没有时 mht_no_html。
 * 返回 { html（已解码的字符串）, resolveResource(src) }：resolveResource 只在包内查找（cid:、Content-Location 原样或按正文的
 * Content-Location 解析相对地址），找到包内图片时返回 { mime, buffer }，否则 null；从不跟随任何地址。
 */
export function extractMht(buffer, limits = MHT_LIMITS) {
  const input = stripUtf8Bom(buffer);
  const { headerEnd } = splitHeader(input, 0, input.length);
  const topHeaders = parseHeaders(input, 0, headerEnd, limits);
  if (!topHeaders.has('mime-version')) throw mhtInvalid('缺少 MIME-Version');
  const state = { parts: 0, leaves: [] };
  const root = walkPart(input, 0, input.length, 0, state, limits);

  let htmlLeaf = null;
  const start = root.children ? normalizeContentId(root.params.get('start')) : null;
  if (start) htmlLeaf = state.leaves.find((leaf) => leaf.contentId === start && leaf.type === 'text/html') ?? null;
  htmlLeaf ??= state.leaves.find((leaf) => leaf.type === 'text/html') ?? null;
  if (!htmlLeaf) throw new MarkupGuardError('mht_no_html', 'MHT 中没有 text/html 部分');

  const htmlBytes = decodeBody(input.subarray(...htmlLeaf.range), htmlLeaf.encoding);
  const html = decodeHtmlBytes(htmlBytes, htmlLeaf.params.get('charset'));
  const base = htmlLeaf.location ? tryUrl(htmlLeaf.location) : null;

  // 包内图片：按 Content-ID 与 Content-Location（原样和规范化后的绝对地址）登记，只在被引用时解码。
  const byId = new Map();
  const byLocation = new Map();
  for (const leaf of state.leaves) {
    if (!MHT_IMAGE_TYPES.has(leaf.type)) continue;
    if (leaf.contentId && !byId.has(leaf.contentId)) byId.set(leaf.contentId, leaf);
    if (leaf.location) {
      for (const key of [leaf.location, tryUrl(leaf.location, base)]) {
        if (key && !byLocation.has(key)) byLocation.set(key, leaf);
      }
    }
  }
  const decoded = new Map();
  function resolveResource(src) {
    const value = String(src ?? '').trim();
    if (!value) return null;
    let leaf = null;
    if (/^cid:/i.test(value)) {
      let id = value.slice(4);
      try {
        id = decodeURIComponent(id);
      } catch {
        // 保留原样。
      }
      leaf = byId.get(normalizeContentId(id)) ?? null;
    } else {
      leaf = byLocation.get(value) ?? byLocation.get(tryUrl(value, base) ?? '') ?? null;
    }
    if (!leaf) return null;
    if (!decoded.has(leaf)) {
      let data = null;
      try {
        data = decodeBody(input.subarray(...leaf.range), leaf.encoding);
      } catch {
        data = null;
      }
      decoded.set(leaf, data);
    }
    const data = decoded.get(leaf);
    return data && data.length > 0 ? { mime: leaf.type === 'image/jpg' ? 'image/jpeg' : leaf.type, buffer: data } : null;
  }
  return { html, resolveResource, partCount: state.parts };
}

// ---------------------------------------------------------------- HTML 字符集

const META_CHARSET = /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i;

function decoderFor(label) {
  if (!label) return null;
  try {
    const decoder = new TextDecoder(String(label).trim().toLowerCase(), { ignoreBOM: false });
    // UTF-16 不可能出现（上传时只识别 ASCII 兼容的开头），声明为 UTF-16 的按 UTF-8 处理（与浏览器相同）。
    return decoder.encoding.startsWith('utf-16') ? new TextDecoder('utf-8') : decoder;
  } catch {
    return null;
  }
}

/**
 * HTML 字节解码为字符串：UTF-8 BOM → 传入的 charset（MHT 部分的参数）→ 前 4 KiB 内的 <meta charset> / http-equiv →
 * 合法 UTF-8 → GB18030。字符集名称不认识时按后续规则处理。
 */
export function decodeHtmlBytes(buffer, charset = null) {
  if (buffer.subarray(0, 3).equals(UTF8_BOM)) return new TextDecoder('utf-8').decode(buffer.subarray(3));
  const declared = decoderFor(charset) ?? decoderFor(META_CHARSET.exec(buffer.subarray(0, 4096).toString('latin1'))?.[1]);
  if (declared) return declared.decode(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('gb18030').decode(buffer);
  }
}
