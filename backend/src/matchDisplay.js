/**
 * Display and diagnosis helpers for matching quality (Stage G).
 * Honest badges stay. One strong exact beats three weaks.
 */

export const EXACT_VISUAL_THRESHOLD = 0.82;

export function preferStrongExact(matches) {
  const list = Array.isArray(matches) ? matches : [];
  const exact = list.filter((match) => match?.match_type === 'exact');
  if (exact.length) return exact.slice(0, 1);
  return list.slice(0, 3);
}

export function exactCount(items) {
  let count = 0;
  for (const item of items || []) {
    for (const match of item.matches || []) {
      if (match?.match_type === 'exact') count += 1;
    }
  }
  return count;
}

export function seechipQueryCount(items) {
  let count = 0;
  for (const item of items || []) {
    const garment = item.garment || {};
    const queries = Array.isArray(garment.queries) ? garment.queries.filter(Boolean) : [];
    if (queries.length || garment.search_query) count += 1;
  }
  return count;
}

/**
 * When no card is exact, name the step that failed so the Sentry trace is actionable.
 * null means empty photo or at least one exact — not a matching miss.
 */
export function diagnoseFailStage(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  if (exactCount(list) > 0) return null;

  const queries = seechipQueryCount(list);
  const hits = list.reduce((n, item) => n + (item.matches || []).length, 0);
  let best = null;
  for (const item of list) {
    for (const match of item.matches || []) {
      const score = Number(match.visual_score);
      if (!Number.isFinite(score)) continue;
      best = best == null ? score : Math.max(best, score);
    }
  }

  if (queries === 0) return 'seechip';
  if (hits === 0) return 'retrieve';
  if (best == null) return 'judge';
  if (best < EXACT_VISUAL_THRESHOLD) return 'judge';
  return 'rank';
}
