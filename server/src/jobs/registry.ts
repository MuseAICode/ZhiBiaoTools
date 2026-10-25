// 生产环境登记的任务类型。6.2 只建任务队列的骨架，还没有业务任务；第 6 步各模块的 PR（6.6 起）在这里追加。
import { createJobTypeRegistry, type JobTypeDefinition } from './definitions.ts';

export const JOB_TYPES: readonly JobTypeDefinition<any>[] = Object.freeze([]);

export const jobTypeRegistry = createJobTypeRegistry(JOB_TYPES);
