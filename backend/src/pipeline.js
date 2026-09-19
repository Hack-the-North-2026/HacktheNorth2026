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
import { Sentry } from './sentry.js';
import { perceive, resolveSourceMode, sourceAndRank } from './tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_RESULT = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/identify-result.mock.json'), 'utf8'),
);

const ALLOWED_ORIGINS = new Set(['app', 'android_overlay', 'android_qs', 'share']);
const IMAGE_MIME = /^image\/(jpeg|jpg|pjpeg|png|webp|heic|heif|gif)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif)$/i;
const ALLOWED_MATCH = new Set(['exact', 'similar']);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 90_000);

export function isImageUpload(file) {
  if (!file) return false;
  if (file.mimetype && IMAGE_MIME.test(file.mimetype)) return true;
  if (file.originalname && IMAGE_EXT.test(file.originalname)) return true;
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
  return updateJob(jobId, patch);
}

export function startIdentifyJob({ origin = 'app', file } = {}) {
  const jobOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'app';
  const job = createJob({
    job_id: randomUUID(),
    status: 'queued',
    origin: jobOrigin,
    items: [],
  });

  const ctx = { cancelled: false };
  const limit = setTimeout(() => {
    ctx.cancelled = true;
    updateJob(job.job_id, {
      status: 'error',
      error: 'This photo took too long to identify. Try another screenshot.',
    });
  }, JOB_TIMEOUT_MS);
  limit.unref();

  void runPipeline(job.job_id, file, ctx, jobOrigin)
    .catch((error) => {
      console.error('[pipeline]', error);
      commit(job.job_id, ctx, {
        status: 'error',
        error: isTimeoutError(error)
          ? 'This photo took too long to identify. Try another screenshot.'
          : 'Something went wrong identifying this photo. Try another screenshot.',
      });
    })
    .finally(() => {
      clearTimeout(limit);
      releaseUpload(file);
    });

  return job;
}

async function runPipeline(jobId, file, ctx, origin = 'app') {
  const mocks = parseMockFlags();
  const temps = [];

  return Sentry.startSpan(
    { name: 'identify', op: 'identify', attributes: { job_id: jobId, origin } },
    async () => {
  try {
    commit(jobId, ctx, { status: 'ingesting' });
    await downscaleUpload(file);
    commit(jobId, ctx, { status: 'seeing' });

    let perceived;
    try {
      perceived = mocks.has('see') ? mockSeeResult() : await perceive(file);
    } catch (error) {
      console.error('[see]', error.message);
      commit(jobId, ctx, {
        status: 'error',
        error: isTimeoutError(error)
          ? 'This photo took too long to analyze. Try another screenshot.'
          : "We couldn't analyze this photo. Try another screenshot.",
      });
      return;
    }

    temps.push(...collectTempPaths(perceived || {}));

    const garments = (perceived?.garments || [])
      .map((garment, index) => normalizeGarment(garment, index))
      .filter((garment) => garment && garment.confidence >= 0.5);

    if (garments.length === 0) {
      console.log('[identify]', { job_id: jobId, origin, status: 'done', garment_count: 0 });
      commit(jobId, ctx, {
        status: 'done',
        outfit_summary: perceived?.outfit_summary || '',
        items: [],
      });
      return;
    }

    temps.push(...collectTempPaths({ garments }));

    commit(jobId, ctx, {
      status: 'sourcing',
      outfit_summary: perceived.outfit_summary || '',
      items: garments.map((garment) => ({ garment, matches: [] })),
    });

    const forceMockSource = mocks.has('source');
    const sourceMode = await resolveSourceMode(forceMockSource);

    let ranked;
    try {
      ranked = await Promise.all(
        garments.map(async (garment) => {
          if (sourceMode === 'mock') {
            return { garment, matches: mockMatchesFor(garment) };
          }
          const matches = await sourceAndRank(garment);
          if (matches == null) {
            return { garment, matches: mockMatchesFor(garment) };
          }
          return { garment, matches: normalizeMatches(matches) };
        }),
      );
    } catch (error) {
      console.error('[source]', error.message);
      commit(jobId, ctx, {
        status: 'error',
        error: isTimeoutError(error)
          ? 'Shop search timed out. Try again in a moment.'
          : "We found the clothes but couldn't search shops. Try again in a moment.",
      });
      return;
    }

    commit(jobId, ctx, { status: 'ranking' });
    console.log('[identify]', { job_id: jobId, origin, status: 'done', garment_count: ranked.length });
    commit(jobId, ctx, {
      status: 'done',
      items: scrubChipKeys(ranked),
    });
  } finally {
    await deleteTempPaths(temps);
  }
  });
}
