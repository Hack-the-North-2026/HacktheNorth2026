import { Sentry } from '../lib/sentry';
import { useEffect } from 'react';
import { router, Stack } from 'expo-router';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BACKGROUND } from '../lib/theme';

// expo-notifications' native module was removed from Expo Go (SDK 53+). On
// Android that's a hard crash on import-time setup, not just a warning like
// iOS — so skip all of it whenever we're running inside Expo Go itself.
// This still works normally in a dev client or standalone build.
const isExpoGo = Constants.appOwnership === 'expo';

if (!isExpoGo) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

function openNotificationResult(notification: Notifications.Notification) {
  const url = notification.request.content.data?.url;
  if (typeof url === 'string' && url.startsWith('/job/')) {
    router.push(url as `/job/${string}`);
  }
}

function RootLayout() {
  useEffect(() => {
    if (isExpoGo) return;

    Notifications.getPermissionsAsync().then(({ status }) => {
      if (status !== 'granted') {
        Notifications.requestPermissionsAsync().catch(() => {});
      }
    });

    const lastResponse = Notifications.getLastNotificationResponse();
    if (lastResponse?.notification) {
      openNotificationResult(lastResponse.notification);
    }

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      openNotificationResult(response.notification);
    });
    return () => subscription.remove();
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
