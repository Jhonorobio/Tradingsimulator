import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { WinnersPanel } from '@/components/winners-panel';
import { TrackingPanel } from '@/components/tracking-panel';
import { useTheme } from '@/hooks/use-theme';
import { getNotificationHistory } from '@/api/notifications';
import { useWs } from '@/store/ws';
import type { NotificationHistoryItem, TokenSnapshot } from '@/api/types';
import { fmtNum, fmtUsd, shortAddress } from '@/utils/format';

const CATEGORY_OPTIONS = [
  { key: 'recent', label: 'Reciente' },
  { key: 'new', label: 'Nuevas' },
  { key: 'completed', label: 'Completadas' },
  { key: 'x_tracker', label: 'Tracker' },
  { key: 'photon', label: 'Photon' },
  { key: 'snaps', label: 'Snapshots' },
  { key: 'gain', label: 'Ganancia' },
];

const VIEW_TABS = [
  { key: 'history', label: 'Historial' },
  { key: 'tracking', label: 'Rastreando' },
  { key: 'winners', label: 'Winners' },
] as const;
type ViewKey = (typeof VIEW_TABS)[number]['key'];

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

const CHAIN_TABS = [
  { key: 'all', label: 'Todos' },
  { key: 'sol', label: 'SOL' },
];

const CATEGORY_LABELS: Record<string, string> = {
  new_creation: 'Nueva',
  completed: 'Completada',
  x_tracker: 'Tracker',
  photon: 'Photon',
};

const HistoryCard = React.memo(function HistoryCard({ item, theme, onPress, expanded, onToggle }: {
  item: NotificationHistoryItem; theme: any; onPress: () => void;
  expanded: boolean; onToggle: () => void;
}) {
  // Use first snapshot if available, otherwise use notification data
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
  const bundleCnt = item.bundle_holders_count ?? null;
  const buys = item.buys_count ?? null;
  const tpHolders = item.tp_holders_count ?? null;
  const topHolders = item.top_holders_rate ?? null;
  const holdersTotal = item.holders_count ?? null;
  const snapCount = item.snapshots?.length ?? 0;

  // Calculate gain: first mcap vs highest mcap in timeline
  const firstMcap = item.snapshots?.[0]?.usd_market_cap ?? item.snapshots?.[0]?.market_cap ?? item.mcap;
  const maxMcap = item.snapshots?.reduce((max, s) => {
    const v = s.usd_market_cap ?? s.market_cap;
    return v != null && v > max ? v : max;
  }, firstMcap ?? 0);
  const gainPct = firstMcap && firstMcap > 0 && maxMcap != null ? ((maxMcap - firstMcap) / firstMcap) * 100 : null;

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
              {item.chain.toUpperCase()} · {item.category === 'photon'
                ? (item.column ? `Photon · ${item.column === 'graduated' ? 'Graduated' : 'New'}` : 'Photon')
                : (CATEGORY_LABELS[item.category] || item.category)}
            </ThemedText>
          </View>
          <View style={styles.cardRight}>
            {mcap != null && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>{fmtUsd(mcap, { compact: true })}</ThemedText>
                {gainPct != null && gainPct !== 0 && (
                  <ThemedText type="small" style={{ color: gainPct > 0 ? theme.positive : theme.negative, fontWeight: '600' }}>
                    {gainPct > 0 ? '+' : ''}{gainPct.toFixed(0)}%
                  </ThemedText>
                )}
              </View>
            )}
            {vol != null && vol > 0 && (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>Vol {fmtUsd(vol, { compact: true })}</ThemedText>
            )}
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {new Date(item.entered_at || item.notified_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </ThemedText>
            {item.filter_matched_at && (
              <ThemedText type="small" style={{ color: theme.accent }}>
                Filtro: {new Date(item.filter_matched_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
          {tpHolders != null && tpHolders > 0 && stat('hardware-chip', String(tpHolders), theme.warn)}
          {topHolders != null && topHolders > 0 && stat('stats-chart', `${(topHolders * 100).toFixed(1)}%`, topHolders > 0.5 ? theme.warn : theme.accent)}
          {holdersTotal != null && holdersTotal > 0 && stat('person', fmtNum(holdersTotal), theme.accent)}
          {rug != null && rug > 0 && stat('warning', `${(rug * 100).toFixed(0)}%`, theme.negative)}
          {bundler != null && bundler > 0 && stat('layers', `${(bundler * 100).toFixed(0)}%`, '#f97316')}
          {bundleCnt != null && bundleCnt > 0 && stat('cube', String(bundleCnt), '#f97316')}
          {buys != null && buys > 0 && stat('cart', String(buys), theme.accent)}
          {entrap != null && entrap > 0 && stat('fish', `${(entrap * 100).toFixed(0)}%`, '#ef4444')}
        </View>

        {item.tweet_notified_at?.length ? (
          <View style={styles.tweetRow}>
            <Ionicons name="logo-twitter" size={12} color={theme.accent} />
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Notificó por tweet · {item.tweet_notified_at
                .map((t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
                .join(', ')}
            </ThemedText>
          </View>
        ) : null}

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
              const sBundleCnt = s.bundle_holders_count;
              const sBuys = s.buys_count;
              const sTpHolders = s.tp_holders_count;
              const sTopHolders = s.top_holders_rate;
              const sHolders = s.holders_count;
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
                  {sTpHolders != null && sTpHolders > 0 && snapStat('hardware-chip', String(sTpHolders), theme.warn)}
                  {sTopHolders != null && sTopHolders > 0 && snapStat('stats-chart', `${(sTopHolders * 100).toFixed(1)}%`, sTopHolders > 0.5 ? theme.warn : theme.accent)}
                  {sHolders != null && sHolders > 0 && snapStat('person', fmtNum(sHolders), theme.accent)}
                  {sRug != null && sRug > 0 && snapStat('warning', `${(sRug * 100).toFixed(0)}%`, theme.negative)}
                  {sBundler != null && sBundler > 0 && snapStat('layers', `${(sBundler * 100).toFixed(0)}%`, '#f97316')}
                  {sBundleCnt != null && sBundleCnt > 0 && snapStat('cube', String(sBundleCnt), '#f97316')}
                  {sBuys != null && sBuys > 0 && snapStat('cart', String(sBuys), theme.accent)}
                  {sEntrap != null && sEntrap > 0 && snapStat('fish', `${(sEntrap * 100).toFixed(0)}%`, '#ef4444')}
                </View>
              );
            })}
          </View>
        )}
      </Card>
    </Pressable>
  );
});

