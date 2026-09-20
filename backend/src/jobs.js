import { findRecentJob } from './recentSearches.js';

const jobs = new Map();
const jobFrames = new Map();
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 24 * 60 * 60 * 1000);

function forgetJob(jobId) {
  jobs.delete(jobId);
  jobFrames.delete(jobId);
}

export function createJob(result) {
  jobs.set(result.job_id, result);
  const timer = setTimeout(() => forgetJob(result.job_id), JOB_TTL_MS);
  timer.unref();
  return result;
}

export async function getJob(jobId) {
  const live = jobs.get(jobId);
  if (live) return live;

  try {
    const persisted = await findRecentJob(jobId);
    if (persisted) {
      jobs.set(jobId, persisted);
      return persisted;
    }
  } catch {
    return null;
  }
  return null;
}

export function updateJob(jobId, patch) {
  const current = jobs.get(jobId);
  if (!current) return null;
  const next = { ...current, ...patch };
  jobs.set(jobId, next);
  return next;
}

export function canReadJob(job, deviceId) {
  if (!job) return false;
  if (!job.device_id) return true;
  return job.device_id === deviceId;
}

export function toPublicJob(job) {
  if (!job) return null;
  const { device_id: _deviceId, ...rest } = job;
  return rest;
}

export function setJobFrames(jobId, buffers) {
  jobFrames.set(jobId, (buffers || []).filter((item) => Buffer.isBuffer(item) && item.length));
}

export function getJobFrame(jobId, index) {
  const list = jobFrames.get(jobId) || [];
  const frame = list[Number(index)];
  return Buffer.isBuffer(frame) ? frame : null;
}

function decodeDataUrl(uri) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(String(uri || '').trim());
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[2], 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

export function publishJobKeyframes(jobId, keyframes) {
  const buffers = [];
  const urls = [];
  for (const uri of keyframes || []) {
    if (!uri || typeof uri !== 'string') continue;
    const decoded = decodeDataUrl(uri);
    if (decoded) {
      buffers.push(decoded);
      urls.push(`/jobs/${jobId}/frames/${urls.length}`);
      continue;
    }
    const frameMatch = /\/jobs\/([^/]+)\/frames\/(\d+)/.exec(uri);
    if (frameMatch) {
      const copied = getJobFrame(frameMatch[1], frameMatch[2]);
      if (copied) {
        buffers.push(copied);
        urls.push(`/jobs/${jobId}/frames/${urls.length}`);
        continue;
      }
    }
    urls.push(uri);
  }
  if (buffers.length) setJobFrames(jobId, buffers);
  return urls;
}
