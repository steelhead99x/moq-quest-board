// Status derivation, kept pure so it can be tested with canned `quest unblocked --json` data.

/** Whether a `## Waiting` party is the maintainer, the reader of the Inbox's "you". */
export const isMaintainer = (party) => /^maintainer$/i.test(String(party).trim());

/** True when any waiting item needs the maintainer. */
export const waitsOnMaintainer = (waiting) => waiting.some((w) => isMaintainer(w.party));

/** Index `quest unblocked --json` output by path. */
export function readyIndex(list) {
  const m = new Map();
  for (const r of list) if (r && typeof r.path === 'string') m.set(r.path, r);
  return m;
}

/**
 * The status of one parsed quest given the ranking `quest unblocked` printed (a Map from path
 * to `{dependents}`), whatever its kind: epics and milestones are ready once their children
 * are gone. Only a README outside the ranking is an `epic`.
 *
 *   root      the tree's own README
 *   ready     in the ranking, nothing waiting
 *   needs-you in the ranking, with a Waiting item for the maintainer
 *   waiting   in the ranking, waiting only on outside parties
 *   epic      a milestone or epic README not in the ranking
 *   blocked   anything else
 */
export function deriveStatus(q, readyMap) {
  if (q.kind === 'root') return 'root';
  if (readyMap.has(q.id)) {
    if (!q.waiting.length) return 'ready';
    return waitsOnMaintainer(q.waiting) ? 'needs-you' : 'waiting';
  }
  return q.kind === 'milestone' || q.kind === 'epic' ? 'epic' : 'blocked';
}
