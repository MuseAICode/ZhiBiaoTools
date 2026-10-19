function logInfo(...args) {
  console.log('[zhibiao-client]', ...args);
}

function logError(...args) {
  console.error('[zhibiao-client]', ...args);
}

module.exports = {
  logError,
  logInfo,
};
