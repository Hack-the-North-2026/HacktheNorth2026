import { findRecentJob } from './recentSearches.js';

const jobs = new Map();
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 24 * 60 * 60 * 1000);

export function createJob(result) {
  jobs.set(result.job_id, result);
  const timer = setTimeout(() => jobs.delete(result.job_id), JOB_TTL_MS);
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