const HISTORY_CACHE_KEY = 'history_cache_v1';

export default function HistoryScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { notifications: wsNotifications, connected } = useWs();
  const [history, setHistory] = useState<NotificationHistoryItem[]>([]);
  const [view, setView] = useState<ViewKey>('history');
  const [search, setSearch] = useState('');
  const [chainFilter, setChainFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('recent');
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await getNotificationHistory(300);
      // Merge WS events newer than the response (arrived during the fetch).
      const newest = res.history[0]?.notified_at ?? '';
      const ids = new Set(res.history.map((e) => e.id));
      const extra = useWs.getState().notifications.filter(
        (n) => n.id != null && !ids.has(n.id) && (!newest || (n.notified_at ?? '') > newest),
      );
      setHistory([...extra, ...res.history].slice(0, 300));
      setLoadError(false);
      AsyncStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(res.history)).catch(() => {});
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Instant first paint from the last successful load while the fetch runs.
  useEffect(() => {
    AsyncStorage.getItem(HISTORY_CACHE_KEY)
      .then((raw) => {
        if (!raw) return;
        setHistory((prev) => (prev.length ? prev : JSON.parse(raw)));
      })
      .catch(() => {});
  }, []);

  // The socket was down (reconnect happened) — refill whatever was missed.
  const prevConnected = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevConnected.current === false && connected) load();
    prevConnected.current = connected;
  }, [connected, load]);

  useEffect(() => {
    if (wsNotifications.length === 0) return;
    setHistory((prev) => {
      // Merge by id so a live event can UPDATE an existing card (e.g. a new
      // "notificó por tweet" time) as well as add brand-new ones.
      const byId = new Map(prev.map((h) => [h.id, h]));
      let changed = false;
      for (const n of wsNotifications) {
        if (n.id == null) continue;
        const cur = byId.get(n.id);
        if (cur === undefined) {
          byId.set(n.id, n);
          changed = true;
        } else if (JSON.stringify(cur) !== JSON.stringify(n)) {
          byId.set(n.id, n);
          changed = true;
        }
      }
      if (!changed) return prev;
      return [...byId.values()]
        .sort((a, b) => (b.notified_at || '').localeCompare(a.notified_at || ''))
        .slice(0, 200);
    });
  }, [wsNotifications]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const searchLower = search.trim().toLowerCase();

  const filtered = useMemo(() => {
    let result = history.filter((h) => {
      if (chainFilter !== 'all' && h.chain !== chainFilter) return false;
      if (categoryFilter === 'new' && !h.category.startsWith('new_creation')) return false;
      if (categoryFilter === 'completed' && !h.category.startsWith('completed')) return false;
      if (categoryFilter === 'x_tracker' && !(h.tweet_notified_at?.length)) return false;
      if (categoryFilter === 'photon' && h.category !== 'photon') return false;
      if (searchLower) {
        return (h.symbol?.toLowerCase().includes(searchLower)) || (h.name?.toLowerCase().includes(searchLower));
      }
      return true;
    });
    if (categoryFilter === 'snaps') {
      result = [...result].sort((a, b) => (b.snapshots?.length ?? 0) - (a.snapshots?.length ?? 0));
    } else if (categoryFilter === 'gain') {
      result = [...result].sort((a, b) => calcGain(b) - calcGain(a));
    }
    return result;
  }, [history, chainFilter, categoryFilter, searchLower]);

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
        <ThemedText type="subtitle" style={styles.title}>Historial de Tokens</ThemedText>

        <View style={styles.viewTabs}>
          {VIEW_TABS.map((tab) => (
            <Pressable
              key={tab.key}
              onPress={() => setView(tab.key)}
              style={[styles.viewTab, view === tab.key && { backgroundColor: theme.accent }]}
            >
              <ThemedText type="small" style={{ color: view === tab.key ? '#000' : theme.textSecondary }}>
                {tab.label}
              </ThemedText>
            </Pressable>
          ))}
        </View>

        {view === 'winners' ? (
          <WinnersPanel />
        ) : view === 'tracking' ? (
          <TrackingPanel />
        ) : (
          <>
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

            <View style={styles.filterRow}>
              <Pressable
                onPress={() => setShowCategoryModal(true)}
                style={[styles.chainTab, { backgroundColor: theme.backgroundSelected }]}
              >
                <Ionicons name="filter" size={14} color={theme.accent} />
                <ThemedText type="small" style={{ color: theme.accent }}>
                  {CATEGORY_OPTIONS.find((o) => o.key === categoryFilter)?.label ?? 'Filtro'}
                </ThemedText>
              </Pressable>
            </View>

            <Modal visible={showCategoryModal} transparent animationType="fade" onRequestClose={() => setShowCategoryModal(false)}>
              <Pressable style={styles.modalOverlay} onPress={() => setShowCategoryModal(false)}>
                <View style={[styles.modalContent, { backgroundColor: theme.backgroundSelected, borderColor: theme.border }]}>
                  {CATEGORY_OPTIONS.map((opt) => (
                    <Pressable
                      key={opt.key}
                      onPress={() => { setCategoryFilter(opt.key); setShowCategoryModal(false); }}
                      style={[styles.modalItem, categoryFilter === opt.key && { backgroundColor: theme.accent + '20' }]}
                    >
                      <ThemedText type="small" style={{ color: categoryFilter === opt.key ? theme.accent : theme.text }}>
                        {opt.label}
                      </ThemedText>
                      {categoryFilter === opt.key && <Ionicons name="checkmark" size={16} color={theme.accent} />}
                    </Pressable>
                  ))}
                </View>
              </Pressable>
            </Modal>

            <View style={styles.searchWrap}>
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Buscar por símbolo..."
                placeholderTextColor={theme.textSecondary}
                style={[styles.searchInput, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]}
              />
            </View>

            {loadError && (
              <Card style={{ borderColor: theme.warn, backgroundColor: `${theme.warn}15` }}>
                <ThemedText type="small" style={{ color: theme.warn }}>
                  {history.length === 0 ? 'No se pudo cargar el historial.' : 'Sin conexión — mostrando datos guardados.'}
                </ThemedText>
                <Pressable onPress={() => load()} hitSlop={6}>
                  <ThemedText type="linkPrimary">Reintentar</ThemedText>
                </Pressable>
              </Card>
            )}

            <FlatList
              data={filtered}
              keyExtractor={(item, i) => `${item.address}-${item.category}-${item.notified_at}-${i}`}
              renderItem={renderItem}
              initialNumToRender={10}
              maxToRenderPerBatch={8}
              windowSize={5}
              removeClippedSubviews={false}
              contentContainerStyle={styles.scroll}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
              ListEmptyComponent={
                <ThemedText style={styles.empty}>{history.length === 0 ? 'No hay notificaciones aún' : 'Sin resultados'}</ThemedText>
              }
            />
          </>
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0d0d' },
  safe: { flex: 1 },
  title: { marginHorizontal: 16, marginTop: 12, marginBottom: 8 },
  viewTabs: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 10, gap: 6 },
  viewTab: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 14, backgroundColor: '#1a1a1a' },
  chainTabs: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, gap: 6 },
  filterRow: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, gap: 8, alignItems: 'center' },
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
  tweetRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 6 },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  snapToggle: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  timeline: { marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  snapRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 1, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
  snapStatItem: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { borderRadius: 12, borderWidth: 1, padding: 8, width: 200 },
  modalItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8 },
});
