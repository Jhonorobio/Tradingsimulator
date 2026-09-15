import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { getNotificationHistory } from '@/api/notifications';
import { useSettings } from '@/store/settings';
import { useWs } from '@/store/ws';
import type { NotificationHistoryItem, TokenSnapshot } from '@/api/types';
import { fmtUsd, shortAddress } from '@/utils/format';

function calcGain(item: NotificationHistoryItem): number {
  const first = item.snapshots?.[0];
  if (!first) return 0;
  const firstMcap = first.usd_market_cap ?? first.market_cap ?? item.mcap;
  if (!firstMcap || firstMcap <= 0) return 0;
  const maxMcap = item.snapshots?.reduce((max, s) => {
    const v = s.usd_market_cap ?? s.market_cap;
    return v != null && v > max ? v : max;
  }, firstMcap) ?? firstMcap;
  return ((maxMcap - firstMcap) / firstMcap) * 100;
}

function calcTimeToPeakMinutes(item: NotificationHistoryItem): number {
  const snaps = item.snapshots;
  if (!snaps || snaps.length < 2) return 999;
  const firstTime = new Date(snaps[0].t).getTime();
  let maxMcap = 0;
  let peakTime = firstTime;
  for (const s of snaps) {
    const v = s.usd_market_cap ?? s.market_cap;
    if (v != null && v > maxMcap) {
      maxMcap = v;
      peakTime = new Date(s.t).getTime();
    }
  }
  return (peakTime - firstTime) / 60000;
}

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

