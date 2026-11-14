import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createArchive, createArchiveStream, maxArchiveBytes, readArchive, SandboxArchiveError, validateArchiveStream } from '../../src/sandbox/archive.ts';
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

  // 8.1 登记的中文文件名要求（#71）：放宽规则随 8.5b；在此之前 agent 模板与其他模板一样只收 ASCII 路径段，
  // 非 ASCII 的名字（含借全角 / 兼容字符、零宽与双向控制字符、组合字符伪装的分隔符与 .、..）一律整体拒绝。
  it.each([
    ['任务/大纲.json'],
    ['所选模板配置.json'],
    ['a\uff0fb.md'], // 全角 ／
    ['a\u2215b.md'], // ∕ DIVISION SLASH
    ['a\uff3cb.md'], // 全角 ＼
    ['\uff0e\uff0e/x.md'], // 全角 ．．
    ['\u2024\u2024/x.md'], // ONE DOT LEADER
    ['x\u200b.md'], // 零宽空格
    ['x\u202e.md'], // RLO
    ['x\u2066.md'], // LRI
    ['e\u0301.md'], // NFD 组合字符
    ['\u00e9.md'], // NFC é
    ['x\ufeff.md'], // BOM
    ['x\ufffd.md'], // 非法 UTF-8 解码后的替换字符
  ])('agent 模板在 8.5b 之前拒绝非 ASCII 路径 %j', async (name) => {
    for (const limits of [SANDBOX_TEMPLATES.agent.output, SANDBOX_TEMPLATES.agent.input, output]) {
      expect(await rejectReason(tarStream(tarEntry({ name, data: Buffer.from('x') }), END_OF_ARCHIVE), limits)).toBe('path segment not allowed');
    }
  });

  it('非法 UTF-8 字节序列的路径同样被拒绝', async () => {
    const entry = tarEntry({ name: 'placeholder.md', data: Buffer.from('x') });
    Buffer.from([0x78, 0xc3, 0x28, 0x2e, 0x6d, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]).copy(entry, 0);
    // 重新计算校验和。
    entry.fill(0x20, 148, 156);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += entry[index]!;
    entry.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    expect(await rejectReason(tarStream(entry, END_OF_ARCHIVE), SANDBOX_TEMPLATES.agent.output)).toBe('path segment not allowed');
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

/** 收集 validateArchiveStream 产出的字节；被拒绝时返回原因和拒绝之前已产出的字节。 */
async function forward(source: AsyncIterable<Uint8Array>, limits: SandboxTransferLimits = input): Promise<{ bytes: Buffer; reason: string | null }> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of validateArchiveStream(source, limits)) chunks.push(chunk);
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxArchiveError);
    return { bytes: Buffer.concat(chunks), reason: (error as SandboxArchiveError).reason };
  }
  return { bytes: Buffer.concat(chunks), reason: null };
}

