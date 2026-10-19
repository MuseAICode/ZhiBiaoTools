// 对象存储集成测试的环境：每个测试文件新建一个独立的 bucket，结束时清空并删除。
// 需要 TEST_S3_ENDPOINT、TEST_S3_ACCESS_KEY_ID、TEST_S3_SECRET_ACCESS_KEY 指向一个 S3 兼容服务
// （CI 中是 SeaweedFS 容器，见 .github/workflows/ci.yml；本机可用 docker-compose.yml 的 s3 服务）。
import { randomBytes } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStorageConfig } from '../../src/config.ts';
import { createS3Client } from '../../src/files/objectStore.ts';

export interface TestBucket {
  readonly config: ObjectStorageConfig;
  readonly client: S3Client;
  /** bucket 中的全部对象键。 */
  keys(): Promise<string[]>;
  /** 尚未完成也未放弃的分片上传的对象键。 */
  pendingMultipartKeys(): Promise<string[]>;
  drop(): Promise<void>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`文件存储集成测试需要 ${name}（S3 兼容服务），例如 TEST_S3_ENDPOINT=http://127.0.0.1:8333`);
  }
  return value;
}

export async function createTestBucket(): Promise<TestBucket> {
  const config: ObjectStorageConfig = Object.freeze({
    endpoint: required('TEST_S3_ENDPOINT'),
    region: process.env.TEST_S3_REGION ?? 'us-east-1',
    bucket: `bidtools-test-${randomBytes(6).toString('hex')}`,
    forcePathStyle: true,
    accessKeyId: required('TEST_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('TEST_S3_SECRET_ACCESS_KEY'),
  });
  const client = createS3Client(config);
  await client.send(new CreateBucketCommand({ Bucket: config.bucket }));

  async function keys(): Promise<string[]> {
    const result: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, ContinuationToken: token }));
      for (const item of page.Contents ?? []) if (item.Key) result.push(item.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return result.sort();
  }

  async function pendingMultipartKeys(): Promise<string[]> {
    const page = await client.send(new ListMultipartUploadsCommand({ Bucket: config.bucket }));
    return (page.Uploads ?? []).map((upload) => upload.Key ?? '').sort();
  }

  return {
    config,
    client,
    keys,
    pendingMultipartKeys,
    async drop() {
      for (const key of await keys()) await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      await client.send(new DeleteBucketCommand({ Bucket: config.bucket }));
      client.destroy();
    },
  };
}
