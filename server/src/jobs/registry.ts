// 生产环境登记的任务类型。第 6 步各模块的 PR 在这里追加；测试用的任务类型只在 tests/ 中登记。
// - document-parse（6.6）：导入后的文档解析，parse 队列，在断网沙箱中执行（src/parse/job.ts）。
import { documentParseJob } from '../parse/job.ts';
import { createJobTypeRegistry, type JobTypeDefinition } from './definitions.ts';

export const JOB_TYPES: readonly JobTypeDefinition<any>[] = Object.freeze([documentParseJob]);

export const jobTypeRegistry = createJobTypeRegistry(JOB_TYPES);
