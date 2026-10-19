const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

// 更新源由随包的 resources/update-feed.json 决定，默认为空：不检查、不下载任何更新。
// 接入自有更新服务器时只改这个文件。
const UPDATE_FEED_CONFIG_PATH = path.join(__dirname, '..', 'resources', 'update-feed.json');
const UPDATE_CHANNEL = 'custom';
const UPDATE_NOT_CONFIGURED_MESSAGE = '未配置更新源，不检查更新';

let autoUpdaterInstance = null;
let downloadedUpdateVersion = '';
let downloadedUpdateChannel = '';
let downloadedUpdateFilePath = '';
let activeUpdateCheckPromise = null;

// 新版本启动后删除已经安装或更旧的手动安装包，保留尚未安装的更新包。
function clearManualUpdateDownloads(app) {
  const updatesDir = path.join(app.getPath('userData'), 'updates');
  try {
    if (!fs.existsSync(updatesDir)) return;
    for (const entry of fs.readdirSync(updatesDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = /^ZhiBiao-(.+?)-(?:win-x64\.exe|mac-(?:x64|arm64)\.dmg)$/i.exec(entry.name);
      if (!match || compareVersions(match[1], app.getVersion()) > 0) continue;
      fs.rmSync(path.join(updatesDir, entry.name), { force: true });
    }
  } catch (error) {
    console.warn('[update] 清理旧更新安装包失败', error?.message || String(error));
  }
}

// 将版本号拆分为核心版本和 SemVer 预发布标识。
function parseVersion(value) {
  const normalized = String(value || '').trim().replace(/^v/i, '').split('+')[0];
  const separatorIndex = normalized.indexOf('-');
  const core = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  const prerelease = separatorIndex === -1 ? [] : normalized.slice(separatorIndex + 1).split('.');
  return {
    core: core.split('.').map((part) => Number(part) || 0),
    prerelease,
  };
}

// 按 SemVer 规则比较单个预发布标识。
function comparePrereleaseIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a.localeCompare(b);
}

// 比较两个版本号，正式版高于相同核心版本的测试版。
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i += 1) {
    const na = pa.core[i] || 0;
    const nb = pb.core[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }

  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i += 1) {
    const partA = pa.prerelease[i];
    const partB = pb.prerelease[i];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    const result = comparePrereleaseIdentifier(partA, partB);
    if (result !== 0) return result;
  }
  return 0;
}

// 更新清单和更新组件共用正式版规则，不依赖服务端或更新组件过滤测试版。
function isStableRelease(release) {
  const version = String(release.version || release.tag_name || release.tagName || '').trim();
  return /^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/i.test(version)
    && !release.prerelease && !release.isPrerelease
    && !release.draft && !release.isDraft
    && release.release_status !== 'pre' && release.release_status !== 'draft';
}

// 只接受 https 地址；文件缺失、格式错误或地址非法都视为未配置。
function readUpdateFeedConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(UPDATE_FEED_CONFIG_PATH, 'utf-8'));
    const feedUrl = String(raw?.feedUrl || '').trim().replace(/\/+$/, '');
    if (!feedUrl) return { feedUrl: '', publicKey: '' };
    if (new URL(feedUrl).protocol !== 'https:') {
      console.warn('[update] 更新源必须使用 https，已忽略');
      return { feedUrl: '', publicKey: '' };
    }
    return { feedUrl, publicKey: String(raw?.publicKey || '').trim() };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[update] 读取更新源配置失败，按未配置处理', error?.message || String(error));
    }
    return { feedUrl: '', publicKey: '' };
  }
}

const updateFeed = readUpdateFeedConfig();

function isUpdateFeedConfigured() {
  return Boolean(updateFeed.feedUrl);
}

// 下载前必须用 update-feed.json 中的公钥验证更新清单签名，并在下载后校验安装包哈希
// （electron-updater 路径同样要覆盖）。自有更新服务器的签名格式确定前这里一律拒绝，
// 配置了更新源也只会检查到新版本并报错，不会下载或安装。
function verifyReleaseSignature(_release) {
  if (!updateFeed.publicKey) {
    return { verified: false, message: '更新源未配置验签公钥，已拒绝下载更新包' };
  }
  return { verified: false, message: '更新包验签尚未实现，已拒绝下载更新包' };
}

