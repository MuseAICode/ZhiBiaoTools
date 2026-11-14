// agent 工作区的中文路径规则（路线图 8.5b，#71 登记）与工作区快照的重写（rewriteArchiveStream）。
// 1. 正常的中文文件名（桌面版工作区的“任务/*.json”“所选模板配置.json”等）在 agent 模板下放入与取回都通过，parse / export 仍只收 ASCII；
// 2. 每一种绕过方式都被拒绝：全角 / 兼容形式的 / \ .、零宽与双向控制字符、BOM、组合字符（NFD）、空白、默认可忽略字符、
//    NFKC 后成为 . 开头、规范化与大小写折叠后的同名、按 UTF-8 字节超长、放不进 ustar 的 prefix + name；
// 3. 重写：只产出普通文件、头部重新生成、不带扩展头，与 createArchive 生成的字节相同；恶意样本（符号链接、硬链接、设备文件、FIFO、
//    ../、超大、超数、扩展名、文件与目录冲突）整体拒绝，且下游收不到结束块；源在结尾处出错时同样收不到结束块。
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createArchive, readArchive, rewriteArchiveStream, SandboxArchiveError, validateArchiveStream } from '../../src/sandbox/archive.ts';
import { SANDBOX_TEMPLATES, type SandboxTransferLimits } from '../../src/sandbox/templates.ts';
import { END_OF_ARCHIVE, paxEntry, tarEntry, tarStream } from './tarFixtures.ts';

const agentOutput = SANDBOX_TEMPLATES.agent.output;
const agentInput = SANDBOX_TEMPLATES.agent.input;
const parseOutput = SANDBOX_TEMPLATES.parse.output;

async function rejectReason(stream: Readable, limits: SandboxTransferLimits): Promise<string> {
  try {
    await readArchive(stream, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxArchiveError);
    return (error as SandboxArchiveError).reason;
  }
  throw new Error('archive was accepted');
}

/** 用 PAX 头带路径（GNU tar 对超过 100 字节的名字用 GNU 长名，posix 格式用 PAX；两者都要覆盖）。 */
function paxFile(path: string, data = Buffer.from('x')): Buffer {
  return Buffer.concat([paxEntry({ path }), tarEntry({ name: 'ignored', data })]);
}

function gnuFile(path: string, data = Buffer.from('x')): Buffer {
  return Buffer.concat([
    tarEntry({ name: '././@LongLink', type: 'L', data: Buffer.from(`${path}\0`, 'utf8'), format: 'gnu' }),
    tarEntry({ name: 'ignored', data, format: 'gnu' }),
  ]);
}

const CHINESE_NAMES = [
  '任务/大纲.json',
  '所选模板配置.json',
  '任务/第1章-概述.md',
  '底稿/技术方案（初稿）.md',
  '底稿/【附件】《说明》、第二版·终稿.md',
  'images/图1.png',
  'été.md', // NFC 的 é
  '〇一二.txt',
  'pi-sessions/2026-11-14T10-00-00-000Z_0f8e.jsonl',
];

