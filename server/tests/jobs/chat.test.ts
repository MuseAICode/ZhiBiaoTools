// 任务中调用模型的公共部分（src/jobs/chat.ts）：步骤键、输出为空、中止、JSON 的修复与重试。
import { describe, expect, it } from 'vitest';
import type { ChatResult } from '../../src/ai/gateway.ts';
import { createJobChat } from '../../src/jobs/chat.ts';
import { JobError, JobInterruptedError, type JobAi, type JobChatRequest } from '../../src/jobs/definitions.ts';

function result(content: string, aborted = false): ChatResult {
  return {
    requestId: 'r',
    content,
    reasoningContent: '',
    toolCalls: [],
    finishReason: 'stop',
    aborted,
    reused: false,
    usage: { inputTokens: 1, outputTokens: 1, estimated: false } as unknown as ChatResult['usage'],
    billing: { status: 'billed', amount: 1n },
  };
}

function fakeAi(outputs: Array<string | ChatResult>): JobAi & { requests: JobChatRequest[] } {
  const requests: JobChatRequest[] = [];
  return {
    requests,
    async chat(request) {
      requests.push(request);
      const next = outputs.shift();
      if (next === undefined) throw new Error('unexpected call');
      return typeof next === 'string' ? result(next) : next;
    },
  };
}

const MODEL = { provider: 'deepseek' as const, model: 'deepseek-chat' };
const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

describe('createJobChat', () => {
  it('text：按给出的步骤键调用组织选择的模型；输出为空时失败（allowEmpty 时返回）；中止的调用按中断处理', async () => {
    const ai = fakeAi(['答案', '  ', '', result('部分', true)]);
    const chat = createJobChat(ai, MODEL);
    expect(await chat.text('step:a', MESSAGES, '第一轮分析', { maxOutputTokens: 1 })).toBe('答案');
    expect(ai.requests[0]).toEqual({ provider: 'deepseek', model: 'deepseek-chat', messages: MESSAGES, stepKey: 'step:a', maxOutputTokens: 1 });
    await expect(chat.text('step:b', MESSAGES, '第一轮分析')).rejects.toMatchObject({ code: 'AI_EMPTY_RESPONSE', message: '第一轮分析未返回内容' });
    expect(await chat.text('step:c', MESSAGES, 'x', { allowEmpty: true })).toBe('');
    await expect(chat.text('step:d', MESSAGES, 'x')).rejects.toBeInstanceOf(JobInterruptedError);
  });

  it('json：合法时一次返回；不合法时先修复，修复仍不合法再重新调用，步骤键依次派生', async () => {
    const ai = fakeAi(['不是 JSON', '还不是', '```json\n{"findings":[]}\n```']);
    const progress: string[] = [];
    const chat = createJobChat(ai, MODEL);
    expect(await chat.json('typo', MESSAGES, { progressLabel: '错别字检查结果', failureMessage: '格式无效', onProgress: (m) => progress.push(m) })).toEqual({ findings: [] });
    expect(ai.requests.map((request) => request.stepKey)).toEqual(['typo', 'typo:repair-1', 'typo:try-2']);
    // 修复请求带上原输出与问题说明。
    expect(ai.requests[1]!.messages[3]!.content).toContain('不是 JSON');
    expect(progress).toEqual(['错别字检查结果格式校验失败，正在基于当前结果进行修复。', '错别字检查结果第 1/3 次校验失败，正在重试。']);
  });

  it('json：3 次都不合法时以给用户看的原因失败（不含模型输出）', async () => {
    const ai = fakeAi(['a', 'b', 'c', 'd', 'e', 'f']);
    const chat = createJobChat(ai, MODEL);
    const error = await chat.json('logic', MESSAGES, { progressLabel: 'L', failureMessage: '逻辑谬误检查结果格式无效，请重新检查' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobError);
    expect(error).toMatchObject({ code: 'AI_INVALID_JSON', message: '逻辑谬误检查结果格式无效，请重新检查' });
    expect(ai.requests.map((request) => request.stepKey)).toEqual(['logic', 'logic:repair-1', 'logic:try-2', 'logic:repair-2', 'logic:try-3', 'logic:repair-3']);
  });
});
