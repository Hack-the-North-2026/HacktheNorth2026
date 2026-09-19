const jobs = new Map();
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 24 * 60 * 60 * 1000);

export function createJob(result) {
  jobs.set(result.job_id, result);
  const timer = setTimeout(() => jobs.delete(result.job_id), JOB_TTL_MS);
  timer.unref();
  return result;
}

export function getJob(jobId) {
  return jobs.get(jobId) ?? null;
}

export function updateJob(jobId, patch) {
  const current = jobs.get(jobId);
  if (!current) return null;
  const next = { ...current, ...patch };
  jobs.set(jobId, next);
  return next;
}
