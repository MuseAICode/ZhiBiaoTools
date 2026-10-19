const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, shell } = require('electron');
const { maskConfigForRenderer, resolveIncomingConfigSecrets, resolveImageModelListConfig } = require('../services/configSecrets.cjs');

function registerConfigIpc({ configStore, aiService, onDeveloperModeChange, onConfigChanged }) {
  // API Key 只在 Main 进程使用：返回给界面的配置打码，回传时空值沿用已保存的值。
  ipcMain.handle('config:load', () => maskConfigForRenderer(configStore.load()));
  ipcMain.handle('config:save', (_event, config) => {
    const previousConfig = configStore.load();
    const result = configStore.save(resolveIncomingConfigSecrets(config, previousConfig));
    const nextConfig = configStore.load();
    onDeveloperModeChange?.(Boolean(nextConfig?.developer_mode));
    onConfigChanged?.(nextConfig, previousConfig);
    return result;
  });
  ipcMain.handle('config:list-models', (_event, config, options) => {
    if (!config) return aiService.listModels();
    const storedConfig = configStore.load();
    return aiService.listModels(options?.target === 'image'
      ? resolveImageModelListConfig(config, storedConfig)
      : resolveIncomingConfigSecrets(config, storedConfig));
  });
  ipcMain.handle('config:open-config-folder', async () => {
    const configFolder = path.dirname(configStore.getConfigFilePath());
    fs.mkdirSync(configFolder, { recursive: true });
    const errorMessage = await shell.openPath(configFolder);

    if (errorMessage) {
      throw new Error(`打开配置文件夹失败：${errorMessage}`);
    }

    return { success: true, path: configFolder };
  });
}

module.exports = {
  registerConfigIpc,
};
