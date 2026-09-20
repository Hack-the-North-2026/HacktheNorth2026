import { agentLog, jobMsg, logger } from './logger.js';
import {
  browseCandidates,
  judgeCandidates,
  rankMatches,
  resolveSourceMode,
  retrieveCandidates,
  sourceAndRank,
} from './tools.js';

export const EXACT_VISUAL_THRESHOLD = 0.82;
export const WEAK_VISUAL_THRESHOLD = 0.62;

export function needsBrowse(best, candidateCount) {
  if (!candidateCount) return true;
  if (best == null || !Number.isFinite(Number(best))) return true;
  return Number(best) < WEAK_VISUAL_THRESHOLD;
}

export function shouldEarlyExit(best) {
  return Number.isFinite(Number(best)) && Number(best) >= EXACT_VISUAL_THRESHOLD;
}

export function needsReformulate(best) {
  if (best == null || !Number.isFinite(Number(best))) return false;
  const score = Number(best);
  return score >= WEAK_VISUAL_THRESHOLD && score < EXACT_VISUAL_THRESHOLD;
}

export function reformulateGarment(garment) {
  const queries = [
    ...new Set((Array.isArray(garment?.queries) ? garment.queries : []).map((query) => String(query || '').trim()).filter(Boolean)),
  ];
  if (queries.length < 2) return garment;
  const rotated = [...queries.slice(1), queries[0]].slice(0, 3);
  return { ...garment, search_query: rotated[0], queries: rotated };
}

export function withAltChip(garment) {
  const alt = garment?.alt_chip_key;
  if (!alt || typeof alt !== 'string') return garment;
  return { ...garment, chip_key: alt };
}