function requestJson(url, label, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'zhibiao-client', ...headers } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        requestJson(new URL(response.headers.location, url).toString(), label, headers).then(resolve, reject);
        return;
      }

      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${label}请求失败：${response.statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`解析${label}响应失败`));
        }
      });
    });
    request.on('error', (error) => reject(error));
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('请求超时'));
    });
  });
}

function getMacUpdateArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

function pickMacDmgFile(files = []) {
  const validFiles = Array.isArray(files) ? files.filter((file) => file?.url && file?.name) : [];
  const arch = getMacUpdateArch();
  return validFiles.find((file) => new RegExp(`-mac-${arch}\\.dmg$`, 'i').test(file.name))
    || validFiles.find((file) => /-mac-(?:x64|arm64)\.dmg$/i.test(file.name))
    || validFiles.find((file) => /\.dmg$/i.test(file.name));
}

function pickPlatformDownloadFile(files = []) {
  const validFiles = Array.isArray(files) ? files.filter((file) => file?.url && file?.name) : [];
  if (process.platform === 'win32') {
    return validFiles.find((file) => /-win-x64\.exe$/i.test(file.name))
      || validFiles.find((file) => /-win-x64\.msi$/i.test(file.name))
      || validFiles.find((file) => /-win-x64\.zip$/i.test(file.name));
  }
  if (process.platform === 'darwin') {
    const arch = getMacUpdateArch();
    return pickMacDmgFile(validFiles)
      || validFiles.find((file) => new RegExp(`-mac-${arch}\\.zip$`, 'i').test(file.name))
      || validFiles.find((file) => /-mac-(?:x64|arm64)\.zip$/i.test(file.name));
  }
  return null;
}

// 选择下载后可直接启动的系统安装程序。
function pickPlatformInstallerFile(files = []) {
  const validFiles = Array.isArray(files) ? files.filter((file) => file?.url && file?.name) : [];
  if (process.platform === 'win32') {
    return validFiles.find((file) => /-win-x64\.exe$/i.test(file.name))
      || validFiles.find((file) => /-win-x64\.msi$/i.test(file.name));
  }
  if (process.platform === 'darwin') {
    return pickMacDmgFile(validFiles);
  }
  return null;
}

// 更新清单沿用 latest.json 格式：version、name、body、generatedAt、files[{ name, url, size }]。
async function fetchFeedLatestRelease() {
  const release = await requestJson(`${updateFeed.feedUrl}/latest.json`, '更新源 ');
  if (!isStableRelease(release)) return null;
  const files = Array.isArray(release.files)
    ? release.files.map((file) => ({
      name: file.name || '',
      url: file.url || '',
      size: Number(file.size || 0),
      contentType: file.contentType || '',
    }))
    : [];
  const downloadFile = pickPlatformDownloadFile(files);
  return {
    channel: UPDATE_CHANNEL,
    version: String(release.version || release.tagName || '').replace(/^v/i, ''),
    name: release.name || release.tagName || '',
    body: release.body || '',
    published_at: release.generatedAt || '',
    html_url: updateFeed.feedUrl,
    download_url: downloadFile?.url || updateFeed.feedUrl,
    files,
  };
}

// 所有查询入口共享正式版选择；空版本表示未配置更新源或没有可用正式版。
async function fetchLatestRelease() {
  const release = isUpdateFeedConfigured() ? await fetchFeedLatestRelease() : null;
  return release || { channel: UPDATE_CHANNEL, version: '', name: '', body: '', published_at: '', html_url: '', files: [] };
}

async function getLatestVersion() {
  return fetchLatestRelease();
}

// 未配置更新源时返回空字符串，由调用方提示用户自行获取新版。
async function getUpdateDownloadUrl() {
  if (!isUpdateFeedConfigured()) return '';
  try {
    const release = await fetchLatestRelease();
    return release.download_url || updateFeed.feedUrl;
  } catch (error) {
    console.warn('[update] 更新源下载地址获取失败', error?.message || String(error));
    return updateFeed.feedUrl;
  }
}

