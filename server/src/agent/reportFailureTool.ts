// 业务工具 report-failure（路线图第 8 步 8.4b；src/agent/failureReport.ts）：Agent 报告无法按要求继续的原因，执行者据此结束任务
// （AGENT_REPORTED_FAILURE）。参数只有 reason（纯文本，服务端规范化后保存）；任务的组织、项目与本次执行全部按令牌取。
//
// 返回 { reported: true }，Agent 应立即停止；之后本次执行的模型调用与工具调用一律 409。规范化后为空的原因 400（可修正后重试）。
import { withTenant } from '../db/tenant.ts';
import { AppError } from '../errors.ts';
import { AGENT_FAILURE_REASON_MAX_LENGTH, normalizeAgentFailureReason, recordAgentFailureReport } from './failureReport.ts';
import type { AgentToolDefinition } from './tools.ts';

export const REPORT_FAILURE_TOOL_NAME = 'report-failure';

export interface ReportFailureArguments {
  reason: string;
}

export interface ReportFailureResult {
  reported: true;
}

export const reportFailureTool: AgentToolDefinition<ReportFailureArguments, ReportFailureResult> = {
  name: REPORT_FAILURE_TOOL_NAME,
  argumentsSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: AGENT_FAILURE_REASON_MAX_LENGTH,
        description: '面向普通用户的无法继续的具体原因，以及需要补充或调整的业务内容（纯文本）。',
      },
    },
  },
  // 500 个字符按 UTF-8 至多 2,000 字节，JSON 转义后（控制字符 \u00XX）至多 3,000 字节，留出外层余量。
  maxArgumentBytes: 4096,
  // 每次执行只记第一次（之后的调用 409）；参数不合法的调用同样计入，留出修正参数后重试的余量。
  maxCallsPerJob: 20,
  maxCallsPerMinute: 10,
  async run(context, args) {
    const reason = normalizeAgentFailureReason(args.reason);
    if (reason.length === 0) throw new AppError(400, 'AGENT_TOOL_INVALID_ARGUMENTS', '工具参数不合法：/reason 去掉空白与控制字符后不能为空');
    const recorded = await withTenant(context.db, context.tenant, (trx) =>
      recordAgentFailureReport(trx, { tenant: context.tenant, jobId: context.identity.jobId, runId: context.identity.runId }, reason),
    );
    if (recorded === null) throw new AppError(409, 'JOB_NOT_RUNNING', '任务不在执行中，不能调用工具');
    // 执行者立即续租一次，发现报告后中止本次执行（不等下一次定期续租）。
    await context.notifyExecutor();
    context.log.info({ jobId: context.identity.jobId, tokenId: context.identity.logId }, 'agent reported failure');
    return { reported: true };
  },
};
