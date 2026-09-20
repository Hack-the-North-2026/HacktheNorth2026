import { Sentry } from '../lib/sentry';
import { useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import { router, Stack } from 'expo-router';
import Constants from 'expo-constants';
import type * as NotificationsType from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from '@expo-google-fonts/manrope';
import {
  Fraunces_500Medium,
  Fraunces_600SemiBold,
  Fraunces_700Bold,
  Fraunces_500Medium_Italic,
} from '@expo-google-fonts/fraunces';
import { BACKGROUND } from '../lib/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

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
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
    Fraunces_500Medium,
    Fraunces_600SemiBold,
    Fraunces_700Bold,
    Fraunces_500Medium_Italic,
  });

  const onLayoutRootView = useCallback(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded]);

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

  if (!fontsLoaded) return null;

  return (
    <SafeAreaProvider onLayout={onLayoutRootView}>
      <StatusBar style="dark" />
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
