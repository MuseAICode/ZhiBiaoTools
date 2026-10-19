// 上传规则（docs/SERVER_DESIGN.md 第 6.1 节）：用途决定允许的扩展名和单文件大小上限。
// 扩展名集合沿用桌面版：fileService.cjs（招标文件）、knowledgeBaseService.cjs（知识库）、
// fileService.cjs 的查重集合、credentialLibraryService.cjs（资信库图片）。SVG 不在任何集合中（第 6.4 节）。
import { FILE_PURPOSES } from '../db/migrations/0006_files.ts';

export { FILE_PURPOSES, FILE_RESTORE_DAYS, ORG_STORAGE_QUOTA_BYTES } from '../db/migrations/0006_files.ts';
export type FilePurpose = (typeof FILE_PURPOSES)[number];

const MIB = 1024 * 1024;
/** 第 9 节第 15 项：文档 100 MB、图片 10 MB。 */
export const DOCUMENT_MAX_BYTES = 100 * MIB;
export const IMAGE_MAX_BYTES = 10 * MIB;

export type FileCategory = 'document' | 'image';

export interface PurposePolicy {
  readonly category: FileCategory;
  readonly maxBytes: number;
  readonly extensions: ReadonlySet<string>;
}

const DOCUMENT = (extensions: string[]): PurposePolicy =>
  Object.freeze({ category: 'document', maxBytes: DOCUMENT_MAX_BYTES, extensions: new Set(extensions) });

export const PURPOSE_POLICIES: Readonly<Record<FilePurpose, PurposePolicy>> = Object.freeze({
  tender: DOCUMENT(['txt', 'md', 'markdown', 'docx', 'pdf', 'doc', 'wps', 'xls', 'xlsx']),
  knowledge: DOCUMENT(['doc', 'docx', 'wps', 'pdf', 'md', 'markdown', 'xls', 'xlsx']),
  'duplicate-check': DOCUMENT(['doc', 'docx', 'wps', 'pdf', 'md', 'markdown', 'xls', 'xlsx']),
  'credential-image': Object.freeze({
    category: 'image',
    maxBytes: IMAGE_MAX_BYTES,
    extensions: new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']),
  }),
});

export function isFilePurpose(value: string): value is FilePurpose {
  return (FILE_PURPOSES as readonly string[]).includes(value);
}
