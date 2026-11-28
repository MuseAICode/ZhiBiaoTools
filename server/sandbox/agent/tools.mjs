// agent 沙箱入口中的业务工具桩（路线图第 8 步 8.6c1；docs/SERVER_DESIGN.md 第 7.24 节）。只用 Node 内置模块与 Pi 传入的 TypeBox。
//
// 业务工具在 worker 中执行（src/agent/tools.ts 与各工具），这里只是桩：模型调用工具时，把 { name, arguments } 经 agent-gw 发到
// POST /v1/tools/call，把 worker 的结果交回模型。桩面向模型的名称、说明与提示沿用桌面版（piUserQuestionTool.cjs、
// piTaskFailureTool.cjs），参数 schema 与 worker 登记的相同（tests/agent/businessTools.test.ts 核对）。
//
// 桩不是控制：参数、阶段、次数与频率、身份全部由 worker 按令牌检查（8.4a、迁移 0042_agent_tool_scopes），沙箱内的命令绕过桩
// 直接调用工具接口也一样被拦住（#91 确认）。桩只负责让 Agent 正常工作：
// - ask-user / request-termination 收到 { answered: false, pending: true } 时等 PENDING_RETRY_DELAY_MS 后以完全相同的参数再次调用，
//   不交给模型（8.4c1、8.4c2 登记）；
// - generate-sections（8.10c2b2，长时工具，src/agent/toolRequests.ts）收到 { completed: false, pending: true } 时同样等待后以完全相同的
//   参数再次调用，不交给模型，每次等待经 onUpdate 给出进度提示；名称与说明沿用桌面版 contentGenerationAgent.cjs（说明中“知识库等”
//   按工作区中是否有知识库索引给出，与桌面版按是否引用知识库相同；只影响说明文字）；check-word-count（8.10c3b1）相同，名称与说明沿用
//   桌面版 contentGenerationWordTools.cjs；fix-submission-issues（8.10c3b3）相同，名称与说明沿用桌面版 contentGenerationEditTools.cjs；
// - report-failure 报告成功、request-termination 收到 { terminated: true } 后立即结束 Pi 会话（不再调用任何工具），
//   入口报告 REPORTED_FAILURE（8.4b 登记）；
// - request-termination 收到 { terminated: false } 时把 instruction（放宽后的执行要求）作为工具结果交给模型；
// - worker 的 4xx 说明（参数不合法、阶段外、次数上限、另有问题在等待等）作为工具错误交给模型，由模型修正；
//   401（令牌失效）与 409 JOB_NOT_RUNNING（本次执行已结束）立即结束 Pi 会话，入口报告 TOKEN_INVALID / RUN_ENDED；
//   其他情形（5xx、连不上、超时、响应不合法）只给模型固定的说明，不带出响应正文。
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { EntryError } from './protocol.mjs';

/** 一次工具调用（含等待用户回答的 50 秒）的时限。 */
export const TOOL_CALL_TIMEOUT_MS = 120_000;
/** worker 的结果至多 4 MiB（AGENT_TOOL_MAX_RESULT_BYTES），加上外层与错误响应的余量。 */
export const MAX_TOOL_RESPONSE_BYTES = 4 * 1024 * 1024 + 64 * 1024;
/** 收到 pending 后再次调用前的等待（worker 一次至多等 50 秒，这里只防止异常情况下的连续请求）。 */
export const PENDING_RETRY_DELAY_MS = 1_000;
/** 交给模型的错误说明至多这么多字符。 */
export const MAX_TOOL_ERROR_CHARS = 500;

const TOOL_CALL_PATH = '/v1/tools/call';
const GENERIC_ERROR = '平台暂时无法执行该工具，请稍后重试';

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 桩的错误：fatal 时入口结束 Pi 会话并报告 code，否则 message 作为工具错误交给模型。 */
export class ToolCallError extends Error {
  constructor(message, fatalCode = null) {
    super(message);
    this.name = 'ToolCallError';
    this.fatalCode = fatalCode;
  }
}

