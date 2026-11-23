export { handleEmbedJob, registerEmbedJob, isEmbedJob, type EmbedJob } from './embed.js'
export {
  handleAttrAlias,
  handleCluePromote,
  handleConflict,
  handleDedupe,
  handleExtract,
  handleForget,
  handleLinkSuggest,
  handleReferenceRot,
  registerConsolidationJobs,
  startConsolidationLoop,
  type ConsolidationDeps,
} from './consolidate.js'
