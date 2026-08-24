import { useEffect } from 'react';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { useSettings } from '@/store/settings';
import { initWs } from '@/api/ws-client';
import { setAndroidChannel } from '@/utils/notifications';

SplashScreen.preventAutoHideAsync();

let wsInitialized = false;

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const { ready, load } = useSettings();

  useEffect(() => {
    load().catch(() => {});
    setAndroidChannel().catch(() => {});
    if (!wsInitialized) {
      wsInitialized = true;
      initWs();
    }
  }, [load]);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="token/[chain]/[address]" options={{ headerShown: true, title: '' }} />
      </Stack>
    </ThemeProvider>
  );
}