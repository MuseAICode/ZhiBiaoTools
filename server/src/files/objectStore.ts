// 对象存储（docs/SERVER_DESIGN.md 第 1、6.3 节）：只依赖 S3 API，云厂商待定（香港节点，与 KMS 同一家）；
// 开发环境和 CI 用本地的 SeaweedFS（docker-compose.yml）。
//
// - bucket 私有，对象键由 files 表的生成列给出（'org/{orgId}/files/{fileId}'），这里不拼接用户输入；
// - 上传是流式的（lib-storage 的分片上传），不整体读入内存；中止或出错时放弃分片上传，不留下对象；
// - 凭据只在本模块使用，不写日志；SDK 不读取环境变量、配置文件或实例元数据中的其他凭据。
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, NoSuchKey, NotFound, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';
import type { ObjectStorageConfig } from '../config.ts';

export interface StoredObject {
  body: Readable;
  size: number | null;
}

export interface ObjectStore {
  /** 写入对象；signal 中止时放弃上传，不留下对象。body 出错时同样拒绝。 */
  put(key: string, body: Readable, options: { contentType: string; signal?: AbortSignal }): Promise<void>;
  /** 读取对象；不存在时返回 null。 */
  get(key: string): Promise<StoredObject | null>;
  /** 是否存在（测试与清理用）。 */
  exists(key: string): Promise<boolean>;
  /** 删除对象；不存在不报错。 */
  delete(key: string): Promise<void>;
}

/** 分片大小和并发：单个上传最多占用约 partSize × (queueSize + 1) 的内存。 */
const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 2;

export function createS3Client(config: ObjectStorageConfig): S3Client {
  return new S3Client({
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // 只在接口要求时计算校验和：多家 S3 兼容服务不支持 SDK 默认的 aws-chunked 尾部校验和。
    // 内容完整性由上传时计算的 SHA-256（files.sha256）保证。
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
  });
}

function isNotFound(error: unknown): boolean {
  if (error instanceof NoSuchKey || error instanceof NotFound) return true;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return status === 404;
}

export function createS3ObjectStore(config: ObjectStorageConfig, client: S3Client = createS3Client(config)): ObjectStore {
  const bucket = config.bucket;
  return {
    async put(key, body, options) {
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: body, ContentType: options.contentType },
        partSize: PART_SIZE,
        queueSize: QUEUE_SIZE,
        leavePartsOnError: false,
      });
      const signal = options.signal;
      const abort = () => void upload.abort().catch(() => {});
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
      // body 出错时 Upload 不一定立即察觉（它在等下一块数据），这里同样放弃上传。
      body.once('error', abort);
      try {
        await upload.done();
      } finally {
        signal?.removeEventListener('abort', abort);
        body.off('error', abort);
      }
    },

    async get(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!result.Body) return null;
        return { body: result.Body as Readable, size: result.ContentLength ?? null };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
