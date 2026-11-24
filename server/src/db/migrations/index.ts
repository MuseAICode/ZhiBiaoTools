// 迁移清单：静态导入，开发（类型擦除直接运行 .ts）和编译产物（dist/*.js）都能用，不依赖目录扫描。
// 新迁移按编号追加；已合并的迁移不再修改。
import type { Migration } from 'kysely/migration';
import * as identity from './0001_identity.ts';
import * as auth from './0002_auth.ts';
import * as billing from './0003_billing.ts';
import * as aiGateway from './0004_ai_gateway.ts';
import * as platformModels from './0005_platform_models.ts';
import * as files from './0006_files.ts';
import * as projects from './0007_projects.ts';
import * as artifacts from './0008_artifacts.ts';
import * as settings from './0009_settings.ts';
import * as exportTemplates from './0010_export_templates.ts';
import * as credentialLibrary from './0011_credential_library.ts';
import * as knowledgeBase from './0012_knowledge_base.ts';
import * as knowledgeBaseItems from './0013_knowledge_base_items.ts';
import * as duplicateCheck from './0014_duplicate_check.ts';
import * as filesProjectImmutable from './0015_files_project_immutable.ts';
import * as rejectionCheck from './0016_rejection_check.ts';
import * as feasibilityReport from './0017_feasibility_report.ts';
import * as technicalPlan from './0018_technical_plan.ts';
import * as technicalPlanOutline from './0019_technical_plan_outline.ts';
import * as technicalPlanContent from './0020_technical_plan_content.ts';
import * as jobs from './0021_jobs.ts';
import * as jobBilling from './0022_job_billing.ts';
import * as artifactSupersede from './0023_artifact_supersede.ts';
import * as cleanup from './0024_cleanup.ts';
import * as jobStepResults from './0025_job_step_results.ts';
import * as technicalPlanBidSectionDetection from './0026_technical_plan_bid_section_detection.ts';
import * as templatePreview from './0027_template_preview.ts';
import * as technicalPlanExport from './0028_technical_plan_export.ts';
import * as technicalPlanExportRequests from './0029_technical_plan_export_requests.ts';
import * as feasibilityReportExport from './0030_feasibility_report_export.ts';
import * as agentJobTokens from './0031_agent_job_tokens.ts';
import * as jobStepToolCalls from './0032_job_step_tool_calls.ts';
import * as agentJobBudgets from './0033_agent_job_budgets.ts';
import * as agentJobBudgetConfirm from './0034_agent_job_budget_confirm.ts';
import * as agentJobLimitOverrides from './0035_agent_job_limit_overrides.ts';
import * as agentJobRuns from './0036_agent_job_runs.ts';
import * as agentToolCalls from './0037_agent_tool_calls.ts';
import * as agentFailureReports from './0038_agent_failure_reports.ts';
import * as agentQuestions from './0039_agent_questions.ts';
import * as agentWorkspaceSnapshots from './0040_agent_workspace_snapshots.ts';
import * as jobPauseStorageQuota from './0041_job_pause_storage_quota.ts';
import * as agentToolScopes from './0042_agent_tool_scopes.ts';
import * as agentModelRejections from './0043_agent_model_rejections.ts';
import * as jobPauseSelection from './0044_job_pause_selection.ts';
import * as aiImageGeneration from './0045_ai_image_generation.ts';

export const migrations: Readonly<Record<string, Migration>> = Object.freeze({
  '0001_identity': identity,
  '0002_auth': auth,
  '0003_billing': billing,
  '0004_ai_gateway': aiGateway,
  '0005_platform_models': platformModels,
  '0006_files': files,
  '0007_projects': projects,
  '0008_artifacts': artifacts,
  '0009_settings': settings,
  '0010_export_templates': exportTemplates,
  '0011_credential_library': credentialLibrary,
  '0012_knowledge_base': knowledgeBase,
  '0013_knowledge_base_items': knowledgeBaseItems,
  '0014_duplicate_check': duplicateCheck,
  '0015_files_project_immutable': filesProjectImmutable,
  '0016_rejection_check': rejectionCheck,
  '0017_feasibility_report': feasibilityReport,
  '0018_technical_plan': technicalPlan,
  '0019_technical_plan_outline': technicalPlanOutline,
  '0020_technical_plan_content': technicalPlanContent,
  '0021_jobs': jobs,
  '0022_job_billing': jobBilling,
  '0023_artifact_supersede': artifactSupersede,
  '0024_cleanup': cleanup,
  '0025_job_step_results': jobStepResults,
  '0026_technical_plan_bid_section_detection': technicalPlanBidSectionDetection,
  '0027_template_preview': templatePreview,
  '0028_technical_plan_export': technicalPlanExport,
  '0029_technical_plan_export_requests': technicalPlanExportRequests,
  '0030_feasibility_report_export': feasibilityReportExport,
  '0031_agent_job_tokens': agentJobTokens,
  '0032_job_step_tool_calls': jobStepToolCalls,
  '0033_agent_job_budgets': agentJobBudgets,
  '0034_agent_job_budget_confirm': agentJobBudgetConfirm,
  '0035_agent_job_limit_overrides': agentJobLimitOverrides,
  '0036_agent_job_runs': agentJobRuns,
  '0037_agent_tool_calls': agentToolCalls,
  '0038_agent_failure_reports': agentFailureReports,
  '0039_agent_questions': agentQuestions,
  '0040_agent_workspace_snapshots': agentWorkspaceSnapshots,
  '0041_job_pause_storage_quota': jobPauseStorageQuota,
  '0042_agent_tool_scopes': agentToolScopes,
  '0043_agent_model_rejections': agentModelRejections,
  '0044_job_pause_selection': jobPauseSelection,
  '0045_ai_image_generation': aiImageGeneration,
});
