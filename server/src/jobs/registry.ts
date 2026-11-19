// 生产环境登记的任务类型。第 6 步各模块的 PR 在这里追加；测试用的任务类型只在 tests/ 中登记。
// - document-parse（6.6）：导入后的文档解析，parse 队列，在断网沙箱中执行（src/parse/job.ts）。
// - rejection-items-extraction、rejection-check-run（6.9）：废标检查的无效与废标项解析、三类检查，ai 队列（src/rejectionCheck/jobs.ts）。
// - duplicate-analysis（6.10）：标书查重分析，ai 队列，不调用模型，在断网沙箱中解析（src/duplicateCheck/job.ts）。
// - bid-section-extraction、bid-analysis（6.11）：技术方案的多标段识别、招标解析，ai 队列（src/technicalPlan/jobs.ts）。
// - feasibility-analysis、feasibility-parameters、feasibility-content、feasibility-human-writing（6.12）：可研报告的资料分析、关键参数、
//   正文生成与自然化审校，ai 队列（src/feasibilityReport/jobs.ts）。
// - knowledge-document-prepare（6.13a）、knowledge-document-match（6.13b）：知识库文档准备（解析、切块、候选条目提取，完成后接着匹配）、
//   段落匹配（重新匹配），ai 队列，组织级（src/knowledgeBase/jobs.ts）。
// - template-preview（7.3d）：模板样张，export 队列，组织级，在断网的 export-preview 沙箱中生成（src/export/previewJob.ts）；
//   template-word-export（7.3e）：样张导出 Word，执行相同，不参与样张的“新请求取代旧请求”。
// - technical-plan-export（7.4g）：技术方案整本导出 Word，export 队列，lock_key 按项目，在断网的 export-document 沙箱中生成
//   （src/export/documentJob.ts）。
// - feasibility-report-export（7.5d）：可研报告导出 Word，export 队列，lock_key 按项目，在断网的 export-feasibility 沙箱中
//   运行桌面版的可研导出代码（src/export/feasibilityJob.ts）。
// - feasibility-outline（8.7a）：可研报告目录生成，agent 队列，lock_key 与其他可研任务相同，在 agent 沙箱中由 Agent 写出目录
//   （src/feasibilityReport/jobs.ts）。
// - global-facts-generation（8.7c1）：技术方案全局事实生成，agent 队列，lock_key 与其他技术方案任务相同，在 agent 沙箱中由 Agent
//   写出全局事实（src/technicalPlan/jobs.ts）。
import { duplicateAnalysisJob } from '../duplicateCheck/job.ts';
import { technicalPlanExportJob } from '../export/documentJob.ts';
import { feasibilityReportExportJob } from '../export/feasibilityJob.ts';
import { templatePreviewJob, templateWordExportJob } from '../export/previewJob.ts';
import { feasibilityReportJobs } from '../feasibilityReport/jobs.ts';
import { knowledgeBaseJobs } from '../knowledgeBase/jobs.ts';
import { documentParseJob } from '../parse/job.ts';
import { rejectionCheckJobs } from '../rejectionCheck/jobs.ts';
import { technicalPlanJobs } from '../technicalPlan/jobs.ts';
import { createJobTypeRegistry, type JobTypeDefinition } from './definitions.ts';

export const JOB_TYPES: readonly JobTypeDefinition<any>[] = Object.freeze([documentParseJob, ...rejectionCheckJobs, duplicateAnalysisJob, ...technicalPlanJobs, ...feasibilityReportJobs, ...knowledgeBaseJobs, templatePreviewJob, templateWordExportJob, technicalPlanExportJob, feasibilityReportExportJob]);

export const jobTypeRegistry = createJobTypeRegistry(JOB_TYPES);
