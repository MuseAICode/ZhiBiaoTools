// zipGuard.mjs 的类型声明，供宿主上的单元测试（server/tests/sandbox/zipGuard.test.ts）使用。
export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxRatio: number;
  readonly ratioMinBytes: number;
}
export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}
export declare const ZIP_LIMITS: ZipLimits;
export declare class ZipGuardError extends Error {
  readonly code: 'zip_invalid' | 'zip_too_many_entries' | 'zip_too_large' | 'zip_ratio';
}
export declare function readZipEntries(buffer: Buffer, limits?: ZipLimits): ZipEntry[];
export declare function assertSafeZip(buffer: Buffer, limits?: ZipLimits): Promise<ZipEntry[]>;
