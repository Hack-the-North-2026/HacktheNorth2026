import Constants from 'expo-constants';
import * as Sentry from '@sentry/react-native';

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN || '';
const isExpoGo = Constants.appOwnership === 'expo';

try {
  const integrations = [];
  if (dsn && !isExpoGo && typeof Sentry.mobileReplayIntegration === 'function') {
    integrations.push(Sentry.mobileReplayIntegration());
  }

  Sentry.init({
    dsn,
    enabled: Boolean(dsn),
    tracesSampleRate: 1.0,
    enableAutoSessionTracking: true,
    replaysSessionSampleRate: dsn && !isExpoGo ? 1.0 : 0,
    replaysOnErrorSampleRate: dsn ? 1.0 : 0,
    sendDefaultPii: false,
    integrations,
  });
} catch (error) {
  console.warn('[sentry] init skipped', error);
}

export { Sentry };

export async function withIdentifySpan<T>(
  jobId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return Sentry.startSpan(
    {
      name: 'identify',
      op: 'identify',
      attributes: { job_id: jobId, origin: 'app' },
    },
    fn,
  );
}
