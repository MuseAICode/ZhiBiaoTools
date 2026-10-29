// 疑似多标段检测的结果（路线图第 6 步 6.11；桌面版 technicalPlanStore.checkBidSections 在开始招标解析前对合并的招标正文现算）。
//
// 桌面版的检测正则在构造的输入上是平方级回溯，第 5 步没有把它放进共享的 api 进程（5.11 的偏离说明）。这里改为解析任务在 worker
// 中对每份招标文件算出检测摘要（src/technicalPlan/bidSectionDetector.ts，耗时与正文长度成正比），与解析结果一起写入文档；
// 读取状态时把各文件的摘要合并（只做集合并集和取最大值），得到与桌面版相同的 { hasMultiple, totalDeclared }。
// - technical_plan_documents.bid_section_detection：jsonb 对象，最大 8 KiB（摘要中的集合最多 10 个短字符串）；解析前、解析失败
//   与原方案为空，读取时只合并解析成功的招标文件；
// - 应用角色只多了这一列的 UPDATE 授权（与解析结果的其他列相同，经 saveDocumentParse 写入）；RLS 策略不变，文档的可见性
//   与写权限仍由 0018 的策略决定。
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { APP_ROLE } from '../roles.ts';

async function run(db: Kysely<unknown>, statements: readonly RawBuilder<unknown>[]): Promise<void> {
  for (const statement of statements) await statement.execute(db);
}

const app = sql.id(APP_ROLE);

/** 一份文档的检测摘要的大小上限（jsonb 的文本形式）。 */
export const TECHNICAL_PLAN_BID_SECTION_DETECTION_MAX_BYTES = 8 * 1024;

export async function up(db: Kysely<unknown>): Promise<void> {
  await run(db, [
    sql`ALTER TABLE technical_plan_documents ADD COLUMN bid_section_detection jsonb
          CHECK (jsonb_typeof(bid_section_detection) = 'object'
            AND octet_length(bid_section_detection::text) <= ${sql.lit(TECHNICAL_PLAN_BID_SECTION_DETECTION_MAX_BYTES)})`,
    sql`GRANT UPDATE (bid_section_detection) ON technical_plan_documents TO ${app}`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await run(db, [sql`ALTER TABLE technical_plan_documents DROP COLUMN bid_section_detection`]);
}
