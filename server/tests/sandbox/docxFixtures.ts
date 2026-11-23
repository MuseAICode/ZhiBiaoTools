// 构造最小的 docx（测试用，路线图 8.8c）：段落、标题、APPMARKLAYOUT 定位书签、表格、内嵌图片、分页、两栏。
// 只写 docx-editor 版式计算需要的部件（[Content_Types].xml、_rels、document.xml、styles.xml、可选的图片），
// 与 OpenXmlHelper 导出的结构相同的地方：定位书签名 app_layout_<n>、正文样式 Normal、标题样式 Heading1（outlineLvl 0）。
import { buildZip, type ZipFixtureEntry } from './zipFixtures.ts';

export type DocxBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string; pageBreakBefore?: boolean }
  | { kind: 'bookmark'; name: string; text?: string }
  | { kind: 'image'; widthCm: number; heightCm: number; bookmark?: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'pageBreak' }
  | { kind: 'raw'; xml: string };

export interface DocxFixtureOptions {
  /** 两栏（横向页面）。 */
  twoColumn?: boolean;
  /** 额外的部件（例如 docx 中的恶意内容）。 */
  extraEntries?: ZipFixtureEntry[];
  /** document.xml.rels 中追加的关系（XML 原文，例如外部图片与链接）。 */
  relationships?: string;
  /** [Content_Types].xml 中追加的条目（XML 原文）。 */
  contentTypes?: string;
  /** 替换整个 document.xml 的正文（<w:body> 之内、sectPr 之前）。 */
  rawBody?: string;
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const run = (text: string) => `<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
const EMU_PER_CM = 360000;

/** 1×1 的灰色 PNG（内嵌图片的内容；版式只用 extent 中的尺寸）。 */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC',
  'base64',
);

function blockXml(block: DocxBlock, index: number): string {
  switch (block.kind) {
    case 'heading':
      return `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:outlineLvl w:val="0"/></w:pPr>${run(block.text)}</w:p>`;
    case 'paragraph':
      return `<w:p><w:pPr><w:pStyle w:val="Normal"/>${block.pageBreakBefore ? '<w:pageBreakBefore/>' : ''}</w:pPr>${run(block.text)}</w:p>`;
    case 'bookmark':
      return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:bookmarkStart w:id="${index + 1}" w:name="${xmlEscape(block.name)}"/>${block.text ? run(block.text) : ''}<w:bookmarkEnd w:id="${index + 1}"/></w:p>`;
    case 'image': {
      const cx = Math.round(block.widthCm * EMU_PER_CM);
      const cy = Math.round(block.heightCm * EMU_PER_CM);
      // 定位书签与 OpenXmlHelper 的 ApplyLayoutBookmarks 相同：零宽书签放在图片所在段落的开头。
      const mark = block.bookmark ? `<w:bookmarkStart w:id="${index + 1}" w:name="${xmlEscape(block.bookmark)}"/><w:bookmarkEnd w:id="${index + 1}"/>` : '';
      return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${mark}<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${index + 1}" name="图片 ${index + 1}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${index + 1}" name="image.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    }
    case 'table': {
      const columns = Math.max(1, ...block.rows.map((row) => row.length));
      const grid = Array.from({ length: columns }, () => '<w:gridCol w:w="2000"/>').join('');
      const rows = block.rows
        .map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p>${run(cell)}</w:p></w:tc>`).join('')}</w:tr>`)
        .join('');
      return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
    }
    case 'pageBreak':
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    case 'raw':
      return block.xml;
  }
}

/** 按块列表生成 docx。 */
export function buildDocx(blocks: readonly DocxBlock[], options: DocxFixtureOptions = {}): Buffer {
  const hasImage = blocks.some((block) => block.kind === 'image');
  const section = options.twoColumn
    ? '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/><w:cols w:num="2" w:space="425"/></w:sectPr>'
    : '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
  const body = options.rawBody ?? blocks.map(blockXml).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}${section}</w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${options.contentTypes ?? ''}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${hasImage ? '<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' : ''}${options.relationships ?? ''}</Relationships>`;
  const entries: ZipFixtureEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rootRels) },
    { name: 'word/document.xml', data: Buffer.from(document) },
    { name: 'word/styles.xml', data: Buffer.from(styles) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels) },
    ...(hasImage ? [{ name: 'word/media/image1.png', data: PIXEL_PNG }] : []),
    ...(options.extraEntries ?? []),
  ];
  return buildZip(entries);
}

/** n 段较长的中文正文（每段约 120 字）。 */
export function bodyParagraphs(n: number, prefix = '正文'): DocxBlock[] {
  const sentence = '本项目按招标文件的要求组织实施，各阶段的工作内容、交付物与验收标准均在下文中逐项说明，';
  return Array.from({ length: n }, (_v, i) => ({ kind: 'paragraph' as const, text: `${prefix}${i + 1}：${sentence.repeat(3)}` }));
}

/**
 * 一份典型的自检文档：标题、正文、两处定位书签 + 大图（单栏与两栏下都被挤到下一页 / 栏，留下大块空白）、表格、
 * 其他书签、显式分页的段落、第二章。
 */
export function sampleLayoutDocx(options: DocxFixtureOptions = {}): Buffer {
  return buildDocx(
    [
      { kind: 'heading', text: '第一章 总体方案' },
      ...bodyParagraphs(11),
      { kind: 'image', widthCm: 12, heightCm: 15, bookmark: 'app_layout_0' },
      ...bodyParagraphs(3, '图后'),
      { kind: 'table', rows: [['序号', '内容'], ['1', '表格单元格中的文字']] },
      { kind: 'bookmark', name: 'unrelated_bookmark', text: '其他书签' },
      ...bodyParagraphs(2, '表后'),
      { kind: 'image', widthCm: 10, heightCm: 13, bookmark: 'app_layout_1' },
      { kind: 'paragraph', text: '显式分页后的段落', pageBreakBefore: true },
      { kind: 'heading', text: '第二章 实施计划' },
      ...bodyParagraphs(4, '二章'),
    ],
    options,
  );
}
