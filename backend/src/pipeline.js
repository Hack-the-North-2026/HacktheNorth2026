import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectTempPaths,
  deleteTempPaths,
  isTimeoutError,
  releaseUpload,
  scrubChipKeys,
} from './cleanup.js';
import { downscaleUpload } from './downscale.js';
import { createJob, updateJob } from './jobs.js';
import { persistRecentSearch, sanitizeDeviceId } from './recentSearches.js';
import { Sentry } from './sentry.js';
import { agentLog, jobMsg, logger } from './logger.js';
import { perceive, perceiveVideo, resolveSourceMode, sourceAndRank } from './tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_RESULT = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/identify-result.mock.json'), 'utf8'),
);

const ALLOWED_ORIGINS = new Set([
  'app',
  'android_overlay',
  'android_qs',
  'share',
  'ios_share',
]);
const IMAGE_MIME = /^image\/(jpeg|jpg|pjpeg|png|webp|heic|heif|gif)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif)$/i;
const VIDEO_MIME = /^video\/(mp4|quicktime|webm|x-m4v|x-matroska)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv)$/i;
const ALLOWED_MATCH = new Set(['exact', 'similar']);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 120_000);

export function isImageUpload(file) {
  if (!file) return false;
  if (file.mimetype && IMAGE_MIME.test(file.mimetype)) return true;
  if (file.originalname && IMAGE_EXT.test(file.originalname)) return true;
  return false;
}

export function isVideoUpload(file) {
  if (!file) return false;
  if (file.mimetype && VIDEO_MIME.test(file.mimetype)) return true;
  if (file.originalname && VIDEO_EXT.test(file.originalname)) return true;
  return false;
}

export function parseMockFlags() {
  const raw = process.env.IDENTIFY_MOCK;
  if (raw === undefined) {
    // Stage 1 is live by default now that See and Source/Rank are implemented.
    return new Set();
  }
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'none' || trimmed === '0') return new Set();
  return new Set(trimmed.split(',').map((flag) => flag.trim()).filter(Boolean));
}

function normalizeGarment(garment, index) {
  if (!garment || typeof garment !== 'object') return null;
  return {
    id: String(garment.id || `garment-${index + 1}`),
    category: garment.category || 'accessory',
    description: garment.description || garment.search_query || 'Clothing item',
    search_query: garment.search_query || garment.description || 'clothing',
    attributes: garment.attributes || { color: 'unknown' },
    brand: garment.brand ?? null,
    brand_cues: Array.isArray(garment.brand_cues) ? garment.brand_cues : [],
    confidence: Number(garment.confidence ?? 0),
    bbox: Array.isArray(garment.bbox) ? garment.bbox : [0, 0, 0, 0],
    chip_key: garment.chip_key || '',
    accessibility_line: garment.accessibility_line || garment.description || '',
    source_frame_index: garment.source_frame_index ?? null,
  };
}

function normalizeMatches(matches) {
  return (Array.isArray(matches) ? matches : [])
    .filter((match) => match && ALLOWED_MATCH.has(match.match_type))
    .slice(0, 3)
    .map((match) => ({
      title: match.title || 'Product',
      url: match.url || '',
      image_url: match.image_url,
      price: match.price,
      currency: match.currency,
      store_name: match.store_name,
      source: match.source || 'shopify',
      raw_score: match.raw_score,
      match_type: match.match_type,
      confidence: Number(match.confidence ?? 0),
      reason: match.reason || '',
    }));
}

function mockMatchesFor(garment) {
  const hit = MOCK_RESULT.items.find((item) => item.garment.category === garment.category);
  if (hit) return normalizeMatches(hit.matches);

  const label = garment.description || garment.search_query || 'Similar item';
  return normalizeMatches([
    {
      title: label,
      url: `https://www.shopify.com/example/${encodeURIComponent(garment.category || 'item')}`,
      image_url: `https://picsum.photos/seed/${encodeURIComponent(garment.id || garment.category || 'item')}/400/500`,
      price: '64.00',
      currency: 'CAD',
      store_name: 'Similar Finds',
      source: 'shopify',
      match_type: 'similar',
      confidence: 0.62,
      reason: `Similar ${garment.category || 'item'} with a comparable color and silhouette.`,
    },
  ]);
}

function mockSeeResult() {
  return {
    garments: MOCK_RESULT.items.map((item) => item.garment),
    outfit_summary: MOCK_RESULT.outfit_summary || '',
  };
}

