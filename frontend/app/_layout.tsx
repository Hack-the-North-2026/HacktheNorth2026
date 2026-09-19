import { Sentry } from '../lib/sentry';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'fade_from_bottom',
          animationDuration: 380,
          contentStyle: { backgroundColor: '#050509' },
        }}
      />
    </SafeAreaProvider>
  );
}

export default Sentry.wrap(RootLayout);
