import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Linking, Modal, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { WinnersPanel } from '@/components/winners-panel';
import { TokenAvatar } from '@/components/token-avatar';
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
  { key: 'vol_mcap', label: 'Vol ≈ MCap' },
  { key: 'snaps', label: 'Snapshots' },
  { key: 'gain', label: 'Ganancia' },
];

const VIEW_TABS = [
  { key: 'history', label: 'Historial' },
  { key: 'winners', label: 'Winners' },
] as const;
type ViewKey = (typeof VIEW_TABS)[number]['key'];

function calcGain(item: UnifiedItem): number {
  const snaps = item.snapshots;
  if (!snaps?.length) return 0;
  const firstMcap = snaps[0].usd_market_cap ?? snaps[0].market_cap;
  if (!firstMcap || firstMcap <= 0) return 0;
  const maxMcap = snaps.reduce((max, s) => {
    const v = s.usd_market_cap ?? s.market_cap;
    return v != null && v > max ? v : max;
  }, firstMcap);
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
  vol_mcap: 'Vol ≈ MCap',
};

/** One card per token: every notification of the same mint merged together. */
interface UnifiedItem {
  address: string;
  chain: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  /** Newest notification — source for mcap, volume and the stats row. */
  base: NotificationHistoryItem;
    /** Every category/column this token hit, chronological (for the chips). */
    events: { category: string; column?: 'new' | 'graduated' | null; label: string; notified_at: string }[];
  /** All snapshots from every notification, sorted oldest → newest. */
  snapshots: TokenSnapshot[];
  /** Snapshots from trenches events (new_creation / completed) — the "Gmgn" toggle. */
  gmgnSnapshots: TokenSnapshot[];
  /** Snapshots from photon events — the "Photon" toggle. */
  photonSnapshots: TokenSnapshot[];
  /** Union of tweet notification times, ascending. */
  tweetTimes: string[];
}

function eventLabel(category: string, column?: 'new' | 'graduated' | null): string {
  if (category === 'photon') {
    return column ? `Photon · ${column === 'graduated' ? 'Graduated' : 'New'}` : 'Photon';
  }
  return CATEGORY_LABELS[category] || category;
}

function groupByAddress(history: NotificationHistoryItem[]): UnifiedItem[] {
  const map = new Map<string, UnifiedItem>();
  for (const h of history) {
    if (h.id == null || !h.address) continue;
    let u = map.get(h.address);
    if (!u) {
      u = {
        address: h.address,
        chain: h.chain,
        symbol: h.symbol,
        name: h.name,
        logo: h.logo,
        base: h,
        events: [],
        snapshots: [],
        gmgnSnapshots: [],
        photonSnapshots: [],
        tweetTimes: [],
      };
      map.set(h.address, u);
    }
    if ((h.notified_at || '') > (u.base.notified_at || '')) {
      u.base = h;
      if (h.symbol || h.name || h.logo) {
        u.symbol = h.symbol ?? u.symbol;
        u.name = h.name ?? u.name;
        u.logo = h.logo ?? u.logo;
      }
    }
    u.events.push({ category: h.category, column: h.column, label: eventLabel(h.category, h.column), notified_at: h.notified_at });
    if (h.snapshots?.length) {
      u.snapshots.push(...h.snapshots);
      if (h.category === 'photon') u.photonSnapshots.push(...h.snapshots);
      else u.gmgnSnapshots.push(...h.snapshots);
    }
    if (h.tweet_notified_at?.length) u.tweetTimes.push(...h.tweet_notified_at);
  }
  const out = Array.from(map.values());
  for (const u of out) {
    u.events.sort((a, b) => (a.notified_at || '').localeCompare(b.notified_at || ''));
    u.snapshots.sort((a, b) => (a.t || '').localeCompare(b.t || ''));
    u.gmgnSnapshots.sort((a, b) => (a.t || '').localeCompare(b.t || ''));
    u.photonSnapshots.sort((a, b) => (a.t || '').localeCompare(b.t || ''));
    u.tweetTimes = Array.from(new Set(u.tweetTimes)).sort();
  }
  return out;
}

function firstNotifiedAt(u: UnifiedItem): string {
  return u.events[0]?.notified_at || u.base.notified_at;
}

