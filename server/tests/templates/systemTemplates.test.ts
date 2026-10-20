// 系统导出模板的定义与桌面版真源一致，以及模板名称的归一化。
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { copyTemplateName, EXPORT_TEMPLATE_NAME_MAX_LENGTH, normalizeTemplateName, UNTITLED_TEMPLATE_NAME } from '../../src/templates/name.ts';
import { SYSTEM_EXPORT_TEMPLATES } from '../../src/templates/systemTemplates.ts';
import { SYSTEM_TEMPLATE_KEY_PATTERN } from '../../src/db/migrations/0010_export_templates.ts';

const require = createRequire(import.meta.url);

describe('系统导出模板', () => {
  it('与桌面版 systemExportTemplates.cjs 生成的配置逐字段相同，key 是去掉 tpl-system- 前缀的 template_id', () => {
    const { SYSTEM_EXPORT_TEMPLATES: desktop } = require('../../../client/electron/services/systemExportTemplates.cjs') as {
      SYSTEM_EXPORT_TEMPLATES: Array<{ template_id: string; config: Record<string, unknown> }>;
    };
    expect(SYSTEM_EXPORT_TEMPLATES).toEqual(
      desktop.map((template) => ({ key: template.template_id.replace(/^tpl-system-/, ''), config: template.config })),
    );
  });

  it('key 符合数据库约束且不重复，名称已是归一化后的形式', () => {
    const keys = SYSTEM_EXPORT_TEMPLATES.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const definition of SYSTEM_EXPORT_TEMPLATES) {
      expect(definition.key).toMatch(new RegExp(SYSTEM_TEMPLATE_KEY_PATTERN));
      expect(normalizeTemplateName(definition.config.template_name)).toBe(definition.config.template_name);
    }
  });
});

describe('模板名称', () => {
  it('NFC 归一化，去掉不可见字符和首尾空白；为空或不是字符串时用默认名称', () => {
    expect(normalizeTemplateName('  é‮模板​ ')).toBe('é模板');
    expect(normalizeTemplateName(' ​ ')).toBe(UNTITLED_TEMPLATE_NAME);
    expect(normalizeTemplateName(undefined)).toBe(UNTITLED_TEMPLATE_NAME);
    expect(normalizeTemplateName(42)).toBe(UNTITLED_TEMPLATE_NAME);
  });

  it('按字符计长度，超过上限拒绝', () => {
    expect(normalizeTemplateName('😀'.repeat(EXPORT_TEMPLATE_NAME_MAX_LENGTH))).toHaveLength(EXPORT_TEMPLATE_NAME_MAX_LENGTH * 2);
    expect(() => normalizeTemplateName('长'.repeat(EXPORT_TEMPLATE_NAME_MAX_LENGTH + 1))).toThrow(/不超过/);
  });

  it('复制名称加“ 副本”，超长时截短原名称且不切断代理对', () => {
    expect(copyTemplateName('标准')).toBe('标准 副本');
    const copied = copyTemplateName('😀'.repeat(EXPORT_TEMPLATE_NAME_MAX_LENGTH));
    expect([...copied]).toHaveLength(EXPORT_TEMPLATE_NAME_MAX_LENGTH);
    expect(normalizeTemplateName(copied)).toBe(copied);
  });
});
