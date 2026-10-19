import { defineConfig } from 'vitest/config';

// 数据库集成测试：需要 TEST_DATABASE_ADMIN_URL（见 tests/db/harness.ts）；文件存储测试另需 TEST_S3_*（见 tests/db/s3.ts）。
export default defineConfig({
  test: {
    include: ['tests/db/**/*.test.ts'],
    environment: 'node',
    // 各测试文件会创建 / 修改同名的集群级角色，串行执行避免竞争。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
