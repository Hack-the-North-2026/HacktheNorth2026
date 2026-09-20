import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { IdentifyResult } from './types';

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

export function getApiBaseUrl(): string {
  // On Android physical device connected via USB, adb reverse tcp:4000 tcp:4000
  // maps 127.0.0.1:4000 on the phone → localhost:4000 on the laptop.
  // This is the ONLY reliable path; LAN IPs are blocked by router isolation.
  if (Platform.OS === 'android') {
    return 'http://127.0.0.1:4000';
  }

  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (fromEnv) return fromEnv;

  const lanHost = hostFromExpo();
  if (lanHost) return `http://${lanHost}:4000`;

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
};

async function buildIdentifyForm(upload: IdentifyUpload): Promise<FormData> {
  const form = new FormData();
  const filename = uploadFilename(upload.uri, upload.fileName, upload.mimeType);
  const blob = await readUriAsBlob(upload.uri);
  form.append('image', blob, filename);
  form.append('type', 'image');
  form.append('origin', 'app');
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

export async function startIdentifyJob(upload: string | IdentifyUpload): Promise<IdentifyResult> {
  const image = typeof upload === 'string' ? { uri: upload } : upload;
  const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/identify`, {
    method: 'POST',
    body: await buildIdentifyForm(image),
    headers: { Accept: 'application/json' },
  }, 30000);
  return readJson<IdentifyResult>(response);
}

export async function getIdentifyJob(jobId: string): Promise<IdentifyResult> {
  const url = `${getApiBaseUrl()}/jobs/${encodeURIComponent(jobId)}?_t=${Date.now()}`;
  const response = await fetchWithTimeout(url, {
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
  const response = await fetchWithTimeout(`${getApiBaseUrl()}/health`, {}, 3000);
  return readJson(response);
}

