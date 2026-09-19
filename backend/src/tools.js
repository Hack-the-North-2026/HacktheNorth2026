import { readFileSync } from 'node:fs';
import path from 'node:path';

const AI_SERVICE_URL = () => process.env.AI_SERVICE_URL || 'http://localhost:8000';
const SEE_TIMEOUT_MS = Number(process.env.SEE_TIMEOUT_MS || 45_000);
const SOURCE_TIMEOUT_MS = Number(process.env.SOURCE_TIMEOUT_MS || 15_000);

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

export async function seeAndCrop(file) {
  const url = `${AI_SERVICE_URL()}/api/identify`;
  const response = await fetch(url, {
    method: 'POST',
    body: imageFormData(file),
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

export async function seeOnly(file) {
  const url = `${AI_SERVICE_URL()}/tools/see`;
  const response = await fetch(url, {
    method: 'POST',
    body: imageFormData(file),
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

export async function cropGarments(imagePath, garments) {
  const url = `${AI_SERVICE_URL()}/tools/crop`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

export async function perceive(file) {
  try {
    return await seeAndCrop(file);
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
    if (error.status && error.status !== 404) throw error;
    const seen = await seeOnly(file);
    if (seen.image_path) {
      try {
        seen.garments = await cropGarments(seen.image_path, seen.garments);
      } catch (cropError) {
        console.warn('[crop]', cropError.message);
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

async function postJson(pathname, body, timeoutMs) {
  const response = await fetch(`${AI_SERVICE_URL()}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await parseJson(response);
  return { response, data };
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
  console.warn('[source] Dev 4 HTTP tools are not up; using mock matches.');
  return cachedSourceMode;
}

export async function sourceAndRank(garment) {
  const mode = await resolveSourceMode(false);
  const chip = chipPayload(garment);

  if (mode === 'source-rank') {
    const { response, data } = await postJson(
      '/tools/source-rank',
      { garment, chip },
      SOURCE_TIMEOUT_MS,
    );
    if (!response.ok) {
      const err = new Error(fastapiDetail(data) || `Source failed (${response.status}).`);
      err.status = response.status;
      throw err;
    }
    return Array.isArray(data.matches) ? data.matches : [];
  }

  if (mode === 'source') {
    const sourced = await postJson('/tools/source', { garment, chip }, SOURCE_TIMEOUT_MS);
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