function fmtClock(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function gmgnUrl(chain: string, address: string): string {
  const c = (chain || 'sol').toLowerCase();
  const seg = c === 'solana' || c === 'sol' ? 'sol' : c;
  return `https://gmgn.ai/${seg}/token/${address}`;
}

/** One expandable snapshot timeline (Gmgn or Photon). */
function SnapTimeline({ snaps, theme }: { snaps: TokenSnapshot[]; theme: any }) {
  return (
    <View style={[styles.timeline, { borderTopColor: theme.border }]}>
      {snaps.map((s: TokenSnapshot, i: number) => {
        const sMcap = s.usd_market_cap ?? s.market_cap;
        const sVol = s.volume_24h;
        const sSm = s.smart_degen_count;
        const sKol = s.renowned_count;
        const sFresh = s.fresh_wallet_rate;
        const sBotCount = s.bot_degen_count;
        const sBot = s.bot_degen_rate;
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
            {sBundler != null && sBundler > 0 && snapStat('layers', `${(sBundler * 100).toFixed(0)}%`, '#f97316')}
            {sBundleCnt != null && sBundleCnt > 0 && snapStat('cube', String(sBundleCnt), '#f97316')}
            {sBuys != null && sBuys > 0 && snapStat('cart', String(sBuys), theme.accent)}
            {sEntrap != null && sEntrap > 0 && snapStat('fish', `${(sEntrap * 100).toFixed(0)}%`, '#ef4444')}
          </View>
        );
      })}
    </View>
  );
}

const HistoryCard = React.memo(function HistoryCard({ item, theme, expandedGmgn, expandedPhoton, onToggleGmgn, onTogglePhoton }: {
  item: UnifiedItem; theme: any;
  expandedGmgn: boolean; expandedPhoton: boolean;
  onToggleGmgn: () => void; onTogglePhoton: () => void;
}) {
  // Newest notification supplies the stats; snapshots are the merged timeline.
  const base = item.base;
  const snap = base.snapshots?.[0] ?? null;
  const mcap = snap?.usd_market_cap ?? snap?.market_cap ?? base.mcap;
  const gmgnCount = item.gmgnSnapshots.length;
  const photonCount = item.photonSnapshots.length;

  // Gain across the merged timeline: first mcap vs highest mcap.
  const gainVal = calcGain(item);
  const gainPct = gainVal !== 0 ? gainVal : null;

  return (
    <Pressable>
      <Card style={[styles.card, { borderColor: theme.border }]}>
        <View style={styles.cardHeader}>
          <TokenAvatar logo={item.logo} symbol={item.symbol} size={32} />
          <View style={styles.cardInfo}>
            <ThemedText type="smallBold" style={{ color: theme.text }}>
              {item.symbol || item.name || shortAddress(item.address)}
            </ThemedText>
            <ThemedText type="small" style={{ color: theme.textSecondary }} numberOfLines={1}>
              {item.name || item.chain.toUpperCase()}
            </ThemedText>
          </View>
          <View style={styles.cardRight}>
            {mcap != null && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>{fmtUsd(mcap, { compact: true })}</ThemedText>
                {gainPct != null && (
                  <ThemedText type="small" style={{ color: gainPct > 0 ? theme.positive : theme.negative, fontWeight: '600' }}>
                    {gainPct > 0 ? '+' : ''}{gainPct.toFixed(0)}%
                  </ThemedText>
                )}
              </View>
            )}
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {fmtClock(firstNotifiedAt(item))}
            </ThemedText>
            {base.filter_matched_at && (
              <ThemedText type="small" style={{ color: theme.accent }}>
                Filtro: {fmtClock(base.filter_matched_at)}
              </ThemedText>
            )}
          </View>
        </View>

        {item.events.length > 0 && (
          <View style={styles.chipsRow}>
            {item.events.map((e, i) => (
              <View
                key={`${e.category}-${e.notified_at}-${i}`}
                style={[styles.chip, { backgroundColor: theme.backgroundSelected, borderColor: theme.border }]}
              >
                <ThemedText type="small" style={{ color: theme.accent, fontSize: 11 }}>{e.label}</ThemedText>
                <ThemedText type="small" style={{ color: theme.textSecondary, fontSize: 10 }}>{fmtClock(e.notified_at)}</ThemedText>
              </View>
            ))}
          </View>
        )}

        {item.tweetTimes.length ? (
          <View style={styles.tweetRow}>
            <Ionicons name="logo-twitter" size={12} color={theme.accent} />
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Notificó por tweet · {item.tweetTimes
                .slice(-5)
                .map(fmtClock)
                .join(', ')}
            </ThemedText>
          </View>
        ) : null}

        <View style={styles.cardFooter}>
          <View style={styles.footerLeft}>
            <Pressable
              onPress={() => Linking.openURL(gmgnUrl(item.chain, item.address)).catch(() => {})}
              style={[styles.gmgnBtn, { backgroundColor: theme.backgroundSelected, borderColor: theme.border }]}
            >
              <Ionicons name="open-outline" size={12} color={theme.accent} />
              <ThemedText type="small" style={{ color: theme.accent }}>Gmgn</ThemedText>
            </Pressable>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {shortAddress(item.address)}
            </ThemedText>
          </View>
          <View style={styles.togglesRow}>
            {gmgnCount > 1 && (
              <Pressable onPress={onToggleGmgn} style={styles.snapToggle}>
                <Ionicons name={expandedGmgn ? 'chevron-up' : 'chevron-down'} size={14} color={theme.accent} />
                <ThemedText type="small" style={{ color: theme.accent }}>{gmgnCount} GMGN</ThemedText>
              </Pressable>
            )}
            {photonCount > 1 && (
              <Pressable onPress={onTogglePhoton} style={styles.snapToggle}>
                <Ionicons name={expandedPhoton ? 'chevron-up' : 'chevron-down'} size={14} color={theme.accent} />
                <ThemedText type="small" style={{ color: theme.accent }}>{photonCount} Photon</ThemedText>
              </Pressable>
            )}
          </View>
        </View>

        {expandedGmgn && gmgnCount > 1 && <SnapTimeline snaps={item.gmgnSnapshots} theme={theme} />}
        {expandedPhoton && photonCount > 1 && <SnapTimeline snaps={item.photonSnapshots} theme={theme} />}
      </Card>
    </Pressable>
  );
});

