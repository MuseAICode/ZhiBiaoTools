// json-validation 的校验本身（路线图第 8 步 8.6c2a；docs/SERVER_DESIGN.md 第 7.25 节）：读取工作区中的 JSON 文件，JSON.parse 后按
// JSON Schema（Draft-07）用 Ajv（MIT，按 package-lock.json 在镜像构建阶段安装）校验。只在 jsonValidationWorker.mjs 的工作线程中
// 执行（jsonValidation.mjs 负责时限与资源上限），测试也可以直接调用。
//
// 与桌面版 pi/piJsonValidationTool.cjs 的 createPiJsonValidator 相同的规则：预置了 Schema 的文件只用预置的（Agent 给出的 schema
// 被忽略），没有预置时必须由 Agent 给出；Ajv 为 allErrors + strict；结果为 { valid, stage, file_path, errors, message }，stage 为
// read / parse / schema / validation / success。不同之处：
// - 文件必须是工作区内的普通文件（解析符号链接后仍在工作区内）、至多 MAX_JSON_FILE_BYTES；
// - 至多报告 MAX_REPORTED_ERRORS 条错误（另给出总数），每条的说明与路径截短，params 过大时省略，结果不会无限长。
//
// 这只是供 Agent 自查的工具，不是控制：Agent 提供的 schema 只在本沙箱中编译与执行（#82 决定事项第 3 项），结果提交时平台另按固定规则
// 校验（8.6d 起）。
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, posix, resolve, sep } from 'node:path';
import Ajv from 'ajv';

export const JSON_VALIDATION_TOOL_NAME = 'json-validation';
/** 待校验文件的上限（工作区快照中单个文件至多 100 MiB；需要自查的结果文件远小于此）。 */
export const MAX_JSON_FILE_BYTES = 16 * 1024 * 1024;
/** 至多报告的错误条数。 */
export const MAX_REPORTED_ERRORS = 100;
/** 一条错误中说明与路径的字符数上限，params 序列化后的字符数上限（超过时省略）。 */
const MAX_ERROR_TEXT_CHARS = 500;
const MAX_ERROR_PARAMS_CHARS = 1_000;

const truncate = (value, max) => {
  const text = String(value ?? '');
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
};

/** 统一 Agent 给出的路径：去掉首尾空白、反斜杠换成 /，必须是相对路径；按 POSIX 规范化。 */
export function normalizeWorkspaceFilePath(filePath) {
  const value = String(filePath ?? '').trim().replace(/\\/g, '/');
  if (!value || value.startsWith('/') || isAbsolute(value)) throw new Error('file_path 必须是当前工作区内的非空相对路径');
  const normalized = posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new Error(`file_path 超出当前工作区：${truncate(filePath, MAX_ERROR_TEXT_CHARS)}`);
  return normalized;
}

const isInside = (root, target) => target === root || target.startsWith(`${root}${sep}`);

/** 读取工作区内的普通文件（解析符号链接后仍须在工作区内），至多 MAX_JSON_FILE_BYTES。 */
function readWorkspaceFile(workspaceDir, relativePath) {
  const root = realpathSync(resolve(workspaceDir));
  const target = resolve(root, relativePath);
  if (!isInside(root, target)) throw new Error(`file_path 超出当前工作区：${relativePath}`);
  let real;
  try {
    real = realpathSync(target);
  } catch {
    throw new Error(`文件不存在：${relativePath}`);
  }
  if (!isInside(root, real)) throw new Error(`file_path 超出当前工作区：${relativePath}`);
  const fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`不是普通文件：${relativePath}`);
    if (stat.size > MAX_JSON_FILE_BYTES) throw new Error(`文件超过 ${MAX_JSON_FILE_BYTES / 1024 / 1024} MiB，无法校验：${relativePath}`);
    // 按上限加一个字节读取：读取期间文件变大时同样拒绝。
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_JSON_FILE_BYTES) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_JSON_FILE_BYTES) throw new Error(`文件超过 ${MAX_JSON_FILE_BYTES / 1024 / 1024} MiB，无法校验：${relativePath}`);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function normalizeParams(params) {
  if (params === undefined) return {};
  let text;
  try {
    text = JSON.stringify(params);
  } catch {
    return {};
  }
  return typeof text === 'string' && text.length <= MAX_ERROR_PARAMS_CHARS ? JSON.parse(text) : {};
}

