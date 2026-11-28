export { handleEmbedJob, registerEmbedJob, isEmbedJob, type EmbedJob } from './embed.js'
export {
  handleAttrAlias,
  handleCluePromote,
  handleConflict,
  handleDedupe,
  handleExtract,
  handleLinkSuggest,
  handleReferenceRot,
  runForget,
  type ConsolidationDeps,
} from './consolidate.js'
export { createConsolidationScheduler, registerConsolidationJobs } from './schedule.js'
