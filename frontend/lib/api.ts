import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { IdentifyOrigin, IdentifyResult, RecentSearch } from './types';
import { getDeviceId } from './device';

function hostFromExpo(): string | null {
  const hostUri =
    Constants.expoConfig?.hostUri ||
    Constants.linkingUri ||
    '';
  const host = hostUri
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .split(':')[0];
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return host;
  }
  return null;
}

let cachedWorkingBaseUrl: string | null = null;

export function getCandidateBaseUrls(): string[] {
  const candidates: string[] = [];

  if (cachedWorkingBaseUrl) {
    candidates.push(cachedWorkingBaseUrl);
  }

  const lanHost = hostFromExpo();
  if (lanHost) {
    candidates.push(`http://${lanHost}:4000`);
  }

  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (fromEnv) {
    candidates.push(fromEnv);
  }

  if (Platform.OS === 'android') {
    candidates.push('http://10.37.123.166:4000');
    candidates.push('http://127.0.0.1:4000');
    candidates.push('http://10.0.2.2:4000');
  } else {
    candidates.push('http://localhost:4000');
    candidates.push('http://127.0.0.1:4000');
  }

  return [...new Set(candidates.filter(Boolean))];
}

export function getApiBaseUrl(): string {
  if (cachedWorkingBaseUrl) return cachedWorkingBaseUrl;

  const lanHost = hostFromExpo();
  if (lanHost) return `http://${lanHost}:4000`;

  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (fromEnv) return fromEnv;

  if (Platform.OS === 'android') {
    return 'http://10.37.123.166:4000';
  }

  return 'http://localhost:4000';
}

export const API_BASE_URL = getApiBaseUrl();

function guessFilename(uri: string): string {
  const raw = uri.split('?')[0].split('/').pop() || 'screenshot.jpg';
  return raw.includes('.') ? raw : `${raw}.jpg`;
}

function uploadFilename(uri: string, fileName?: string | null, mimeType?: string | null): string {
  if (fileName && fileName.includes('.')) return fileName;
  const guessed = fileName || guessFilename(uri);
  if (guessed.includes('.')) return guessed;
  const ext = mimeType?.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
  return `${guessed}.${ext}`;
}

async function readUriAsBlob(uri: string): Promise<Blob> {
  if (Platform.OS === 'web') {
    const response = await fetch(uri);
    return response.blob();
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.onload = () => {
      const blob = xhr.response as Blob | null;
      if (!blob) {
        reject(new Error('Could not read the selected image.'));
        return;
      }
      resolve(blob);
    };
    xhr.onerror = () => reject(new Error('Could not read the selected image.'));
    xhr.responseType = 'blob';
    xhr.open('GET', uri);
    xhr.send();
  });
}

export type IdentifyUpload = {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  type?: 'image' | 'video';
};

export function isVideoUri(uri?: string | null, mimeType?: string | null): boolean {
  if (!uri) return false;
  if (mimeType?.startsWith('video/')) return true;
  const clean = uri.split('?')[0].toLowerCase();
  return /\.(mp4|mov|webm|m4v|mkv)$/i.test(clean);
}

async function buildIdentifyForm(
  upload: IdentifyUpload,
  origin: IdentifyOrigin,
): Promise<FormData> {
  const form = new FormData();
  const isVideo = upload.type === 'video' || isVideoUri(upload.uri, upload.mimeType);
  const type = isVideo ? 'video' : 'image';
  const filename = uploadFilename(upload.uri, upload.fileName, upload.mimeType);
  const blob = await readUriAsBlob(upload.uri);
  form.append(type, blob, filename);
  form.append('type', type);
  form.append('origin', origin);
  form.append('device_id', await getDeviceId());
  return form;
}

async function readJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    detail?: string;
  } & T;
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : data.error;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return data;
}

/** Hermes-compatible fetch with timeout (AbortSignal.timeout is not available). */
function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchWithCandidateFallback(
  pathAndQuery: string,
  opts: RequestInit = {},
  timeoutMs = 5000,
): Promise<Response> {
  const candidates = getCandidateBaseUrls();
  let lastError: unknown = null;

  for (const base of candidates) {
    try {
      const url = `${base}${pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`}`;
      const response = await fetchWithTimeout(url, opts, timeoutMs);
      cachedWorkingBaseUrl = base;
      return response;
    } catch (err) {
      lastError = err;
      console.warn(`[API] Failed connecting to ${base}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw lastError || new Error('Failed to connect to backend server');
}

export async function startIdentifyJob(
  upload: string | IdentifyUpload,
  origin: IdentifyOrigin = 'app',
): Promise<IdentifyResult> {
  const image = typeof upload === 'string' ? { uri: upload } : upload;
  const filename = uploadFilename(image.uri, image.fileName, image.mimeType);
  console.log(`capture — uploading "${filename}" to backend`);

  const candidates = getCandidateBaseUrls();
  let lastError: unknown = null;

  for (const base of candidates) {
    try {
      const form = await buildIdentifyForm(image, origin);
      const response = await fetchWithTimeout(`${base}/api/identify`, {
        method: 'POST',
        body: form,
        headers: { Accept: 'application/json' },
      }, 30000);
      cachedWorkingBaseUrl = base;
      const job = await readJson<IdentifyResult>(response);
      const short = String(job.job_id || '').replace(/-/g, '').slice(0, 8);
      console.log(`capture — Job ${short} created, waiting for results`);
      return job;
    } catch (err) {
      lastError = err;
      console.warn(`[API] startIdentifyJob failed on ${base}:`, err instanceof Error ? err.message : String(err));
    }
  }

  throw lastError || new Error('Could not upload image to backend');
}

export async function getIdentifyJob(jobId: string): Promise<IdentifyResult> {
  const path = `/jobs/${encodeURIComponent(jobId)}?_t=${Date.now()}`;
  const response = await fetchWithCandidateFallback(path, {
    headers: { 
      Accept: 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    },
  }, 5000);
  return readJson<IdentifyResult>(response);
}

export async function checkBackendHealth() {
  const response = await fetchWithCandidateFallback('/health', {}, 3000);
  return readJson(response);
}

export async function listRecentSearches(): Promise<RecentSearch[]> {
  const deviceId = await getDeviceId();
  const response = await fetchWithCandidateFallback('/recent-searches', {
    headers: {
      Accept: 'application/json',
      'x-device-id': deviceId,
    },
  }, 5000);
  const data = await readJson<{ searches?: RecentSearch[] }>(response);
  return Array.isArray(data.searches) ? data.searches : [];
}
