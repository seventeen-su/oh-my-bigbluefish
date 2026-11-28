export { handleEmbedJob, registerEmbedJob, isEmbedJob, type EmbedJob } from './embed.js'
export {
  handleAttrAlias,
  handleCluePromote,
  handleCluePromoteFor,
  handleConflict,
  handleConflictFor,
  handleDedupe,
  handleDedupeFor,
  handleExtract,
  handleExtractArtifact,
  handleLinkSuggest,
  handleReferenceRot,
  handleReferenceRotForSource,
  handleReferenceRotForTarget,
  runForget,
  type ConsolidationDeps,
} from './consolidate.js'
export { CONSOLIDATION_JOBS, type ConsolidationJobName } from './names.js'
export {
  consolidationJobPayloadOf,
  createConsolidationJobRunners,
  type ConsolidationJobContext,
  type ConsolidationJobPayload,
  type ConsolidationJobRunner,
  type ConsolidationJobRunners,
} from './runners.js'
export {
  CONSOLIDATION_WORKFLOW_SPECS,
  CONSOLIDATION_WORKFLOW_VERSION,
  createConsolidationWorkflows,
  type ConsolidationWorkflowDeps,
  type ConsolidationWorkflowSpec,
} from './workflows.js'
export {
  createConsolidationScheduler,
  registerConsolidationJobs,
  type ConsolidationJobOptions,
  type ConsolidationMode,
  type ConsolidationSchedule,
  type ConsolidationScheduler,
  type ConsolidationSchedulerDeps,
  type ConsolidationWorkflowDispatch,
  type WorkflowRunStarter,
} from './schedule.js'
