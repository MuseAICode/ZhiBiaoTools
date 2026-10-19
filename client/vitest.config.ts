import { defineConfig } from 'vitest/config';

// 测试放在 tests/ 下，不进入 Vite 构建产物，也不随 electron/** 打包。
// Renderer 代码按 ESM TypeScript 直接导入；Electron Main 的 .cjs 在测试中用 createRequire 加载，保持 CommonJS 语义。
// 默认 node 环境；需要 DOM 的测试在文件头用 `// @vitest-environment jsdom` 单独声明。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
  },
});
