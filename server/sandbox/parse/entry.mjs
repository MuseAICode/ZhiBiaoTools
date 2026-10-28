// parse 沙箱的解析入口（路线图第 6 步 6.6；docs/SERVER_DESIGN.md 第 7.5 节）。由 sandbox-runner 按 parse 模板执行：
//   node /opt/parse/entry.mjs format=<格式> [images=0|1] [charset=utf-8|gb18030] [analysis=duplicate-check]
// 原件固定在 /input/source（worker 经 copyIn 放入），结果固定写到 /output：
//   content.md      Markdown（UTF-8）
//   images/…        提取的图片（只在 images=1 时；只收 png / jpeg / gif / webp / bmp，至多 2,000 张）
//   manifest.json   { version: 1, images: [{ path, mime }] }
//   analysis.json   只在 analysis=duplicate-check 时：标书查重的逐文档提取结果（目录、句子、图片位置，duplicateText.mjs，6.10）。
//                   表格类格式另由 worker 放入 /input/title（文件名，UTF-8 一行），提取时与桌面版相同以它作一级标题。
// 格式由 worker 按上传时记录的 MIME 分派，这里不再猜测。失败时不写结果，在标准输出写一行 {"error":"代码"}：
// 参数不合法退出码 64，转换失败 65。错误只给代码，给用户看的文案由 worker 按代码决定，不采用沙箱输出的文字。
// 本进程没有网络、没有凭据；它的输出在 worker 中按不可信输入逐项校验（src/sandbox/archive.ts、src/parse/output.ts）。
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const FORMATS = new Set([
  'pdf', 'docx', 'xlsx', 'word-ole', 'xls-ole', 'text', 'markdown',
  'rtf', 'html-word', 'html-sheet', 'mht', 'word-xml', 'spreadsheet-xml',
]);
const CHARSETS = new Set(['utf-8', 'gb18030']);
const ANALYSES = new Set(['duplicate-check']);
const INPUT = '/input/source';
const TITLE_INPUT = '/input/title';
/** 标题文件的上限（字节）。worker 只放入整理过的文件名。 */
const TITLE_MAX_BYTES = 4096;
const OUTPUT = '/output';
/** 单个文件产出的图片上限（决定事项第 5 项）。 */
const MAX_IMAGES = 2_000;
const IMAGE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
});
/** 由 worker 识别的错误代码；其他异常一律为 conversion_failed。 */
const KNOWN_CODES = new Set([
  'unsupported_format',
  'text_decode_failed',
  'zip_invalid',
  'zip_too_many_entries',
  'zip_too_large',
  'zip_ratio',
  'pdf_invalid',
  'pdf_too_many_pages',
  'pdf_text_layer_missing',
  'spreadsheet_empty',
  'office_conversion_failed',
  'office_conversion_timeout',
  'too_many_images',
  'xml_invalid',
  'xml_doctype',
  'xml_external_reference',
  'rtf_invalid',
  'mht_invalid',
  'mht_too_complex',
  'mht_no_html',
]);

function fail(code, exitCode) {
  process.stdout.write(`${JSON.stringify({ error: code })}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = { format: null, images: false, charset: null, analysis: null };
  const seen = new Set();
  for (const arg of argv) {
    const match = /^(format|images|charset|analysis)=(.+)$/.exec(arg);
    if (!match || seen.has(match[1])) return null;
    seen.add(match[1]);
    const [, key, value] = match;
    if (key === 'format') {
      if (!FORMATS.has(value)) return null;
      options.format = value;
    } else if (key === 'images') {
      if (value !== '0' && value !== '1') return null;
      options.images = value === '1';
    } else if (key === 'analysis') {
      if (!ANALYSES.has(value)) return null;
      options.analysis = value;
    } else {
      if (!CHARSETS.has(value)) return null;
      options.charset = value;
    }
  }
  if (!options.format) return null;
  const textual = options.format === 'text' || options.format === 'markdown';
  if (textual !== (options.charset !== null)) return null;
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options) fail('bad_arguments', 64);

// 解析库（pdfjs 等）会向控制台打印警告，可能含文档内容，也会混进标准输出的结果行：一律丢弃。
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};

// 依赖较重（pdfjs、mammoth 等），参数检查通过后才加载。
const { convertToMarkdown } = await import('./convert.mjs');

const images = [];
let imageDirectoryReady = false;
async function imageSink({ buffer, mime }) {
  const extension = IMAGE_EXTENSIONS[String(mime).toLowerCase()];
  // emf / wmf / tiff / svg 等不能作为产物保存（迁移 0008 只登记了位图），丢弃。
  if (!extension || !Buffer.isBuffer(buffer) || buffer.length === 0) return '';
  if (images.length >= MAX_IMAGES) {
    const error = new Error('too many images');
    error.code = 'too_many_images';
    throw error;
  }
  if (!imageDirectoryReady) {
    await mkdir(`${OUTPUT}/images`);
    imageDirectoryReady = true;
  }
  const path = `images/image-${String(images.length + 1).padStart(4, '0')}.${extension}`;
  await writeFile(`${OUTPUT}/${path}`, buffer, { flag: 'wx' });
  images.push({ path, mime: extension === 'jpg' ? 'image/jpeg' : `image/${extension}` });
  return path;
}

/** worker 放入的标题（表格类格式的文件名）；没有时为空。 */
async function readTitle() {
  let data;
  try {
    data = await readFile(TITLE_INPUT);
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
  if (data.length > TITLE_MAX_BYTES) return '';
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return '';
  }
  return text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

try {
  const buffer = await readFile(INPUT);
  const markdown = await convertToMarkdown({
    format: options.format,
    buffer,
    charset: options.charset ?? undefined,
    imageSink: options.images ? imageSink : null,
  });
  await writeFile(`${OUTPUT}/content.md`, markdown, { encoding: 'utf8', flag: 'wx' });
  await writeFile(`${OUTPUT}/manifest.json`, JSON.stringify({ version: 1, images }), { encoding: 'utf8', flag: 'wx' });
  if (options.analysis === 'duplicate-check') {
    const { analyzeDuplicateCheckDocument } = await import('./duplicateText.mjs');
    const { extractHtmlTableTextBlocks } = await import('./duplicateTables.mjs');
    const title = await readTitle();
    const source = (title ? `# ${title}\n\n${markdown}` : markdown).trim();
    const analysis = analyzeDuplicateCheckDocument(source, extractHtmlTableTextBlocks);
    await writeFile(`${OUTPUT}/analysis.json`, JSON.stringify(analysis), { encoding: 'utf8', flag: 'wx' });
  }
} catch (error) {
  const code = KNOWN_CODES.has(error?.code) ? error.code : 'conversion_failed';
  // 标准错误只写错误类型和代码，不写消息（可能含文档内容），供排查。
  process.stderr.write(`${error?.name ?? 'Error'} ${code}\n`);
  fail(code, 65);
}
