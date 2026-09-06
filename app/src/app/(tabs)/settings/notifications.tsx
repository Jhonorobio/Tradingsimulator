import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/store/settings';
import { saveNotificationConfig, getNotificationConfig } from '@/api/notifications';
import { ApiError } from '@/api/client';
import type { NotificationConfig } from '@/api/types';
import { registerForPushNotificationsAsync, notificationsAvailable } from '@/utils/notifications';

const NOTIF_CATEGORIES = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood', 'new_creation_bsc', 'completed_bsc'] as const;
const NOTIF_LABELS: Record<string, string> = {
  new_creation: 'Nueva creación (SOL)',
  completed: 'Completado (SOL)',
  new_creation_robinhood: 'Nueva creación (Robinhood)',
  completed_robinhood: 'Completado (Robinhood)',
  new_creation_bsc: 'Nueva creación (BSC)',
  completed_bsc: 'Completado (BSC)',
};

export default function NotificationsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { pushToken, setPushToken } = useSettings();

  const [notifCategories, setNotifCategories] = useState<NotificationConfig['categories']>({
    new_creation: false,
    completed: false,
    new_creation_robinhood: false,
    completed_robinhood: false,
    new_creation_bsc: false,
    completed_bsc: false,
  });

  const loadAll = useCallback(async () => {
    try {
      const notifCfg = await getNotificationConfig().catch(() => null);
      if (notifCfg) setNotifCategories(notifCfg.categories);
    } catch {}
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const toggleNotifCategory = async (cat: string) => {
    const next = { ...notifCategories, [cat]: !notifCategories[cat as keyof typeof notifCategories] };
    setNotifCategories(next);

    let token = pushToken;
    if (!token) {
      if (!notificationsAvailable()) {
        Alert.alert(
          'Push no disponible',
          'En Android, expo-notifications ya no funciona dentro de Expo Go (desde SDK 53). Necesitas un development build.'
        );
        setNotifCategories((prev) => ({ ...prev, [cat]: false }));
        return;
      }
      token = await registerForPushNotificationsAsync();
      if (!token) {
        Alert.alert('Push no disponible', 'Solo funciona en un dispositivo físico.');
        setNotifCategories((prev) => ({ ...prev, [cat]: false }));
        return;
      }
      setPushToken(token);
    }

    try {
      await saveNotificationConfig(token, next);
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'No se pudo guardar');
      setNotifCategories((prev) => ({ ...prev, [cat]: !prev[cat as keyof typeof prev] }));
    }
  };

  const isAnyNotifOn = Object.values(notifCategories).some(Boolean);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={theme.text} />
          </Pressable>
          <ThemedText type="smallBold" style={{ color: theme.text }}>Notificaciones</ThemedText>
        </View>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Card>
            <View style={styles.rowBetween}>
              <ThemedText type="smallBold">Notificaciones push</ThemedText>
              {pushToken && isAnyNotifOn && (
                <ThemedText type="small" style={{ color: theme.positive }}>Activo</ThemedText>
              )}
            </View>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Recibe un aviso por push cuando llegue un token nuevo a cada categoría.
            </ThemedText>
            {pushToken ? (
              <ThemedText type="small" style={{ color: theme.positive }}>
                Push token registrado
              </ThemedText>
            ) : null}

            {NOTIF_CATEGORIES.map((cat) => (
              <View key={cat} style={[styles.notifRow, { borderColor: theme.border }]}>
                <View style={{ flex: 1 }}>
                  <ThemedText type="smallBold">{NOTIF_LABELS[cat]}</ThemedText>
                </View>
                <Switch
                  value={notifCategories[cat]}
                  onValueChange={() => toggleNotifCategory(cat)}
                  trackColor={{ true: theme.accent }}
                />
              </View>
            ))}
          </Card>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: { padding: 4 },
  scroll: { padding: 16, gap: 12, paddingBottom: 40 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  notifRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
