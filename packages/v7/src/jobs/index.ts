export { handleEmbedJob, registerEmbedJob, isEmbedJob, type EmbedJob } from './embed.js'
export {
  createConsolidationScheduler,
  handleAttrAlias,
  handleCluePromote,
  handleConflict,
  handleDedupe,
  handleExtract,
  handleLinkSuggest,
  handleReferenceRot,
  registerConsolidationJobs,
  runForget,
  type ConsolidationDeps,
} from './consolidate.js'
