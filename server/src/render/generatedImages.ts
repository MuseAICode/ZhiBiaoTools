// 生图结果入库（路线图第 8 步 8.9）：服务商返回的图片一律按不可信内容处理，经 8.8a2 的 render-html 沙箱重新编码成 PNG 后才入库。
//
// 1. 按内容判断格式（PNG / JPEG / WebP / SVG），不采用服务商声明的类型；其他格式（含 GIF、BMP、HTML 等）该张失败 image_invalid；
// 2. 同一批（至多 4 张）放进一个 render-html 沙箱（断网、禁用页面脚本、gVisor）：PNG / JPEG / WebP 只缩小不放大、长宽 ≤ 1920 × 2880，
//    SVG 等比放进同一上限；解码失败、格式不符时该张失败，不影响其他张（renderHtmlImages 的输出按不可信输入校验）；
// 3. 转出的 PNG 再按上传图片的规则校验（src/files/inspect.ts：按内容判断类型、≤ 10 MiB），通过后写成图片产物（image/png，属于任务的项目）；
// 4. 只有入库成功的张数计费（src/ai/images.ts）。沙箱不可用、存储配额已满等平台一侧的错误整批抛出，本次不收费。
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Kysely } from 'kysely';
import type { ImageItemFailure, ImageStoreResult, ProviderImage, StoredImage } from '../ai/images.ts';
import { supersedeArtifactsById, writeArtifact } from '../artifacts/store.ts';
import type { Database } from '../db/schema.ts';
import type { TenantContext } from '../db/tenant.ts';
import { InspectionStream } from '../files/inspect.ts';
import type { ObjectStore } from '../files/objectStore.ts';
import { IMAGE_MAX_BYTES } from '../files/policy.ts';
import { AppError } from '../errors.ts';
import { JobError } from '../jobs/definitions.ts';
import { renderHtmlImages, type ConvertImageInput, type RenderHtmlContext, type RenderHtmlOptions, type RenderImageFormat } from './htmlImages.ts';

export interface GeneratedImageStoreContext extends RenderHtmlContext {
  db: Kysely<Database>;
  tenant: TenantContext;
  objectStore: ObjectStore | null;
  /** 图片产物所属的项目（任务的项目）。 */
  projectId: string | null;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(data: Buffer, signature: readonly number[], offset = 0): boolean {
  return data.length >= offset + signature.length && signature.every((byte, index) => data[offset + index] === byte);
}

/** 按内容判断格式；不是这四种时为 null。SVG 必须是合法 UTF-8、不含 NUL，开头（去掉 BOM 与空白）是 <?xml 或 <svg，且含有 <svg。 */
export function sniffGeneratedImage(data: Buffer): RenderImageFormat | null {
  if (startsWith(data, PNG)) return 'png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
  if (text.includes('\0')) return null;
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 5).toLowerCase();
  return (head.startsWith('<?xml') || head.startsWith('<svg')) && text.includes('<svg') ? 'svg' : null;
}

/** 按上传图片的规则校验转出的 PNG（与上传链路同一个校验流）。 */
async function inspectPng(png: Buffer): Promise<boolean> {
  const inspector = new InspectionStream({
    extension: 'png',
    maxBytes: IMAGE_MAX_BYTES,
    tooLarge: () => new AppError(413, 'FILE_TOO_LARGE', '图片超过大小上限'),
  });
  try {
    await pipeline(Readable.from([png]), inspector, new Writable({ write: (_chunk, _encoding, callback) => callback() }));
    return inspector.result.kind === 'png' && inspector.result.size === png.length;
  } catch {
    return false;
  }
}

/** 把服务商返回的图片转成 PNG 并写成图片产物；返回成功入库的与每张失败的原因。 */
export async function storeGeneratedImages(
  context: GeneratedImageStoreContext,
  images: readonly ProviderImage[],
  options: RenderHtmlOptions = {},
): Promise<ImageStoreResult> {
  if (!context.objectStore) throw new JobError('STORAGE_UNAVAILABLE', '文件存储暂不可用，请稍后再试');
  if (!context.projectId) throw new JobError('PROJECT_REQUIRED', '生图结果必须属于一个项目');
  const failures: ImageItemFailure[] = [];
  const pending: { image: ProviderImage; input: ConvertImageInput }[] = [];
  for (const image of images) {
    const format = sniffGeneratedImage(image.data);
    if (format === null) failures.push('image_invalid');
    else pending.push({ image, input: { kind: 'image', format, data: image.data } });
  }
  if (pending.length === 0) return { stored: [], failures };

  const objectStore = context.objectStore;
  const projectId = context.projectId;
  const results = await renderHtmlImages(context, pending.map((entry) => entry.input), options);
  const stored: StoredImage[] = [];
  try {
    for (const [position, result] of results.entries()) {
      if (result.status === 'failed') {
        failures.push(result.error === 'image_invalid' ? 'image_invalid' : 'render_failed');
        continue;
      }
      if (!(await inspectPng(result.png))) {
        failures.push('image_invalid');
        continue;
      }
      const name = `generated-${String(pending[position]!.image.index + 1).padStart(2, '0')}.png`;
      const artifact = await writeArtifact(context.db, context.tenant, objectStore, { kind: 'image', name, mime: 'image/png', projectId }, result.png);
      stored.push({ artifactId: artifact.id, width: result.width, height: result.height });
    }
  } catch (error) {
    // 写到一半失败（例如存储配额已满）：整批不收费，已写入的也作废。
    await supersedeArtifactsById(context.db, context.tenant, stored.map((image) => image.artifactId)).catch(() => 0);
    throw error;
  }
  return { stored, failures };
}

/** 丢弃本次入库的图片（同一步骤已有结果时）：标为已被替换，由清理任务删除。 */
export async function discardGeneratedImages(context: Pick<GeneratedImageStoreContext, 'db' | 'tenant'>, artifactIds: readonly string[]): Promise<void> {
  await supersedeArtifactsById(context.db, context.tenant, artifactIds);
}