describe('unicode 路径段（agent 工作区）', () => {
  it.each(CHINESE_NAMES)('接受 %j（ustar、PAX、GNU 长名三种写法）', async (name) => {
    const data = Buffer.from('内容');
    for (const entry of [tarEntry({ name, data }), paxFile(name, data), gnuFile(name, data)]) {
      for (const limits of [agentOutput, agentInput]) {
        const files = await readArchive(tarStream(entry, END_OF_ARCHIVE), limits);
        expect(files.map((file) => file.path)).toEqual([name]);
        expect(files[0]!.data.equals(data)).toBe(true);
      }
    }
  });

  it('GNU 长名修饰的条目不解码头部的 name 字段（GNU tar 只放前 100 个字节，可能截断在多字节字符中间）', async () => {
    const path = `底稿1/${'很长的中文目录名'.repeat(4)}/第一章.md`;
    const truncated = Buffer.from(path).subarray(0, 100);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(truncated)).toThrow();
    const header = tarEntry({ name: 'x', data: Buffer.from('x'), format: 'gnu' });
    header.fill(0, 0, 100);
    truncated.copy(header, 0);
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += header[index]!;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    const longLink = tarEntry({ name: '././@LongLink', type: 'L', data: Buffer.from(`${path}\0`), format: 'gnu' });
    const files = await readArchive(tarStream(longLink, header, END_OF_ARCHIVE), agentOutput);
    expect(files.map((file) => file.path)).toEqual([path]);
    // 对照组：没有长名时同一个截断的 name 字段按非法 UTF-8 拒绝。
    expect(await rejectReason(tarStream(header, END_OF_ARCHIVE), agentOutput)).toBe('path encoding invalid');
  });

  it('parse / export 模板仍只收 ASCII 路径段', async () => {
    for (const limits of [parseOutput, SANDBOX_TEMPLATES['export-document'].input, SANDBOX_TEMPLATES['export-preview'].output]) {
      expect(await rejectReason(tarStream(tarEntry({ name: '大纲.md', data: Buffer.from('x') }), END_OF_ARCHIVE), limits)).toBe('path segment not allowed');
    }
  });

  it.each([
    ['a／b.md', '全角 ／'],
    ['a∕b.md', 'DIVISION SLASH'],
    ['a⁄b.md', 'FRACTION SLASH'],
    ['a＼b.md', '全角 ＼'],
    ['a﹨b.md', 'SMALL REVERSE SOLIDUS'],
    ['．．/x.md', '全角 ．．'],
    ['．/x.md', '全角 ．'],
    ['․․/x.md', 'ONE DOT LEADER'],
    ['‥/x.md', 'TWO DOT LEADER'],
    ['﹒﹒/x.md', 'SMALL FULL STOP'],
    ['．hidden.md', '全角 ． 开头'],
    ['x​.md', '零宽空格'],
    ['x‌.md', 'ZWNJ'],
    ['x‍.md', 'ZWJ'],
    ['x‎.md', 'LRM'],
    ['x‏.md', 'RLM'],
    ['x‪.md', 'LRE'],
    ['x‮.md', 'RLO'],
    ['x⁦.md', 'LRI'],
    ['x⁩.md', 'PDI'],
    ['x⁠.md', 'WORD JOINER'],
    ['x­.md', 'SOFT HYPHEN'],
    ['x﻿.md', 'BOM'],
    ['﻿x.md', '开头的 BOM'],
    ['xㅤ.md', 'HANGUL FILLER（字母类但默认可忽略）'],
    ['x͏.md', 'COMBINING GRAPHEME JOINER'],
    ['a b.md', 'ASCII 空格'],
    ['a　b.md', '全角空格'],
    ['a b.md', 'NBSP'],
    ['a b.md', 'LINE SEPARATOR'],
    ['a\u0085b.md', 'NEL'],
    ['a\u007fb.md', 'DEL'],
    ['ab.md', '私用区'],
    ['a͸b.md', '未分配'],
    ['a̸b.md', '组合字符（叠加斜线）'],
    ['x�.md', '替换字符'],
    ['a*b.md', 'ASCII 符号'],
    ['a:b.md', '冒号'],
    ['-x.md', '以 - 开头'],
    ['.x.md', '以 . 开头'],
    ['、x.md', '以顿号开头'],
    ['）x.md', '以右括号开头'],
    ['(x).md', '以 ASCII 括号开头'],
    ['⒈.md', 'NFKC 后成为 1.（数字类）——允许'],
  ])('拒绝 %j（%s）', async (name, label) => {
    const run = async () => rejectReason(tarStream(tarEntry({ name, data: Buffer.from('x') }), END_OF_ARCHIVE), agentOutput);
    if (label.endsWith('允许')) {
      // ⒈（U+2488）NFKC 后是“1.”，不是分隔符、不以 . 开头，按数字接受：确认 NFKC 检查只拦分隔符与 .。
      await expect(readArchive(tarStream(tarEntry({ name, data: Buffer.from('x') }), END_OF_ARCHIVE), agentOutput)).resolves.toHaveLength(1);
      return;
    }
    expect(await run()).toBe('path segment not allowed');
    // PAX 与 GNU 长名中的同一路径同样被拒绝。
    expect(await rejectReason(tarStream(paxFile(name), END_OF_ARCHIVE), agentOutput)).toBe('path segment not allowed');
    expect(await rejectReason(tarStream(gnuFile(name), END_OF_ARCHIVE), agentOutput)).toBe('path segment not allowed');
  });

  it('拒绝未经 NFC 规范化的路径（组合字符）', async () => {
    for (const name of ['é.md', '任务/é.json', 'Å.md']) {
      expect(await rejectReason(tarStream(tarEntry({ name, data: Buffer.from('x') }), END_OF_ARCHIVE), agentOutput)).toBe('path not normalized');
    }
  });

  it('., .. 与绝对路径照常拒绝', async () => {
    expect(await rejectReason(tarStream(tarEntry({ name: '任务/../../x.md' }), END_OF_ARCHIVE), agentOutput)).toBe('path traversal');
    expect(await rejectReason(tarStream(paxFile('../任务.md'), END_OF_ARCHIVE), agentOutput)).toBe('path traversal');
    expect(await rejectReason(tarStream(gnuFile('/任务.md'), END_OF_ARCHIVE), agentOutput)).toBe('absolute path');
    expect(await rejectReason(tarStream(tarEntry({ name: '任务\\x.md' }), END_OF_ARCHIVE), agentOutput)).toBe('path segment not allowed');
  });

  it('规范化与大小写折叠后的同名一律按重复拒绝', async () => {
    const pairs: Array<[string, string]> = [
      ['README.md', 'readme.md'],
      ['Ａ.md', 'A.md'], // 全角 Ａ
      ['ａ.md', 'A.md'],
      ['straße.md', 'STRASSE.md'], // ß 折叠为 ss
      ['任务/A.json', '任务/a.json'],
      ['①.md', '1.md'], // ① 与 1
      ['ﬁle.md', 'file.md'], // ﬁ 连字
    ];
    for (const [first, second] of pairs) {
      const archive = tarStream(tarEntry({ name: first, data: Buffer.from('1') }), tarEntry({ name: second, data: Buffer.from('2') }), END_OF_ARCHIVE);
      expect(await rejectReason(archive, agentOutput)).toBe('duplicate path');
      // 对照组：ascii 规则（parse）下大小写不同的 ASCII 名字是两个文件。
    }
    const ascii = await readArchive(tarStream(tarEntry({ name: 'README.md' }), tarEntry({ name: 'readme.md' }), END_OF_ARCHIVE), parseOutput);
    expect(ascii).toHaveLength(2);
    // 目录名大小写不同、文件名不同：不是重复。
    const distinct = await readArchive(tarStream(tarEntry({ name: '任务/a.json' }), tarEntry({ name: '任务/b.json' }), END_OF_ARCHIVE), agentOutput);
    expect(distinct).toHaveLength(2);
  });

  it('一个路径不能既是文件又是目录（含大小写折叠后）', async () => {
    const cases: Buffer[][] = [
      [tarEntry({ name: '任务' }), tarEntry({ name: '任务/a.json' })],
      [tarEntry({ name: '任务/a.json' }), tarEntry({ name: '任务' })],
      [tarEntry({ name: '任务/', type: '5' }), tarEntry({ name: '任务' })],
      [tarEntry({ name: 'Docs' }), tarEntry({ name: 'docs/a.md' })],
    ];
    const lenient: SandboxTransferLimits = { ...agentOutput, extensions: null };
    for (const parts of cases) expect(await rejectReason(tarStream(...parts, END_OF_ARCHIVE), lenient)).toBe('path conflict');
    // ascii 规则同样检查冲突。
    expect(await rejectReason(tarStream(tarEntry({ name: 'a' }), tarEntry({ name: 'a/b' }), END_OF_ARCHIVE), { ...parseOutput, maxDepth: 3, extensions: null })).toBe('path conflict');
  });

  it('段与整条路径按 UTF-8 字节限长，且必须能写进 ustar 的 prefix + name', async () => {
    const lenient: SandboxTransferLimits = { ...agentOutput, extensions: null };
    // 段：33 个汉字 = 99 字节可以，34 个 = 102 字节不行。
    const ok = '汉'.repeat(33);
    expect(await readArchive(tarStream(gnuFile(ok)), lenient).catch((error) => error)).toBeInstanceOf(SandboxArchiveError); // 没有结束块
    expect(await readArchive(tarStream(gnuFile(ok), END_OF_ARCHIVE), lenient)).toHaveLength(1);
    expect(await rejectReason(tarStream(gnuFile('汉'.repeat(34)), END_OF_ARCHIVE), lenient)).toBe('path too long');
    // 中间的段同样限长（它能放进 155 字节的 prefix，只靠 ustar 拆分挡不住）。
    expect(await rejectReason(tarStream(gnuFile(`${'汉'.repeat(34)}/a.md`), END_OF_ARCHIVE), lenient)).toBe('path too long');
    // 整条路径：75 + 75 + 99 字节的三段（251 字节，prefix 151 + name 99）可以；超过 255 字节不行。
    const s75 = '汉'.repeat(25);
    expect(await readArchive(tarStream(gnuFile(`${s75}/${s75}/${ok}`), END_OF_ARCHIVE), lenient)).toHaveLength(1);
    const over = `${s75}/${s75}/${s75}/${'a'.repeat(33)}`;
    expect(Buffer.byteLength(over)).toBeGreaterThan(255);
    expect(await rejectReason(tarStream(gnuFile(over), END_OF_ARCHIVE), lenient)).toBe('path too long');
    // 255 字节以内、但放不进 prefix（155）+ name（100）：最后一段 1 字节、前一段 99 字节、再前一段 99 字节 → prefix 至少 199 字节。
    const long = '汉'.repeat(33);
    const unsplittable = `${long}/${long}/a`;
    expect(Buffer.byteLength(unsplittable)).toBeLessThanOrEqual(255);
    expect(await rejectReason(tarStream(gnuFile(unsplittable), END_OF_ARCHIVE), lenient)).toBe('path too long');
  });

  it('createArchive 把超过 100 字节的中文路径写进 prefix + name，可以原样读回', async () => {
    const path = `${'汉'.repeat(30)}/${'字'.repeat(30)}.md`;
    expect(Buffer.byteLength(path)).toBeGreaterThan(100);
    const archive = createArchive([{ path, data: Buffer.from('正文') }], agentInput);
    // 不带扩展头：第一个头部就是普通文件。
    expect(String.fromCharCode(archive[156]!)).toBe('0');
    const files = await readArchive(Readable.from([archive]), agentOutput);
    expect(files.map((file) => file.path)).toEqual([path]);
    // ascii 规则不变：超过 100 字节的路径不放入。
    expect(() => createArchive([{ path: `${'a'.repeat(60)}/${'b'.repeat(60)}`, data: Buffer.alloc(1) }], SANDBOX_TEMPLATES.parse.input)).toThrow(SandboxArchiveError);
  });
});

