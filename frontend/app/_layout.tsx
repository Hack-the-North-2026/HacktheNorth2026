import { Sentry } from '../lib/sentry';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { router, Stack } from 'expo-router';
import Constants from 'expo-constants';
import type * as NotificationsType from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BACKGROUND } from '../lib/theme';

// expo-notifications' native module was removed from Expo Go (SDK 53+). On
// Android, merely *importing* the module throws synchronously (not just a
// warning like iOS) — so it must be dynamically imported, and only outside
// Expo Go. This still works normally in a dev client or standalone build.
const isExpoGo = Constants.appOwnership === 'expo';

function openNotificationResult(notification: NotificationsType.Notification) {
  const url = notification.request.content.data?.url;
  if (typeof url === 'string' && url.startsWith('/job/')) {
    router.push(url as `/job/${string}`);
  }
}

function RootLayout() {
  useEffect(() => {
    if (isExpoGo || Platform.OS === 'web') return;
    let subscription: { remove: () => void } | undefined;

    (async () => {
      const Notifications: typeof NotificationsType = await import('expo-notifications');

      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldPlaySound: false,
          shouldSetBadge: false,
          shouldShowBanner: true,
          shouldShowList: true,
        }),
      });

      const { status } = await Notifications.getPermissionsAsync();
      if (status !== 'granted') {
        Notifications.requestPermissionsAsync().catch(() => {});
      }

      const lastResponse = Notifications.getLastNotificationResponse();
      if (lastResponse?.notification) {
        openNotificationResult(lastResponse.notification);
      }

      subscription = Notifications.addNotificationResponseReceivedListener((response) => {
        openNotificationResult(response.notification);
      });
    })();

    return () => subscription?.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'fade',
          contentStyle: { backgroundColor: BACKGROUND },
        }}
      >
        {/* The capture screen's ripple already covers the screen before navigating here. */}
        <Stack.Screen name="job/[id]" options={{ animation: 'none' }} />
      </Stack>
    </SafeAreaProvider>
  );
}

export default Sentry.wrap(RootLayout);
