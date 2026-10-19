const { ipcMain } = require('electron');
const { resolveIncomingConfigSecrets } = require('../services/configSecrets.cjs');

function registerAiIpc({ aiService, configStore }) {
  ipcMain.handle('ai:chat', (_event, request) => aiService.chat(request));
  ipcMain.handle('ai:request-json', (_event, request) => aiService.requestJson(request));
  // 界面拿到的是打码配置，测试前按已保存的档案还原留空的 Key。
  ipcMain.handle('ai:test-image-model', (_event, config) => aiService.testImageModel(resolveIncomingConfigSecrets(config, configStore.load())));
}

module.exports = {
  registerAiIpc,
};