async function collect(source: AsyncIterable<Buffer>): Promise<{ bytes: Buffer; error: unknown }> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of source) chunks.push(chunk);
  } catch (error) {
    return { bytes: Buffer.concat(chunks), error };
  }
  return { bytes: Buffer.concat(chunks), error: null };
}

describe('rewriteArchiveStream', () => {
  it('只用普通文件重新生成归档：与 createArchive 的字节相同，目录与扩展头不转出，结束块之后的数据丢弃', async () => {
    const big = Buffer.alloc(200_000, 7);
    const source = Readable.from([
      Buffer.concat([
        tarEntry({ name: './', type: '5', format: 'gnu' }),
        tarEntry({ name: './任务/', type: '5', format: 'gnu' }),
        gnuFile('./任务/大纲.json', Buffer.from('{"a":1}')),
        paxFile('所选模板配置.json', Buffer.from('{}')),
        tarEntry({ name: './images/a.png', data: big, format: 'gnu' }),
        tarEntry({ name: 'empty.txt' }),
        END_OF_ARCHIVE,
        Buffer.alloc(9 * 1024),
      ]),
    ]);
    const rewritten = rewriteArchiveStream(source, agentOutput);
    expect(() => rewritten.fileCount).toThrow();
    const { bytes, error } = await collect(rewritten.chunks);
    expect(error).toBeNull();
    expect(rewritten.fileCount).toBe(4);
    const expected = createArchive(
      [
        { path: '任务/大纲.json', data: Buffer.from('{"a":1}') },
        { path: '所选模板配置.json', data: Buffer.from('{}') },
        { path: 'images/a.png', data: big },
        { path: 'empty.txt', data: Buffer.alloc(0) },
      ],
      agentInput,
    );
    expect(bytes.equals(expected)).toBe(true);
    // 重新生成的归档同样通过放入规则（sandbox-runner 的 validateArchiveStream）。
    const forwarded: Buffer[] = [];
    for await (const chunk of validateArchiveStream(Readable.from([bytes]), agentInput)) forwarded.push(chunk);
    expect(Buffer.concat(forwarded).equals(bytes)).toBe(true);
    // 只能迭代一次。
    await expect(collect(rewritten.chunks).then((result) => result.error)).resolves.toBeInstanceOf(Error);
  });

  it('权限、属主与时间由这里重新生成，不沿用沙箱中的头部', async () => {
    const entry = tarEntry({ name: 'a.md', data: Buffer.from('x') });
    entry.write('0004755\0', 100, 8, 'ascii'); // setuid
    entry.write('0001750\0', 108, 8, 'ascii');
    entry.write('17777777777\0', 136, 12, 'ascii');
    entry.fill(0x20, 148, 156);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += entry[index]!;
    entry.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    const { bytes } = await collect(rewriteArchiveStream(tarStream(entry, END_OF_ARCHIVE), agentOutput).chunks);
    expect(bytes.subarray(100, 108).toString('ascii')).toBe('0000600\0');
    expect(bytes.subarray(108, 116).toString('ascii')).toBe('0000000\0');
    expect(bytes.subarray(136, 148).toString('ascii')).toBe('00000000000\0');
  });

  it.each<[string, () => Buffer[], string, SandboxTransferLimits?, number?]>([
    ['符号链接', () => [tarEntry({ name: 'x.md', type: '2', linkname: '/etc/passwd' })], 'symbolic link not allowed'],
    ['指向工作区外的硬链接', () => [tarEntry({ name: 'x.md', type: '1', linkname: '../../etc/passwd' })], 'hard link not allowed'],
    ['字符设备', () => [tarEntry({ name: 'x.md', type: '3' })], 'device file not allowed'],
    ['块设备', () => [tarEntry({ name: 'x.md', type: '4' })], 'device file not allowed'],
    ['FIFO', () => [tarEntry({ name: 'x.md', type: '6' })], 'fifo not allowed'],
    ['GNU 稀疏文件', () => [tarEntry({ name: 'x.md', type: 'S' })], 'entry type not allowed'],
    ['../ 穿越', () => [tarEntry({ name: '任务/../../x.md', data: Buffer.from('x') })], 'path traversal'],
    ['PAX 路径穿越', () => [paxFile('../../x.md')], 'path traversal'],
    ['GNU 长名穿越', () => [gnuFile('任务/../../x.md')], 'path traversal'],
    ['绝对路径', () => [tarEntry({ name: '/etc/x.md' })], 'absolute path'],
    ['扩展名不在白名单', () => [tarEntry({ name: '任务/run.sh', data: Buffer.from('x') })], 'file extension not allowed'],
    ['没有扩展名', () => [tarEntry({ name: 'Makefile', data: Buffer.from('x') })], 'file extension not allowed'],
    ['隐藏文件', () => [tarEntry({ name: '.bashrc.md', data: Buffer.from('x') })], 'path segment not allowed'],
    ['零宽字符伪装', () => [tarEntry({ name: 'a​.md', data: Buffer.from('x') })], 'path segment not allowed'],
    ['超过层数', () => [tarEntry({ name: 'a/b/c/d/e/f/g/h/i.md', data: Buffer.from('x') })], 'path too deep'],
    ['重复', () => [tarEntry({ name: 'a.md' })], 'duplicate path'],
    ['折叠后重复', () => [tarEntry({ name: 'A.MD' })], 'duplicate path'],
    ['文件与目录冲突', () => [tarEntry({ name: 'a.md/b.md' })], 'path conflict'],
    ['PAX 改变条目含义', () => [paxEntry({ linkpath: '/etc/passwd' }), tarEntry({ name: 'x.md' })], 'pax key not supported'],
    ['校验和错误', () => [tarEntry({ name: 'x.md', badChecksum: true })], 'header checksum mismatch'],
    ['单个文件超大', () => [tarEntry({ name: 'x.md', size: 100 * 1024 * 1024 + 1 })], 'file too large'],
    ['超数', () => [tarEntry({ name: 'b.md' }), tarEntry({ name: 'c.md' })], 'too many files', { ...agentOutput, maxFiles: 2 }, 512 + 2 + 510 + 512],
    ['合计超大', () => [tarEntry({ name: 'b.md', data: Buffer.alloc(2048) })], 'archive too large', { ...agentOutput, maxTotalBytes: 2048 }],
  ])('拒绝%s，下游收不到结束块', async (_label, parts, reason, limits = agentOutput, maxBytes = 512 + 2) => {
    const good = tarEntry({ name: 'a.md', data: Buffer.from('ok') });
    const rewritten = rewriteArchiveStream(Readable.from([Buffer.concat([good, ...parts(), END_OF_ARCHIVE])]), limits);
    const { bytes, error } = await collect(rewritten.chunks);
    expect(error).toBeInstanceOf(SandboxArchiveError);
    expect((error as SandboxArchiveError).reason).toBe(reason);
    expect(() => rewritten.fileCount).toThrow();
    // 至多转出了之前合规的文件（头部与内容，最后一个不含对齐），没有结束块。
    expect(bytes.length).toBeLessThanOrEqual(maxBytes);
    expect(bytes.subarray(-1024).equals(Buffer.alloc(1024))).toBe(false);
  });

  it('被截断的归档与源在结尾处出错时不产出结束块', async () => {
    const good = tarEntry({ name: 'a.md', data: Buffer.from('ok') });
    const truncated = await collect(rewriteArchiveStream(tarStream(good), agentOutput).chunks);
    expect((truncated.error as SandboxArchiveError).reason).toBe('archive truncated');
    async function* failingAtEnd() {
      yield Buffer.concat([good, END_OF_ARCHIVE]);
      throw new Error('integrity check failed');
    }
    const failed = await collect(rewriteArchiveStream(failingAtEnd(), agentOutput).chunks);
    expect((failed.error as Error).message).toBe('integrity check failed');
    expect(failed.bytes.length).toBe(512 + 2);
  });

  it('expectedFileCount 不符时在结束块之前拒绝', async () => {
    const archive = Buffer.concat([tarEntry({ name: 'a.md', data: Buffer.from('ok') }), END_OF_ARCHIVE]);
    const mismatch = await collect(rewriteArchiveStream(Readable.from([archive]), agentOutput, { expectedFileCount: 2 }).chunks);
    expect((mismatch.error as SandboxArchiveError).reason).toBe('file count mismatch');
    expect(mismatch.bytes.length).toBe(512 + 2);
    const matched = rewriteArchiveStream(Readable.from([archive]), agentOutput, { expectedFileCount: 1 });
    expect((await collect(matched.chunks)).error).toBeNull();
    expect(matched.fileCount).toBe(1);
  });

  it('按块读取：大文件不在内存中整体缓存，消费方提前结束时释放源', async () => {
    const size = 32 * 1024 * 1024;
    let pulled = 0;
    let released = false;
    async function* source() {
      try {
        yield tarEntry({ name: 'big.png', size }).subarray(0, 512);
        for (let sent = 0; sent < size; sent += 1024 * 1024) {
          pulled += 1;
          yield Buffer.alloc(1024 * 1024, 5);
        }
        yield END_OF_ARCHIVE;
      } finally {
        released = true;
      }
    }
    let largest = 0;
    let seen = 0;
    for await (const chunk of rewriteArchiveStream(source(), agentOutput).chunks) {
      largest = Math.max(largest, chunk.length);
      seen += chunk.length;
      if (seen > 4 * 1024 * 1024) break;
    }
    expect(largest).toBeLessThanOrEqual(64 * 1024);
    expect(pulled).toBeLessThanOrEqual(6);
    expect(released).toBe(true);
  });
});