function errorMessageOf(body) {
  const message = isPlainObject(body) && isPlainObject(body.error) && typeof body.error.message === 'string' ? body.error.message : '';
  return message.trim() === '' ? GENERIC_ERROR : Array.from(message).slice(0, MAX_TOOL_ERROR_CHARS).join('');
}

/**
 * POST /v1/tools/call：200 返回 result；401 抛 fatal TOKEN_INVALID；409 JOB_NOT_RUNNING 抛 fatal RUN_ENDED；其他 4xx 抛带 worker 说明的
 * ToolCallError；5xx、连不上、超时、响应过大或不合法抛带固定说明的 ToolCallError。不跟随重定向、不复用连接。
 */
export function callBusinessTool({ baseUrl, token, name, args, signal, timeoutMs = TOOL_CALL_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        req.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onAbort = () => finish(new ToolCallError('工具调用已中止'));
    const body = Buffer.from(JSON.stringify({ name, arguments: args }), 'utf8');
    const url = new URL(TOOL_CALL_PATH, baseUrl);
    const req = httpRequest(url, {
      method: 'POST',
      agent: false,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length, accept: 'application/json', connection: 'close' },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_TOOL_RESPONSE_BYTES) {
          finish(new ToolCallError(GENERIC_ERROR));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => finish(new ToolCallError(GENERIC_ERROR)));
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        let parsed;
        try {
          parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          parsed = undefined;
        }
        if (status === 200) {
          if (!isPlainObject(parsed) || !Object.hasOwn(parsed, 'result')) return finish(new ToolCallError(GENERIC_ERROR));
          return finish(null, parsed.result);
        }
        if (status === 401) return finish(new ToolCallError(GENERIC_ERROR, 'TOKEN_INVALID'));
        if (status === 409 && isPlainObject(parsed) && isPlainObject(parsed.error) && parsed.error.code === 'JOB_NOT_RUNNING') {
          return finish(new ToolCallError(GENERIC_ERROR, 'RUN_ENDED'));
        }
        if (status >= 400 && status < 500) return finish(new ToolCallError(errorMessageOf(parsed)));
        finish(new ToolCallError(GENERIC_ERROR));
      });
    });
    const timer = setTimeout(() => finish(new ToolCallError(GENERIC_ERROR)), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', () => finish(new ToolCallError(GENERIC_ERROR)));
    req.end(body);
  });
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

const jsonContent = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], details: value });
const isPending = (result) => isPlainObject(result) && result.pending === true && result.answered === false;

// 以下参数 schema 与 worker 登记的相同（src/agent/askUserTool.ts、reportFailureTool.ts、requestTerminationTool.ts）：
// 长度上限取自 src/agent/questions.ts 与 failureReport.ts。
const QUESTION_MAX_LENGTH = 2_000;
const LABEL_MAX_LENGTH = 60;
const DESCRIPTION_MAX_LENGTH = 300;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const REASON_MAX_LENGTH = 500;

