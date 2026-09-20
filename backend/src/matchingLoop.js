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

async function runMatchLoop(garments, jobId, step, tools) {
  await step('sourcing', 'searching catalogs');
  const retrieved = await Promise.all(
    garments.map(async (garment) => {
      const label = garment?.category || garment?.id || 'item';
      try {
        const candidates = await tools.retrieve(garment, jobId);
        logger.info(jobMsg(jobId, `source — ${label}: ${candidates.length} catalog hits`));
        return { garment, candidates };
      } catch (error) {
        logger.warn(jobMsg(jobId, `source — ${label}: retrieve failed`));
        logger.warn(error instanceof Error ? error.message : String(error));
        return { garment, candidates: [] };
      }
    }),
  );

  await step('judging', 'comparing product photos to the crop');
  const judged = await Promise.all(
    retrieved.map(async (item) => {
      const label = item.garment?.category || item.garment?.id || 'item';
      try {
        const result = await tools.judge(item.garment, item.candidates, jobId);
        return {
          ...item,
          visual_scores: result.visual_scores || [],
          best: result.best ?? null,
        };
      } catch (error) {
        logger.warn(jobMsg(jobId, `judge — ${label}: visual compare failed`));
        logger.warn(error instanceof Error ? error.message : String(error));
        return { ...item, visual_scores: [], best: null };
      }
    }),
  );

  const mid = judged.filter((item) => needsReformulate(item.best));
  if (mid.length) {
    await step('retrying', 'searching with a sharper query');
    await Promise.all(
      mid.map(async (item) => {
        const label = item.garment?.category || item.garment?.id || 'item';
        try {
          const extra = await tools.retrieve(reformulateGarment(item.garment), jobId);
          if (extra?.length) {
            item.candidates = mergeBrowse(item.candidates, extra);
          } else {
            logger.info(jobMsg(jobId, `source — ${label}: reformulate returned nothing new`));
          }
          const hasAlt = Boolean(item.garment?.alt_chip_key);
          if (!extra?.length && !hasAlt) return;
          const judgeGarment = hasAlt ? withAltChip(item.garment) : item.garment;
          const again = await tools.judge(judgeGarment, item.candidates, jobId);
          item.visual_scores = again.visual_scores || [];
          item.best = again.best ?? item.best;
          logger.info(
            jobMsg(
              jobId,
              `source — ${label}: reformulate merged ${extra?.length || 0}${hasAlt ? ' + alt chip' : ''}, visual ${item.best ?? 'none'}`,
            ),
          );
        } catch (error) {
          logger.warn(jobMsg(jobId, `source — ${label}: reformulate failed`));
          logger.warn(error instanceof Error ? error.message : String(error));
        }
      }),
    );
  }

  const weak = judged.filter((item) => !shouldEarlyExit(item.best) && needsBrowse(item.best, item.candidates.length));
  if (weak.length) {
    await step('retrying', 'searching the open web');
    await Promise.all(
      weak.map(async (item) => {
        const label = item.garment?.category || item.garment?.id || 'item';
        try {
          const browseGarment = item.garment?.alt_chip_key ? withAltChip(item.garment) : item.garment;
          const browsed = await tools.browse(browseGarment, jobId);
          if (!browsed?.length) {
            logger.info(jobMsg(jobId, `browse — ${label}: no reverse-image listings`));
            return;
          }
          item.candidates = mergeBrowse(item.candidates, browsed);
          const again = await tools.judge(item.garment, item.candidates, jobId);
          item.visual_scores = again.visual_scores || [];
          item.best = again.best ?? item.best;
          logger.info(
            jobMsg(
              jobId,
              `browse — ${label}: merged ${browsed.length} listings, visual ${item.best ?? 'none'}`,
            ),
          );
        } catch (error) {
          logger.warn(jobMsg(jobId, `browse — ${label}: reverse-image failed, keeping catalog`));
          logger.warn(error instanceof Error ? error.message : String(error));
        }
      }),
    );
  } else if (judged.some((item) => shouldEarlyExit(item.best))) {
    logger.info(jobMsg(jobId, 'match — skip Browserbase, visual confirmed an item'));
    agentLog('F', 'matchingLoop.js:earlyExit', 'skipped Browserbase', {
      jobId,
      garments: judged.map((item) => ({
        category: item.garment?.category,
        best: item.best,
        candidates: item.candidates.length,
      })),
    });
  } else {
    logger.info(jobMsg(jobId, 'match — skip Browserbase, catalog visual is similar not weak'));
  }

  await step('ranking', 'picking the best matches');
  return Promise.all(
    judged.map(async (item) => {
      const label = item.garment?.category || item.garment?.id || 'item';
      try {
        const matches = await tools.rank(item.garment, item.candidates, item.visual_scores, jobId);
        return { garment: item.garment, matches };
      } catch (error) {
        logger.warn(jobMsg(jobId, `rank — ${label}: failed`));
        logger.warn(error instanceof Error ? error.message : String(error));
        return { garment: item.garment, matches: [] };
      }
    }),
  );
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
  } = options;
  const step = async (status, note) => {
    if (onStep) await onStep(status, note);
  };
  const mode = await resolveMode(forceMock);
  if (mode === 'match-loop') {
    return runMatchLoop(garments, jobId, step, { retrieve, judge, browse, rank });
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
