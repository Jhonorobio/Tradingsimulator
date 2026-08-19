import * as Device from 'expo-device';
import { Platform } from 'react-native';

type NotificationsModule = typeof import('expo-notifications');

// expo-notifications throws at import time on Android in Expo Go
// (remote push was removed from Expo Go in SDK 53+). Load it lazily so the
// app still works on Android Expo Go; notifications become a no-op there.
let Notifications: NotificationsModule | null = null;
try {
  const mod = require('expo-notifications') as NotificationsModule;
  Notifications = mod;
  mod.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
} catch {
  Notifications = null;
}

export function notificationsAvailable(): boolean {
  return Notifications != null;
}

export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (Platform.OS === 'web' || Platform.OS === 'android' || !Notifications || !Device.isDevice) {
    return null;
  }

  const current = await Notifications.getPermissionsAsync();
  let status = current.status;
  if (status !== 'granted') {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== 'granted') return null;

  const token = await Notifications.getExpoPushTokenAsync();
  return token.data ?? token.toString();
}

export async function setAndroidChannel() {
  if (Platform.OS !== 'android' || !Notifications) return;
  try {
    await Notifications.setNotificationChannelAsync('trenches', {
      name: 'Trenches alerts',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  } catch {
    // channel setup is best-effort
  }
}