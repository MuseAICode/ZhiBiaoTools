import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { StoredObject } from '../../src/files/objectStore.ts';
import { createArchiveStream, readArchive } from '../../src/sandbox/archive.ts';
import { ObjectInputError, objectInputFile } from '../../src/sandbox/objectInput.ts';
import { SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';

const limits = SANDBOX_TEMPLATES['export-document'].input;

function fakeStore(objects: Record<string, { data: Buffer; reportedSize?: number | null }>) {
  const gets: string[] = [];
  const bodies: Readable[] = [];
  return {
    gets,
    bodies,
    async get(key: string): Promise<StoredObject | null> {
      gets.push(key);
      const object = objects[key];
      if (!object) return null;
      const body = Readable.from([object.data.subarray(0, 7), object.data.subarray(7)]);
      bodies.push(body);
      return { body, size: object.reportedSize === undefined ? object.data.length : object.reportedSize };
    },
  };
}

describe('objectInputFile', () => {
  it('reads each object only when the archive reaches it', async () => {
    const store = fakeStore({ 'org/1/artifacts/a': { data: Buffer.from('first image bytes') }, 'org/1/artifacts/b': { data: Buffer.from('second'), reportedSize: null } });
    const files = [
      { path: 'request.json', data: Buffer.from('{}') },
      objectInputFile(store, { path: 'assets/a', key: 'org/1/artifacts/a', size: 17 }),
      objectInputFile(store, { path: 'assets/b', key: 'org/1/artifacts/b', size: 6 }),
    ];
    const stream = createArchiveStream(files, limits);
    expect(store.gets).toEqual([]);
    const read = await readArchive(stream.chunks, limits);
    expect(read.map((file) => [file.path, file.data.toString()])).toEqual([
      ['request.json', '{}'],
      ['assets/a', 'first image bytes'],
      ['assets/b', 'second'],
    ]);
    expect(store.gets).toEqual(['org/1/artifacts/a', 'org/1/artifacts/b']);
  });

  it('fails without reading when the object is missing or its stored length differs from the registered size', async () => {
    const store = fakeStore({ 'k/short': { data: Buffer.from('abc') } });
    const missing = objectInputFile(store, { path: 'assets/a', key: 'k/missing', size: 3 });
    await expect(missing.open()).rejects.toMatchObject({ name: 'ObjectInputError', reason: 'missing' });
    const mismatch = objectInputFile(store, { path: 'assets/a', key: 'k/short', size: 4 });
    const error = await mismatch.open().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ObjectInputError);
    expect((error as ObjectInputError).reason).toBe('size mismatch');
    expect((error as Error).message).not.toContain('k/short');
    expect(store.bodies[0]!.destroyed).toBe(true);
  });

  it('does not contact the store when already aborted, and releases a body fetched after the abort', async () => {
    const store = fakeStore({ k: { data: Buffer.from('abc') } });
    const file = objectInputFile(store, { path: 'assets/a', key: 'k', size: 3 });
    await expect(file.open(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.gets).toEqual([]);

    const controller = new AbortController();
    const slow = { ...store, get: async (key: string) => {
      const object = await store.get(key);
      controller.abort();
      return object;
    } };
    await expect(objectInputFile(slow, { path: 'assets/a', key: 'k', size: 3 }).open(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.bodies[0]!.destroyed).toBe(true);
  });
});
