// 文档解析任务（路线图第 6 步 6.6；docs/SERVER_DESIGN.md 第 6.2、7.5 节）：document-parse，parse 队列。
// 技术方案（招标文件、原方案）、废标检查、可研报告导入文件后自动入队（src/parse/enqueue.ts），一个文件一个任务。
//
// 流程：文档标为解析中 → 按记录的 MIME 分派（src/parse/dispatch.ts）→ 从对象存储取出原件 → 新建 parse 沙箱（断网）→
// copyIn → 执行解析入口 → copyOut（归档按模板校验）→ 校验输出内容（src/parse/output.ts）→ 经 writeArtifact 写入图片和
// Markdown → 经各模块的 saveDocumentParse / saveSourceParse 写回文档 → 把该文件之前的产物标为已被替换（迁移 0023）。
// 沙箱在 finally 中销毁（exec 的任何非 0 结果之后都不复用，6.5 的约定）；sandbox-runner 的到期清理（15 分钟）是兜底。
//
// - 任务进程内不解析上传的内容：原件只经 copyIn 交给沙箱，取回的结果按不可信输入校验；
// - 失败时文档标为 error，写给用户看的原因（文案由代码决定，不采用沙箱输出的文字），任务以同一代码失败；
// - 沙箱数已达上限（SANDBOX_BUSY）或 sandbox-runner 暂不可用时按可重试处理：按退避间隔重试创建，仍不行才失败；
// - 可续跑：worker 崩溃或关闭后从头重新解析，上一次写了一半的产物在成功后一并标为已被替换；
// - 文档在解析中被移除（原件进回收站）时，写回影响 0 行，任务直接结束。
import { supersedeArtifacts } from '../artifacts/store.ts';
import { findFile } from '../files/store.ts';
import { JobError, JobInterruptedError, type JobContext, type JobTypeDefinition } from '../jobs/definitions.ts';
import { saveSourceParse } from '../feasibilityReport/store.ts';
import { saveDocumentParse as saveRejectionCheckDocumentParse } from '../rejectionCheck/store.ts';
import { saveDocumentParse as saveTechnicalPlanDocumentParse } from '../technicalPlan/store.ts';
import { LOCAL_PARSER_LABEL, parseFailureOf, parseFileInSandbox, writeParseArtifacts } from './run.ts';

export { LOCAL_PARSER_LABEL };

export const DOCUMENT_PARSE_JOB_TYPE = 'document-parse';

/** 解析结果写回到哪个模块的文档；只有原方案保留图片（桌面版 importOriginalPlanDocument 的 preserveImages）。 */
export const PARSE_TARGETS = ['technical-plan-tender', 'technical-plan-original-plan', 'rejection-check', 'feasibility-report'] as const;
export type ParseTarget = (typeof PARSE_TARGETS)[number];

export interface DocumentParseParams {
  target: ParseTarget;
  fileId: string;
}

/** 写回文档的字段（三个模块的 saveDocumentParse / saveSourceParse 相同）。 */
interface ParseResultInput {
  status?: 'pending' | 'running' | 'success' | 'error';
  markdownArtifactId?: string | null;
  contentChars?: number;
  contentHash?: string | null;
  parserLabel?: string | null;
  error?: string | null;
}

type SaveParse = (db: JobContext<unknown>['db'], context: JobContext<unknown>['tenant'], projectId: string, fileId: string, input: ParseResultInput) => Promise<boolean>;

const SAVE_BY_TARGET: Readonly<Record<ParseTarget, SaveParse>> = Object.freeze({
  'technical-plan-tender': saveTechnicalPlanDocumentParse,
  'technical-plan-original-plan': saveTechnicalPlanDocumentParse,
  'rejection-check': saveRejectionCheckDocumentParse,
  'feasibility-report': saveSourceParse,
});