export function mergeBrowse(catalog, browsed, limit = 16) {
  const seen = new Set();
  const out = [];
  for (const item of [...(catalog || []), ...(browsed || [])]) {
    const url = String(item?.url || '').trim();
    if (!url) continue;
    let key = url;
    try {
      const parsed = new URL(url);
      key = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.toLowerCase().replace(/\/$/, '') || url;
    } catch {
      key = url.split('?')[0].toLowerCase();
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  const withImage = out.filter((item) => item.image_url);
  const without = out.filter((item) => !item.image_url);
  return [...withImage, ...without].slice(0, limit);
}

function onceStep(fn) {
  let pending = null;
  return (...args) => {
    if (!pending) pending = fn(...args);
    return pending;
  };
}

async function matchGarment(garment, jobId, tools, notes, prepare) {
  let next = garment;
  if (prepare) {
    next = (await prepare(garment)) || garment;
    if (next.dropped) return { dropped: true, garment: next.garment || garment };
  }

  const label = next?.category || next?.id || 'item';
  let candidates = [];
  await notes.sourcing();
  try {
    candidates = await tools.retrieve(next, jobId);
    logger.info(jobMsg(jobId, `source — ${label}: ${candidates.length} catalog hits`));
  } catch (error) {
    logger.warn(jobMsg(jobId, `source — ${label}: retrieve failed`));
    logger.warn(error instanceof Error ? error.message : String(error));
  }

  await notes.judging();
  let visualScores = [];
  let best = null;
  try {
    const result = await tools.judge(next, candidates, jobId);
    visualScores = result.visual_scores || [];
    best = result.best ?? null;
  } catch (error) {
    logger.warn(jobMsg(jobId, `judge — ${label}: visual compare failed`));
    logger.warn(error instanceof Error ? error.message : String(error));
  }

  if (needsReformulate(best)) {
    await notes.retrying('searching with a sharper query');
    try {
      const extra = await tools.retrieve(reformulateGarment(next), jobId);
      if (extra?.length) {
        candidates = mergeBrowse(candidates, extra);
      } else {
        logger.info(jobMsg(jobId, `source — ${label}: reformulate returned nothing new`));
      }
      const hasAlt = Boolean(next?.alt_chip_key);
      if (extra?.length || hasAlt) {
        const judgeGarment = hasAlt ? withAltChip(next) : next;
        const again = await tools.judge(judgeGarment, candidates, jobId);
        visualScores = again.visual_scores || [];
        best = again.best ?? best;
        logger.info(
          jobMsg(
            jobId,
            `source — ${label}: reformulate merged ${extra?.length || 0}${hasAlt ? ' + alt chip' : ''}, visual ${best ?? 'none'}`,
          ),
        );
      }
    } catch (error) {
      logger.warn(jobMsg(jobId, `source — ${label}: reformulate failed`));
      logger.warn(error instanceof Error ? error.message : String(error));
    }
  }

  if (!shouldEarlyExit(best) && needsBrowse(best, candidates.length)) {
    await notes.retrying('searching the open web');
    try {
      const browseGarment = next?.alt_chip_key ? withAltChip(next) : next;
      const browsed = await tools.browse(browseGarment, jobId);
      if (!browsed?.length) {
        logger.info(jobMsg(jobId, `browse — ${label}: no reverse-image listings`));
      } else {
        candidates = mergeBrowse(candidates, browsed);
        const again = await tools.judge(browseGarment, candidates, jobId);
        visualScores = again.visual_scores || [];
        best = again.best ?? best;
        logger.info(
          jobMsg(
            jobId,
            `browse — ${label}: merged ${browsed.length} listings, visual ${best ?? 'none'}`,
          ),
        );
      }
    } catch (error) {
      logger.warn(jobMsg(jobId, `browse — ${label}: reverse-image failed, keeping catalog`));
      logger.warn(error instanceof Error ? error.message : String(error));
    }
  } else if (shouldEarlyExit(best)) {
    logger.info(jobMsg(jobId, `match — ${label}: skip Browserbase, visual confirmed an item`));
    agentLog('F', 'matchingLoop.js:earlyExit', 'skipped Browserbase', {
      jobId,
      category: label,
      best,
      candidates: candidates.length,
    });
  }

  await notes.ranking();
  let matches = [];
  try {
    matches = await tools.rank(next, candidates, visualScores, jobId);
  } catch (error) {
    logger.warn(jobMsg(jobId, `rank — ${label}: failed`));
    logger.warn(error instanceof Error ? error.message : String(error));
  }
  return { garment: next, matches };
}

async function runMatchLoop(garments, jobId, step, tools, prepare) {
  logger.info(jobMsg(jobId, `match — pipelined ${garments.length} garment${garments.length === 1 ? '' : 's'}`));
  const notes = {
    sourcing: onceStep(() => step('sourcing', 'searching catalogs')),
    judging: onceStep(() => step('judging', 'comparing product photos to the crop')),
    retrying: onceStep((note) => step('retrying', note)),
    ranking: onceStep(() => step('ranking', 'picking the best matches')),
  };
  const ranked = await Promise.all(
    garments.map((garment) => matchGarment(garment, jobId, tools, notes, prepare)),
  );
  const kept = ranked.filter((item) => !item.dropped);
  return kept.map(({ garment, matches }) => ({ garment, matches }));
}

export async function matchOutfit(garments, jobId, options = {}) {
  const {
    onStep,
    forceMock = false,
    resolveMode = resolveSourceMode,
    retrieve = retrieveCandidates,
    judge = judgeCandidates,
    browse = browseCandidates,
    rank = rankMatches,
    sourceRank = sourceAndRank,
    prepare,
  } = options;
  const step = async (status, note) => {
    if (onStep) await onStep(status, note);
  };
  const mode = await resolveMode(forceMock);
  if (mode === 'match-loop') {
    return runMatchLoop(garments, jobId, step, { retrieve, judge, browse, rank }, prepare);
  }

  await step('sourcing', 'searching catalogs');
  const ranked = await Promise.all(
    garments.map(async (garment) => {
      const matches = await sourceRank(garment, jobId);
      return { garment, matches };
    }),
  );
  await step('ranking', 'picking the best matches');
  return ranked;
}
