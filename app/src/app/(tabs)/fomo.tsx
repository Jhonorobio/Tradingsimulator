import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TokenAvatar } from '@/components/token-avatar';
import { useTheme } from '@/hooks/use-theme';
import { getFomoGraduated, getFomoTrending, setFomoProxy, putFomoNotifyFilters } from '@/api/market';
import type { FomoFeedResponse, FomoFilters, FomoPushData, FomoToken } from '@/api/market';
import { getNotificationConfig, saveNotificationConfig } from '@/api/notifications';
import { ApiError } from '@/api/client';
import { useSettings } from '@/store/settings';
import { registerForPushNotificationsAsync, notificationsAvailable } from '@/utils/notifications';
import { getWsClient } from '@/api/ws-client';
import { fmtNum, fmtPct, fmtUsd, timeAgo } from '@/utils/format';

const FILTERS_KEY = 'trading-sim/fomo-filters';
const POLL_MS = 10_000;

/** Two feeds from the same FOMO WS — only the origin differs (Solana only). */
type Feed = 'graduated' | 'trending';

/**
 * Per-tab default filters. Trending's age is off by default but fully
 * supported: upstream sends no `createdAt` there, so the server resolves it
 * per token via Pulse's `created_at` when the bound is set.
 */
const FILTER_DEFAULTS: Record<Feed, FomoFilters> = {
  graduated: { ageMaxMin: '60', mcapMin: '60000', mcapMax: '450000', kolMin: '' },
  trending: { ageMaxMin: '', mcapMin: '60000', mcapMax: '450000', kolMin: '' },
};

interface FilterField {
  key: keyof FomoFilters;
  label: string;
  unit: string;
  placeholder: string;
}

const FILTER_FIELDS: FilterField[] = [
  { key: 'ageMaxMin', label: 'Edad máxima', unit: 'm', placeholder: 'sin límite' },
  { key: 'mcapMin', label: 'Market cap mínimo', unit: '$', placeholder: 'sin límite' },
  { key: 'mcapMax', label: 'Market cap máximo', unit: '$', placeholder: 'sin límite' },
  { key: 'kolMin', label: 'KOLs mínimo', unit: 'KOL', placeholder: 'sin límite' },
];

/** Per-feed display + WS topic/event metadata. */
interface FeedMeta {
  label: string;
  /** Server WS topic + event pushed for this feed. */
  topic: string;
  event: string;
  icon: keyof typeof Ionicons.glyphMap;
}

const FEED_META: Record<Feed, FeedMeta> = {
  graduated: { label: 'Graduados', topic: 'fomo', event: 'fomo_updated', icon: 'ribbon' },
  trending: { label: 'Trending', topic: 'fomo_trending', event: 'fomo_trending_updated', icon: 'flame' },
};
const FEEDS: Feed[] = ['graduated', 'trending'];

/** Keep only known string fields from a stored object (corruption tolerance). */
function pickFilters(raw: unknown): Partial<FomoFilters> {
  const out: Partial<FomoFilters> = {};
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const f of FILTER_FIELDS) {
      const v = o[f.key];
      if (typeof v === 'string') out[f.key] = v as FomoFilters[keyof FomoFilters];
    }
  }
  return out;
}

/**
 * Per-tab filters: the stored value is Record<Feed, FomoFilters>. The legacy
 * flat shape (one set shared by both tabs) is applied to BOTH tabs so nothing
 * changes for the user; corrupted values fall back to the per-tab defaults.
 */
function loadStoredFilters(raw: string | null): Record<Feed, FomoFilters> {
  const out: Record<Feed, FomoFilters> = {
    graduated: { ...FILTER_DEFAULTS.graduated },
    trending: { ...FILTER_DEFAULTS.trending },
  };
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && ('graduated' in parsed || 'trending' in parsed)) {
      const perFeed = parsed as Record<string, unknown>;
      for (const fd of FEEDS) out[fd] = { ...out[fd], ...pickFilters(perFeed[fd]) };
    } else {
      const shared = pickFilters(parsed);
      out.graduated = { ...out.graduated, ...shared };
      out.trending = { ...out.trending, ...shared };
    }
  } catch {
    // corrupted value → keep defaults
  }
  return out;
}

