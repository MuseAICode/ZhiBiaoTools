const path = require('node:path');
const { getDeveloperLogsDir } = require('../../utils/paths.cjs');
const { enqueueJsonLine } = require('../../utils/silentFileLog.cjs');
const { isExpectedAgentInterruption } = require('./agentInterruption.cjs');

const LOG_FILE_NAME = 'agent-failures.jsonl';
const MAX_MESSAGE_CHARS = 2000;
const MAX_STACK_CHARS = 4000;
const MAX_CAUSE_DEPTH = 4;
const SENSITIVE_KEY_PATTERN = /api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|mineru[_-]?token|password|passwd|secret|cookie|session[_-]?token/i;

// 收集配置中的全部凭据值，用于清除错误文本中的已知密钥。
function collectConfiguredSecrets(value, secrets = new Set(), ancestors = new WeakSet()) {
  if (!value || typeof value !== 'object' || ancestors.has(value)) return secrets;
  ancestors.add(value);
  try {
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key) && typeof item === 'string' && item.trim()) secrets.add(item);
      if (item && typeof item === 'object') collectConfiguredSecrets(item, secrets, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
  return secrets;
}

// 清除已配置凭据和常见认证信息格式，并限制长度。
function redactText(value, secrets, maxChars) {
  let text = String(value || '');
  for (const secret of secrets) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/\bsk-[a-z0-9_-]{8,}/gi, '[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[REDACTED]:[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|password|secret|key)=)[^&#\s]*/gi, '$1[REDACTED]')
    .slice(0, maxChars);
}

// 只记录错误类型、状态码和消息，不记录模型原始响应、Prompt 或工作区文件。
function summarizeError(error, secrets, depth = 0) {
  if (!error || depth > MAX_CAUSE_DEPTH) return null;
  if (typeof error !== 'object') return { message: redactText(error, secrets, MAX_MESSAGE_CHARS) };
  return {
    name: String(error.name || 'Error'),
    code: String(error.code || ''),
    status: Number(error.status || error.statusCode || 0),
    message: redactText(error.message || String(error), secrets, MAX_MESSAGE_CHARS),
    stack: depth === 0 ? redactText(error.stack, secrets, MAX_STACK_CHARS) : undefined,
    cause: error.cause ? summarizeError(error.cause, secrets, depth + 1) : null,
  };
}

function summarizeManagedTask(userTaskContext) {
  const task = userTaskContext?.managed_task;
  if (!task || typeof task !== 'object') return null;
  return {
    type: String(task.type || ''),
    label: String(task.label || ''),
    task_id: String(task.task_id || ''),
  };
}

// Agent 最终失败只写入本机日志 userData/logs/agent/agent-failures.jsonl，不向任何服务上传。
function writeAgentFailureLog({ app, configStore, payload = {}, error, userTaskContext }) {
  try {
    if (!error || isExpectedAgentInterruption(error)) return;
    let config = {};
    try { config = configStore?.load?.() || {}; } catch {}
    const secrets = collectConfiguredSecrets(config);
    enqueueJsonLine(path.join(getDeveloperLogsDir(app, 'agent'), LOG_FILE_NAME), {
      at: new Date().toISOString(),
      task_id: String(payload.task_id || ''),
      title: redactText(payload.title, secrets, 200),
      runtime_id: String(error.agentRuntimeId || ''),
      managed_task: summarizeManagedTask(userTaskContext),
      retry_count: Array.isArray(error.agentRetryAttempts) ? error.agentRetryAttempts.length : 0,
      model_retry_count: Number(error.agentModelRetryCount || 0),
      validation_failed: Boolean(error.agentValidationFailed),
      partial_output_chars: Number(error.agentPartialOutputChars || String(error.agentPartialOutput || '').length),
      error: summarizeError(error, secrets),
    });
  } catch {
    // 失败日志不能影响主流程。
  }
}

module.exports = {
  writeAgentFailureLog,
};
