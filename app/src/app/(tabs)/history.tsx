import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { getNotificationHistory } from '@/api/notifications';
import { useSettings } from '@/store/settings';
import { useWs } from '@/store/ws';
import type { NotificationHistoryItem } from '@/api/types';
import { fmtUsd, shortAddress } from '@/utils/format';

const CATEGORY_LABELS: Record<string, string> = {
  new_creation: 'Nueva',
  completed: 'Completada',
  new_creation_robinhood: 'Nueva RH',
  completed_robinhood: 'Completada RH',
};

export default function HistoryScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { deviceId } = useSettings();
  const { notifications: wsNotifications, subscribeNotifications, unsubscribeNotifications } = useWs();
  const [history, setHistory] = useState<NotificationHistoryItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await getNotificationHistory(100);
      setHistory(res.history);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  // Subscribe to real-time notifications via WebSocket
  useEffect(() => {
    if (!deviceId) return;
    subscribeNotifications(deviceId);
    return () => { unsubscribeNotifications(deviceId); };
  }, [deviceId, subscribeNotifications, unsubscribeNotifications]);

  // Merge WS notifications into history (dedupe by address+notified_at)
  useEffect(() => {
    if (wsNotifications.length === 0) return;
    setHistory((prev) => {
      const seen = new Set(prev.map((h) => `${h.address}:${h.notified_at}`));
      const newItems = wsNotifications.filter((n) => !seen.has(`${n.address}:${n.notified_at}`));
      if (newItems.length === 0) return prev;
      return [...newItems, ...prev].slice(0, 200);
    });
  }, [wsNotifications]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const goToToken = (item: NotificationHistoryItem) => {
    router.push(`/token/${item.chain}/${item.address}`);
  };

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <ThemedText type="subtitle" style={styles.title}>Historial de Notificaciones</ThemedText>

        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}>
          {history.length === 0 ? (
            <ThemedText style={styles.empty}>No hay notificaciones aún</ThemedText>
          ) : (
            history.map((item) => (
              <Pressable key={item.id} onPress={() => goToToken(item)}>
                <Card style={[styles.card, { borderColor: theme.border }]}>
                  <View style={styles.cardHeader}>
                    {item.logo ? (
                      <View style={[styles.logo, { backgroundColor: theme.backgroundSelected }]}>
                        <ThemedText type="small">{item.symbol?.charAt(0) || '?'}</ThemedText>
                      </View>
                    ) : null}
                    <View style={styles.cardInfo}>
                      <ThemedText type="smallBold" style={{ color: theme.text }}>
                        {item.symbol || item.name || shortAddress(item.address)}
                      </ThemedText>
                      <ThemedText type="tiny" style={{ color: theme.textSecondary }}>
                        {item.chain.toUpperCase()} · {CATEGORY_LABELS[item.category] || item.category}
                      </ThemedText>
                    </View>
                    <View style={styles.cardRight}>
                      {item.mcap != null ? (
                        <ThemedText type="tiny" style={{ color: theme.textSecondary }}>
                          MCap {fmtUsd(item.mcap)}
                        </ThemedText>
                      ) : null}
                      <ThemedText type="tiny" style={{ color: theme.textSecondary }}>
                        {new Date(item.notified_at).toLocaleDateString()} {new Date(item.notified_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </ThemedText>
                    </View>
                  </View>
                  <ThemedText type="tiny" style={{ color: theme.textSecondary, marginTop: 4 }}>
                    {shortAddress(item.address)}
                  </ThemedText>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                    {item.smart_degen_count != null && item.smart_degen_count > 0 && (
                      <ThemedText type="tiny" style={{ color: theme.accent }}>SM {item.smart_degen_count}</ThemedText>
                    )}
                    {item.renowned_count != null && item.renowned_count > 0 && (
                      <ThemedText type="tiny" style={{ color: theme.accent }}>KOL {item.renowned_count}</ThemedText>
                    )}
                    {item.fresh_wallet_rate != null && item.fresh_wallet_rate > 0 && (
                      <ThemedText type="tiny" style={{ color: theme.positive }}>Fresh {(item.fresh_wallet_rate * 100).toFixed(0)}%</ThemedText>
                    )}
                    {item.bot_degen_count != null && item.bot_degen_count > 0 && (
                      <ThemedText type="tiny" style={{ color: theme.warn }}>Bot {item.bot_degen_count}</ThemedText>
                    )}
                    {item.bot_degen_rate != null && item.bot_degen_rate > 0 && (
                      <ThemedText type="tiny" style={{ color: theme.warn }}>Bot% {(item.bot_degen_rate * 100).toFixed(1)}%</ThemedText>
                    )}
                  </View>
                </Card>
              </Pressable>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0d0d' },
  safe: { flex: 1 },
  title: { marginHorizontal: 16, marginTop: 12, marginBottom: 8 },
  empty: { textAlign: 'center', marginTop: 40, opacity: 0.5 },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  card: { marginBottom: 8, padding: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  logo: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  cardInfo: { flex: 1 },
  cardRight: { alignItems: 'flex-end' },
});
