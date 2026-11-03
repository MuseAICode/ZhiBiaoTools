import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 数据库集成测试需要 PostgreSQL，单独用 npm run test:db 运行（vitest.db.config.ts）。
    // 沙箱隔离测试需要 Docker（和 CI 中的 gVisor），单独用 npm run test:sandbox 运行（vitest.sandbox.config.ts）。
    exclude: ['tests/db/**', 'tests/sandbox/docker/**'],
    environment: 'node',
  },
});
