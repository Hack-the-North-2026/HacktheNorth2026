const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configuredLevel] ?? LEVELS.info;

const SECRET_KEY = /(authorization|api[_-]?key|token|secret|password|cookie|base64|buffer|\bdata\b)/i;

function sanitize(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause ? { cause: sanitize(value.cause, depth + 1) } : {}),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? '[redacted]' : sanitize(item, depth + 1),
      ]),
    );
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

function write(level, event, context = {}) {
  if (LEVELS[level] < threshold) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'backend',
    event,
    ...sanitize(context),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event, context) => write('debug', event, context),
  info: (event, context) => write('info', event, context),
  warn: (event, context) => write('warn', event, context),
  error: (event, error, context = {}) => write('error', event, { ...context, error }),
};
