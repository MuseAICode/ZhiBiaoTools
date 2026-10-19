// 项目软删除与其下文件、产物的联动（迁移 0008_artifacts）：不复制删除状态，读取时判断。
// 文件所属的项目已删除时文件不可访问；产物所属的项目已删除、或来源文件不可访问时产物不可访问。
// 恢复项目即一起恢复。Store 中读取或修改文件、产物的查询都要加上这里的条件。
import { sql, type RawBuilder } from 'kysely';

/** 行不属于项目，或所属项目未删除。 */
export function projectIsLive(projectColumn: 'files.project_id' | 'artifacts.project_id'): RawBuilder<boolean> {
  const column = sql.ref(projectColumn);
  return sql<boolean>`(${column} IS NULL OR EXISTS (
    SELECT 1 FROM projects live_project WHERE live_project.id = ${column} AND live_project.deleted_at IS NULL))`;
}

/** 产物没有来源文件，或来源文件已上传、未删除且所属项目未删除。 */
export function sourceFileIsLive(): RawBuilder<boolean> {
  return sql<boolean>`(artifacts.source_file_id IS NULL OR EXISTS (
    SELECT 1 FROM files live_file LEFT JOIN projects live_file_project ON live_file_project.id = live_file.project_id
    WHERE live_file.id = artifacts.source_file_id AND live_file.status = 'uploaded' AND live_file.deleted_at IS NULL
      AND live_file_project.deleted_at IS NULL))`;
}