/** Ajv 的错误转换为 Agent 便于定位与修复的结构（与桌面版相同的字段），至多 MAX_REPORTED_ERRORS 条。 */
export function normalizeAjvErrors(errors = []) {
  return errors.slice(0, MAX_REPORTED_ERRORS).map((error) => ({
    instancePath: truncate(error.instancePath || '/', MAX_ERROR_TEXT_CHARS),
    schemaPath: truncate(error.schemaPath || '', MAX_ERROR_TEXT_CHARS),
    keyword: truncate(error.keyword || '', MAX_ERROR_TEXT_CHARS),
    message: truncate(error.message || '字段不符合 JSON Schema', MAX_ERROR_TEXT_CHARS),
    params: normalizeParams(error.params),
  }));
}

/** 工具结果的内容（与桌面版 createToolResult 的 payload 相同；错误多于上限时另有 error_count）。 */
export function validationPayload({ filePath, valid, stage, errors = [], errorCount = errors.length }) {
  return {
    valid,
    stage,
    file_path: filePath,
    errors,
    ...(errorCount > errors.length ? { error_count: errorCount } : {}),
    message: valid
      ? 'JSON.parse 和 Ajv 校验均已通过。'
      : errorCount > errors.length
        ? `校验未通过，共 ${errorCount} 处错误，只列出前 ${errors.length} 处；请修复后重新校验。`
        : '校验未通过，请根据 errors 修复文件后重新校验。',
  };
}

const errorMessage = (error) => truncate(error instanceof Error ? error.message : String(error), MAX_ERROR_TEXT_CHARS);

/**
 * 校验工作区中的一个 JSON 文件。presetSchemas 为 worker 预置的 { 相对路径: schema }（protocol.mjs 已检查键的形式）；
 * schema 为 Agent 给出的（只在没有预置时使用）。返回 validationPayload 的结果，不抛异常。
 */
export function validateJsonFile({ workspaceDir, filePath, presetSchemas = {}, schema }) {
  let relativePath;
  let source;
  try {
    relativePath = normalizeWorkspaceFilePath(filePath);
    source = readWorkspaceFile(workspaceDir, relativePath);
  } catch (error) {
    return validationPayload({ filePath: truncate(relativePath ?? filePath, MAX_ERROR_TEXT_CHARS), valid: false, stage: 'read', errors: [{ message: errorMessage(error) }] });
  }

  let data;
  try {
    data = JSON.parse(source);
  } catch (error) {
    return validationPayload({ filePath: relativePath, valid: false, stage: 'parse', errors: [{ message: errorMessage(error) }] });
  }

  let validate;
  try {
    const preset = Object.hasOwn(presetSchemas, relativePath) ? presetSchemas[relativePath] : undefined;
    const selected = preset !== undefined ? preset : schema;
    if (selected === undefined) throw new Error(`任务未为 ${relativePath} 预置 Schema，调用时必须提供 schema`);
    // 每次校验新建 Ajv：Agent 给出的 schema 之间互不影响（$id 重复等）。
    validate = new Ajv({ allErrors: true, strict: true }).compile(selected);
  } catch (error) {
    return validationPayload({ filePath: relativePath, valid: false, stage: 'schema', errors: [{ message: errorMessage(error) }] });
  }

  if (validate(data)) return validationPayload({ filePath: relativePath, valid: true, stage: 'success' });
  const all = validate.errors ?? [];
  return validationPayload({ filePath: relativePath, valid: false, stage: 'validation', errors: normalizeAjvErrors(all), errorCount: all.length });
}
