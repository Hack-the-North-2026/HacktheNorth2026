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
import { attachClipHash, clipCacheKey, downscaleUpload } from './downscale.js';
import { getCachedIdentify, setCachedIdentify } from './identifyCache.js';
import { createJob, publishJobKeyframes, updateJob } from './jobs.js';
import { persistRecentSearch, sanitizeDeviceId } from './recentSearches.js';
import { canonicalizeQuery } from './queryCanonicalize.js';
import { Sentry } from './sentry.js';
import { agentLog, jobMsg, logger } from './logger.js';
import { ingestVideo, perceive, perceiveVideo, resolveSourceMode, seeChips, seeVideoFrames } from './tools.js';
import { matchOutfit } from './matchingLoop.js';
import { diagnoseFailStage, exactCount, preferStrongExact, seechipQueryCount } from './matchDisplay.js';

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
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 270_000);

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
  const searchQuery = canonicalizeQuery(garment.search_query || garment.description || 'clothing');
  const queries = Array.isArray(garment.queries)
    ? [...new Set(garment.queries.map((query) => canonicalizeQuery(query)).filter(Boolean))].slice(0, 3)
    : [];
  if (searchQuery && !queries.includes(searchQuery)) queries.unshift(searchQuery);
  return {
    id: String(garment.id || `garment-${index + 1}`),
    category: garment.category || 'accessory',
    description: garment.description || garment.search_query || 'Clothing item',
    search_query: searchQuery,
    queries: queries.slice(0, 3),
    attributes: garment.attributes || { color: 'unknown' },
    brand: garment.brand ?? null,
    brand_cues: Array.isArray(garment.brand_cues) ? garment.brand_cues : [],
    confidence: Number(garment.confidence ?? 0),
    bbox: Array.isArray(garment.bbox) ? garment.bbox : [0, 0, 0, 0],
    chip_key: garment.chip_key || '',
    alt_chip_key: garment.alt_chip_key || '',
    accessibility_line: garment.accessibility_line || garment.description || '',
    source_frame_index: garment.source_frame_index ?? null,
    crop_fallback: Boolean(garment.crop_fallback),
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
      visual_score: Number.isFinite(Number(match.visual_score)) ? Number(match.visual_score) : undefined,
      visual_label: match.visual_label,
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

function bestVisualScore(ranked) {
  let best = null;
  for (const item of ranked || []) {
    for (const match of item.matches || []) {
      const score = Number(match.visual_score);
      if (!Number.isFinite(score)) continue;
      best = best == null ? score : Math.max(best, score);
    }
  }
  return best;
}

function matchingFields(garments, extra = {}) {
  return {
    image_hash: extra.image_hash || null,
    phash: extra.phash || null,
    search_query: (garments || []).map((g) => g?.search_query).filter(Boolean),
    visual_score: extra.visual_score ?? null,
    ...extra,
  };
}

function cachedIdentifyPayload(perceived, items, extra = {}) {
  const keyframes = extra.keyframes || [];
  return {
    outfit_summary: perceived?.outfit_summary || extra.outfit_summary || '',
    items: items || [],
    keyframes,
    thumbnail_url: extra.thumbnail_url || keyframes[0] || undefined,
    frame_count: extra.frame_count ?? perceived?.frame_count ?? 0,
    selected_frames: extra.selected_frames ?? perceived?.selected_frames ?? 0,
    clip_duration: extra.clip_duration ?? perceived?.duration ?? null,
    empty_reason: extra.empty_reason || perceived?.empty_reason,
  };
}

function cacheIdentifyResult(imageHash, phash, mocks, usedMock, payload) {
  if (!imageHash || usedMock || mocks.size > 0) return;
  if (!payload?.items?.length) return;
  setCachedIdentify(imageHash, payload, phash);
  const durationKey = clipCacheKey(imageHash, payload.clip_duration);
  if (durationKey && durationKey !== imageHash) {
    setCachedIdentify(durationKey, payload, phash);
  }
}

function publicKeyframes(jobId, keyframes) {
  return publishJobKeyframes(jobId, keyframes);
}

function commit(jobId, ctx, patch) {
  if (ctx.cancelled) return null;
  const next = updateJob(jobId, patch);
  if (next?.status === 'done') {
    void persistRecentSearch(next, ctx.deviceId);
  }
  return next;
}

function step(jobId, ctx, status, note, extra = {}) {
  ctx.steps = [...(ctx.steps || []), { status, at: new Date().toISOString(), note }];
  return commit(jobId, ctx, { status, steps: ctx.steps, ...extra });
}

export function startIdentifyJob({ origin = 'app', file, deviceId, type, deps = {} } = {}) {
  const jobOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'app';
  const mediaType = type === 'video' || isVideoUpload(file) ? 'video' : 'image';
  const job = createJob({
    job_id: randomUUID(),
    status: 'queued',
    origin: jobOrigin,
    media_type: mediaType,
    device_id: sanitizeDeviceId(deviceId),
    items: [],
  });

  const ctx = { cancelled: false, deviceId: sanitizeDeviceId(deviceId), steps: [] };
  const limit = setTimeout(() => {
    ctx.cancelled = true;
    logger.error(jobMsg(job.job_id, `timed out — ${mediaType} took too long to identify`));
    updateJob(job.job_id, {
      status: 'error',
      error: `This ${mediaType} took too long to identify. Try another ${mediaType === 'video' ? 'clip' : 'screenshot'}.`,
    });
  }, JOB_TIMEOUT_MS);
  limit.unref();

  void runPipeline(job.job_id, file, ctx, jobOrigin, mediaType, deps)
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

async function runPipeline(jobId, file, ctx, origin = 'app', mediaType = 'image', deps = {}) {
  const perceiveFn = deps.perceive || perceive;
  const perceiveVideoFn = deps.perceiveVideo || perceiveVideo;
  const ingestVideoFn = deps.ingestVideo || ingestVideo;
  const seeVideoFramesFn = deps.seeVideoFrames || seeVideoFrames;
  const seeChipsFn = deps.seeChips || seeChips;
  const matchOutfitFn = deps.matchOutfit || matchOutfit;
  const resolveSourceModeFn = deps.resolveSourceMode || resolveSourceMode;
  const mocks = parseMockFlags();
  const temps = [];
  let ingestMs = null;
  let seeMs = null;
  let frameCount = 0;
  let selectedFrames = 0;
  let clipDuration = null;
  let emptyReason;
  let cachedKeyframes = [];

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
    } else if (mediaType === 'video') {
      attachClipHash(file);
      if (file?.image_hash) {
        logger.info(jobMsg(jobId, `ingest — clip_hash ${String(file.image_hash).slice(0, 12)}`));
      }
    }
    const imageHash = file?.image_hash || null;
    const phash = mediaType === 'image' ? file?.phash || null : null;
    try {
      Sentry.getActiveSpan()?.setAttribute('image_hash', imageHash || '');
      if (phash) Sentry.getActiveSpan()?.setAttribute('phash', phash);
    } catch {
      // Tracing attributes are optional.
    }

    const cached = getCachedIdentify(imageHash, phash);
    if (cached) {
      logger.info(jobMsg(jobId, `cache hit — returning identical IdentifyResult (${String(imageHash).slice(0, 12)})`));
      Sentry.logger.info('identify.cache_hit', {
        job_id: jobId,
        origin,
        ...matchingFields(cached.items?.map((item) => item.garment) || [], {
          image_hash: imageHash,
          phash,
          garment_count: cached.items?.length || 0,
        }),
      });
      // #region agent log
      agentLog('F', 'pipeline.js:cache', 'identify cache hit', {
        jobId,
        imageHash,
        phash,
        clothes: cached.items?.length || 0,
      });
      // #endregion
      const keyframes = publicKeyframes(jobId, cached.keyframes || []);
      commit(jobId, ctx, {
        status: 'done',
        outfit_summary: cached.outfit_summary || '',
        items: cached.items || [],
        steps: ctx.steps,
        keyframes,
        thumbnail_url: keyframes[0] || undefined,
        empty_reason: cached.empty_reason,
      });
      return;
    }
    let perceived;
    try {
      if (mocks.has('see')) {
        step(jobId, ctx, 'seeing', 'looking at the outfit');
        logger.warn(jobMsg(jobId, 'see — using mock clothes (IDENTIFY_MOCK=see)'));
        perceived = mockSeeResult();
      } else if (mediaType === 'video') {
        step(jobId, ctx, 'ingesting', 'pulling clear frames');
        const ingestStarted = Date.now();
        let ingested;
        try {
          ingested = await ingestVideoFn(file, jobId);
        } catch (ingestError) {
          if (ingestError.status === 404) {
            logger.warn(jobMsg(jobId, 'ingest — /tools/ingest missing, using identify-video'));
            step(jobId, ctx, 'seeing', 'reading the outfit across frames');
            const seeStarted = Date.now();
            perceived = await perceiveVideoFn(file, jobId);
            seeMs = Date.now() - seeStarted;
            emptyReason = perceived?.empty_reason || emptyReason;
            frameCount = Number(perceived?.frame_count || 0);
            selectedFrames = Number(perceived?.selected_frames || perceived?.keyframes?.length || 0);
            clipDuration = Number.isFinite(Number(perceived?.duration)) ? Number(perceived.duration) : clipDuration;
            cachedKeyframes = perceived?.keyframes || [];
            if (perceived?.keyframes?.length) {
              perceived.keyframes = publicKeyframes(jobId, perceived.keyframes);
            }
          } else {
            throw ingestError;
          }
        }
        if (!perceived) {
          ingestMs = Date.now() - ingestStarted;
          frameCount = Number(ingested?.frame_count || 0);
          selectedFrames = Number(ingested?.selected_frames || ingested?.image_paths?.length || 0);
          clipDuration = Number.isFinite(Number(ingested?.duration)) ? Number(ingested.duration) : clipDuration;
          temps.push(...collectTempPaths(ingested || {}));
          const rawKeyframes = ingested?.keyframes || [];
          cachedKeyframes = rawKeyframes;
          const keyframes = publicKeyframes(jobId, rawKeyframes);
          if (ingested) ingested.keyframes = keyframes;
          commit(jobId, ctx, {
            keyframes,
            thumbnail_url: keyframes[0] || undefined,
          });
          try {
            const span = Sentry.getActiveSpan();
            span?.setAttribute('frame_count', frameCount);
            span?.setAttribute('selected_frames', selectedFrames);
            span?.setAttribute('ingest_ms', ingestMs);
          } catch {
            // Tracing attributes are optional.
          }
          Sentry.logger.info('identify.ingest', {
            job_id: jobId,
            origin,
            media_type: mediaType,
            frame_count: frameCount,
            selected_frames: selectedFrames,
            ingest_ms: ingestMs,
            clip_duration: clipDuration,
            image_hash: imageHash,
          });
          if (!ingested?.image_paths?.length) {
            emptyReason = 'ingest';
            perceived = {
              garments: [],
              outfit_summary: ingested?.outfit_summary || "Couldn't find a clear enough view of the outfit in this clip.",
              keyframes,
              frame_count: frameCount,
              selected_frames: selectedFrames,
              duration: clipDuration,
              empty_reason: 'ingest',
            };
          } else {
            step(jobId, ctx, 'seeing', 'reading the outfit across frames', {
              keyframes,
              thumbnail_url: keyframes[0] || undefined,
            });
            const seeStarted = Date.now();
            perceived = await seeVideoFramesFn(ingested, jobId);
            seeMs = Date.now() - seeStarted;
            perceived.keyframes = perceived.keyframes?.length ? perceived.keyframes : keyframes;
            try {
              Sentry.getActiveSpan()?.setAttribute('see_ms', seeMs);
            } catch {
              // Tracing attributes are optional.
            }
            Sentry.logger.info('identify.see', {
              job_id: jobId,
              origin,
              media_type: mediaType,
              frame_count: frameCount,
              selected_frames: selectedFrames,
              see_ms: seeMs,
            });
          }
        }
      } else {
        step(jobId, ctx, 'seeing', 'looking at the outfit');
        const seeStarted = Date.now();
        perceived = await perceiveFn(file, jobId, { detail: false });
        seeMs = Date.now() - seeStarted;
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

    let garments = (perceived?.garments || [])
      .map((garment, index) => normalizeGarment(garment, index))
      .filter((garment) => garment && garment.confidence >= 0.5);

    if (garments.length === 0) {
      logger.info(jobMsg(jobId, `done — no clothes found in this ${mediaType}`));
      const resolvedEmpty = emptyReason || (mediaType === 'video' ? 'see' : undefined);
      const failStage = diagnoseFailStage([], { empty_reason: resolvedEmpty, media_type: mediaType });
      Sentry.logger.info('identify.done', {
        job_id: jobId,
        origin,
        media_type: mediaType,
        garment_count: 0,
        shopify_hits: 0,
        fail_stage: failStage,
        ...matchingFields([], {
          image_hash: imageHash,
          phash,
          frame_count: frameCount || perceived?.frame_count || 0,
          selected_frames: selectedFrames || perceived?.selected_frames || 0,
          ingest_ms: ingestMs,
          see_ms: seeMs,
          clip_duration: clipDuration ?? perceived?.duration ?? null,
        }),
      });
      if (failStage === 'ingest') {
        Sentry.logger.warn('identify.exact_rate_zero', {
          job_id: jobId,
          origin,
          media_type: mediaType,
          fail_stage: 'ingest',
          frame_count: frameCount || perceived?.frame_count || 0,
          selected_frames: selectedFrames || perceived?.selected_frames || 0,
        });
      }
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
        keyframes: perceived?.keyframes || [],
        thumbnail_url: perceived?.keyframes?.[0] || undefined,
        empty_reason: emptyReason || 'see',
      });
      cacheIdentifyResult(
        imageHash,
        phash,
        mocks,
        false,
        cachedIdentifyPayload(perceived, [], {
          keyframes: cachedKeyframes,
          frame_count: frameCount || perceived?.frame_count || 0,
          selected_frames: selectedFrames || perceived?.selected_frames || 0,
          clip_duration: clipDuration ?? perceived?.duration ?? null,
          empty_reason: emptyReason || 'see',
        }),
      );
      return;
    }

    const names = garments.map((garment) => garment.category).join(', ');
    logger.info(jobMsg(jobId, `see — ${garments.length} clothes: ${names}`));
    for (const garment of garments) {
      if (!garment?.crop_fallback) continue;
      Sentry.logger.warn('video.crop_fallback', {
        job_id: jobId,
        garment_id: garment.id,
        source_frame_index: garment.source_frame_index,
      });
    }
    temps.push(...collectTempPaths({ garments }));

    step(jobId, ctx, 'detailing', 'reading each garment up close', {
      outfit_summary: perceived.outfit_summary || '',
      items: garments.map((garment) => ({ garment, matches: [] })),
      keyframes: perceived.keyframes || [],
      thumbnail_url: perceived.keyframes?.[0] || undefined,
    });

    if (!mocks.has('see')) {
      try {
        const detailed = await seeChipsFn(garments, jobId);
        garments = detailed
          .map((garment, index) => normalizeGarment(garment, index))
          .filter((garment) => garment && garment.confidence >= 0.5);
        temps.push(...collectTempPaths({ garments }));
        logger.info(jobMsg(jobId, `see-chip — detailed ${garments.length} clothes`));
      } catch (chipError) {
        logger.warn(jobMsg(jobId, 'see-chip — failed, using scene descriptions'));
        logger.warn(chipError instanceof Error ? chipError.message : String(chipError));
      }
    }

    // #region agent log
    agentLog('A', 'pipeline.js:see', 'garments after see+crop+SeeChip+confidence filter', {
      jobId,
      outfit_summary: perceived?.outfit_summary || '',
      rawCount: (perceived?.garments || []).length,
      keptCount: garments.length,
      garments: garments.map((g) => ({
        id: g.id,
        category: g.category,
        description: g.description,
        search_query: g.search_query,
        queries: g.queries,
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
    if (garments.length === 0) {
      commit(jobId, ctx, {
        status: 'done',
        outfit_summary: perceived?.outfit_summary || '',
        items: [],
        keyframes: perceived?.keyframes || [],
        thumbnail_url: perceived?.keyframes?.[0] || undefined,
        empty_reason: emptyReason || 'see',
      });
      cacheIdentifyResult(
        imageHash,
        phash,
        mocks,
        false,
        cachedIdentifyPayload(perceived, [], {
          keyframes: cachedKeyframes,
          frame_count: frameCount || perceived?.frame_count || 0,
          selected_frames: selectedFrames || perceived?.selected_frames || 0,
          clip_duration: clipDuration ?? perceived?.duration ?? null,
          empty_reason: emptyReason || 'see',
        }),
      );
      return;
    }

    const forceMockSource = mocks.has('source');
    const sourceMode = await resolveSourceModeFn(forceMockSource);
    if (sourceMode === 'mock') {
      logger.warn(jobMsg(jobId, 'source — Shopify tools unavailable, using mock matches'));
    } else {
      logger.info(jobMsg(jobId, 'match — retrieve → judge → maybe browse → rank'));
    }

    let usedMock = sourceMode === 'mock';
    let ranked;
    try {
      if (sourceMode === 'mock') {
        step(jobId, ctx, 'sourcing', 'searching catalogs');
        ranked = garments.map((garment) => ({ garment, matches: preferStrongExact(mockMatchesFor(garment)) }));
        step(jobId, ctx, 'ranking', 'picking the best matches');
      } else {
        const raw = await matchOutfitFn(garments, jobId, {
          onStep: (status, note) => step(jobId, ctx, status, note),
        });
        ranked = raw.map((item) => {
          if (item.matches == null) {
            logger.warn(jobMsg(jobId, `source — ${item.garment.category}: no live results`));
            return { garment: item.garment, matches: [] };
          }
          return { garment: item.garment, matches: preferStrongExact(normalizeMatches(item.matches)) };
        });
      }
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
    const matchCount = ranked.reduce((count, item) => count + item.matches.length, 0);
    const exacts = exactCount(ranked);
    const failStage = diagnoseFailStage(ranked);
    logger.info(jobMsg(jobId, `rank — finished for all garments`));
    logger.info(jobMsg(jobId, `done — ${ranked.length} clothes, ${matchCount} shop matches`));
    const doneFields = matchingFields(ranked.map((item) => item.garment), {
      image_hash: imageHash,
      phash,
      visual_score: bestVisualScore(ranked),
      exact_count: exacts,
      exact_rate: ranked.length ? Number((exacts / ranked.length).toFixed(3)) : 0,
      fail_stage: failStage,
      seechip_queries: seechipQueryCount(ranked),
      frame_count: frameCount || perceived?.frame_count || 0,
      selected_frames: selectedFrames || perceived?.selected_frames || 0,
      ingest_ms: ingestMs,
      see_ms: seeMs,
      clip_duration: clipDuration ?? perceived?.duration ?? null,
    });
    Sentry.logger.info('identify.done', {
      job_id: jobId,
      origin,
      media_type: mediaType,
      garment_count: ranked.length,
      shopify_hits: matchCount,
      ...doneFields,
    });
    if (failStage) {
      Sentry.logger.warn('identify.exact_rate_zero', {
        job_id: jobId,
        origin,
        media_type: mediaType,
        fail_stage: failStage,
        ...doneFields,
      });
    }
    try {
      const span = Sentry.getActiveSpan();
      span?.setAttribute('exact_count', exacts);
      span?.setAttribute('fail_stage', failStage || '');
      span?.setAttribute('visual_score', doneFields.visual_score ?? '');
      span?.setAttribute('seechip_queries', doneFields.seechip_queries);
      if (mediaType === 'video') {
        span?.setAttribute('frame_count', doneFields.frame_count);
        span?.setAttribute('selected_frames', doneFields.selected_frames);
        if (ingestMs != null) span?.setAttribute('ingest_ms', ingestMs);
        if (seeMs != null) span?.setAttribute('see_ms', seeMs);
        if (doneFields.clip_duration != null) span?.setAttribute('clip_duration', doneFields.clip_duration);
      }
    } catch {
      // Tracing attributes are optional.
    }
    // #region agent log
    agentLog('D', 'pipeline.js:done', 'identify result', {
      jobId,
      sourceMode,
      clothes: ranked.length,
      matchCount,
      items: ranked.map((item) => ({
        category: item.garment?.category,
        search_query: item.garment?.search_query,
        queries: item.garment?.queries,
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
          visual_score: m.visual_score,
          visual_label: m.visual_label,
        })),
      })),
    });
    // #endregion
    const items = scrubChipKeys(ranked);
    cacheIdentifyResult(
      imageHash,
      phash,
      mocks,
      usedMock,
      cachedIdentifyPayload(perceived, items, {
        keyframes: cachedKeyframes,
        frame_count: frameCount || perceived?.frame_count || 0,
        selected_frames: selectedFrames || perceived?.selected_frames || 0,
        clip_duration: clipDuration ?? perceived?.duration ?? null,
      }),
    );
    commit(jobId, ctx, {
      status: 'done',
      items,
      keyframes: perceived.keyframes || [],
      thumbnail_url: perceived.keyframes?.[0] || undefined,
    });
  } finally {
    await deleteTempPaths(temps);
  }
  });
}
