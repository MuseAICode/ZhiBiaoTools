import { describe, expect, it } from 'vitest';
import type { RejectionCheckWorkspacePatch } from '../../../src/features/rejection-check/types';

// Electron IPC 用结构化克隆传参；WebBridge 以后经 HTTP / WebSocket 传 JSON。
// 这里固定两者的差异，作为 WebBridge 编解码设计的约束，避免迁移时静默改变语义。

const viaIpc = <T>(value: T): T => structuredClone(value);
const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

describe('bridge 参数序列化', () => {
  it('值为 undefined 的字段：IPC 保留键，JSON 丢失键', () => {
    const payload = { a: undefined, b: 1 };
    expect(hasOwn(viaIpc(payload), 'a')).toBe(true);
    expect(hasOwn(viaJson(payload), 'a')).toBe(false);
  });

  it('rejectionCheckStore 依赖 hasOwn 判断补丁字段：{ tenderDocument: undefined } 经 JSON 后从“清空”变成“不改”', () => {
    // 与 electron/services/rejectionCheckStore.cjs 的 updateState 判断一致：有这个键且值为假时清空招标文件。
    const clearsTender = (partial: RejectionCheckWorkspacePatch) => hasOwn(partial, 'tenderDocument') && !partial.tenderDocument;
    const patch: RejectionCheckWorkspacePatch = { tenderDocument: undefined };
    expect(clearsTender(viaIpc(patch))).toBe(true);
    expect(clearsTender(viaJson(patch))).toBe(false);
  });

  it('显式 null 在两种方式下都保留', () => {
    const payload = { tenderDocument: null };
    expect(viaIpc(payload)).toEqual({ tenderDocument: null });
    expect(viaJson(payload)).toEqual({ tenderDocument: null });
  });

  it('数组中的 undefined：IPC 保留，JSON 变成 null', () => {
    expect(viaIpc([1, undefined])).toEqual([1, undefined]);
    expect(viaJson([1, undefined])).toEqual([1, null]);
  });

  it('顶层 undefined 参数（例如 restart(reason?)）：JSON.stringify 返回 undefined，不是合法的 JSON 文本', () => {
    expect(viaIpc(undefined)).toBeUndefined();
    expect(JSON.stringify(undefined)).toBeUndefined();
  });

  it('Uint8Array（readContentWord、renderPreview 的 bytes）：IPC 保留类型，JSON 变成按下标的普通对象', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(viaIpc(bytes)).toBeInstanceOf(Uint8Array);
    expect(viaIpc(bytes)).toEqual(bytes);
    const decoded = viaJson(bytes) as unknown;
    expect(decoded).not.toBeInstanceOf(Uint8Array);
    expect(decoded).toEqual({ 0: 1, 1: 2, 2: 3 });
  });

  it('Date：IPC 保留类型，JSON 变成 ISO 字符串', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    expect(viaIpc({ at }).at).toBeInstanceOf(Date);
    expect(viaJson({ at }).at).toBe('2026-01-02T03:04:05.000Z');
  });
});
