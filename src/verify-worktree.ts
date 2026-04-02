import * as worktree from "./worktree.js";

export function reviewScopeVerifierName(scopeId: string): string {
  return `verify-scope-${scopeId}`;
}

export function cleanupReviewScopeVerifierWorktree(
  feature: string,
  scopeId: string,
  projectRoot: string = process.cwd(),
): void {
  const verifierName = reviewScopeVerifierName(scopeId);
  worktree.remove(verifierName, projectRoot, true);
  worktree.deleteBranch(feature, verifierName, projectRoot, true);
}