const HISTORY_CACHE_KEY = 'history_cache_v1';

export default function HistoryScreen() {
  const theme = useTheme();
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

  const unified = useMemo(() => groupByAddress(history), [history]);

  const filtered = useMemo(() => {
    let result = unified.filter((u) => {
      if (chainFilter !== 'all' && u.chain !== chainFilter) return false;
      if (categoryFilter === 'new' && !u.events.some((e) => e.category.startsWith('new_creation'))) return false;
      if (categoryFilter === 'completed' && !u.events.some((e) => e.category.startsWith('completed'))) return false;
      if (categoryFilter === 'x_tracker' && u.tweetTimes.length === 0) return false;
      if (categoryFilter === 'photon' && !u.events.some((e) => e.category === 'photon')) return false;
      if (categoryFilter === 'vol_mcap' && !u.events.some((e) => e.category === 'vol_mcap')) return false;
      if (searchLower) {
        return (u.symbol?.toLowerCase().includes(searchLower)) || (u.name?.toLowerCase().includes(searchLower));
      }
      return true;
    });
    if (categoryFilter === 'snaps') {
      result = [...result].sort((a, b) => b.snapshots.length - a.snapshots.length);
    } else if (categoryFilter === 'gain') {
      result = [...result].sort((a, b) => calcGain(b) - calcGain(a));
    } else if (categoryFilter === 'recent') {
      result = [...result].sort((a, b) => (firstNotifiedAt(b) || '').localeCompare(firstNotifiedAt(a) || ''));
    }
    return result;
  }, [unified, chainFilter, categoryFilter, searchLower]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const renderItem = useCallback(({ item }: { item: UnifiedItem }) => (
    <HistoryCard
      item={item}
      theme={theme}
      expandedGmgn={expandedIds.has(item.address)}
      expandedPhoton={expandedIds.has(`${item.address}:photon`)}
      onToggleGmgn={() => toggleExpanded(item.address)}
      onTogglePhoton={() => toggleExpanded(`${item.address}:photon`)}
    />
  ), [theme, expandedIds, toggleExpanded]);

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
              keyExtractor={(item) => item.address}
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
  cardInfo: { flex: 1 },
  cardRight: { alignItems: 'flex-end' },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  tweetRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 6 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, flexWrap: 'wrap', gap: 8 },
  footerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  gmgnBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  togglesRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  snapToggle: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  timeline: { marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  snapRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 1, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
  snapStatItem: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { borderRadius: 12, borderWidth: 1, padding: 8, width: 200 },
  modalItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8 },
});
