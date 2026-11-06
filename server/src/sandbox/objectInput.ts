// 从对象存储按需读取、放入沙箱的文件（路线图第 7 步 7.4e；整本导出的配图由 7.4f 的任务经它放入 export-document 沙箱）。
// 只在归档生成到这个条目时才发起读取，同一时刻至多一个对象在读（src/sandbox/archive.ts 的 createArchiveStream），
// 对象的内容按对象存储的分块原样转出，不在内存中缓存整个对象。
//
// - 大小由调用方给出（产物表中登记的 size），写进 tar 头部；对象存储返回的长度与它不同时不读取、直接失败；
//   实际读到的字节数与它不同时由 createArchiveStream 判定失败（file size mismatch），沙箱被终止；
// - 对象不存在（已被清理）时抛 ObjectInputError('missing')，copyIn 以 SANDBOX_INPUT_FAILED 失败、cause 为它；
// - 对象键只来自调用方（产物表的 storage_key），这里不拼接用户输入；错误信息不含对象键。
import type { ObjectStore } from '../files/objectStore.ts';
import type { SandboxStreamFile } from './archive.ts';

export type ObjectInputFailure = 'missing' | 'size mismatch';

/** 读取放入沙箱的对象失败。message 不含对象键。 */
export class ObjectInputError extends Error {
  readonly reason: ObjectInputFailure;

  constructor(reason: ObjectInputFailure) {
    super(`sandbox input object ${reason}`);
    this.name = 'ObjectInputError';
    this.reason = reason;
  }
}

export interface ObjectInput {
  /** 沙箱内的相对路径，例如 assets/<产物 id>。 */
  path: string;
  /** 对象键（产物表的 storage_key）。 */
  key: string;
  /** 登记的字节数。 */
  size: number;
}

/** 生成一个按需从对象存储读取的输入文件。 */
export function objectInputFile(store: Pick<ObjectStore, 'get'>, input: ObjectInput): SandboxStreamFile {
  const { path, key, size } = input;
  return Object.freeze({
    path,
    size,
    async open(signal?: AbortSignal) {
      signal?.throwIfAborted();
      const object = await store.get(key);
      if (!object) throw new ObjectInputError('missing');
      if (object.size !== null && object.size !== size) {
        object.body.destroy();
        throw new ObjectInputError('size mismatch');
      }
      if (signal?.aborted) {
        object.body.destroy();
        signal.throwIfAborted();
      }
      return object.body;
    },
  });
}
