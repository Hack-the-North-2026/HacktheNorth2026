const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configuredLevel] ?? LEVELS.info;

export function shortId(id) {
  return String(id || '').replace(/-/g, '').slice(0, 8);
}

export function bytesLabel(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function jobMsg(jobId, message) {
  return `Job ${shortId(jobId)}  ${message}`;
}

function clock() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function write(level, message, error) {
  if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
  const tag = level === 'error' ? 'ERROR  ' : level === 'warn' ? 'WARN   ' : '';
  const line = `${clock()}  ${tag}${message}`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  out(line);
  if (!error) return;
  const detail = error instanceof Error ? error.message : String(error);
  if (detail && !String(message).includes(detail)) {
    out(`${clock()}         ${detail}`);
  }
}

export const logger = {
  blank: () => console.log(''),
  debug: (message) => write('debug', message),
  info: (message) => write('info', message),
  warn: (message) => write('warn', message),
  error: (message, error) => write('error', message, error),
};
