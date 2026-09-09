import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
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

const CHAIN_TABS = [
  { key: 'all', label: 'Todos' },
  { key: 'sol', label: 'SOL' },
  { key: 'bsc', label: 'BSC' },
  { key: 'robinhood', label: 'RH' },
];

const CATEGORY_LABELS: Record<string, string> = {
  new_creation: 'Nueva',
  completed: 'Completada',
  new_creation_robinhood: 'Nueva RH',
  completed_robinhood: 'Completada RH',
  new_creation_bsc: 'Nueva BSC',
  completed_bsc: 'Completada BSC',
};

const HistoryCard = React.memo(function HistoryCard({ item, theme, onPress }: { item: NotificationHistoryItem; theme: any; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
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
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {item.chain.toUpperCase()} · {CATEGORY_LABELS[item.category] || item.category}
            </ThemedText>
          </View>
          <View style={styles.cardRight}>
            {item.mcap != null ? (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                MCap {fmtUsd(item.mcap)}
              </ThemedText>
            ) : null}
            {item.vol24h != null ? (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Vol {fmtUsd(item.vol24h)}
              </ThemedText>
            ) : null}
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {new Date(item.notified_at).toLocaleDateString()} {new Date(item.notified_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </ThemedText>
          </View>
        </View>
        <ThemedText type="small" style={{ color: theme.textSecondary, marginTop: 4 }}>
          {shortAddress(item.address)}
        </ThemedText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
          {item.smart_degen_count != null && item.smart_degen_count > 0 && (
            <ThemedText type="small" style={{ color: theme.accent }}>SM {item.smart_degen_count}</ThemedText>
          )}
          {item.renowned_count != null && item.renowned_count > 0 && (
            <ThemedText type="small" style={{ color: theme.accent }}>KOL {item.renowned_count}</ThemedText>
          )}
          {item.fresh_wallet_rate != null && item.fresh_wallet_rate > 0 && (
            <ThemedText type="small" style={{ color: theme.positive }}>Fresh {(item.fresh_wallet_rate * 100).toFixed(0)}%</ThemedText>
          )}
          {item.bot_degen_count != null && item.bot_degen_count > 0 && (
            <ThemedText type="small" style={{ color: theme.warn }}>Bot {item.bot_degen_count}</ThemedText>
          )}
          {item.bot_degen_rate != null && item.bot_degen_rate > 0 && (
            <ThemedText type="small" style={{ color: theme.warn }}>Bot% {(item.bot_degen_rate * 100).toFixed(1)}%</ThemedText>
          )}
        </View>
      </Card>
    </Pressable>
  );
});

export default function HistoryScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { deviceId } = useSettings();
  const { notifications: wsNotifications, subscribeNotifications, unsubscribeNotifications } = useWs();
  const [history, setHistory] = useState<NotificationHistoryItem[]>([]);
  const [search, setSearch] = useState('');
  const [chainFilter, setChainFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await getNotificationHistory(500);
      setHistory(res.history);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!deviceId) return;
    subscribeNotifications(deviceId);
    return () => { unsubscribeNotifications(deviceId); };
  }, [deviceId, subscribeNotifications, unsubscribeNotifications]);

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

  const searchLower = search.trim().toLowerCase();

  const filtered = useMemo(() => {
    return history.filter((h) => {
      if (chainFilter !== 'all' && h.chain !== chainFilter) return false;
      if (searchLower) {
        return (h.symbol?.toLowerCase().includes(searchLower)) || (h.name?.toLowerCase().includes(searchLower));
      }
      return true;
    });
  }, [history, chainFilter, searchLower]);

  const renderItem = useCallback(({ item }: { item: NotificationHistoryItem }) => (
    <HistoryCard item={item} theme={theme} onPress={() => router.push(`/token/${item.chain}/${item.address}`)} />
  ), [theme, router]);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <ThemedText type="subtitle" style={styles.title}>Historial de Notificaciones</ThemedText>

        <View style={styles.chainTabs}>
          {CHAIN_TABS.map((tab) => (
            <Pressable
              key={tab.key}
              onPress={() => setChainFilter(tab.key)}
              style={[styles.chainTab, chainFilter === tab.key && { backgroundColor: theme.accent }]}
            >
              <ThemedText type="small" style={{ color: chainFilter === tab.key ? '#000' : theme.textSecondary }}>
                {tab.label}
              </ThemedText>
            </Pressable>
          ))}
        </View>

        <View style={styles.searchWrap}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Buscar por símbolo..."
            placeholderTextColor={theme.textSecondary}
            style={[styles.searchInput, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]}
          />
        </View>

        <FlatList
          data={filtered}
          keyExtractor={(item, i) => `${item.address}-${item.category}-${item.notified_at}-${i}`}
          renderItem={renderItem}
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={7}
          getItemLayout={(_, index) => ({ length: 120, offset: 120 * index, index })}
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
          ListEmptyComponent={
            <ThemedText style={styles.empty}>{history.length === 0 ? 'No hay notificaciones aún' : 'Sin resultados'}</ThemedText>
          }
        />
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0d0d' },
  safe: { flex: 1 },
  title: { marginHorizontal: 16, marginTop: 12, marginBottom: 8 },
  chainTabs: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, gap: 6 },
  chainTab: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, backgroundColor: '#1a1a1a' },
  searchWrap: { marginHorizontal: 16, marginBottom: 8 },
  searchInput: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 14 },
  empty: { textAlign: 'center', marginTop: 40, opacity: 0.5 },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  card: { marginBottom: 8, padding: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  logo: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  cardInfo: { flex: 1 },
  cardRight: { alignItems: 'flex-end' },
});