describe('validateArchiveStream', () => {
  const lenient: SandboxTransferLimits = { directory: '/input', maxDepth: 2, maxFiles: 8, maxFileBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024, extensions: null };

  it('forwards a valid archive byte for byte, in chunks no larger than the input chunks', async () => {
    const archive = createArchive(
      [
        { path: 'request.json', data: Buffer.from('{"a":1}') },
        { path: 'assets/a.png', data: Buffer.alloc(200_000, 3) },
        { path: 'assets/b.png', data: Buffer.alloc(512, 4) },
      ],
      SANDBOX_TEMPLATES['export-document'].input,
    );
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < archive.length; offset += 7_001) chunks.push(archive.subarray(offset, offset + 7_001));
    const { bytes, reason } = await forward(Readable.from(chunks), SANDBOX_TEMPLATES['export-document'].input);
    expect(reason).toBeNull();
    expect(bytes.equals(archive)).toBe(true);
    // 1 字节一块同样可以。
    const bytewise: Buffer[] = [...archive.subarray(0, 4096)].map((byte) => Buffer.from([byte]));
    bytewise.push(archive.subarray(4096));
    expect((await forward(Readable.from(bytewise), SANDBOX_TEMPLATES['export-document'].input)).bytes.equals(archive)).toBe(true);
  });

  it('forwards PAX and GNU long-name headers together with their entry and directories', async () => {
    const pax = paxEntry({ path: 'images/long-name.png' });
    const entry = tarEntry({ name: 'ignored.png', data: Buffer.from('png') });
    const dir = tarEntry({ name: 'images/', type: '5' });
    const { bytes, reason } = await forward(tarStream(dir, pax, entry, END_OF_ARCHIVE), lenient);
    expect(reason).toBeNull();
    expect(bytes.equals(Buffer.concat([dir, pax, entry, END_OF_ARCHIVE]))).toBe(true);
  });

  it('rejects with the same reasons as readArchive and never forwards the offending header', async () => {
    const good = tarEntry({ name: 'a.md', data: Buffer.from('ok') });
    const bad: Array<[Buffer[], string]> = [
      [[tarEntry({ name: 'x.md', type: '2', linkname: '/etc/passwd' })], 'symbolic link not allowed'],
      [[tarEntry({ name: 'x.md', type: '1', linkname: 'a.md' })], 'hard link not allowed'],
      [[tarEntry({ name: 'x.md', type: '3' })], 'device file not allowed'],
      [[tarEntry({ name: '../x.md', data: Buffer.from('x') })], 'path traversal'],
      [[tarEntry({ name: 'x.md', prefix: '..' })], 'path traversal'],
      [[paxEntry({ path: '../../x.md' }), tarEntry({ name: 'x.md' })], 'path traversal'],
      [[paxEntry({ linkpath: '/etc/passwd' }), tarEntry({ name: 'x.md' })], 'pax key not supported'],
      [[tarEntry({ name: '././@LongLink', type: 'L', data: Buffer.from('../x.md\0'), format: 'gnu' }), tarEntry({ name: 'x.md', format: 'gnu' })], 'path traversal'],
      [[tarEntry({ name: 'a.md' })], 'duplicate path'],
      [[tarEntry({ name: 'x.md', badChecksum: true })], 'header checksum mismatch'],
      [[tarEntry({ name: 'x.md', data: Buffer.alloc(1024 * 1024 + 1) })], 'file too large'],
    ];
    for (const [parts, expected] of bad) {
      const archive = Buffer.concat([good, ...parts, END_OF_ARCHIVE]);
      const { bytes, reason } = await forward(Readable.from([archive]), lenient);
      expect(reason).toBe(expected);
      expect(await rejectReason(Readable.from([archive]), lenient)).toBe(expected);
      // 下游只收到拒绝之前那个合规的条目，扩展头和不合规的头部都没有转出。
      expect(bytes.equals(good)).toBe(true);
    }
    // 被截断（没有结束块）：已转出的条目不带结束块，下游的 tar 收不到完整的归档。
    const truncated = await forward(tarStream(good), lenient);
    expect(truncated.reason).toBe('archive truncated');
    expect(truncated.bytes.equals(good)).toBe(true);
  });

  it('applies the template input rules', async () => {
    const exportInput = SANDBOX_TEMPLATES['export-document'].input;
    expect((await forward(tarStream(tarEntry({ name: 'x.md', data: Buffer.from('x') }), END_OF_ARCHIVE), output)).reason).toBe(null);
    expect((await forward(tarStream(tarEntry({ name: 'page.html', data: Buffer.from('x') }), END_OF_ARCHIVE), output)).reason).toBe('file extension not allowed');
    expect((await forward(tarStream(tarEntry({ name: 'assets/a/b.png', data: Buffer.from('x') }), END_OF_ARCHIVE), exportInput)).reason).toBe('path too deep');
    expect((await forward(tarStream(tarEntry({ name: 'a/b.docx', data: Buffer.from('x') }), END_OF_ARCHIVE))).reason).toBe('path too deep');
    const many = Array.from({ length: input.maxFiles + 1 }, (_, index) => tarEntry({ name: `f${index}.docx`, data: Buffer.from('x') }));
    expect((await forward(tarStream(...many, END_OF_ARCHIVE))).reason).toBe('too many files');
  });

  it('counts trailing data toward the byte limit and does not forward it', async () => {
    const archive = Buffer.concat([tarEntry({ name: 'a.md', data: Buffer.from('ok') }), END_OF_ARCHIVE]);
    const padded = await forward(Readable.from([archive, Buffer.alloc(9 * 1024), Buffer.from('junk')]), lenient);
    expect(padded.reason).toBeNull();
    expect(padded.bytes.equals(archive)).toBe(true);
    let produced = 0;
    async function* endless() {
      yield archive;
      for (;;) {
        produced += 65536;
        yield Buffer.alloc(65536);
      }
    }
    const tiny: SandboxTransferLimits = { ...lenient, maxFiles: 1, maxTotalBytes: 1024 };
    expect((await forward(endless(), tiny)).reason).toBe('archive too large');
    expect(produced).toBeLessThanOrEqual(maxArchiveBytes(tiny) + 65536);
  });

  it('reads the source lazily: a large file is forwarded in bounded chunks', async () => {
    const size = 64 * 1024 * 1024;
    const header = tarEntry({ name: 'big.docx', size, data: Buffer.alloc(0) }).subarray(0, 512);
    let pulled = 0;
    let largestChunk = 0;
    async function* source() {
      yield header;
      for (let sent = 0; sent < size; sent += 1024 * 1024) {
        pulled += 1;
        yield Buffer.alloc(1024 * 1024, 5);
      }
      yield END_OF_ARCHIVE;
    }
    let forwarded = 0;
    let maxAhead = 0;
    for await (const chunk of validateArchiveStream(source(), input)) {
      forwarded += chunk.length;
      largestChunk = Math.max(largestChunk, chunk.length);
      // 已从源流读入、尚未转出的字节不超过一块源数据。
      maxAhead = Math.max(maxAhead, pulled * 1024 * 1024 + 512 - forwarded);
    }
    expect(forwarded).toBe(512 + size + 1024);
    expect(largestChunk).toBeLessThanOrEqual(64 * 1024);
    expect(maxAhead).toBeLessThanOrEqual(1024 * 1024);
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

describe('createArchiveStream', () => {
  const exportInput = SANDBOX_TEMPLATES['export-document'].input;
  const collect = async (chunks: AsyncIterable<Buffer>) => {
    const parts: Buffer[] = [];
    for await (const chunk of chunks) parts.push(chunk);
    return Buffer.concat(parts);
  };
  /** 按需读取的文件：内容按 chunk 字节分块产出，记录打开与释放。 */
  function onDemand(path: string, data: Buffer, log: string[], chunk = 1000) {
    return {
      path,
      size: data.length,
      async open() {
        log.push(`open:${path}`);
        async function* source() {
          try {
            for (let offset = 0; offset < data.length; offset += chunk) yield data.subarray(offset, offset + chunk);
          } finally {
            log.push(`release:${path}`);
          }
        }
        return source();
      },
    };
  }

  it('produces exactly the bytes createArchive produces, with the declared length, opening sources lazily and in order', async () => {
    const memory = [
      { path: 'request.json', data: Buffer.from('{"html":"<p>正文</p>"}') },
      { path: 'assets/a', data: Buffer.alloc(1500, 1) },
      { path: 'assets/empty', data: Buffer.alloc(0) },
      { path: 'assets/b', data: Buffer.alloc(512, 2) },
      { path: 'assets/c', data: Buffer.alloc(70_001, 3) },
    ];
    const expected = createArchive(memory, exportInput);
    const log: string[] = [];
    const mixed = [memory[0]!, ...memory.slice(1).map((file) => onDemand(file.path, file.data, log))];
    const stream = createArchiveStream(mixed, exportInput);
    expect(stream.byteLength).toBe(expected.length);
    expect(log).toEqual([]);

    const seen: string[] = [];
    const parts: Buffer[] = [];
    for await (const chunk of stream.chunks) {
      seen.push(log.join(','));
      parts.push(chunk);
    }
    expect(Buffer.concat(parts).equals(expected)).toBe(true);
    // 每个源读完、释放之后才打开下一个。
    expect(log).toEqual(['assets/a', 'assets/empty', 'assets/b', 'assets/c'].flatMap((path) => [`open:${path}`, `release:${path}`]));
    expect(seen[0]).toBe('');
    expect(stream.failure).toBeUndefined();

    // 只有内存中的文件时与 createArchive 相同；结果能被 readArchive 与 validateArchiveStream 原样接受。
    expect((await collect(createArchiveStream(memory, exportInput).chunks)).equals(expected)).toBe(true);
    const files = await readArchive(Readable.from([expected]), exportInput);
    expect(files.map((file) => [file.path, file.data.length])).toEqual(memory.map((file) => [file.path, file.data.length]));
    expect((await collect(validateArchiveStream(Readable.from([expected]), exportInput))).equals(expected)).toBe(true);
  });

  it('validates every entry before producing a byte or opening a source', () => {
    const log: string[] = [];
    const cases: [unknown[], string][] = [
      [[onDemand('assets/a', Buffer.alloc(1), log), onDemand('assets/a', Buffer.alloc(1), log)], 'duplicate path'],
      [[onDemand('../a', Buffer.alloc(1), log)], 'path traversal'],
      [[onDemand('a/b/c', Buffer.alloc(1), log)], 'path too deep'],
      [[{ path: 'assets/a', size: -1, open: async () => [] }], 'file size invalid'],
      [[{ path: 'assets/a', size: Number.NaN, open: async () => [] }], 'file size invalid'],
      [[{ path: 'assets/a', size: exportInput.maxFileBytes + 1, open: async () => [] }], 'file too large'],
      [[{ path: 'assets/a', size: exportInput.maxFileBytes, open: async () => [] }, { path: 'assets/b', size: exportInput.maxTotalBytes - exportInput.maxFileBytes + 1, open: async () => [] }], 'archive too large'],
      [Array.from({ length: exportInput.maxFiles + 1 }, (_, index) => ({ path: `assets/${index}`, size: 0, open: async () => [] })), 'too many files'],
    ];
    for (const [files, reason] of cases) {
      let error: unknown;
      try {
        createArchiveStream(files as never, exportInput);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SandboxArchiveError);
      expect((error as SandboxArchiveError).reason).toBe(reason);
    }
    expect(log).toEqual([]);
  });

  it('fails with file size mismatch when a source yields more or fewer bytes than declared, releasing it', async () => {
    for (const actual of [999, 1001, 0, 5000]) {
      const log: string[] = [];
      const file = { ...onDemand('assets/a', Buffer.alloc(actual, 1), log), size: 1000 };
      const stream = createArchiveStream([file], exportInput);
      const error = await collect(stream.chunks).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SandboxArchiveError);
      expect((error as SandboxArchiveError).reason).toBe('file size mismatch');
      expect(stream.failure).toBe(error);
      expect(log).toEqual(['open:assets/a', 'release:assets/a']);
    }
  });

  it('passes source errors through, records them, and releases the source when the consumer stops early', async () => {
    const broken = createArchiveStream([{ path: 'assets/a', size: 10, open: async () => Promise.reject(new Error('missing object')) }], exportInput);
    await expect(collect(broken.chunks)).rejects.toThrow('missing object');
    expect((broken.failure as Error).message).toBe('missing object');

    const log: string[] = [];
    const stream = createArchiveStream([onDemand('assets/a', Buffer.alloc(10_000, 1), log), onDemand('assets/b', Buffer.alloc(10, 1), log)], exportInput);
    let chunks = 0;
    for await (const _chunk of stream.chunks) {
      chunks += 1;
      if (chunks === 3) break;
    }
    expect(log).toEqual(['open:assets/a', 'release:assets/a']);
    expect(stream.failure).toBeUndefined();
    // 只能迭代一次。
    await expect(collect(stream.chunks)).rejects.toThrow('only be consumed once');
  });

  it('stops before opening anything when aborted, and destroys a Readable source that is waiting for data', async () => {
    const log: string[] = [];
    const aborted = createArchiveStream([onDemand('assets/a', Buffer.alloc(10), log)], exportInput, { signal: AbortSignal.abort() });
    await expect(collect(aborted.chunks)).rejects.toMatchObject({ name: 'AbortError' });
    expect(log).toEqual([]);

    const controller = new AbortController();
    const stalled = new Readable({ read() {} });
    stalled.push(Buffer.alloc(100));
    const stream = createArchiveStream([{ path: 'assets/a', size: 1000, open: async () => stalled }], exportInput, { signal: controller.signal });
    const consumed = collect(stream.chunks).then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect(await consumed).not.toBeNull();
    expect(stalled.destroyed).toBe(true);
  });
});
