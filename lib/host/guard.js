import { statusFingerprint } from './git.js';

export async function captureWorkspaceState({ cwd, signal }) {
  const fingerprint = await statusFingerprint(cwd, { signal });
  return { combined: fingerprint.available ? fingerprint.combined : null, at: new Date().toISOString() };
}

export function detectWorkspaceMutation(before, after) {
  if (before?.combined == null || after?.combined == null) return { mutated: false, reason: 'unavailable' };
  return before.combined === after.combined ? { mutated: false } : { mutated: true, reason: 'workspace_mutated_during_review' };
}