/** ''/junk → null (no bound) — mirrors the server's toN(). */
function toBound(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Client-side filter over the live map — same semantics as the server's
 * GET /fomo/{graduated,trending} (WS pushes are unfiltered, so the view filters
 * here). The age bound applies to both tabs: trending records get their
 * `createdAt` resolved server-side via Pulse when the bound is set (the REST
 * poll backfills it within ~10s, like the KOL count). The trending list sorts
 * by rank instead of date. A token without `kolCount` never passes an active
 * KOL filter; the REST poll also backfills counts for candidates.
 */
function filterTokens(map: Map<string, FomoToken>, f: FomoFilters, feed: Feed): FomoToken[] {
  const now = Math.floor(Date.now() / 1000);
  const ageMaxMin = toBound(f.ageMaxMin);
  const mcapMin = toBound(f.mcapMin);
  const mcapMax = toBound(f.mcapMax);
  const kolMin = toBound(f.kolMin);
  const out: FomoToken[] = [];
  for (const t of map.values()) {
    if (ageMaxMin != null && (t.createdAt == null || now - t.createdAt > ageMaxMin * 60)) continue;
    if (
      (mcapMin != null || mcapMax != null) &&
      (t.mcap == null || (mcapMin != null && t.mcap < mcapMin) || (mcapMax != null && t.mcap > mcapMax))
    ) {
      continue;
    }
    if (kolMin != null && (t.kolCount == null || t.kolCount < kolMin)) continue;
    out.push(t);
  }
  out.sort(
    feed === 'trending'
      ? (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
      : (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  );
  return out;
}

/**
 * Merge tokens into the map. WS pushes (and snapshot rebuilds) drop fields
 * the upstream record doesn't repeat — `kolCount` (enriched server-side) and
 * the Pulse-resolved `createdAt` that trending items never carry — so keep
 * the values we already know instead of letting every push erase them.
 */
function mergeTokens(next: Map<string, FomoToken>, list: FomoToken[], old: Map<string, FomoToken>) {
  for (const t of list) {
    const prev = old.get(t.address);
    let rec = t;
    if (prev) {
      const kolCount = t.kolCount != null ? t.kolCount : prev.kolCount;
      const createdAt = t.createdAt != null ? t.createdAt : prev.createdAt;
      if (kolCount !== t.kolCount || createdAt !== t.createdAt) rec = { ...t, kolCount, createdAt };
    }
    next.set(t.address, rec);
  }
}

/** Apply upstream removals (`removed` in WS pushes) to the map. */
function removeAddresses(next: Map<string, FomoToken>, removed?: string[]) {
  if (!removed?.length) return;
  for (const addr of removed) next.delete(addr);
}

/** GMGN token page — every FOMO feed is Solana-only. */
function gmgnUrl(address: string): string {
  return `https://gmgn.ai/sol/token/${address}`;
}

/**
 * FOMO's own token page — their React Router manifest defines the SEO route
 * `tokens/:chain/:tokenAddress` with chain slug `solana` (confirmed against
 * their /assets/manifest-*.js and AASA "SEO-friendly token pages").
 */
function fomoUrl(address: string): string {
  return `https://fomo.family/tokens/solana/${address}`;
}

interface StatItem {
  icon: keyof typeof Ionicons.glyphMap;
  value: string | null;
  color: string;
}

function FomoRow({ token, showRank = false }: { token: FomoToken; showRank?: boolean }) {
  const theme = useTheme();

  // change24 is a FRACTION upstream — ×100 for percent display (FOMO does the same).
  const changePct = token.change24 != null ? token.change24 * 100 : null;
  const changeColor =
    changePct == null ? theme.textSecondary : changePct >= 0 ? '#22c55e' : '#ef4444';

  const stats: StatItem[] = [
    { icon: 'people', value: token.holders != null ? fmtNum(token.holders) : null, color: theme.textSecondary },
    { icon: 'bar-chart', value: token.vol24 != null ? fmtUsd(token.vol24, { compact: true }) : null, color: theme.textSecondary },
    { icon: 'trending-up', value: fmtPct(changePct), color: changeColor },
    { icon: 'pricetag', value: token.price != null ? fmtUsd(token.price) : null, color: theme.textSecondary },
    // KOL count (Pulse) — only present once the server enriched the record.
    { icon: 'star', value: token.kolCount != null ? `${fmtNum(token.kolCount)} KOL` : null, color: '#a855f7' },
  ];
  const visible = stats.filter((s) => s.value != null && s.value !== '—');

  return (
    <Pressable style={styles.card}>
      <View style={styles.mainRow}>
        <View style={[styles.avatarWrap, { borderColor: '#a855f7' }]}>
          <TokenAvatar logo={token.image} symbol={token.symbol} size={50} borderRadius={4} />
        </View>

        <View style={styles.contentCol}>
          <View style={styles.row}>
            <View style={styles.leftGroup}>
              {showRank && token.rank != null && (
                <ThemedText type="smallBold" style={[styles.rankText, { color: '#a855f7' }]}>
                  #{token.rank + 1}
                </ThemedText>
              )}
              <ThemedText type="smallBold" numberOfLines={1} style={[styles.symbolText, { color: theme.text }]}>
                {token.symbol || '???'}
              </ThemedText>
              <ThemedText numberOfLines={1} style={[styles.nameText, { color: theme.textSecondary }]}>
                {token.name || 'Token'}
              </ThemedText>
            </View>
            <View style={styles.rightGroup}>
              <ThemedText style={[styles.valueLabel, { color: theme.textSecondary }]}>MC</ThemedText>
              <ThemedText type="small" style={[styles.valueText, { fontWeight: '500', color: theme.text }]}>
                {fmtUsd(token.mcap, { compact: true })}
              </ThemedText>
            </View>
          </View>

          <View style={styles.row}>
            <View style={styles.leftGroup}>
              <ThemedText style={[styles.ageText, { color: theme.textSecondary }]}>
                {token.createdAt != null ? timeAgo(token.createdAt) : '—'}
                {token.launchpad ? ` · ${token.launchpad}` : ''}
              </ThemedText>
            </View>
            <View style={styles.rightGroup}>
              <ThemedText style={[styles.valueLabel, { color: theme.textSecondary }]}>V24</ThemedText>
              <ThemedText type="small" style={[styles.valueText, { fontWeight: '500', color: theme.text }]}>
                {fmtUsd(token.vol24, { compact: true })}
              </ThemedText>
            </View>
          </View>
        </View>
      </View>

      {visible.length > 0 && (
        <View style={styles.statsBar}>
          {visible.map((s, i) => (
            <View key={i} style={styles.statItem}>
              <Ionicons name={s.icon} size={13} color={s.color} />
              <ThemedText style={[styles.statValue, { color: s.color }]}>{s.value}</ThemedText>
            </View>
          ))}
        </View>
      )}

      {/* Full mint + FOMO/GMGN shortcuts (footer pattern matches History cards). */}
      <View style={styles.addrRow}>
        <ThemedText style={[styles.addrText, { color: theme.textSecondary }]} numberOfLines={1}>
          {token.address}
        </ThemedText>
        <Pressable
          onPress={() => Linking.openURL(fomoUrl(token.address)).catch(() => {})}
          hitSlop={8}
          style={[styles.linkBtn, { backgroundColor: theme.backgroundSelected, borderColor: theme.border }]}>
          <Ionicons name="flame-outline" size={12} color={theme.accent} />
          <ThemedText type="small" style={{ color: theme.accent }}>Fomo</ThemedText>
        </Pressable>
        <Pressable
          onPress={() => Linking.openURL(gmgnUrl(token.address)).catch(() => {})}
          hitSlop={8}
          style={[styles.linkBtn, { backgroundColor: theme.backgroundSelected, borderColor: theme.border }]}>
          <Ionicons name="open-outline" size={12} color={theme.accent} />
          <ThemedText type="small" style={{ color: theme.accent }}>Gmgn</ThemedText>
        </Pressable>
      </View>
    </Pressable>
  );
}

export default function FomoScreen() {
  const theme = useTheme();
  const pushToken = useSettings((s) => s.pushToken);
  const setPushToken = useSettings((s) => s.setPushToken);
  /** Active sub-feed — each tab has its OWN filter set (per pestaña). */
  const [feed, setFeed] = useState<Feed>('graduated');
  /** Filter state per tab; `filters` is the active tab's set. */
  const [filtersByFeed, setFiltersByFeed] = useState<Record<Feed, FomoFilters>>(FILTER_DEFAULTS);
  const filters = filtersByFeed[feed];
  /** Live token maps (one per feed): WS pushes (unfiltered) + REST backfill. */
  const [gradMap, setGradMap] = useState<Map<string, FomoToken>>(() => new Map());
  const [trendMap, setTrendMap] = useState<Map<string, FomoToken>>(() => new Map());
  const [resp, setResp] = useState<FomoFeedResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  /** True while pushes arrived recently — flipped by the WS handler + a stale timer. */
  const [pushFresh, setPushFresh] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const [editorVisible, setEditorVisible] = useState(false);
  const [draft, setDraft] = useState<FomoFilters>(FILTER_DEFAULTS.graduated);
  /** Per-feed alert switches, read from the notification config on open. */
  const [alerts, setAlerts] = useState<Record<Feed, boolean>>({ graduated: false, trending: false });
  /** Proxy draft — persisted on the SERVER (reconnects the FOMO WS). */
  const [proxyDraft, setProxyDraft] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load the saved per-tab filters once (legacy flat values → both tabs).
  useEffect(() => {
    AsyncStorage.getItem(FILTERS_KEY)
      .then((raw) => setFiltersByFeed(loadStoredFilters(raw)))
      .catch(() => {})
      .finally(() => setHydrated(true));
  }, []);

  const load = useCallback(async (f: FomoFilters, fd: Feed) => {
    try {
      const res = fd === 'trending' ? await getFomoTrending(f) : await getFomoGraduated(f);
      setResp(res);
      setFetchError(null);
      // Merge (never replace): WS owns the truth, REST just backfills.
      // `fd` picks the target map so a late response can't cross feeds.
      const target = fd === 'trending' ? setTrendMap : setGradMap;
      target((prev) => {
        const next = new Map(prev);
        mergeTokens(next, res.tokens, prev);
        return next;
      });
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Real-time feed: the server pushes batched changes (~1/s) per feed — topic
  // `fomo` (graduados) or `fomo_trending`. Only the visible feed stays
  // subscribed; subscribing triggers an immediate full snapshot push.
  // Freshness is a flag flipped here and expired by a timer — Date.now() in
  // render would break react-hooks/purity.
  useEffect(() => {
    const meta = FEED_META[feed];
    const client = getWsClient();
    client.subscribe(meta.topic);
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    const off = client.on(meta.event, (msg) => {
      const data = (msg?.data ?? null) as FomoPushData | null;
      if (!data) return;
      const incoming = data.tokens ?? [];
      if (incoming.length === 0 && !data.removed?.length) return;
      setPushFresh(true);
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => setPushFresh(false), 15_000);
      const target = feed === 'trending' ? setTrendMap : setGradMap;
      target((prev) => {
        if (data.snapshot) {
          // Authoritative upstream rebuild — entries missing here are gone.
          const next = new Map<string, FomoToken>();
          mergeTokens(next, incoming, prev);
          removeAddresses(next, data.removed);
          return next;
        }
        const next = new Map(prev);
        mergeTokens(next, incoming, prev);
        removeAddresses(next, data.removed);
        return next;
      });
    });
    return () => {
      if (staleTimer) clearTimeout(staleTimer);
      off();
      client.unsubscribe(meta.topic);
    };
  }, [feed]);

  // Poll the server-side filtered feed (server holds the live WS connection).
  // `feed` in the deps refetches the other list right when tabs switch.
  useEffect(() => {
    if (!hydrated) return;
    // Defer the first fetch so setState never runs synchronously in the effect.
    const first = setTimeout(() => load(filters, feed), 0);
    const timer = setInterval(() => load(filters, feed), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [hydrated, filters, feed, load]);

  const openFilterEditor = useCallback(() => {
    setDraft({ ...filtersByFeed[feed] });
    setProxyDraft(resp?.status.proxy?.url ?? '');
    setSaveError(null);
    setEditorVisible(true);
    // Current per-device alert switches (may have changed since the last open).
    getNotificationConfig()
      .then((cfg) => setAlerts({ graduated: cfg.fomo_graduated_alerts === true, trending: cfg.fomo_trending_alerts === true }))
      .catch(() => {});
  }, [feed, filtersByFeed, resp]);

  const closeFilterEditor = useCallback(() => setEditorVisible(false), []);

  const resetDraft = useCallback(() => {
    setDraft({ ...FILTER_DEFAULTS[feed] });
    setProxyDraft('');
    setSaveError(null);
  }, [feed]);

  const setDraftValue = useCallback((key: keyof FomoFilters, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const confirmFilters = useCallback(async () => {
    const nextAll: Record<Feed, FomoFilters> = { ...filtersByFeed, [feed]: { ...draft } };
    setFiltersByFeed(nextAll);
    AsyncStorage.setItem(FILTERS_KEY, JSON.stringify(nextAll)).catch(() => {});

    // Proxy lives on the server: PUT only when it actually changed.
    const currentProxy = resp?.status.proxy?.url ?? '';
    const nextProxy = proxyDraft.trim();
    if (nextProxy !== currentProxy) {
      setSaving(true);
      try {
        await setFomoProxy(nextProxy);
        setSaveError(null);
      } catch (err) {
        setSaveError(`Error al guardar el proxy: ${err instanceof Error ? err.message : String(err)}`);
        setSaving(false);
        return; // keep the sheet open so the error is visible
      }
    }

    // Push BOTH tabs' filters so the server-side alert matcher evaluates with
    // exactly what this screen shows (alerts fire per tab with its own set).
    try {
      await putFomoNotifyFilters(nextAll);
    } catch (err) {
      setSaveError(`Error al sincronizar los filtros de aviso: ${err instanceof Error ? err.message : String(err)}`);
      setSaving(false);
      return; // keep the sheet open — alerts would use stale filters
    }
    setSaving(false);
    setEditorVisible(false);
  }, [draft, feed, filtersByFeed, proxyDraft, resp]);

  /**
   * Enable/disable a feed's alert notifications (per device, merge-only flags —
   * the rest of the notification config is untouched). Enabling first pushes
   * the current per-tab filters to the server, so the matcher is always up to
   * date the moment the switch turns on.
   */
  const toggleAlert = useCallback(async (fd: Feed, value: boolean) => {
    setAlerts((prev) => ({ ...prev, [fd]: value })); // optimistic
    const revert = () => setAlerts((prev) => ({ ...prev, [fd]: !value }));
    try {
      const cfg = await getNotificationConfig();
      let token = cfg.push_token ?? pushToken;
      if (value && !token) {
        if (!notificationsAvailable()) {
          Alert.alert('Push no disponible', 'En Android, expo-notifications ya no funciona dentro de Expo Go (desde SDK 53). Necesitas un development build.');
          revert();
          return;
        }
        token = await registerForPushNotificationsAsync();
        if (!token) {
          Alert.alert('Push no disponible', 'Solo funciona en un dispositivo físico.');
          revert();
          return;
        }
        setPushToken(token);
      }
      if (!token) throw new Error('Sin token de notificaciones');
      if (value) await putFomoNotifyFilters(filtersByFeed);
      const other = fd === 'graduated' ? cfg.fomo_trending_alerts === true : cfg.fomo_graduated_alerts === true;
      await saveNotificationConfig(
        token,
        cfg.categories,
        cfg.filters,
        cfg.tracker_tweets,
        cfg.vol_mcap_alerts,
        cfg.vol_mcap_min_mcap,
        cfg.vol_mcap_kol,
        fd === 'graduated' ? value : other,
        fd === 'trending' ? value : other,
      );
    } catch (err) {
      revert();
      Alert.alert('Error', err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'No se pudo guardar');
    }
  }, [filtersByFeed, pushToken, setPushToken]);

  const activeMap = feed === 'trending' ? trendMap : gradMap;
  const tokens = useMemo(() => filterTokens(activeMap, filters, feed), [activeMap, filters, feed]);
  const status = resp?.status;
  const trendStatus = status?.trending;
  const feedCount = (feed === 'trending' ? trendStatus?.count : status?.count) ?? activeMap.size;
  const feedMsgAge = feed === 'trending' ? trendStatus?.lastMsgAgeMs ?? null : status?.lastMsgAgeMs ?? null;
  const feedConnected = feed === 'trending' ? trendStatus?.subscribed === true : status?.connected === true;
  const feedLive = feed === 'trending' ? trendStatus?.live === true : status?.live === true;
  // Live = recent WS push (primary) OR upstream feed healthy per REST status.
  const live = pushFresh || (fetchError == null && feedLive);

  const statusText = pushFresh
    ? `en vivo · ${feedCount} tokens${status?.proxy?.transport === 'proxy' ? ' · px' : ''}`
    : fetchError
      ? fetchError
      : status
        ? feedConnected
          ? `${feedCount} tokens${feedMsgAge != null ? ` · ${(feedMsgAge / 1000).toFixed(0)}s` : ''}${status.proxy?.transport === 'proxy' ? ' · px' : ''}`
          : 'conectando…'
        : 'cargando…';

  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    const age = Number(filters.ageMaxMin);
    if (filters.ageMaxMin && Number.isFinite(age)) parts.push(`≤${age}m`);
    const lo = Number(filters.mcapMin);
    const hi = Number(filters.mcapMax);
    if (filters.mcapMin && Number.isFinite(lo)) parts.push(`≥${fmtUsd(lo, { compact: true })}`);
    if (filters.mcapMax && Number.isFinite(hi)) parts.push(`≤${fmtUsd(hi, { compact: true })}`);
    const kol = Number(filters.kolMin);
    if (filters.kolMin && Number.isFinite(kol)) parts.push(`≥${kol} KOL`);
    return parts.length > 0 ? parts.join(' · ') : 'sin filtros';
  }, [filters]);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.topBar}>
          <View style={styles.titleGroup}>
            <ThemedText type="title" style={{ color: theme.text }}>FOMO</ThemedText>
            <View style={[styles.liveDot, { backgroundColor: live ? '#22c55e' : '#ef4444' }]} />
            <ThemedText type="small" numberOfLines={1} style={{ color: theme.textSecondary, flexShrink: 1 }}>
              {statusText}
            </ThemedText>
          </View>
          <View style={styles.topActions}>
            <Pressable
              onPress={openFilterEditor}
              style={[styles.filterBtn, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
              <Ionicons name="funnel" size={16} color={theme.textSecondary} />
            </Pressable>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {tokens.length}
            </ThemedText>
          </View>
        </View>

        {/* Feed switcher: graduados | trending (filtros propios de cada pestaña). */}
        <View style={styles.feedTabs}>
          {FEEDS.map((key) => {
            const meta = FEED_META[key];
            const active = feed === key;
            return (
              <Pressable
                key={key}
                onPress={() => setFeed(key)}
                style={[styles.feedTab, active && styles.feedTabActive]}>
                <Ionicons name={meta.icon} size={14} color={active ? '#080808' : theme.textSecondary} />
                <ThemedText type="smallBold" style={{ color: active ? '#080808' : theme.textSecondary }}>
                  {meta.label}
                </ThemedText>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.filterBar}>
          <Ionicons name="options-outline" size={13} color={theme.textSecondary} />
          <ThemedText type="small" style={{ color: theme.textSecondary }}>{filterSummary}</ThemedText>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>· FOMO {FEED_META[feed].label.toLowerCase()}</ThemedText>
        </View>

        <FlatList
          data={tokens}
          keyExtractor={(item) => `fomo-${item.address}`}
          renderItem={({ item }) => <FomoRow token={item} showRank={feed === 'trending'} />}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.emptyCard}>
              <ThemedText type="small" style={{ color: theme.textSecondary, textAlign: 'center' }}>
                {fetchError && activeMap.size === 0
                  ? `Error: ${fetchError}`
                  : activeMap.size === 0 && (!hydrated || !resp)
                    ? 'Conectando con el feed de FOMO…'
                    : 'Ningún token coincide con estos filtros.'}
              </ThemedText>
            </View>
          }
        />

        <View style={styles.footer}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            Graduados y trending Solana · tiempo real (push ~1s · respaldo 10s) · fomo.family
          </ThemedText>
        </View>
      </SafeAreaView>

      {/* ── Filter editor ── */}
      <Modal visible={editorVisible} transparent animationType="slide" onRequestClose={closeFilterEditor}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.backdropTouch} onPress={closeFilterEditor} />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <ThemedText type="smallBold" style={styles.sheetTitle}>Filtros — {FEED_META[feed].label}</ThemedText>
              <Pressable onPress={resetDraft} hitSlop={8}>
                <ThemedText type="small" style={styles.resetText}>Restablecer</ThemedText>
              </Pressable>
            </View>
            <ScrollView
              style={styles.sheetBody}
              contentContainerStyle={styles.sheetBodyContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled">
              {FILTER_FIELDS.map((f) => (
                <View key={f.key} style={styles.fieldRow}>
                  <ThemedText type="small" style={[styles.fieldLabel, { color: theme.textSecondary }]}>
                    {f.label}
                  </ThemedText>
                  <View style={styles.inputGroup}>
                    <TextInput
                      value={draft[f.key]}
                      onChangeText={(v) => setDraftValue(f.key, v)}
                      placeholder={f.placeholder}
                      placeholderTextColor={theme.textSecondary}
                      keyboardType="numeric"
                      style={[styles.fieldInput, { color: theme.text }]}
                    />
                    <ThemedText style={[styles.inputUnit, { color: theme.textSecondary }]}>{f.unit}</ThemedText>
                  </View>
                </View>
              ))}
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Vacío = sin límite. Los KOLs se resuelven en el servidor (Pulse → GMGN).
              </ThemedText>
              {feed === 'trending' && (
                <ThemedText type="small" style={{ color: theme.textSecondary }}>
                  En Trending la edad se resuelve con Pulse (~10s en rellenar la lista).
                </ThemedText>
              )}

              <View style={styles.sectionDivider} />
              <ThemedText type="smallBold" style={{ color: theme.text }}>
                Notificaciones
              </ThemedText>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Aviso push cuando un token pase los filtros de esa pestaña. Se guardan por pestaña.
              </ThemedText>
              {FEEDS.map((fd) => (
                <View key={fd} style={styles.alertRow}>
                  <ThemedText type="small" style={{ color: theme.text, flex: 1 }}>
                    Avisos de {FEED_META[fd].label}
                  </ThemedText>
                  <Switch
                    value={alerts[fd]}
                    onValueChange={(v) => toggleAlert(fd, v)}
                    trackColor={{ true: theme.accent }}
                  />
                </View>
              ))}

              <View style={styles.sectionDivider} />
              <ThemedText type="smallBold" style={{ color: theme.text }}>
                Conexión del feed (servidor)
              </ThemedText>
              <View style={styles.fieldRow}>
                <ThemedText type="small" style={[styles.fieldLabel, { color: theme.textSecondary }]}>
                  Proxy para el WS de FOMO
                </ThemedText>
                <View style={styles.inputGroup}>
                  <TextInput
                    value={proxyDraft}
                    onChangeText={setProxyDraft}
                    placeholder="host:puerto o http://… (vacío = directo)"
                    placeholderTextColor={theme.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.fieldInput, { color: theme.text }]}
                  />
                </View>
              </View>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                {status?.proxy?.enabled
                  ? `Actual: ${status.proxy.url} · vía ${status.proxy.transport === 'proxy' ? 'proxy' : 'directo (fallback)'}`
                  : 'Sin proxy — conexión directa.'}
                {' '}Se guarda en el servidor y reconecta el feed.
              </ThemedText>
              {saveError != null && (
                <ThemedText type="small" style={{ color: '#ef4444' }}>
                  {saveError}
                </ThemedText>
              )}
            </ScrollView>
            <View style={styles.sheetFooter}>
              <Pressable onPress={closeFilterEditor} style={styles.cancelBtn}>
                <ThemedText type="smallBold" style={{ color: '#ffffff' }}>Cancelar</ThemedText>
              </Pressable>
              <Pressable onPress={confirmFilters} disabled={saving} style={[styles.confirmBtn, saving && styles.btnDisabled]}>
                <ThemedText type="smallBold" style={{ color: '#000000' }}>
                  {saving ? 'Guardando…' : 'Confirmar'}
                </ThemedText>
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  titleGroup: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  filterBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },

  /* ── Feed switcher (graduados | trending) ── */
  feedTabs: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 2,
  },
  feedTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: '#333',
    backgroundColor: '#111111',
  },
  feedTabActive: {
    backgroundColor: '#a855f7',
    borderColor: '#a855f7',
  },

  list: { padding: 10, gap: 8, paddingBottom: 40 },
  emptyCard: {
    backgroundColor: '#111111',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
  },
  footer: {
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1e1e1e',
  },

  card: {
    backgroundColor: '#111111',
    borderRadius: 12,
    padding: 10,
    gap: 8,
  },
  mainRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatarWrap: { borderWidth: 2, borderRadius: 6, overflow: 'hidden' },
  contentCol: { flex: 1, gap: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  leftGroup: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  rightGroup: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0 },
  symbolText: { fontSize: 17, fontWeight: '600' },
  rankText: { fontSize: 13, fontWeight: '700' },
  nameText: { fontSize: 13, maxWidth: 150 },
  ageText: { fontSize: 13 },
  valueLabel: { fontSize: 11 },
  valueText: { fontSize: 13 },

  statsBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    backgroundColor: '#1a1a1a',
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 1,
    alignSelf: 'flex-start',
  },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  statValue: { fontSize: 12, fontWeight: '500' },

  /* ── Card footer: full mint + FOMO/GMGN links ── */
  addrRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addrText: { flex: 1, fontSize: 11 },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
  },

  /* ── Sheets (filter editor) ── */
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000088',
    justifyContent: 'flex-end',
  },
  backdropTouch: { flex: 1 },
  sheet: {
    backgroundColor: '#121212',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    maxHeight: '88%',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#333333',
    marginTop: 10,
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  sheetTitle: { fontSize: 16, color: '#ffffff' },
  resetText: { color: '#9a9a9a', fontSize: 14 },
  sheetBody: { flexGrow: 0 },
  sheetBodyContent: { paddingBottom: 8, gap: 4 },
  sheetFooter: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 14,
    paddingBottom: 20,
  },
  cancelBtn: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#2c2c2e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmBtn: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.5 },

  /* ── Filter fields ── */
  fieldRow: { marginBottom: 14 },
  fieldLabel: { fontSize: 12, marginBottom: 6 },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#333333',
    marginVertical: 14,
  },
  inputGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1c1c1e',
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 40,
  },
  fieldInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  inputUnit: { fontSize: 12, marginLeft: 6 },

  /* ── Alert notification switches (per feed) ── */
  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 8,
  },
});