function commit(jobId, ctx, patch) {
  if (ctx.cancelled) return null;
  const next = updateJob(jobId, patch);
  if (next?.status === 'done') {
    void persistRecentSearch(next, ctx.deviceId);
  }
  return next;
}

export function startIdentifyJob({ origin = 'app', file, deviceId, type } = {}) {
  const jobOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'app';
  const mediaType = type === 'video' || isVideoUpload(file) ? 'video' : 'image';
  const job = createJob({
    job_id: randomUUID(),
    status: 'queued',
    origin: jobOrigin,
    items: [],
  });

  const ctx = { cancelled: false, deviceId: sanitizeDeviceId(deviceId) };
  const limit = setTimeout(() => {
    ctx.cancelled = true;
    logger.error(jobMsg(job.job_id, `timed out — ${mediaType} took too long to identify`));
    updateJob(job.job_id, {
      status: 'error',
      error: `This ${mediaType} took too long to identify. Try another ${mediaType === 'video' ? 'clip' : 'screenshot'}.`,
    });
  }, JOB_TIMEOUT_MS);
  limit.unref();

  void runPipeline(job.job_id, file, ctx, jobOrigin, mediaType)
    .catch((error) => {
      logger.error(jobMsg(job.job_id, 'pipeline failed'), error);
      Sentry.captureException(error);
      commit(job.job_id, ctx, {
        status: 'error',
        error: isTimeoutError(error)
          ? `This ${mediaType} took too long to identify. Try another ${mediaType === 'video' ? 'clip' : 'screenshot'}.`
          : `Something went wrong identifying this ${mediaType}. Try another ${mediaType === 'video' ? 'clip' : 'screenshot'}.`,
      });
    })
    .finally(() => {
      clearTimeout(limit);
      releaseUpload(file);
    });

  return job;
}

