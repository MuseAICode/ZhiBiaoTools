import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../src/server.ts', import.meta.url));

describe('进程入口', () => {
  it('缺少必需配置时启动失败，退出码为 1，stderr 输出结构化错误且不回显值', () => {
    const result = spawnSync(process.execPath, [entry], {
      env: { PATH: process.env.PATH, PORT: 'postgres://admin:hunter2@db' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    const line = result.stderr.trim().split('\n').at(-1) ?? '';
    const parsed = JSON.parse(line) as { level: string; issues: { name: string }[] };
    expect(parsed.level).toBe('fatal');
    expect(parsed.issues.map((issue) => issue.name)).toEqual(['NODE_ENV', 'PORT', 'DATABASE_PASSWORD']);
    expect(result.stderr).not.toContain('hunter2');
    expect(result.stdout).toBe('');
  });
});