/** 同一文件同时只有一个解析任务（jobs 的部分唯一索引）。 */
export function documentParseLockKey(fileId: string): string {
  return `document-parse:${fileId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseParams(raw: unknown): DocumentParseParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('解析任务参数不合法');
  const { target, fileId, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new TypeError('解析任务参数不合法');
  if (typeof target !== 'string' || !(PARSE_TARGETS as readonly string[]).includes(target)) throw new TypeError('解析目标不合法');
  if (typeof fileId !== 'string' || !UUID.test(fileId)) throw new TypeError('文件 id 不合法');
  return { target: target as ParseTarget, fileId };
}

export interface DocumentParseJobOptions {
  /**
   * 沙箱数已达上限或 sandbox-runner 暂不可用时，重试创建前的等待（毫秒）；用完仍失败则任务失败。
   * 默认约 5 分钟内重试 8 次。
   */
  createRetryDelaysMs?: readonly number[];
}

export function createDocumentParseJob(options: DocumentParseJobOptions = {}): JobTypeDefinition<DocumentParseParams> {

  async function parse(context: JobContext<DocumentParseParams>, projectId: string, save: SaveParse): Promise<void> {
    const { db, tenant, params } = context;
    const file = await findFile(db, tenant, params.fileId);
    // 原件已删除，或不属于本项目（参数由服务端生成，这里只是防御）：按文档已移除处理。
    if (!file || file.projectId !== projectId) return;
    const images = params.target === 'technical-plan-original-plan';
    const parsed = await parseFileInSandbox(context, file, { images, ...(options.createRetryDelaysMs ? { createRetryDelaysMs: options.createRetryDelaysMs } : {}) });
    await context.setProgress(60);
    const written = await writeParseArtifacts(context, projectId, file, parsed);

    // 写回之前确认仍持有租约（已被收回时抛 JobInterruptedError，由新的执行者重新解析）。
    await context.setProgress(90);
    const saved = await save(db, tenant, projectId, file.id, {
      status: 'success',
      markdownArtifactId: written.markdownArtifactId,
      contentChars: written.markdown.length,
      contentHash: written.contentHash,
      parserLabel: LOCAL_PARSER_LABEL,
      error: null,
    });
    // 文档已移除：本次写入的产物与之前的一起标为已被替换。
    await supersedeArtifacts(db, tenant, file.id, saved ? written.artifactIds : []);
    await context.log(saved ? '解析完成' : '文档已移除，解析结果已丢弃', { images: parsed.output.images.length, chars: written.markdown.length });
  }

  return {
    type: DOCUMENT_PARSE_JOB_TYPE,
    queue: 'parse',
    resumable: true,
    parseParams,
    async run(context) {
      const { db, tenant, params } = context;
      const projectId = context.projectId;
      if (!projectId) throw new JobError('PARSE_FAILED', '文件解析失败');
      const save = SAVE_BY_TARGET[params.target];
      if (!(await save(db, tenant, projectId, params.fileId, { status: 'running', error: null }))) {
        await context.log('文档已移除，跳过解析');
        return;
      }
      try {
        await parse(context, projectId, save);
      } catch (error) {
        const reason = context.signal.reason as unknown;
        // 租约丢失、worker 关闭、暂停：不写文档（由续跑的执行者继续）。取消：文档标为失败。
        if (context.signal.aborted && reason !== 'cancel') throw error;
        if (error instanceof JobInterruptedError && reason !== 'cancel') throw error;
        let failure: JobError;
        let unexpected: unknown = null;
        if (context.signal.aborted) failure = new JobError('PARSE_CANCELLED', '解析已取消');
        else {
          const known = parseFailureOf(error, '原方案图片资源缺失，请重新导入原 Word');
          // 其他错误（程序错误、数据库或对象存储故障）：文档同样标为失败，原错误交给执行者写日志（任务记为 JOB_FAILED）。
          if (!known) unexpected = error;
          failure = known ?? new JobError('PARSE_FAILED', '文件解析失败');
        }
        await save(db, tenant, projectId, params.fileId, {
          status: 'error',
          markdownArtifactId: null,
          contentChars: 0,
          contentHash: null,
          error: failure.message,
        });
        // 写了一半的产物（例如写到一半超出配额）和之前的产物都标为已被替换。
        await supersedeArtifacts(db, tenant, params.fileId, []);
        throw unexpected ?? failure;
      }
    },
  };
}

export const documentParseJob = createDocumentParseJob();
