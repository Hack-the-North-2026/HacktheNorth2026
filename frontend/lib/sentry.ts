import Constants from 'expo-constants';
import { Platform } from 'react-native';
import * as Sentry from '@sentry/react-native';

const extra = (Constants.expoConfig?.extra ?? {}) as { sentryDsn?: string };
const dsn = extra.sentryDsn || process.env.EXPO_PUBLIC_SENTRY_DSN || '';
const isExpoGo = Constants.appOwnership === 'expo';

try {
  const integrations = [];
  if (dsn) {
    if (!isExpoGo && typeof Sentry.mobileReplayIntegration === 'function') {
      integrations.push(Sentry.mobileReplayIntegration());
    } else if (Platform.OS === 'web' && typeof Sentry.browserReplayIntegration === 'function') {
      integrations.push(
        Sentry.browserReplayIntegration({
          maskAllText: false,
          blockAllMedia: false,
        }),
      );
    }
  }

  Sentry.init({
    dsn: dsn || undefined,
    enabled: Boolean(dsn),
    environment: __DEV__ ? 'development' : 'production',
    tracesSampleRate: 1.0,
    enableLogs: true,
    enableNative: Boolean(dsn) && !isExpoGo,
    enableNativeCrashHandling: Boolean(dsn) && !isExpoGo,
    enableNativeNagger: false,
    enableAutoSessionTracking: true,
    replaysSessionSampleRate: dsn ? 1.0 : 0,
    replaysOnErrorSampleRate: dsn ? 1.0 : 0,
    sendDefaultPii: false,
    integrations,
  });
} catch (error) {
  console.warn('[sentry] init skipped', error);
}

export { Sentry };

export function sentryEnabled(): boolean {
  return Boolean(dsn);
}

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
    async () => {
      Sentry.logger.info('identify.poll.start', { job_id: jobId, origin: 'app' });
      return fn();
    },
  );
}
