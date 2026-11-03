import { defineConfig } from 'vitest/config';

// 沙箱隔离测试：需要 Docker 和 parse 镜像（TEST_SANDBOX_IMAGE），见 tests/sandbox/docker/env.ts。CI 中在 gVisor（runsc）下运行。
export default defineConfig({
  test: {
    include: ['tests/sandbox/docker/**/*.test.ts'],
    environment: 'node',
    // 共用同一个 Docker，串行执行，避免沙箱数上限和计时相互影响。
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
