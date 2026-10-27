// 按记录的 MIME 分派（src/parse/dispatch.ts，路线图第 6 步分派表；6.6 只开放二进制与纯文本格式）。
import { describe, expect, it } from 'vitest';
import { dispatchParse, isSpreadsheetFormat, parseCommandArgs } from '../../src/parse/dispatch.ts';
import { resolveCommand, SANDBOX_TEMPLATES } from '../../src/sandbox/templates.ts';

describe('dispatchParse', () => {
  it.each([
    ['application/pdf', 'pdf', null],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx', null],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx', null],
    ['application/msword', 'word-ole', null],
    ['application/vnd.ms-works', 'word-ole', null],
    ['application/vnd.ms-excel', 'xls-ole', null],
    ['text/plain; charset=utf-8', 'text', 'utf-8'],
    ['text/plain; charset=gb18030', 'text', 'gb18030'],
    ['text/markdown; charset=utf-8', 'markdown', 'utf-8'],
    ['text/markdown; charset=gb18030', 'markdown', 'gb18030'],
  ])('%s → %s', (mime, format, charset) => {
    expect(dispatchParse(mime)).toEqual({ kind: 'parse', format, charset });
  });

  it.each(['application/rtf', 'text/html', 'message/rfc822', 'application/xml'])('%s is left to 6.7', (mime) => {
    expect(dispatchParse(mime)).toEqual({ kind: 'not-yet-supported' });
  });

  it.each(['image/png', 'application/octet-stream', 'text/plain', 'text/plain; charset=latin1', 'TEXT/PLAIN; charset=utf-8', 'application/pdf; x=1', ''])(
    'rejects %j',
    (mime) => {
      expect(dispatchParse(mime)).toEqual({ kind: 'unsupported' });
    },
  );

  it('builds arguments that the parse template accepts and that carry no path', () => {
    const args = parseCommandArgs({ format: 'markdown', charset: 'gb18030' }, true);
    expect(args).toEqual(['format=markdown', 'images=1', 'charset=gb18030']);
    expect(resolveCommand(SANDBOX_TEMPLATES.parse, 'parse', args)).not.toBeNull();
    expect(parseCommandArgs({ format: 'pdf', charset: null }, false)).toEqual(['format=pdf', 'images=0']);
  });

  it('marks spreadsheet formats (the title comes from the file name)', () => {
    expect(isSpreadsheetFormat('xlsx')).toBe(true);
    expect(isSpreadsheetFormat('xls-ole')).toBe(true);
    expect(isSpreadsheetFormat('docx')).toBe(false);
  });
});
