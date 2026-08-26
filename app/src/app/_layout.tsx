import { useEffect, useRef } from 'react';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { Platform, useColorScheme } from 'react-native';

import { useSettings } from '@/store/settings';
import { initWs } from '@/api/ws-client';
import { setAndroidChannel, notificationsAvailable } from '@/utils/notifications';

SplashScreen.preventAutoHideAsync();

let wsInitialized = false;

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const { ready, load } = useSettings();
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

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

  // Notification listeners (deep-link + foreground)
  useEffect(() => {
    if (!notificationsAvailable()) return;

    let mounted = true;

    const setup = async () => {
      const Notifications = require('expo-notifications') as typeof import('expo-notifications');

      // Deep-link: navigate to token screen when user taps a notification
      const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data;
        if (data?.address && data?.chain && mounted) {
          routerRef.current.push(`/token/${data.chain}/${data.address}`);
        }
      });

      // Foreground: process notification while app is open
      // The system banner is already shown by the handler in notifications.ts.
      // This listener is for any additional JS-side handling.
      const receivedSub = Notifications.addNotificationReceivedListener((_notification) => {
        // Notification received in foreground — banner shown by system handler
      });

      return () => {
        mounted = false;
        responseSub.remove();
        receivedSub.remove();
      };
    };

    let cleanup: (() => void) | undefined;
    setup().then((fn) => { cleanup = fn; });

    return () => { cleanup?.(); };
  }, [ready]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="token/[chain]/[address]" options={{ headerShown: true, title: '' }} />
        <Stack.Screen name="proxy-tester" options={{ headerShown: true, title: 'Proxy Tester' }} />
      </Stack>
    </ThemeProvider>
  );
}