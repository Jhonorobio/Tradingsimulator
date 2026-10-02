import { useEffect } from 'react';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { Platform, useColorScheme } from 'react-native';

import { useSettings } from '@/store/settings';
import { useMemescope } from '@/store/memescope';
import { useWs } from '@/store/ws';
import { initWs } from '@/api/ws-client';
import { setAndroidChannel, notificationsAvailable } from '@/utils/notifications';

SplashScreen.preventAutoHideAsync();

let wsInitialized = false;

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const { ready, load, deviceId } = useSettings();

  useEffect(() => {
    load().catch(() => {});
    setAndroidChannel().catch(() => {});
    if (!wsInitialized) {
      wsInitialized = true;
      initWs();
    }
    // Global Photon feed: subscribe once — server polls only while we listen.
    useMemescope.getState().startListening();
  }, [load]);

  // Global notifications: History merges these live. The client keeps the
  // topic in its set, so it re-subscribes automatically on every reconnect.
  useEffect(() => {
    if (ready && deviceId) useWs.getState().subscribeNotifications(deviceId);
  }, [ready, deviceId]);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // Notification listeners (foreground)
  useEffect(() => {
    if (!notificationsAvailable()) return;

    const setup = async () => {
      const Notifications = require('expo-notifications') as typeof import('expo-notifications');

      // Foreground: process notification while app is open
      // The system banner is already shown by the handler in notifications.ts.
      // This listener is for any additional JS-side handling.
      const receivedSub = Notifications.addNotificationReceivedListener((_notification) => {
        // Notification received in foreground — banner shown by system handler
      });

      return () => {
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
        <Stack.Screen name="proxy-tester" options={{ headerShown: false }} />
      </Stack>
    </ThemeProvider>
  );
}