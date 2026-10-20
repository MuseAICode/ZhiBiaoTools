// 资信库接口字段（camelCase，与桌面版 Renderer 的 credential-library/types.ts 相同）与数据库列（迁移 0011）的对应。
import {
  CREDENTIAL_LONG_TEXT_MAX,
  CREDENTIAL_PROFILE_TEXT_COLUMNS,
  CREDENTIAL_RECORD_TABLES,
  CREDENTIAL_SHORT_TEXT_MAX,
} from '../db/migrations/0011_credential_library.ts';

export type CredentialRecordType = keyof typeof CREDENTIAL_RECORD_TABLES;

function camel(column: string): string {
  return column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function fieldsOf<T extends Record<string, 'short' | 'long'>>(columns: T): Readonly<Record<string, { column: keyof T & string; maxLength: number }>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(columns).map(([column, kind]) => [
        camel(column),
        { column, maxLength: kind === 'long' ? CREDENTIAL_LONG_TEXT_MAX : CREDENTIAL_SHORT_TEXT_MAX },
      ]),
    ),
  );
}

/** 企业信息的文本字段（watermarkEnabled 是布尔值，单独处理）。 */
export const PROFILE_TEXT_FIELDS = fieldsOf(CREDENTIAL_PROFILE_TEXT_COLUMNS);

/** 各类记录的文本字段。 */
export const RECORD_TEXT_FIELDS: Readonly<Record<CredentialRecordType, ReturnType<typeof fieldsOf>>> = Object.freeze({
  certificate: fieldsOf(CREDENTIAL_RECORD_TABLES.certificate.textColumns),
  employee: fieldsOf(CREDENTIAL_RECORD_TABLES.employee.textColumns),
  project: fieldsOf(CREDENTIAL_RECORD_TABLES.project.textColumns),
  other: fieldsOf(CREDENTIAL_RECORD_TABLES.other.textColumns),
});
