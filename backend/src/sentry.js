import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN || '';


Sentry.init({
  dsn: dsn || undefined,
  enabled: Boolean(dsn),
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 1.0,
  enableLogs: true,
  sendDefaultPii: false,
});

export { Sentry };

export function sentryEnabled() {
  return Boolean(dsn);
}