function configureAutoUpdater() {
  if (!autoUpdaterInstance) {
    return;
  }
  autoUpdaterInstance.setFeedURL({ provider: 'generic', url: updateFeed.feedUrl });
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function setProgressBar(mainWindow, progress) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.setProgressBar(progress);
}

function getDisabledResult(message) {
  return { enabled: false, updateAvailable: false, message };
}

function sanitizeDownloadFileName(fileName, fallback) {
  const normalized = String(fileName || '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').trim();
  const baseName = path.basename(normalized);
  return baseName && baseName !== '.' && baseName !== '..' ? baseName : fallback;
}

function getManualUpdateDownloadPath(app, release, file) {
  const platformSuffix = process.platform === 'win32' ? 'win-x64.exe' : `mac-${getMacUpdateArch()}.dmg`;
  const fallbackName = `ZhiBiao-${release.version || 'update'}-${platformSuffix}`;
  const fileName = sanitizeDownloadFileName(file?.name, fallbackName);
  return path.join(app.getPath('userData'), 'updates', fileName);
}

function isDownloadedFileReady(filePath, expectedSize = 0) {
  if (!filePath) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0 && (!expectedSize || stat.size === expectedSize);
  } catch {
    return false;
  }
}

function requestModuleForUrl(url) {
  if (url.protocol === 'https:') return https;
  if (url.protocol === 'http:') return http;
  throw new Error(`不支持的下载地址协议：${url.protocol}`);
}

function downloadFile(url, destinationPath, options = {}, redirectCount = 0) {
  const { expectedSize = 0, onProgress } = options;
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error('更新包下载地址无效'));
      return;
    }

    let settled = false;
    let tempPath = '';
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (tempPath) {
        try { fs.rmSync(tempPath, { force: true }); } catch {}
      }
      reject(error);
    };

    let request;
    try {
      request = requestModuleForUrl(parsedUrl).get(parsedUrl, { headers: { 'User-Agent': 'zhibiao-client' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectCount >= 5) {
            fail(new Error('更新包下载重定向次数过多'));
            return;
          }
          downloadFile(new URL(response.headers.location, parsedUrl).toString(), destinationPath, options, redirectCount + 1)
            .then(resolve, reject);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          fail(new Error(`更新包下载失败：${response.statusCode}`));
          return;
        }

        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        tempPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
        const output = fs.createWriteStream(tempPath);
        const total = Number(response.headers['content-length'] || expectedSize || 0);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            onProgress?.(Math.max(0, Math.min(100, (downloaded / total) * 100)));
          }
        });
        response.on('error', fail);
        output.on('error', fail);
        output.on('finish', () => {
          output.close(() => {
            try {
              fs.rmSync(destinationPath, { force: true });
              fs.renameSync(tempPath, destinationPath);
              tempPath = '';
              if (expectedSize && fs.statSync(destinationPath).size !== expectedSize) {
                throw new Error('更新包下载不完整，请重新检查更新');
              }
              onProgress?.(100);
              settled = true;
              resolve(destinationPath);
            } catch (error) {
              if (!tempPath) {
                try { fs.rmSync(destinationPath, { force: true }); } catch {}
              }
              fail(error);
            }
          });
        });

        response.pipe(output);
      });
    } catch (error) {
      fail(error);
      return;
    }

    request.on('error', fail);
    request.setTimeout(60000, () => {
      request.destroy(new Error('下载更新包超时'));
    });
  });
}

