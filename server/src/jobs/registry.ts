// 生产环境登记的任务类型。第 6 步各模块的 PR 在这里追加；测试用的任务类型只在 tests/ 中登记。
// - document-parse（6.6）：导入后的文档解析，parse 队列，在断网沙箱中执行（src/parse/job.ts）。
// - rejection-items-extraction、rejection-check-run（6.9）：废标检查的无效与废标项解析、三类检查，ai 队列（src/rejectionCheck/jobs.ts）。
// - duplicate-analysis（6.10）：标书查重分析，ai 队列，不调用模型，在断网沙箱中解析（src/duplicateCheck/job.ts）。
// - bid-section-extraction、bid-analysis（6.11）：技术方案的多标段识别、招标解析，ai 队列（src/technicalPlan/jobs.ts）。
import { duplicateAnalysisJob } from '../duplicateCheck/job.ts';
import { documentParseJob } from '../parse/job.ts';
import { rejectionCheckJobs } from '../rejectionCheck/jobs.ts';
import { technicalPlanJobs } from '../technicalPlan/jobs.ts';
import { createJobTypeRegistry, type JobTypeDefinition } from './definitions.ts';

export const JOB_TYPES: readonly JobTypeDefinition<any>[] = Object.freeze([documentParseJob, ...rejectionCheckJobs, duplicateAnalysisJob, ...technicalPlanJobs]);

export const jobTypeRegistry = createJobTypeRegistry(JOB_TYPES);