async function runPipeline(jobId, file, ctx, origin = 'app', mediaType = 'image') {
  const mocks = parseMockFlags();
  const temps = [];

  return Sentry.startSpan(
    { name: 'identify', op: 'identify', attributes: { job_id: jobId, origin, media_type: mediaType } },
    async () => {
  try {
    logger.info(jobMsg(jobId, `started — identifying ${mediaType} (from ${origin})`));
    Sentry.logger.info('identify.started', { job_id: jobId, origin, media_type: mediaType });
    // #region agent log
    agentLog('F', 'pipeline.js:start', 'job started', {
      jobId,
      origin,
      mediaType,
      mocks: [...mocks],
      mime: file?.mimetype || null,
      bytes: file?.size || file?.buffer?.length || 0,
      filename: file?.originalname || null,
    });
    // #endregion
    commit(jobId, ctx, { status: 'ingesting' });
    logger.info(jobMsg(jobId, `ingest — preparing ${mediaType}`));
    if (mediaType === 'image') {
      await downscaleUpload(file, jobId);
    }
    commit(jobId, ctx, { status: 'seeing' });

    let perceived;
    try {
      if (mocks.has('see')) {
        logger.warn(jobMsg(jobId, 'see — using mock clothes (IDENTIFY_MOCK=see)'));
        perceived = mockSeeResult();
      } else if (mediaType === 'video') {
        perceived = await perceiveVideo(file, jobId);
      } else {
        perceived = await perceive(file, jobId);
      }
    } catch (error) {
      logger.error(jobMsg(jobId, 'see — Baseten/AI failed'), error);
      commit(jobId, ctx, {
        status: 'error',
        error: isTimeoutError(error)
          ? `This ${mediaType} took too long to analyze. Try another ${mediaType === 'video' ? 'clip' : 'screenshot'}.`
          : `We couldn't analyze this ${mediaType}. Try another ${mediaType === 'video' ? 'clip' : 'screenshot'}.`,
      });
      return;
    }

    temps.push(...collectTempPaths(perceived || {}));

    const garments = (perceived?.garments || [])
      .map((garment, index) => normalizeGarment(garment, index))
      .filter((garment) => garment && garment.confidence >= 0.5);

    if (garments.length === 0) {
      logger.info(jobMsg(jobId, `done — no clothes found in this ${mediaType}`));
      Sentry.logger.info('identify.done', {
        job_id: jobId,
        origin,
        garment_count: 0,
        shopify_hits: 0,
      });
      // #region agent log
      agentLog('A', 'pipeline.js:empty', 'no garments after confidence filter', {
        jobId,
        outfit_summary: perceived?.outfit_summary || '',
        rawCount: (perceived?.garments || []).length,
      });
      // #endregion
      commit(jobId, ctx, {
        status: 'done',
        outfit_summary: perceived?.outfit_summary || '',
        items: [],
      });
      return;
    }

    const names = garments.map((garment) => garment.category).join(', ');
    logger.info(jobMsg(jobId, `see — ${garments.length} clothes: ${names}`));
    // #region agent log
    agentLog('A', 'pipeline.js:see', 'garments after see+crop+confidence filter', {
      jobId,
      outfit_summary: perceived?.outfit_summary || '',
      rawCount: (perceived?.garments || []).length,
      keptCount: garments.length,
      garments: garments.map((g) => ({
        id: g.id,
        category: g.category,
        description: g.description,
        search_query: g.search_query,
        brand: g.brand,
        brand_cues: g.brand_cues,
        confidence: g.confidence,
        bbox: g.bbox,
        hasChip: Boolean(g.chip_key && g.chip_key.includes('/')),
        accessibility_line: g.accessibility_line,
        attributes: g.attributes,
      })),
    });
    // #endregion
    temps.push(...collectTempPaths({ garments }));

    commit(jobId, ctx, {
      status: 'sourcing',
      outfit_summary: perceived.outfit_summary || '',
      items: garments.map((garment) => ({ garment, matches: [] })),
    });

    const forceMockSource = mocks.has('source');
    const sourceMode = await resolveSourceMode(forceMockSource);
    if (sourceMode === 'mock') {
      logger.warn(jobMsg(jobId, 'source — Shopify tools unavailable, using mock matches'));
    } else {
      logger.info(jobMsg(jobId, 'source — Shopify yes · Browserbase skipped · Composio skipped'));
    }

    let ranked;
    try {
      ranked = await Promise.all(
        garments.map(async (garment) => {
          if (sourceMode === 'mock') {
            return { garment, matches: mockMatchesFor(garment) };
          }
          const matches = await sourceAndRank(garment, jobId);
          if (matches == null) {
            logger.warn(jobMsg(jobId, `source — ${garment.category}: no live results, using mock matches`));
            // #region agent log
            agentLog('D', 'pipeline.js:mockFallback', 'used mock matches', { jobId, category: garment.category });
            // #endregion
            return { garment, matches: mockMatchesFor(garment) };
          }
          return { garment, matches: normalizeMatches(matches) };
        }),
      );
    } catch (error) {
      logger.error(jobMsg(jobId, 'source — shop search failed'), error);
      commit(jobId, ctx, {
        status: 'error',
        error: isTimeoutError(error)
          ? 'Shop search timed out. Try again in a moment.'
          : "We found the clothes but couldn't search shops. Try again in a moment.",
      });
      return;
    }

    commit(jobId, ctx, { status: 'ranking' });
    const matchCount = ranked.reduce((count, item) => count + item.matches.length, 0);
    logger.info(jobMsg(jobId, `rank — finished for all garments`));
    logger.info(jobMsg(jobId, `done — ${ranked.length} clothes, ${matchCount} shop matches`));
    Sentry.logger.info('identify.done', {
      job_id: jobId,
      origin,
      garment_count: ranked.length,
      shopify_hits: matchCount,
    });
    // #region agent log
    agentLog('D', 'pipeline.js:done', 'identify result', {
      jobId,
      sourceMode,
      clothes: ranked.length,
      matchCount,
      items: ranked.map((item) => ({
        category: item.garment?.category,
        search_query: item.garment?.search_query,
        usedMock: sourceMode === 'mock',
        matchCount: (item.matches || []).length,
        matches: (item.matches || []).map((m) => ({
          title: m.title,
          match_type: m.match_type,
          source: m.source,
          store_name: m.store_name,
          price: m.price,
          currency: m.currency,
          hasUrl: Boolean(m.url),
          hasImage: Boolean(m.image_url),
          reason: m.reason,
          confidence: m.confidence,
        })),
      })),
    });
    // #endregion
    commit(jobId, ctx, {
      status: 'done',
      items: scrubChipKeys(ranked),
    });
  } finally {
    await deleteTempPaths(temps);
  }
  });
}