// 下载可由系统直接启动的 Windows 或 macOS 更新安装包。
async function runManualInstallerUpdateCheck(options, release, channel) {
  const { app, mainWindow, onProgress, onDownloaded, onError } = options;
  const installerFile = pickPlatformInstallerFile(release.files);
  if (!installerFile) {
    const platformLabel = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : '当前系统';
    const message = `未找到适用于 ${platformLabel} 的更新安装包`;
    onError?.(message);
    return { enabled: true, updateAvailable: true, version: release.version, failed: true, message, channel };
  }

  const destinationPath = getManualUpdateDownloadPath(app, release, installerFile);
  const expectedSize = Number(installerFile.size || 0);

  try {
    if (isDownloadedFileReady(destinationPath, expectedSize)) {
      downloadedUpdateVersion = release.version;
      downloadedUpdateChannel = channel;
      downloadedUpdateFilePath = destinationPath;
      onDownloaded?.(release.version);
      return { enabled: true, updateAvailable: true, version: release.version, downloaded: true, channel };
    }

    setProgressBar(mainWindow, 0);
    await downloadFile(installerFile.url, destinationPath, {
      expectedSize,
      onProgress: (percent) => {
        setProgressBar(mainWindow, Math.max(0, Math.min(1, percent / 100)));
        onProgress?.(percent);
      },
    });

    downloadedUpdateVersion = release.version;
    downloadedUpdateChannel = channel;
    downloadedUpdateFilePath = destinationPath;
    setProgressBar(mainWindow, -1);
    onDownloaded?.(release.version);
    return { enabled: true, updateAvailable: true, version: release.version, downloaded: true, channel };
  } catch (error) {
    const message = formatErrorMessage(error);
    setProgressBar(mainWindow, -1);
    onError?.(message);
    return { enabled: true, updateAvailable: true, version: release.version, failed: true, message, channel };
  }
}

async function runUpdateCheck(options = {}) {
  const { app, mainWindow, onProgress, onDownloaded, onError } = options;
  const channel = UPDATE_CHANNEL;
  const release = await fetchLatestRelease();
  if (!release.version || compareVersions(release.version, app.getVersion()) <= 0) {
    return { enabled: true, updateAvailable: false, channel };
  }
  const signature = verifyReleaseSignature(release);
  if (!signature.verified) {
    onError?.(signature.message);
    return { enabled: true, updateAvailable: true, version: release.version, failed: true, message: signature.message, channel };
  }
  if (process.platform === 'darwin') {
    return runManualInstallerUpdateCheck(options, release, channel);
  }
  configureAutoUpdater();
  downloadedUpdateFilePath = '';
  if (!autoUpdaterInstance) {
    return { enabled: true, updateAvailable: false, failed: true, message: '自动更新未初始化', channel };
  }

  let downloadedVersion = release.version;
  let downloadedNotified = false;
  let errorNotified = false;
  const notifyError = (message) => {
    if (errorNotified) {
      return;
    }
    errorNotified = true;
    onError?.(message);
  };

  const handleProgress = (progress) => {
    const percent = Number(progress?.percent || 0);
    setProgressBar(mainWindow, Math.max(0, Math.min(1, percent / 100)));
    onProgress?.(percent);
  };

  const handleDownloaded = (info) => {
    downloadedVersion = info?.version || release.version;
    downloadedUpdateVersion = downloadedVersion;
    downloadedUpdateChannel = channel;
    downloadedUpdateFilePath = '';
    downloadedNotified = true;
    setProgressBar(mainWindow, -1);
    onDownloaded?.(downloadedVersion);
  };

  const handleError = (error) => {
    setProgressBar(mainWindow, -1);
    notifyError(formatErrorMessage(error));
  };

  autoUpdaterInstance.on('download-progress', handleProgress);
  autoUpdaterInstance.on('update-downloaded', handleDownloaded);
  autoUpdaterInstance.on('error', handleError);

  try {
    const result = await autoUpdaterInstance.checkForUpdates();
    if (!result) {
      throw new Error('未找到可下载的更新包');
    }
    // 更新组件会再次读取清单，下载前也必须满足同一正式版规则。
    if (!result.isUpdateAvailable || !isStableRelease(result.updateInfo)
      || compareVersions(result.updateInfo.version, app.getVersion()) <= 0) {
      return { enabled: true, updateAvailable: false, channel };
    }
    downloadedVersion = result.updateInfo.version;

    await autoUpdaterInstance.downloadUpdate();
    downloadedUpdateVersion = downloadedVersion;
    downloadedUpdateChannel = channel;
    downloadedUpdateFilePath = '';
    setProgressBar(mainWindow, -1);
    if (!downloadedNotified) {
      onDownloaded?.(downloadedVersion);
    }
    return { enabled: true, updateAvailable: true, version: downloadedVersion, downloaded: true, channel };
  } catch (error) {
    const message = formatErrorMessage(error);
    notifyError(message);
    return { enabled: true, updateAvailable: true, version: release.version, failed: true, message, channel };
  } finally {
    autoUpdaterInstance.removeListener('download-progress', handleProgress);
    autoUpdaterInstance.removeListener('update-downloaded', handleDownloaded);
    autoUpdaterInstance.removeListener('error', handleError);
    setProgressBar(mainWindow, -1);
  }
}

