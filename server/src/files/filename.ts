// 用户提供的文件名只用于显示和下载时的建议文件名（docs/SERVER_DESIGN.md 第 6.1 节），从不参与对象键。
// 清洗：替换为合法 Unicode、NFC 归一化，去掉控制字符和改变显示方向的字符，路径分隔符和 Windows 保留字符换成 “_”，
// 去掉首尾空白和开头的点，按 UTF-8 截断到 255 字节（尽量保留扩展名）。
const MAX_NAME_BYTES = 255;
const FALLBACK_NAME = '未命名';

// C0 / C1 控制字符、DEL、零宽字符、双向文本控制字符（可用来把 “exe.pdf” 显示成 “fdp.exe”）、BOM。
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;
const SEPARATORS = /[/\\<>:"|?*]/gu;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** 按码点截断，结果不超过 maxBytes 字节，不会切开多字节字符或代理对。 */
function truncateBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const size = byteLength(char);
    if (bytes + size > maxBytes) break;
    result += char;
    bytes += size;
  }
  return result;
}

/** 扩展名（小写、不带点）；没有扩展名或不是 1~16 位字母数字时返回 null。 */
export function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(extension) ? extension : null;
}

export function sanitizeDisplayName(raw: string): string {
  let name = raw.toWellFormed().normalize('NFC').replace(INVISIBLE, '').replace(SEPARATORS, '_');
  name = name.trim().replace(/^[.\s]+/u, '').replace(/[.\s]+$/u, '');
  if (name === '') return FALLBACK_NAME;
  if (byteLength(name) <= MAX_NAME_BYTES) return name;

  const extension = extensionOf(name);
  if (extension === null) return truncateBytes(name, MAX_NAME_BYTES);
  const suffix = `.${extension}`;
  const base = truncateBytes(name.slice(0, name.length - suffix.length), MAX_NAME_BYTES - byteLength(suffix)).trimEnd();
  return base === '' ? truncateBytes(name, MAX_NAME_BYTES) : `${base}${suffix}`;
}

/**
 * Content-Disposition 的值，一律 attachment（第 6.4 节）。filename* 给出 UTF-8 原名（RFC 6266 / 8187），
 * filename 是给旧客户端的 ASCII 回退：非 ASCII 字符、引号和反斜杠换成 “_”。
 */
export function attachmentDisposition(displayName: string): string {
  const fallback = displayName.replace(/[^\x20-\x7e]|["\\]/gu, '_');
  const encoded = encodeURIComponent(displayName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
