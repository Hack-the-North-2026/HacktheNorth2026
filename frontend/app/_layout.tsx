import { Sentry } from '../lib/sentry';
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

function RootLayout() {
  return (
    <SafeAreaProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#0F0F12' },
          animation: 'fade',
        }}
      />
    </SafeAreaProvider>
  );
}

export default Sentry.wrap(RootLayout);
