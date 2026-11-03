// 按记录的 MIME 分派（src/parse/dispatch.ts，路线图第 6 步分派表；6.6 二进制与纯文本格式，6.7 文本类格式）。
import { describe, expect, it } from 'vitest';
import { dispatchParse, isSpreadsheetFormat, metadataCommandArgs, PARSE_FORMATS, parseCommandArgs, supportsDocumentMetadata } from '../../src/parse/dispatch.ts';
import { resolveCommand, SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';

describe('dispatchParse', () => {
  it.each([
    ['application/pdf', 'pdf', 'pdf', null],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx', 'docx', null],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx', 'xlsx', null],
    ['application/msword', 'doc', 'word-ole', null],
    ['application/vnd.ms-works', 'wps', 'word-ole', null],
    ['application/vnd.ms-excel', 'xls', 'xls-ole', null],
    ['text/plain; charset=utf-8', 'txt', 'text', 'utf-8'],
    ['text/plain; charset=gb18030', 'txt', 'text', 'gb18030'],
    ['text/markdown; charset=utf-8', 'md', 'markdown', 'utf-8'],
    ['text/markdown; charset=gb18030', 'markdown', 'markdown', 'gb18030'],
    ['application/rtf', 'doc', 'rtf', null],
    ['application/rtf', 'wps', 'rtf', null],
    ['message/rfc822', 'doc', 'mht', null],
    ['text/html', 'doc', 'html-word', null],
    ['text/html', 'wps', 'html-word', null],
    ['text/html', 'xls', 'html-sheet', null],
    ['application/xml', 'doc', 'word-xml', null],
    ['application/xml', 'wps', 'word-xml', null],
    ['application/xml', 'xls', 'spreadsheet-xml', null],
  ])('%s (.%s) → %s', (mime, extension, format, charset) => {
    expect(dispatchParse(mime, extension)).toEqual({ kind: 'parse', format, charset });
  });

  it('only looks at the extension for text/html and application/xml (the recorded MIME decides everything else)', () => {
    // 扩展名只用来区分 Word 与表格；其他 MIME 不看扩展名。
    expect(dispatchParse('application/pdf', 'xls')).toEqual({ kind: 'parse', format: 'pdf', charset: null });
    expect(dispatchParse('application/rtf', 'xls')).toEqual({ kind: 'parse', format: 'rtf', charset: null });
    for (const extension of ['docx', 'xlsx', 'html', 'xml', 'pdf', 'DOC', '']) {
      expect(dispatchParse('text/html', extension)).toEqual({ kind: 'unsupported' });
      expect(dispatchParse('application/xml', extension)).toEqual({ kind: 'unsupported' });
    }
  });

  it.each(['image/png', 'application/octet-stream', 'text/plain', 'text/plain; charset=latin1', 'TEXT/PLAIN; charset=utf-8', 'application/pdf; x=1', 'text/html; charset=utf-8', ''])(
    'rejects %j',
    (mime) => {
      expect(dispatchParse(mime, 'doc')).toEqual({ kind: 'unsupported' });
    },
  );

  it('builds arguments that the parse template accepts and that carry no path', () => {
    const args = parseCommandArgs({ format: 'markdown', charset: 'gb18030' }, true);
    expect(args).toEqual(['format=markdown', 'images=1', 'charset=gb18030']);
    expect(resolveCommand(SANDBOX_TEMPLATES.parse, 'parse', args)).not.toBeNull();
    expect(parseCommandArgs({ format: 'pdf', charset: null }, false)).toEqual(['format=pdf', 'images=0']);
    // 标书查重的逐文档提取（6.10）。
    const analysis = parseCommandArgs({ format: 'xlsx', charset: null }, true, 'duplicate-check');
    expect(analysis).toEqual(['format=xlsx', 'images=1', 'analysis=duplicate-check']);
    expect(resolveCommand(SANDBOX_TEMPLATES.parse, 'parse', analysis)).not.toBeNull();
  });

  it('builds metadata-only arguments (6.10b) for the formats that carry document metadata', () => {
    const args = metadataCommandArgs('word-ole');
    expect(args).toEqual(['format=word-ole', 'metadata=duplicate-check']);
    expect(resolveCommand(SANDBOX_TEMPLATES.parse, 'parse', args)).not.toBeNull();
    expect(PARSE_FORMATS.filter((format) => supportsDocumentMetadata(format))).toEqual(['pdf', 'docx', 'word-ole', 'rtf', 'html-word', 'mht', 'word-xml']);
  });

  it('marks spreadsheet formats (the title comes from the file name)', () => {
    expect(isSpreadsheetFormat('xlsx')).toBe(true);
    expect(isSpreadsheetFormat('xls-ole')).toBe(true);
    expect(isSpreadsheetFormat('html-sheet')).toBe(true);
    expect(isSpreadsheetFormat('spreadsheet-xml')).toBe(true);
    for (const format of ['docx', 'word-ole', 'rtf', 'html-word', 'mht', 'word-xml'] as const) expect(isSpreadsheetFormat(format)).toBe(false);
  });
});
