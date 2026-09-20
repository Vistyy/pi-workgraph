export {
  applyOutput,
  classifyOutput,
  cleanupAppliedOutput,
  detachedPlacement,
  discardOutput,
  ensureDetachedWorktree,
  isAncestor,
  prepareApplication,
  prepareDiscard,
  type RepositoryOperation,
  resolveRevision,
  validateRetainedCandidate,
} from "./repository/candidate.js";

export { GitError, resolveTaskTarget } from "./repository/git.js";
