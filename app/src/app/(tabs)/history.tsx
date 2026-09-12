import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
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

const HistoryCard = React.memo(function HistoryCard({ item, theme, onPress, expanded, onToggle }: {
  item: NotificationHistoryItem; theme: any; onPress: () => void;
  expanded: boolean; onToggle: () => void;
}) {
  // Use first snapshot if available, otherwise use notification data
  const snap = item.snapshots?.[0] ?? null;
  const mcap = snap?.usd_market_cap ?? snap?.market_cap ?? item.mcap;
  const vol = snap?.volume_24h ?? item.vol24h;
  const sm = snap?.smart_degen_count ?? item.smart_degen_count;
  const kol = snap?.renowned_count ?? item.renowned_count;
  const fresh = snap?.fresh_wallet_rate ?? item.fresh_wallet_rate;
  const botCount = snap?.bot_degen_count ?? item.bot_degen_count;
  const botRate = snap?.bot_degen_rate ?? item.bot_degen_rate;
  const rug = snap?.rug_ratio ?? item.rug_ratio;
  const bundler = snap?.bundler_rate ?? snap?.bundler_trader_amount_rate ?? item.bundler_rate ?? item.bundler_trader_amount_rate;
  const entrap = snap?.entrapment_ratio ?? item.entrapment_ratio;
  const snapCount = item.snapshots?.length ?? 0;

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
            {mcap != null && (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>{fmtUsd(mcap, { compact: true })}</ThemedText>
            )}
            {vol != null && (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>Vol {fmtUsd(vol, { compact: true })}</ThemedText>
            )}
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {new Date(item.notified_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </ThemedText>
          </View>
        </View>

        <View style={styles.statsRow}>
          {sm != null && sm > 0 && stat('wallet', `${sm}`, theme.accent)}
          {kol != null && kol > 0 && stat('people', `${kol}`, theme.accent)}
          {fresh != null && fresh > 0 && stat('leaf', `${(fresh * 100).toFixed(0)}%`, theme.positive)}
          {((botCount != null && botCount > 0) || (botRate != null && botRate > 0)) &&
            stat('hardware-chip', `${botCount ?? 0}/${(botRate != null ? (botRate * 100).toFixed(0) : '0')}%`, theme.warn)}
          {rug != null && rug > 0 && stat('skull', `${(rug * 100).toFixed(0)}%`, theme.negative)}
          {bundler != null && bundler > 0 && stat('layers', `${(bundler * 100).toFixed(0)}%`, '#f97316')}
          {entrap != null && entrap > 0 && stat('shield-checkmark', `${(entrap * 100).toFixed(0)}%`, '#ef4444')}
        </View>

        <View style={styles.cardFooter}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            {shortAddress(item.address)}
          </ThemedText>
          {snapCount > 1 && (
            <Pressable onPress={onToggle} style={styles.snapToggle}>
              <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.accent} />
              <ThemedText type="small" style={{ color: theme.accent }}>{snapCount} snapshots</ThemedText>
            </Pressable>
          )}
        </View>

        {expanded && item.snapshots && item.snapshots.length > 1 && (
          <View style={[styles.timeline, { borderTopColor: theme.border }]}>
            {item.snapshots.map((s: TokenSnapshot, i: number) => {
              const sMcap = s.usd_market_cap ?? s.market_cap;
              const sVol = s.volume_24h;
              const sSm = s.smart_degen_count;
              const sKol = s.renowned_count;
              const sFresh = s.fresh_wallet_rate;
              const sBotCount = s.bot_degen_count;
              const sBot = s.bot_degen_rate;
              const sRug = s.rug_ratio;
              const sBundler = s.bundler_rate ?? s.bundler_trader_amount_rate;
              const sEntrap = s.entrapment_ratio;
              const snapStat = (icon: string, value: string, color: string) => (
                <View style={styles.snapStatItem}>
                  <Ionicons name={icon as any} size={10} color={color} />
                  <ThemedText type="small" style={{ color, fontSize: 10 }}>{value}</ThemedText>
                </View>
              );
              return (
                <View key={i} style={[styles.snapRow, { borderBottomColor: theme.border }]}>
                  <ThemedText type="small" style={{ color: theme.textSecondary, width: 34, fontSize: 10 }}>
                    {new Date(s.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                  </ThemedText>
                  {sMcap != null && <ThemedText type="small" style={{ color: theme.text, width: 42, fontSize: 10 }}>{fmtUsd(sMcap, { compact: true })}</ThemedText>}
                  {sVol != null && <ThemedText type="small" style={{ color: theme.textSecondary, width: 42, fontSize: 10 }}>{fmtUsd(sVol, { compact: true })}</ThemedText>}
                  {sSm != null && sSm > 0 && snapStat('wallet', `${sSm}`, theme.accent)}
                  {sKol != null && sKol > 0 && snapStat('people', `${sKol}`, theme.accent)}
                  {sFresh != null && sFresh > 0 && snapStat('leaf', `${(sFresh * 100).toFixed(0)}%`, theme.positive)}
                  {((sBotCount != null && sBotCount > 0) || (sBot != null && sBot > 0)) &&
                    snapStat('hardware-chip', `${sBotCount ?? 0}/${(sBot != null ? (sBot * 100).toFixed(0) : '0')}%`, theme.warn)}
                  {sRug != null && sRug > 0 && snapStat('skull', `${(sRug * 100).toFixed(0)}%`, theme.negative)}
                  {sBundler != null && sBundler > 0 && snapStat('layers', `${(sBundler * 100).toFixed(0)}%`, '#f97316')}
                  {sEntrap != null && sEntrap > 0 && snapStat('shield-checkmark', `${(sEntrap * 100).toFixed(0)}%`, '#ef4444')}
                </View>
              );
            })}
          </View>
        )}
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
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await getNotificationHistory(1000);
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

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const renderItem = useCallback(({ item }: { item: NotificationHistoryItem }) => {
    const id = `${item.address}-${item.category}-${item.notified_at}`;
    return (
      <HistoryCard
        item={item}
        theme={theme}
        onPress={() => router.push(`/token/${item.chain}/${item.address}`)}
        expanded={expandedIds.has(id)}
        onToggle={() => toggleExpanded(id)}
      />
    );
  }, [theme, router, expandedIds, toggleExpanded]);

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
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  snapToggle: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  timeline: { marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  snapRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 1, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
  snapStatItem: { flexDirection: 'row', alignItems: 'center', gap: 2 },
});
