import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 数据库集成测试需要 PostgreSQL，单独用 npm run test:db 运行（vitest.db.config.ts）。
    exclude: ['tests/db/**'],
    environment: 'node',
  },
});
