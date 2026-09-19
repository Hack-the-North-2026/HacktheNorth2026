import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN || '';

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  tracesSampleRate: 1.0,
  sendDefaultPii: false,
});

export { Sentry };