/** ask-user 的桩（桌面版 piUserQuestionTool.cjs 的说明与提示；问题按纯文本显示，不用 Markdown）。 */
function askUserStub({ Type, call }) {
  return {
    name: 'ask-user',
    label: '询问用户',
    description: '当任务材料无法确定且不同选择会实质影响结果时，暂停执行并向普通用户提出一个简单易懂的问题。提供 2 至 5 个互斥选项，将推荐选项放在第一项；每个选项必须声明是否需要用户输入具体要求，且最多只能有一个自定义输入选项。',
    promptSnippet: '在关键事项无法从材料中确定时，使用普通用户能理解的自然中文提问并等待回答。',
    promptGuidelines: [
      '已有材料足以判断时自主执行，不要调用 ask-user。',
      '只有不确定事项会实质影响结果时才调用 ask-user；每次只问一个问题，提供 2 至 5 个互斥选项，并将无需用户补充输入的推荐选项放在第一项。每个选项都必须填写 custom。',
      '问题、选项名称和选项说明必须面向不懂软件开发的普通用户，只说明业务对象、推荐结果、实际影响和可选操作，语言简单、自然且容易决策。',
      '禁止向用户展示变量名、字段名、文件名、JSON 属性、英文状态、内部编号或其他软件实现术语；必须把内部信息转换为具体名称、数量、层级和调整效果等业务表述。',
      '问题、选项名称和选项说明不得复述、概括或改写当前任务 Prompt 中的要求，只呈现分析后确实需要用户确认的结论或不确定事项。',
      '问题按纯文本显示，不要使用 Markdown 标记。存在多个实际确认事项时，按“简短说明、空行、以“- ”开头的分行要点、空行、最后确认问题”组织；每个要点只表达一件事，不要输出连续长段落。',
      '选项名称使用“按推荐方案处理”“保持当前结果”等可直接判断结果的简短操作文案，不得描述程序处理步骤或数据结构。',
      '普通选项设置 custom=false；只有需要用户选中后输入具体要求时才设置 custom=true。custom=true 的选项最多只能有一个，通常放在最后，且必须使用“补充具体要求”等明确操作名称，不得使用含义模糊的“其他”。',
      '用户回答前工具会一直等待；不要因为等待而重复提问或改问其他问题。',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      question: Type.String({
        minLength: 1,
        maxLength: QUESTION_MAX_LENGTH,
        description: '需要普通用户确认的具体业务问题，必须使用简单自然的中文，不得包含任何软件实现术语或复述任务要求；存在多个实际确认事项时分行列出要点。',
      }),
      options: Type.Array(Type.Object({
        label: Type.String({ minLength: 1, maxLength: LABEL_MAX_LENGTH, description: '简短、明确且可直接判断结果的操作名称，不得包含内部字段或技术标识。' }),
        description: Type.Optional(Type.String({ maxLength: DESCRIPTION_MAX_LENGTH, description: '使用普通用户能理解的语言说明该选项的业务结果或影响。' })),
        custom: Type.Boolean({ description: '是否需要用户在选中后输入具体要求。普通选项为 false，自定义输入选项为 true；一次提问最多只能有一个 true。' }),
      }, { additionalProperties: false }), {
        minItems: MIN_OPTIONS,
        maxItems: MAX_OPTIONS,
        description: '候选选项，第一项必须是 custom=false 的推荐选项；自定义输入选项计入总数。',
      }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params, signal) => {
      let result = await call('ask-user', params, signal);
      while (isPending(result)) {
        await delay(PENDING_RETRY_DELAY_MS, signal);
        if (signal?.aborted) throw new ToolCallError('工具调用已中止');
        result = await call('ask-user', params, signal);
      }
      return jsonContent(result);
    },
  };
}

const reasonParameter = (Type, description) => Type.Object({ reason: Type.String({ minLength: 1, maxLength: REASON_MAX_LENGTH, description }) }, { additionalProperties: false });

/** 直接报告失败的 report-failure 面向模型的定义（桌面版 piTaskFailureTool.cjs 直接报告的分支；主会话与子会话相同）。 */
function reportFailureDefinition(Type) {
  return {
    name: 'report-failure',
    label: '报告任务失败',
    description: '可自行修复的问题应先修复；需要用户决策时按本任务的提问规则处理。无法在当前任务允许的处理规则内完成要求时，报告面向普通用户的具体原因并立即结束任务。',
    promptSnippet: '任务确实无法继续时，使用自然中文报告具体原因并立即结束，不要删除、清空或重命名文件。',
    promptGuidelines: [
      '可自行修复的问题继续修复；需要用户选择有效方案时按本任务的提问规则处理，有 ask-user 工具时调用该工具。当无法在当前任务允许的处理规则内完成要求时，调用 report-failure 并说明原因。任务明确允许的补充设定、占位或概括性表达按对应规范执行；不得虚构工具执行结果、文件存在状态或任务完成情况。',
      'reason 必须直接面向普通用户，说明无法继续的具体业务原因和需要补充或调整的内容，不得使用文件名、字段名、JSON 属性或内部错误码。',
      '调用 report-failure 后任务会立即结束，不要再调用任何工具，也不得通过删除、清空或重命名输入、过程或输出文件表达失败。',
    ],
    executionMode: 'sequential',
    parameters: reasonParameter(Type, '面向普通用户的任务失败原因，并说明需要补充或调整的业务内容。'),
  };
}

/** report-failure 的桩（主会话：经 worker 写下失败报告，任务随之失败）。 */
function reportFailureStub({ Type, call, end }) {
  return {
    ...reportFailureDefinition(Type),
    execute: async (_toolCallId, params, signal) => {
      const result = await call('report-failure', params, signal);
      if (isPlainObject(result) && result.reported === true) end('REPORTED_FAILURE');
      return jsonContent(result);
    },
  };
}

/** report-failure 的桩（经用户决定是否终止，worker 一侧为 request-termination；桌面版 requestTerminationDecision 的分支）。 */
function requestTerminationStub({ Type, call, end }) {
  return {
    name: 'report-failure',
    label: '请求终止任务',
    description: '只有判断当前任务无法按要求继续时调用。程序会向用户说明原因并确认是否终止：用户确认后任务结束；用户选择继续时，工具会返回放宽后的执行要求，你必须按该要求继续完成任务。',
    promptSnippet: '任务确实无法按要求继续时，用自然中文说明原因并请求终止；是否终止由用户决定，用户选择继续时必须降低要求完成任务。',
    promptGuidelines: [
      '可自行修复的问题继续修复；需要用户在有效方案之间选择时按本任务的提问规则处理。只有判断当前任务无法按要求继续时才调用 report-failure，由用户决定是否终止；不得以其他方式自行结束或放弃任务，不得虚构工具执行结果、文件存在状态或任务完成情况。',
      'reason 必须直接面向普通用户，说明无法继续的具体业务原因，不得使用文件名、字段名、JSON 属性或内部错误码。',
      '用户确认终止后任务会立即结束，不要再调用任何工具；用户选择继续时，严格按工具返回的要求降低质量继续执行，不得以同一原因再次请求终止。',
      '不得通过删除、清空或重命名输入、过程或输出文件表达失败。',
    ],
    executionMode: 'sequential',
    parameters: reasonParameter(Type, '面向普通用户的无法继续原因，会展示给用户用于决定是否终止任务。'),
    execute: async (_toolCallId, params, signal) => {
      let result = await call('request-termination', params, signal);
      while (isPending(result)) {
        await delay(PENDING_RETRY_DELAY_MS, signal);
        if (signal?.aborted) throw new ToolCallError('工具调用已中止');
        result = await call('request-termination', params, signal);
      }
      if (isPlainObject(result) && result.terminated === true) {
        end('REPORTED_FAILURE');
        return jsonContent(result);
      }
      if (isPlainObject(result) && result.terminated === false && typeof result.instruction === 'string') {
        const details = { terminated: false, selected_option: result.selected_option, ...(typeof result.user_reply === 'string' ? { user_reply: result.user_reply } : {}) };
        return { content: [{ type: 'text', text: result.instruction }], details };
      }
      throw new ToolCallError(GENERIC_ERROR);
    },
  };
}

/** 正文生成的任务文件与知识库索引（与 src/technicalPlan/contentWriting.ts 的 taskFilePath('sections')、知识库/索引.json 相同）。 */
export const CONTENT_SECTIONS_TASK_FILE = '任务/正文生成.json';
export const KNOWLEDGE_INDEX_FILE = '知识库/索引.json';
const TASK_FILE_WRITING = '写完再调用对应工具提交。';
const isLongPending = (result) => isPlainObject(result) && result.pending === true && result.completed === false;

/** generate-sections 的桩（桌面版 contentGenerationAgent.cjs 的名称与说明）：worker 的执行者在本条提示词执行期间生成并写回各节正文。 */
function generateSectionsStub({ Type, call, workspaceDir }) {
  const hasKnowledgeBase = existsSync(join(workspaceDir, KNOWLEDGE_INDEX_FILE));
  return {
    name: 'generate-sections',
    label: '批量生成正文小节',
    description: `读取 ${CONTENT_SECTIONS_TASK_FILE} 中的全部小节并提交生成受限 HTML，格式为 {"sections":[{"section_id":"…","instructions":"…","references":"…"}]}，每项三个字段都必填。section_id 原样填写正文编排决策 targets 中本节的 id，不使用 number。instructions 仅填写本节新增配图安排，以及已有编排和公共规则之外确有必要的补充要求：配图安排包含布局、组数、逐图表达目的、图片类型和生成方式（aiImage/htmlImage/mermaid），AI 图片另写明画面类型、主体、视角景别和画面形式；没有新增配图和补充要求时填空字符串，失败重试时可填写具体纠错要求。references 为${hasKnowledgeBase ? '知识库等' : ''}补充资料的相关原文摘录并注明来源，完整全局事实由程序提供，无补充资料时填空字符串。程序自动提供本节编排、完整全局事实及公共材料，无需复述目标字数、写作重点、表格安排和格式规则。已生成正文的小节自动跳过，重复提交同一任务文件不会重写；确需整节重写时该项加 "regenerate": true。${TASK_FILE_WRITING}程序队列按用户配置控制实际并发，超出上限的任务自动排队，各节独立落盘。返回 total、success、skipped 和 unresolved（失败小节及原因）；失败小节修正文件中的要求后再次提交即可。`,
    executionMode: 'sequential',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_toolCallId, params, signal, onUpdate) => {
      // 每次等待刷新 Agent 的无进展计时（桌面版每节完成时 onUpdate）。
      const result = await callLongTool(call, 'generate-sections', params, signal, onUpdate, '正文小节仍在生成，完成后自动返回结果');
      // 与桌面版相同：模型只接收统计与未成功项（紧凑的 JSON）。
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}

/** 等待长时工具的结果：pending 时等待后以相同参数再次调用（不交给模型），每次等待经 onUpdate 给出进度提示。 */
async function callLongTool(call, name, params, signal, onUpdate, progress) {
  let result = await call(name, params, signal);
  while (isLongPending(result)) {
    onUpdate?.({ content: [{ type: 'text', text: progress }], details: { pending: true } });
    await delay(PENDING_RETRY_DELAY_MS, signal);
    if (signal?.aborted) throw new ToolCallError('工具调用已中止');
    result = await call(name, params, signal);
  }
  return result;
}

/** 与桌面版 WORD_COUNT_ONLY_NOTE 相同（src/technicalPlan/contentWordCount.ts）。 */
const WORD_COUNT_ONLY_NOTE = '本工具只统计实际字数：保持正文不变，不以任何方式（包括脚本批量删改）调整字数；字数要求由程序在本阶段提交后按设置统一处理。';

/** check-word-count 的桩（桌面版 contentGenerationWordTools.cjs 的名称与说明）：worker 的执行者统计实际字数并写入清单。 */
function checkWordCountStub({ Type, call }) {
  return {
    name: 'check-word-count',
    label: '检查正文总字数',
    description: `仅在全部正文和配图完成后调用。读取实际 HTML，返回总字数、上下限和缺失小节数，各节字数及缺失小节 ID 写入 程序清单/正文字数统计.json，按需读取；内容就绪后启用图片写入保护，不修改正文。${WORD_COUNT_ONLY_NOTE}`,
    executionMode: 'sequential',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const result = await callLongTool(call, 'check-word-count', params, signal, onUpdate, '正在统计正文总字数，完成后自动返回结果');
      // 与桌面版相同：结果按紧凑的 JSON 交给模型。
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}

/** 与 src/technicalPlan/contentSubmission.ts 的 CONTENT_SUBMISSION_ISSUES_FILE、contentWriting.ts 的 SUBMISSION_FIX_PARALLEL_THRESHOLD 相同。 */
export const CONTENT_SUBMISSION_ISSUES_FILE = '程序清单/提交校验问题.json';
const SUBMISSION_FIX_PARALLEL_THRESHOLD = 5;

/** fix-submission-issues 的桩（桌面版 contentGenerationEditTools.cjs 的名称与说明）：worker 的执行者在同一沙箱中用并发子会话修复各节。 */
function submissionFixStub({ Type, call }) {
  return {
    name: 'fix-submission-issues',
    label: '并发修复提交问题',
    description: `提交校验退回的问题涉及超过 ${SUBMISSION_FIX_PARALLEL_THRESHOLD} 个小节时使用：读取 ${CONTENT_SUBMISSION_ISSUES_FILE} 中按小节记录的问题（HTML 结构、图片块等），每个小节交给一个子任务并发修复。派发前按最新文件复查，已修好的小节跳过；子任务获得本节完整 HTML、本节问题及需要恢复的原始图片块，完成后程序校验本节。正文或图片文件缺失等子任务无法处理的问题列在 unresolved 中，由你直接处理。返回 total、success、skipped 和 unresolved。`,
    executionMode: 'sequential',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const result = await callLongTool(call, 'fix-submission-issues', params, signal, onUpdate, '正在并发修复提交问题，完成后自动返回结果');
      // 与桌面版相同：结果按紧凑的 JSON 交给模型。
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}

/**
 * 子会话的 report-failure（8.10c3b2，桌面版 failure_handled_by_parent：失败交回父 Agent）：在沙箱内处理，不经 worker、不写失败报告；
 * 名称、说明与参数与主会话的 report-failure 相同。report(reason) 记下原因并结束子会话，入口把原因作为结果交给 worker。
 */
export function createChildReportFailureTool({ Type, report }) {
  return {
    ...reportFailureDefinition(Type),
    execute: async (_toolCallId, params) => {
      const reason = isPlainObject(params) && typeof params.reason === 'string' ? params.reason.trim() : '';
      if (reason === '') throw new Error('reason 不能为空');
      report(reason);
      return jsonContent({ reported: true });
    },
  };
}

const STUBS = Object.freeze({
  'ask-user': askUserStub,
  'report-failure': reportFailureStub,
  'request-termination': requestTerminationStub,
  'generate-sections': generateSectionsStub,
  'check-word-count': checkWordCountStub,
  'fix-submission-issues': submissionFixStub,
});

/** 业务工具（worker 一侧的名字）面向模型的工具名。 */
export function modelToolName(name) {
  return name === 'request-termination' ? 'report-failure' : name;
}

/**
 * 为请求中的业务工具创建桩（Pi 的工具定义，由 pi.mjs 经 defineTool 登记）。
 * - Type：TypeBox（随 Pi 加载）；
 * - call(name, args, signal)：调用 worker 一侧的工具，返回 result，失败抛 ToolCallError（默认经 callBusinessTool）；
 * - end(code)：结束 Pi 会话，入口报告 code（REPORTED_FAILURE、TOKEN_INVALID、RUN_ENDED）；
 * - workspaceDir：工作区（generate-sections 的说明按其中是否有知识库索引给出）。
 * fatal 的 ToolCallError 由这里转成 end(code)，再作为工具错误交给模型（会话随即结束）。
 */
export function createBusinessToolStubs({ Type, names, call, end, workspaceDir = '/workspace' }) {
  const guardedCall = async (name, args, signal) => {
    try {
      return await call(name, args, signal);
    } catch (error) {
      if (error instanceof ToolCallError && error.fatalCode) end(error.fatalCode);
      if (error instanceof ToolCallError || error instanceof EntryError) throw new Error(error.message);
      throw new Error(GENERIC_ERROR);
    }
  };
  return names.map((name) => {
    const factory = STUBS[name];
    if (!factory) throw new EntryError('INTERNAL');
    return factory({ Type, call: guardedCall, end, workspaceDir });
  });
}
