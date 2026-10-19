import { describe, expect, it } from 'vitest';
import { attachmentDisposition, extensionOf, sanitizeDisplayName } from '../../src/files/filename.ts';

describe('sanitizeDisplayName', () => {
  it.each<[string, string]>([
    ['../../etc/passwd.pdf', '_.._etc_passwd.pdf'],
    ['..\\..\\windows\\system32\\a.docx', '_.._windows_system32_a.docx'],
    ['/abs/path/投标文件.pdf', '_abs_path_投标文件.pdf'],
    ['C:\\Users\\a\\file.docx', 'C__Users_a_file.docx'],
    ['  .hidden.pdf  ', 'hidden.pdf'],
    ['report.pdf...', 'report.pdf'],
    ['a\u0000b\u001fc.pdf', 'abc.pdf'],
    ['invoice\u202Efdp.exe', 'invoicefdp.exe'],
    ['zero\u200bwidth.pdf', 'zerowidth.pdf'],
    ['<script>.pdf', '_script_.pdf'],
    ['', '未命名'],
    ['../..', '_'],
    ['...', '未命名'],
  ])('%j → %j', (raw, expected) => {
    expect(sanitizeDisplayName(raw)).toBe(expected);
  });

  it('NFC 归一化', () => {
    expect(sanitizeDisplayName('cafe\u0301.pdf')).toBe('caf\u00e9.pdf');
  });

  it('孤立的代理项替换为 U+FFFD', () => {
    expect(sanitizeDisplayName('a\ud800b.pdf')).toBe('a\ufffdb.pdf');
  });

  it('超过 255 字节时截断，保留扩展名，不切开多字节字符', () => {
    const name = `${'标'.repeat(200)}.docx`;
    const result = sanitizeDisplayName(name);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(255);
    expect(result.endsWith('.docx')).toBe(true);
    expect(result).not.toContain('\ufffd');
    expect(Buffer.byteLength(sanitizeDisplayName('a'.repeat(1000)))).toBe(255);
  });

  it('结果中不再有路径分隔符和控制字符', () => {
    for (const raw of ['../a/b\\c.pdf', 'x\r\ny.pdf', '\u0085\u2028.pdf']) {
      const result = sanitizeDisplayName(raw);
      expect(result).not.toMatch(/[/\\\u0000-\u001f\u007f-\u009f\u2028]/u);
    }
  });
});

describe('extensionOf', () => {
  it.each<[string, string | null]>([
    ['a.PDF', 'pdf'],
    ['a.tar.gz', 'gz'],
    ['noext', null],
    ['.pdf', null],
    ['a.', null],
    ['a.p df', null],
    ['a.verylongextension123', null],
  ])('%j → %j', (name, expected) => {
    expect(extensionOf(name)).toBe(expected);
  });
});

describe('attachmentDisposition', () => {
  it('一律 attachment，filename* 为 UTF-8 编码，filename 为 ASCII 回退', () => {
    expect(attachmentDisposition('投标 "文件"(1).pdf')).toBe(
      `attachment; filename="__ ____(1).pdf"; filename*=UTF-8''%E6%8A%95%E6%A0%87%20%22%E6%96%87%E4%BB%B6%22%281%29.pdf`,
    );
  });

  it('结果不含换行，不能注入其他响应头', () => {
    expect(attachmentDisposition('a\r\nSet-Cookie: x=1.pdf')).not.toMatch(/[\r\n]/);
  });
});
