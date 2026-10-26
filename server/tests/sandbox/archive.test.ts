import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createArchive, readArchive, SandboxArchiveError } from '../../src/sandbox/archive.ts';
import { SANDBOX_TEMPLATES, type SandboxTransferLimits } from '../../src/sandbox/templates.ts';
import { END_OF_ARCHIVE, paxEntry, tarEntry, tarStream } from './tarFixtures.ts';

const output = SANDBOX_TEMPLATES.parse.output;
const input = SANDBOX_TEMPLATES.parse.input;

async function rejectReason(stream: Readable, limits: SandboxTransferLimits = output): Promise<string> {
  try {
    await readArchive(stream, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxArchiveError);
    return (error as SandboxArchiveError).reason;
  }
  throw new Error('archive was accepted');
}

describe('readArchive', () => {
  it('accepts regular files and directories, normalizing ./ prefixes', async () => {
    const files = await readArchive(
      tarStream(
        tarEntry({ name: './', type: '5', format: 'gnu' }),
        tarEntry({ name: './content.md', data: Buffer.from('# 标题'), format: 'gnu' }),
        tarEntry({ name: './images/', type: '5', format: 'gnu' }),
        tarEntry({ name: './images/image-001.png', data: Buffer.from([0x89, 0x50]), format: 'gnu' }),
        END_OF_ARCHIVE,
      ),
      output,
    );
    expect(files.map((file) => file.path)).toEqual(['content.md', 'images/image-001.png']);
    expect(files[0]!.data.toString('utf8')).toBe('# 标题');
  });

  it('round-trips archives created by createArchive', async () => {
    const archive = createArchive([{ path: 'original.docx', data: Buffer.alloc(1500, 7) }], input);
    const files = await readArchive(Readable.from([archive]), input);
    expect(files).toHaveLength(1);
    expect(files[0]!.data.equals(Buffer.alloc(1500, 7))).toBe(true);
  });

  it('reads chunked streams', async () => {
    const archive = Buffer.concat([tarEntry({ name: 'a.md', data: Buffer.alloc(3000, 1) }), END_OF_ARCHIVE]);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < archive.length; offset += 7) chunks.push(archive.subarray(offset, offset + 7));
    const files = await readArchive(Readable.from(chunks), output);
    expect(files[0]!.data.length).toBe(3000);
  });

  it.each([
    ['1', 'hard link not allowed'],
    ['2', 'symbolic link not allowed'],
    ['3', 'device file not allowed'],
    ['4', 'device file not allowed'],
    ['6', 'fifo not allowed'],
    ['S', 'entry type not allowed'],
    ['K', 'entry type not allowed'],
    ['g', 'entry type not allowed'],
  ])('rejects entries of type %s', async (type, reason) => {
    expect(await rejectReason(tarStream(tarEntry({ name: 'x.md', type, linkname: '/etc/passwd' }), END_OF_ARCHIVE))).toBe(reason);
  });

  it.each([
    ['../escape.md', 'path traversal'],
    ['images/../../escape.md', 'path traversal'],
    ['/etc/cron.d/x.md', 'absolute path'],
    ['a\\b.md', 'path segment not allowed'],
    ['.hidden.md', 'path segment not allowed'],
    ['a//b.md', 'path segment not allowed'],
    ['a/b/c.png', 'path too deep'],
    ['page.html', 'file extension not allowed'],
    ['image.svg', 'file extension not allowed'],
    ['noextension', 'file extension not allowed'],
    ['bad\u0001name.md', 'path segment not allowed'],
  ])('rejects the path %j', async (name, reason) => {
    expect(await rejectReason(tarStream(tarEntry({ name, data: Buffer.from('x') }), END_OF_ARCHIVE))).toBe(reason);
  });

  it('rejects traversal hidden in the ustar prefix, a PAX path or a GNU long name', async () => {
    expect(await rejectReason(tarStream(tarEntry({ name: 'x.md', prefix: '..' }), END_OF_ARCHIVE))).toBe('path traversal');
    expect(await rejectReason(tarStream(paxEntry({ path: '../../x.md' }), tarEntry({ name: 'x.md' }), END_OF_ARCHIVE))).toBe('path traversal');
    expect(
      await rejectReason(tarStream(tarEntry({ name: '././@LongLink', type: 'L', data: Buffer.from('../x.md\0'), format: 'gnu' }), tarEntry({ name: 'x.md', format: 'gnu' }), END_OF_ARCHIVE)),
    ).toBe('path traversal');
  });

  it('uses the PAX path and rejects PAX keys that change the entry', async () => {
    const files = await readArchive(tarStream(paxEntry({ mtime: '1.5', path: 'images/long-name.png' }), tarEntry({ name: 'ignored.png' }), END_OF_ARCHIVE), output);
    expect(files.map((file) => file.path)).toEqual(['images/long-name.png']);
    expect(await rejectReason(tarStream(paxEntry({ size: '10' }), tarEntry({ name: 'x.md' }), END_OF_ARCHIVE))).toBe('pax key not supported');
    expect(await rejectReason(tarStream(paxEntry({ linkpath: '/etc/passwd' }), tarEntry({ name: 'x.md' }), END_OF_ARCHIVE))).toBe('pax key not supported');
    expect(await rejectReason(tarStream(paxEntry({ path: 'a.md' }), END_OF_ARCHIVE))).toBe('extended header without entry');
  });

  it('rejects duplicate paths, bad checksums, truncated archives and base-256 sizes', async () => {
    expect(await rejectReason(tarStream(tarEntry({ name: 'a.md' }), tarEntry({ name: './a.md' }), END_OF_ARCHIVE))).toBe('duplicate path');
    expect(await rejectReason(tarStream(tarEntry({ name: 'a.md', badChecksum: true }), END_OF_ARCHIVE))).toBe('header checksum mismatch');
    expect(await rejectReason(tarStream(tarEntry({ name: 'a.md', data: Buffer.from('x') })))).toBe('archive truncated');
    expect(await rejectReason(tarStream(tarEntry({ name: 'a.md', size: 4096, data: Buffer.alloc(10) }), END_OF_ARCHIVE))).toBe('archive truncated');
    const base256 = Buffer.alloc(12);
    base256[0] = 0x80;
    base256[11] = 1;
    expect(await rejectReason(tarStream(tarEntry({ name: 'a.md', rawSize: base256 }), END_OF_ARCHIVE))).toBe('size field not supported');
  });

  it('enforces the file count, file size and total size limits', async () => {
    const small: SandboxTransferLimits = { directory: '/output', maxDepth: 2, maxFiles: 2, maxFileBytes: 100, maxTotalBytes: 150, extensions: null };
    const entry = (name: string, size: number) => tarEntry({ name, data: Buffer.alloc(size) });
    expect(await rejectReason(tarStream(entry('a', 1), entry('b', 1), entry('c', 1), END_OF_ARCHIVE), small)).toBe('too many files');
    expect(await rejectReason(tarStream(entry('a', 101), END_OF_ARCHIVE), small)).toBe('file too large');
    expect(await rejectReason(tarStream(entry('a', 100), entry('b', 100), END_OF_ARCHIVE), small)).toBe('archive too large');
    // 大量目录条目同样受限。
    const dirs = Array.from({ length: 30 }, (_, index) => tarEntry({ name: `d${index}/`, type: '5' }));
    expect(await rejectReason(tarStream(...dirs, END_OF_ARCHIVE), small)).toBe('too many entries');
  });

  it('rejects directories with data and stops reading after the first bad header', async () => {
    expect(await rejectReason(tarStream(tarEntry({ name: 'd/', type: '5', size: 1024 * 1024 * 1024 }), END_OF_ARCHIVE))).toBe('malformed header');
    let produced = 0;
    async function* garbage() {
      yield tarEntry({ name: 'a.md', data: Buffer.alloc(5) });
      for (;;) {
        produced += 65536;
        yield Buffer.alloc(65536, 1);
      }
    }
    expect(await rejectReason(Readable.from(garbage()))).toBe('malformed header');
    expect(produced).toBeLessThan(1024 * 1024);
  });
});

describe('createArchive', () => {
  it('validates input paths and limits', () => {
    expect(() => createArchive([{ path: '../x', data: Buffer.alloc(1) }], input)).toThrow(SandboxArchiveError);
    expect(() => createArchive([{ path: 'dir/x.docx', data: Buffer.alloc(1) }], input)).toThrow(SandboxArchiveError);
    expect(() => createArchive([{ path: 'a', data: Buffer.alloc(1) }, { path: 'a', data: Buffer.alloc(1) }], input)).toThrow(SandboxArchiveError);
    expect(() => createArchive(Array.from({ length: 5 }, (_, index) => ({ path: `f${index}`, data: Buffer.alloc(1) })), input)).toThrow(SandboxArchiveError);
  });
});
