import { readFileSync } from 'node:fs';
import path from 'node:path';
import { agentLog, jobMsg, logger } from './logger.js';

const AI_SERVICE_URL = () => process.env.AI_SERVICE_URL || 'http://localhost:8000';
const SEE_TIMEOUT_MS = Number(process.env.SEE_TIMEOUT_MS || 60_000);
const VIDEO_TIMEOUT_MS = Number(process.env.VIDEO_TIMEOUT_MS || 90_000);
const SEE_CHIP_TIMEOUT_MS = Number(process.env.SEE_CHIP_TIMEOUT_MS || 45_000);
const SOURCE_TIMEOUT_MS = Number(process.env.SOURCE_TIMEOUT_MS || 70_000);
const RETRIEVE_TIMEOUT_MS = Number(process.env.RETRIEVE_TIMEOUT_MS || 25_000);
const JUDGE_TIMEOUT_MS = Number(process.env.JUDGE_TIMEOUT_MS || 25_000);
const BROWSE_TIMEOUT_MS = Number(process.env.BROWSE_TIMEOUT_MS || 18_000);
const RANK_TIMEOUT_MS = Number(process.env.RANK_TIMEOUT_MS || 20_000);

let cachedSourceMode;

function toBlob(file) {
  const type = file.mimetype || 'image/jpeg';
  return new Blob([new Uint8Array(file.buffer)], { type });
}

export function imageFormData(file) {
  const form = new FormData();
  form.append('image', toBlob(file), file.originalname || 'screenshot.jpg');
  return form;
}

export function videoFormData(file) {
  const form = new FormData();
  const type = file.mimetype || 'video/mp4';
  const blob = new Blob([new Uint8Array(file.buffer)], { type });
  form.append('video', blob, file.originalname || 'clip.mp4');
  return form;
}

function fastapiDetail(data) {
  const detail = data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => item.msg || item.detail || JSON.stringify(item)).join('; ');
  }
  if (typeof data?.error === 'string') return data.error;
  return null;
}

async function parseJson(response) {
  return response.json().catch(() => ({}));
}

function jobHeaders(jobId, extra = {}) {
  const headers = jobId ? { ...extra, 'x-job-id': jobId } : { ...extra };
  const toolKey = process.env.TOOL_SERVER_SECRET;
  if (toolKey) headers['x-tool-key'] = toolKey;
  return headers;
}