async function checkAndDownloadUpdate(options = {}) {
  const { app } = options;
  const channel = UPDATE_CHANNEL;
  if (!app?.isPackaged) {
    return getDisabledResult('开发调试模式不执行自动更新');
  }
  if (!isUpdateFeedConfigured()) {
    return getDisabledResult(UPDATE_NOT_CONFIGURED_MESSAGE);
  }
  if (process.platform !== 'darwin' && !autoUpdaterInstance) {
    return { enabled: true, updateAvailable: false, failed: true, message: '自动更新未初始化', channel };
  }
  if (downloadedUpdateVersion && downloadedUpdateChannel === channel) {
    if (!downloadedUpdateFilePath || isDownloadedFileReady(downloadedUpdateFilePath)) {
      return { enabled: true, updateAvailable: true, version: downloadedUpdateVersion, downloaded: true, channel };
    }
    downloadedUpdateVersion = '';
    downloadedUpdateChannel = '';
    downloadedUpdateFilePath = '';
  }
  if (activeUpdateCheckPromise) {
    return activeUpdateCheckPromise;
  }

  activeUpdateCheckPromise = runUpdateCheck(options)
    .catch((error) => {
      const message = formatErrorMessage(error);
      options.onError?.(message);
      return { enabled: true, updateAvailable: false, failed: true, message, channel };
    })
    .finally(() => {
      activeUpdateCheckPromise = null;
    });
  return activeUpdateCheckPromise;
}

function triggerUpdateDownload(options) {
  return checkAndDownloadUpdate(options);
}

async function quitAndInstall(options = {}) {
  if (downloadedUpdateFilePath) {
    if (!isDownloadedFileReady(downloadedUpdateFilePath)) {
      return { success: false, message: '更新安装包尚未下载完成，请先检查更新' };
    }

    const { shell } = require('electron');
    const openError = await shell.openPath(downloadedUpdateFilePath);
    if (openError) {
      return { success: false, message: `打开更新安装包失败：${openError}` };
    }

    const { app } = options;
    setTimeout(() => {
      if (app?.quit) {
        app.quit();
      }
    }, 500);
    return { success: true };
  }

  if (autoUpdaterInstance && downloadedUpdateVersion) {
    autoUpdaterInstance.quitAndInstall(false, true);
    return { success: true };
  }

  return { success: false, message: '更新包尚未下载完成，请先检查更新' };
}

function setupAutoUpdate({ app, mainWindow }) {
  if (!app.isPackaged) {
    return;
  }
  clearManualUpdateDownloads(app);
  if (process.platform === 'darwin' || !isUpdateFeedConfigured()) {
    return;
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdaterInstance = autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  configureAutoUpdater();

  autoUpdater.on('download-progress', (progress) => {
    const percent = Number(progress?.percent || 0);
    setProgressBar(mainWindow, Math.max(0, Math.min(1, percent / 100)));
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateVersion = info?.version || downloadedUpdateVersion;
    downloadedUpdateFilePath = '';
    setProgressBar(mainWindow, -1);
  });

  autoUpdater.on('error', (error) => {
    setProgressBar(mainWindow, -1);
    console.warn('自动更新检查失败', error);
  });
}

module.exports = {
  setupAutoUpdate,
  checkAndDownloadUpdate,
  triggerUpdateDownload,
  quitAndInstall,
  getLatestVersion,
  getUpdateDownloadUrl,
};
