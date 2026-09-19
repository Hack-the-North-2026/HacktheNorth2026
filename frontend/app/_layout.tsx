import { Sentry } from '../lib/sentry';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BACKGROUND } from '../lib/theme';

function RootLayout() {
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