const WinnerCard = React.memo(function WinnerCard({ item, theme, onPress }: {
  item: NotificationHistoryItem; theme: any; onPress: () => void;
}) {
  const snap = item.snapshots?.[0] ?? null;
  const mcap = snap?.usd_market_cap ?? snap?.market_cap ?? item.mcap;
  const vol = snap?.volume_24h ?? item.vol24h ?? 0;
  const sm = snap?.smart_degen_count ?? item.smart_degen_count;
  const kol = snap?.renowned_count ?? item.renowned_count;
  const fresh = snap?.fresh_wallet_rate ?? item.fresh_wallet_rate;
  const botCount = snap?.bot_degen_count ?? item.bot_degen_count;
  const botRate = snap?.bot_degen_rate ?? item.bot_degen_rate;
  const rug = snap?.rug_ratio ?? item.rug_ratio;
  const bundler = snap?.bundler_rate ?? snap?.bundler_trader_amount_rate ?? item.bundler_rate ?? item.bundler_trader_amount_rate;
  const entrap = snap?.entrapment_ratio ?? item.entrapment_ratio;

  const gainPct = calcGain(item);
  const timeToPeak = calcTimeToPeakMinutes(item);

  const peakMcap = item.snapshots?.reduce((max, s) => {
    const v = s.usd_market_cap ?? s.market_cap;
    return v != null && v > max ? v : max;
  }, 0) ?? 0;

  const stat = (icon: string, value: string, color: string) => (
    <View style={styles.statItem}>
      <Ionicons name={icon as any} size={12} color={color} />
      <ThemedText type="small" style={{ color }}>{value}</ThemedText>
    </View>
  );

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
            <ThemedText type="small" style={{ color: theme.positive, fontWeight: '700', fontSize: 15 }}>
              +{gainPct.toFixed(0)}%
            </ThemedText>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {timeToPeak < 999 ? `${timeToPeak.toFixed(1)}m` : 'n/a'}
            </ThemedText>
            {peakMcap > 0 && (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Peak {fmtUsd(peakMcap, { compact: true })}
              </ThemedText>
            )}
            {mcap != null && (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Entry {fmtUsd(mcap, { compact: true })}
              </ThemedText>
            )}
          </View>
        </View>

        <View style={styles.statsRow}>
          {sm != null && sm > 0 && stat('wallet', `${sm}`, theme.accent)}
          {kol != null && kol > 0 && stat('people', `${kol}`, theme.accent)}
          {fresh != null && fresh > 0 && stat('leaf', `${(fresh * 100).toFixed(0)}%`, theme.positive)}
          {((botCount != null && botCount > 0) || (botRate != null && botRate > 0)) &&
            stat('hardware-chip', `${botCount ?? 0}/${(botRate != null ? (botRate * 100).toFixed(0) : '0')}%`, theme.warn)}
          {rug != null && rug > 0 && stat('warning', `${(rug * 100).toFixed(0)}%`, theme.negative)}
          {bundler != null && bundler > 0 && stat('layers', `${(bundler * 100).toFixed(0)}%`, '#f97316')}
          {entrap != null && entrap > 0 && stat('fish', `${(entrap * 100).toFixed(0)}%`, '#ef4444')}
          {vol != null && vol > 0 && stat('trending-up', `Vol ${fmtUsd(vol, { compact: true })}`, theme.textSecondary)}
        </View>

        <View style={styles.cardFooter}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            {shortAddress(item.address)}
          </ThemedText>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            {new Date(item.entered_at || item.notified_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </ThemedText>
        </View>
      </Card>
    </Pressable>
  );
});

export default function WinnersScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { deviceId } = useSettings();
  const { notifications: wsNotifications, subscribeNotifications, unsubscribeNotifications } = useWs();
  const [history, setHistory] = useState<NotificationHistoryItem[]>([]);
  const [chainFilter, setChainFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await getNotificationHistory(300);
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
      return [...newItems, ...prev].slice(0, 300);
    });
  }, [wsNotifications]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const winners = useMemo(() => {
    return history
      .filter((h) => {
        if (chainFilter !== 'all' && h.chain !== chainFilter) return false;
        if (calcGain(h) < 100) return false;
        if (calcTimeToPeakMinutes(h) < 2) return false;
        return true;
      })
      .sort((a, b) => calcGain(b) - calcGain(a));
  }, [history, chainFilter]);

  const totalGain = useMemo(() => {
    if (winners.length === 0) return null;
    const avg = winners.reduce((sum, w) => sum + calcGain(w), 0) / winners.length;
    return avg;
  }, [winners]);

  const renderItem = useCallback(({ item }: { item: NotificationHistoryItem }) => (
    <WinnerCard
      item={item}
      theme={theme}
      onPress={() => router.push(`/token/${item.chain}/${item.address}`)}
    />
  ), [theme, router]);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <ThemedText type="subtitle" style={styles.title}>Winners</ThemedText>

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

        <View style={[styles.summary, { backgroundColor: theme.backgroundSelected, borderColor: theme.border }]}>
          <View style={styles.summaryItem}>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>Tokens</ThemedText>
            <ThemedText type="smallBold" style={{ color: theme.positive }}>{winners.length}</ThemedText>
          </View>
          {totalGain != null && (
            <View style={styles.summaryItem}>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>Gain Promedio</ThemedText>
              <ThemedText type="smallBold" style={{ color: theme.positive }}>+{totalGain.toFixed(0)}%</ThemedText>
            </View>
          )}
        </View>

        <FlatList
          data={winners}
          keyExtractor={(item, i) => `winner-${item.address}-${item.category}-${item.notified_at}-${i}`}
          renderItem={renderItem}
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={7}
          getItemLayout={(_, index) => ({ length: 120, offset: 120 * index, index })}
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
          ListEmptyComponent={
            <ThemedText style={styles.empty}>No hay tokens con 100%+ de ganancia</ThemedText>
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
  chainTabs: { flexDirection: 'row', marginBottom: 8, gap: 6, marginHorizontal: 16 },
  chainTab: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, backgroundColor: '#1a1a1a' },
  summary: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 10, borderWidth: 1, gap: 24 },
  summaryItem: { alignItems: 'center' },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  card: { marginBottom: 8, padding: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  logo: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  cardInfo: { flex: 1 },
  cardRight: { alignItems: 'flex-end' },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  empty: { textAlign: 'center', marginTop: 40, opacity: 0.5 },
});
