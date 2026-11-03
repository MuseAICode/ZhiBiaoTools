// 生产环境登记的任务类型。第 6 步各模块的 PR 在这里追加；测试用的任务类型只在 tests/ 中登记。
// - document-parse（6.6）：导入后的文档解析，parse 队列，在断网沙箱中执行（src/parse/job.ts）。
// - rejection-items-extraction、rejection-check-run（6.9）：废标检查的无效与废标项解析、三类检查，ai 队列（src/rejectionCheck/jobs.ts）。
// - duplicate-analysis（6.10）：标书查重分析，ai 队列，不调用模型，在断网沙箱中解析（src/duplicateCheck/job.ts）。
// - bid-section-extraction、bid-analysis（6.11）：技术方案的多标段识别、招标解析，ai 队列（src/technicalPlan/jobs.ts）。
// - feasibility-analysis、feasibility-parameters、feasibility-content、feasibility-human-writing（6.12）：可研报告的资料分析、关键参数、
//   正文生成与自然化审校，ai 队列（src/feasibilityReport/jobs.ts）。
// - knowledge-document-prepare（6.13a）、knowledge-document-match（6.13b）：知识库文档准备（解析、切块、候选条目提取，完成后接着匹配）、
//   段落匹配（重新匹配），ai 队列，组织级（src/knowledgeBase/jobs.ts）。
import { duplicateAnalysisJob } from '../duplicateCheck/job.ts';
import { feasibilityReportJobs } from '../feasibilityReport/jobs.ts';
import { knowledgeBaseJobs } from '../knowledgeBase/jobs.ts';
import { documentParseJob } from '../parse/job.ts';
import { rejectionCheckJobs } from '../rejectionCheck/jobs.ts';
import { technicalPlanJobs } from '../technicalPlan/jobs.ts';
import { createJobTypeRegistry, type JobTypeDefinition } from './definitions.ts';

export const JOB_TYPES: readonly JobTypeDefinition<any>[] = Object.freeze([documentParseJob, ...rejectionCheckJobs, duplicateAnalysisJob, ...technicalPlanJobs, ...feasibilityReportJobs, ...knowledgeBaseJobs]);

export const jobTypeRegistry = createJobTypeRegistry(JOB_TYPES);
