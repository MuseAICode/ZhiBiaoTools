// 插件代码在 Main 进程中直接 require() 执行且没有签名校验，独立运营期间整体停用；代码暂时保留，Web 版计划下线。
// Main 进程侧的开关见 electron/ipc/index.cjs 的 PLUGIN_SYSTEM_ENABLED，两处需同时修改。
export const PLUGIN_SYSTEM_ENABLED = false;
