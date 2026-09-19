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
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (fromEnv) return fromEnv;

  const lanHost = hostFromExpo();
  if (lanHost) return `http://${lanHost}:4000`;

  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:4000';
  }
  return 'http://localhost:4000';
}

export const API_BASE_URL = getApiBaseUrl();

function guessFilename(uri: string): string {
  const raw = uri.split('?')[0].split('/').pop() || 'screenshot.jpg';
  return raw.includes('.') ? raw : `${raw}.jpg`;
}

function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}

async function buildIdentifyForm(uri: string): Promise<FormData> {
  const form = new FormData();
  const filename = guessFilename(uri);
  const type = guessMime(filename);

  if (Platform.OS === 'web') {
    const blob = await (await fetch(uri)).blob();
    form.append('image', blob, filename);
  } else {
    form.append('image', { uri, name: filename, type } as unknown as Blob);
  }
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

export async function startIdentifyJob(uri: string): Promise<IdentifyResult> {
  const response = await fetch(`${getApiBaseUrl()}/api/identify`, {
    method: 'POST',
    body: await buildIdentifyForm(uri),
    headers: { Accept: 'application/json' },
  });
  return readJson<IdentifyResult>(response);
}

export async function getIdentifyJob(jobId: string): Promise<IdentifyResult> {
  const response = await fetch(`${getApiBaseUrl()}/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Accept: 'application/json' },
  });
  return readJson<IdentifyResult>(response);
}

export async function checkBackendHealth() {
  const response = await fetch(`${getApiBaseUrl()}/health`);
  return readJson(response);
}
