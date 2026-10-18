import { runCouncil } from './council.js';

/** Independent one-shot briefs and ballots; no discussion or minutes calls. */
export function runQuick(input, deps) {
  return runCouncil({ ...input, mode: 'quick' }, deps);
}