export async function seeAndCrop(file, jobId, { detail = true } = {}) {
  const qs = detail ? '' : '?detail=0';
  const url = `${AI_SERVICE_URL()}/api/identify${qs}`;
  const response = await fetch(url, {
    method: 'POST',
    body: imageFormData(file),
    headers: jobHeaders(jobId),
    signal: AbortSignal.timeout(SEE_TIMEOUT_MS),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    const err = new Error(fastapiDetail(data) || `Perception failed (${response.status}).`);
    err.status = response.status;
    throw err;
  }
  return {
    garments: Array.isArray(data.garments) ? data.garments : [],
    outfit_summary: data.outfit_summary || '',
    image_path: data.image_path,
  };
}

export async function seeVideoAndCrop(file, jobId) {
  const url = `${AI_SERVICE_URL()}/api/identify-video`;
  const response = await fetch(url, {
    method: 'POST',
    body: videoFormData(file),
    headers: jobHeaders(jobId),
    signal: AbortSignal.timeout(VIDEO_TIMEOUT_MS),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    const err = new Error(fastapiDetail(data) || `Video perception failed (${response.status}).`);
    err.status = response.status;
    throw err;
  }
  return {
    garments: Array.isArray(data.garments) ? data.garments : [],
    outfit_summary: data.outfit_summary || '',
    image_path: data.image_path,
    frame_count: data.frame_count || 0,
    keyframes: Array.isArray(data.keyframes) ? data.keyframes : [],
  };
}

export async function perceiveVideo(file, jobId) {
  logger.info(jobMsg(jobId, 'see — analyzing video frames with AI (Baseten VLM + crop)'));
  return await seeVideoAndCrop(file, jobId);
}

export async function seeOnly(file, jobId) {
  const url = `${AI_SERVICE_URL()}/tools/see`;
  const response = await fetch(url, {
    method: 'POST',
    body: imageFormData(file),
    headers: jobHeaders(jobId),
    signal: AbortSignal.timeout(SEE_TIMEOUT_MS),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    const err = new Error(fastapiDetail(data) || `See failed (${response.status}).`);
    err.status = response.status;
    throw err;
  }
  return {
    garments: Array.isArray(data.garments) ? data.garments : [],
    outfit_summary: data.outfit_summary || '',
    image_path: data.image_path,
  };
}

export async function cropGarments(imagePath, garments, jobId) {
  const url = `${AI_SERVICE_URL()}/tools/crop`;
  const response = await fetch(url, {
    method: 'POST',
    headers: jobHeaders(jobId, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ image_path: imagePath, garments }),
    signal: AbortSignal.timeout(SEE_TIMEOUT_MS),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    const err = new Error(fastapiDetail(data) || `Crop failed (${response.status}).`);
    err.status = response.status;
    throw err;
  }
  return Array.isArray(data.garments) ? data.garments : garments;
}

export async function seeChips(garments, jobId) {
  const url = `${AI_SERVICE_URL()}/tools/see-chip`;
  const response = await fetch(url, {
    method: 'POST',
    headers: jobHeaders(jobId, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ garments }),
    signal: AbortSignal.timeout(SEE_CHIP_TIMEOUT_MS),
  });
  const data = await parseJson(response);
  if (!response.ok) {
    const err = new Error(fastapiDetail(data) || `SeeChip failed (${response.status}).`);
    err.status = response.status;
    throw err;
  }
  return Array.isArray(data.garments) ? data.garments : garments;
}

export async function perceive(file, jobId, { detail = true } = {}) {
  logger.info(
    jobMsg(
      jobId,
      detail
        ? 'see — sending photo to AI (Baseten scene + crop + chip)'
        : 'see — sending photo to AI (Baseten scene + crop)',
    ),
  );
  try {
    return await seeAndCrop(file, jobId, { detail });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
    if (error.status && error.status !== 404) throw error;
    logger.warn(jobMsg(jobId, 'see — combined identify failed, trying see then crop separately'));
    const seen = await seeOnly(file, jobId);
    if (seen.image_path) {
      try {
        seen.garments = await cropGarments(seen.image_path, seen.garments, jobId);
      } catch (cropError) {
        logger.warn(jobMsg(jobId, 'crop — failed, continuing without garment chips'));
        logger.warn(cropError instanceof Error ? cropError.message : String(cropError));
      }
    }
    if (detail) {
      try {
        seen.garments = await seeChips(seen.garments, jobId);
      } catch (chipError) {
        logger.warn(jobMsg(jobId, 'see-chip — failed, using scene descriptions'));
        logger.warn(chipError instanceof Error ? chipError.message : String(chipError));
      }
    }
    return seen;
  }
}

function chipPayload(garment) {
  const chipKey = garment?.chip_key;
  if (!chipKey || typeof chipKey !== 'string') return null;
  if (!path.isAbsolute(chipKey)) return null;
  try {
    const bytes = readFileSync(chipKey);
    const ext = path.extname(chipKey).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
    return { content_type: contentType, data: bytes.toString('base64') };
  } catch {
    return null;
  }
}

async function postJson(pathname, body, timeoutMs, jobId) {
  const response = await fetch(`${AI_SERVICE_URL()}${pathname}`, {
    method: 'POST',
    headers: jobHeaders(jobId, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await parseJson(response);
  return { response, data };
}

export function resetSourceModeCache() {
  cachedSourceMode = undefined;
}

export async function resolveSourceMode(forceMock) {
  if (forceMock) return 'mock';
  if (cachedSourceMode) return cachedSourceMode;

  try {
    const response = await fetch(`${AI_SERVICE_URL()}/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    const data = await parseJson(response);
    const endpoints = Array.isArray(data.endpoints) ? data.endpoints : [];
    if (
      response.ok &&
      endpoints.includes('/tools/retrieve') &&
      endpoints.includes('/tools/judge') &&
      endpoints.includes('/tools/rank')
    ) {
      cachedSourceMode = 'match-loop';
      return cachedSourceMode;
    }
    if (response.ok && endpoints.includes('/tools/source-rank')) {
      cachedSourceMode = 'source-rank';
      return cachedSourceMode;
    }
    if (response.ok && endpoints.includes('/tools/source')) {
      cachedSourceMode = 'source';
      return cachedSourceMode;
    }
  } catch {
    // AI service down or no source route — fall through to fixtures.
  }

  cachedSourceMode = 'mock';
  logger.warn('source — AI source/rank tools are down; will use mock matches');
  return cachedSourceMode;
}

export async function retrieveCandidates(garment, jobId) {
  const chip = chipPayload(garment);
  const { response, data } = await postJson(
    '/tools/retrieve',
    { garment, chip },
    RETRIEVE_TIMEOUT_MS,
    jobId,
  );
  if (!response.ok) {
    const err = new Error(fastapiDetail(data) || `Retrieve failed (${response.status}).`);
    err.status = response.status;
    throw err;
  }
  return Array.isArray(data.candidates) ? data.candidates : [];
}

export async function judgeCandidates(garment, candidates, jobId) {
  const chip = chipPayload(garment);
  const { response, data } = await postJson(
    '/tools/judge',
    { garment, candidates, chip },
    JUDGE_TIMEOUT_MS,
    jobId,
  );
  if (!response.ok) {
    const err = new Error(fastapiDetail(data) || `Judge failed (${response.status}).`);
    err.status = response.status;
    throw err;
  }
  const visualScores = Array.isArray(data.visual_scores) ? data.visual_scores : [];
  const best = Number.isFinite(Number(data.best)) ? Number(data.best) : null;
  return { visual_scores: visualScores, best };
}

export async function browseCandidates(garment, jobId) {
  const chip = chipPayload(garment);
  const { response, data } = await postJson(
    '/tools/browse',
    { garment, chip },
    BROWSE_TIMEOUT_MS,
    jobId,
  );
  if (!response.ok) {
    const err = new Error(fastapiDetail(data) || `Browse failed (${response.status}).`);
    err.status = response.status;
    throw err;
  }
  return Array.isArray(data.candidates) ? data.candidates : [];
}

export async function rankMatches(garment, candidates, visualScores, jobId) {
  const { response, data } = await postJson(
    '/tools/rank',
    { garment, candidates, visual_scores: visualScores || [] },
    RANK_TIMEOUT_MS,
    jobId,
  );
  if (!response.ok) {
    const err = new Error(fastapiDetail(data) || `Rank failed (${response.status}).`);
    err.status = response.status;
    throw err;
  }
  return Array.isArray(data.matches) ? data.matches : [];
}

export async function sourceAndRank(garment, jobId) {
  const mode = await resolveSourceMode(false);
  const chip = chipPayload(garment);
  const label = garment?.category || garment?.id || 'item';

  // #region agent log
  agentLog('C', 'tools.js:sourceAndRank', 'chip payload', {
    jobId,
    category: label,
    mode,
    hasChip: Boolean(chip?.data),
    chipBytes: chip?.data ? Math.floor((chip.data.length * 3) / 4) : 0,
    chip_key: garment?.chip_key ? String(garment.chip_key).slice(-80) : '',
  });
  // #endregion

  if (mode === 'source-rank' || mode === 'match-loop') {
    logger.info(jobMsg(jobId, `source — ${label}: Shopify fan-out + rank (Browserbase if weak)`));
    const { response, data } = await postJson(
      '/tools/source-rank',
      { garment, chip },
      SOURCE_TIMEOUT_MS,
      jobId,
    );
    if (!response.ok) {
      const err = new Error(fastapiDetail(data) || `Source failed (${response.status}).`);
      err.status = response.status;
      throw err;
    }
    return Array.isArray(data.matches) ? data.matches : [];
  }

  if (mode === 'source') {
    logger.info(jobMsg(jobId, `source — ${label}: calling Shopify, then OpenAI rank`));
    const sourced = await postJson('/tools/source', { garment, chip }, SOURCE_TIMEOUT_MS, jobId);
    if (!sourced.response.ok) {
      const err = new Error(fastapiDetail(sourced.data) || `Source failed (${sourced.response.status}).`);
      err.status = sourced.response.status;
      throw err;
    }
    const candidates = Array.isArray(sourced.data.matches)
      ? sourced.data.matches
      : Array.isArray(sourced.data.candidates)
        ? sourced.data.candidates
        : [];

    const ranked = await postJson(
      '/tools/rank',
      { garment, candidates },
      SOURCE_TIMEOUT_MS,
      jobId,
    );
    if (ranked.response.status === 404) {
      return candidates;
    }
    if (!ranked.response.ok) {
      const err = new Error(fastapiDetail(ranked.data) || `Rank failed (${ranked.response.status}).`);
      err.status = ranked.response.status;
      throw err;
    }
    return Array.isArray(ranked.data.matches) ? ranked.data.matches : candidates;
  }

  return null;
}
