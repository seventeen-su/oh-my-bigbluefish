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
export { createConsolidationScheduler, registerConsolidationJobs, type ConsolidationMode } from './schedule.js'
