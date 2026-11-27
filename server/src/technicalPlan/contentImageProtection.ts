// 正文写作阶段的图片保护（路线图第 8 步 8.10c3b1；docs/SERVER_DESIGN.md 第 7.47 节），取代桌面版 contentGenerationEditTools.cjs 的
// createContentImageProtection 中“进入保护后限制业务工具”的部分。
//
// 桌面版在 check-word-count 确认全部正文就绪后进入保护：记录各目标小节的图片结构与原始图片块（提交时比对），并经 setActiveTools 把
// Agent 可用的工具换成 WORD_ADJUSTMENT_TOOLS（不再有 generate-sections 与配图工具），另在 beforeToolCall 中拒绝其他工具。
// Web 版一条提示词的工具在发出时已经确定（沙箱内的桩、令牌的工具范围），提示词执行期间不能换；改为由执行者一侧的长时工具在执行前
// 检查保护状态：进入保护后 generate-sections（以及 8.10d 的配图工具）按 AgentToolRequestRejection 交回 Agent，说明与桌面版
// beforeToolCall 的相同。保护状态随任务的 checkpoint 保存（state()，8.10c3c 写入），续跑时传回。
//
// 图片结构与原始图片块的记录、提交时的比对（image-block）随 8.10d 加入。
import { AgentToolRequestRejection } from '../agent/toolRequests.ts';

/** 保护状态（写进任务的 checkpoint）。 */
export interface ContentImageProtectionState {
  readonly active: boolean;
}

export interface ContentImageProtection {
  /** 是否已进入保护。 */
  readonly active: boolean;
  /** 进入保护（已进入时不变）。 */
  enter(): void;
  /** 保护期间不能执行的业务工具：已进入保护时抛 AgentToolRequestRejection（桌面版 beforeToolCall 的说明）。 */
  assertToolAllowed(name: string): void;
  state(): ContentImageProtectionState;
}

/** 解析 checkpoint 中的保护状态（不合法时抛 TypeError：checkpoint 由执行者写下，不合法是程序错误）。 */
export function parseContentImageProtectionState(raw: unknown): ContentImageProtectionState {
  if (raw === null || raw === undefined) return { active: false };
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1 || typeof (raw as Record<string, unknown>).active !== 'boolean') {
    throw new TypeError('图片保护的状态不合法');
  }
  return { active: (raw as { active: boolean }).active };
}

export function createContentImageProtection(state?: ContentImageProtectionState): ContentImageProtection {
  let active = parseContentImageProtectionState(state ?? null).active;
  return {
    get active() {
      return active;
    },
    enter() {
      active = true;
    },
    assertToolAllowed(name: string) {
      if (active) throw new AgentToolRequestRejection(`正文编辑期间不能调用 ${name}，请只调整文字并保留图片。`);
    },
    state: () => ({ active }),
  };
}
