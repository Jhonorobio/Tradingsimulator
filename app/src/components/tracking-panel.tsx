import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

import { ThemedText } from '@/components/themed-text';
import { Card } from '@/components/card';
import { TokenAvatar } from '@/components/token-avatar';
import { useTheme } from '@/hooks/use-theme';
import { getXTrackerTokens, type XTrackerToken, type XTrackerTokensResponse } from '@/api/market';
import { useWs, type TrackerSummary } from '@/store/ws';
import { fmtUsd, shortAddress } from '@/utils/format';

// Fallback poll — the WS push is the primary path, this is just the safety net.
const REFRESH_MS = 1_000;

const STOP_LABELS: Record<string, string> = {
  mcap_below_8k: 'MCap < 8K',
  mcap_below_10k: 'MCap < 10K',
  no_pairs: 'Sin datos',
  max_age: '1h cumplida',
};

// ─── Dashboard visibility filter ─────────────────────────────────────────────
// When on, the list only shows tokens whose 24h volume ≈ market cap (same
// 0.9–2.3x range as the push alert) AND mcap > $20k. Persisted on device.
const VOL_MCAP_ONLY_KEY = 'dashboard:vol_mcap_only';
const VIS_RATIO_MIN = 0.9;
const VIS_RATIO_MAX = 2.3;
const VIS_MIN_MCAP = 20_000;

/** Whether a token meets the vol≈mcap + mcap>20k visibility rule. */
function matchesVolMcap(t: XTrackerToken): boolean {
  const mc = t.mcap;
  const vol = t.volume24h;
  if (mc == null || vol == null || !(mc > 0) || mc <= VIS_MIN_MCAP) return false;
  const ratio = vol / mc;
  return ratio >= VIS_RATIO_MIN && ratio <= VIS_RATIO_MAX;
}

function fmtAge(seconds?: number | null): string {
  if (seconds == null || seconds < 0) return '';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h${rm}m` : `${h}h`;
}

function fmtTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Whether a live WS update should replace the copy we already render. */
function isFresher(u: XTrackerToken, cur: XTrackerToken): boolean {
  if (u.status !== cur.status) return true;
  if (!u.last_dex_check || !cur.last_dex_check) return true;
  return u.last_dex_check >= cur.last_dex_check;
}

const TrackingCard = React.memo(function TrackingCard({ item, theme }: {
  item: XTrackerToken; theme: any;
}) {
  const active = item.status === 'active';
  const statusColor = active ? theme.positive : theme.negative;
  const statusLabel = active ? 'Rastreando' : (STOP_LABELS[item.stop_reason || ''] || 'Detenido');

  const stat = (icon: string, value: string, color: string) => (
    <View style={styles.statItem}>
      <Ionicons name={icon as any} size={12} color={color} />
      <ThemedText type="small" style={{ color }}>{value}</ThemedText>
    </View>
  );

  return (
    <Pressable>
      <Card style={[styles.card, { borderColor: theme.border, opacity: active ? 1 : 0.65 }]}>
        <View style={styles.cardHeader}>
          <TokenAvatar logo={item.logo} symbol={item.symbol} size={32} />
          <View style={styles.cardInfo}>
            <ThemedText type="smallBold" style={{ color: theme.text }} numberOfLines={1}>
              {item.symbol || item.name || shortAddress(item.address)}
            </ThemedText>
            <View style={styles.statusRow}>
              <View style={[styles.dot, { backgroundColor: statusColor }]} />
              <ThemedText type="small" style={{ color: statusColor }}>{statusLabel}</ThemedText>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                · {item.chain.toUpperCase()}
                {item.age_seconds != null ? ` · ${fmtAge(item.age_seconds)}` : ''}
              </ThemedText>
            </View>
          </View>
          <View style={styles.cardRight}>
            {item.mcap != null && (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                {fmtUsd(item.mcap, { compact: true })}
              </ThemedText>
            )}
            {item.volume24h != null && (
              <View style={styles.volRow}>
                <Ionicons name="stats-chart" size={10} color={theme.textSecondary} />
                <ThemedText type="small" style={{ color: theme.textSecondary }}>
                  {fmtUsd(item.volume24h, { compact: true })}
                </ThemedText>
              </View>
            )}
          </View>
        </View>

        {!active && item.stopped_at ? (
          <View style={styles.statsRow}>
            {stat('pause', fmtTime(item.stopped_at), theme.negative)}
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
});

export function TrackingPanel() {
  const theme = useTheme();
  const [tokens, setTokens] = useState<XTrackerToken[]>([]);
  const [summary, setSummary] = useState<XTrackerTokensResponse['summary'] | null>(null);
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [volMcapOnly, setVolMcapOnly] = useState(false);

  const trackerLive = useWs((s) => s.tracker);
  const liveSummary = useWs((s) => s.trackerSummary);
  const subscribeTracker = useWs((s) => s.subscribeTracker);
  const unsubscribeTracker = useWs((s) => s.unsubscribeTracker);

  const load = useCallback(async () => {
    try {
      const res = await getXTrackerTokens({ status: 'active', limit: 1000 });
      setTokens(res.tokens);
      setSummary(res.summary);
    } catch {}
  }, []);

  useEffect(() => {
    // Defer the first fetch so setState never runs synchronously in the effect.
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  useEffect(() => {
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Live push: the 10s fetch stays as the fallback, the WS topic paints instantly.
  useEffect(() => {
    subscribeTracker();
    return () => unsubscribeTracker();
  }, [subscribeTracker, unsubscribeTracker]);

  useEffect(() => {
    const updates = Object.values(trackerLive);
    if (updates.length === 0) return;
    // Defer like `load` does: setState must not run synchronously in the effect.
    const t = setTimeout(() => {
      setTokens((prev) => {
        const byAddr = new Map(prev.map((tok) => [tok.address, tok]));
        let changed = false;
        for (const u of updates) {
          const cur = byAddr.get(u.address);
          if (!cur) { byAddr.set(u.address, u); changed = true; continue; }
          if (!isFresher(u, cur)) continue;
          if (JSON.stringify(cur) !== JSON.stringify(u)) {
            byAddr.set(u.address, { ...cur, ...u });
            changed = true;
          }
        }
        return changed ? Array.from(byAddr.values()) : prev;
      });
    }, 0);
    return () => clearTimeout(t);
  }, [trackerLive]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Restore the visibility filter (default: off) and persist every toggle.
  useEffect(() => {
    AsyncStorage.getItem(VOL_MCAP_ONLY_KEY)
      .then((v) => { if (v === '1') setVolMcapOnly(true); })
      .catch(() => {});
  }, []);

  const toggleVolMcap = useCallback(() => {
    setVolMcapOnly((prev) => {
      const next = !prev;
      AsyncStorage.setItem(VOL_MCAP_ONLY_KEY, next ? '1' : '0').catch(() => {});
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tokens.filter((t) => {
      // Only live tokens: a WS push can carry a just-stopped one before the poll.
      if (t.status !== 'active') return false;
      // Optional view: only vol≈mcap tokens above 20k mcap.
      if (volMcapOnly && !matchesVolMcap(t)) return false;
      if (!q) return true;
      return (t.symbol || '').toLowerCase().includes(q)
        || (t.name || '').toLowerCase().includes(q)
        || t.address.toLowerCase().includes(q);
    });
  }, [tokens, search, volMcapOnly]);

  const renderItem = useCallback(({ item }: { item: XTrackerToken }) => (
    <TrackingCard
      item={item}
      theme={theme}
    />
  ), [theme]);

  const shownSummary: TrackerSummary | null = liveSummary ?? summary;

  return (
    <View style={styles.panel}>
      <View style={[styles.summary, { backgroundColor: theme.backgroundSelected, borderColor: theme.border }]}>
        <View style={styles.summaryItem}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>Activos</ThemedText>
          <ThemedText type="smallBold" style={{ color: theme.positive }}>{shownSummary?.active ?? 0}</ThemedText>
        </View>
        <View style={styles.summaryItem}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>Photon</ThemedText>
          <ThemedText type="smallBold" style={{ color: theme.accent }}>{shownSummary?.photon ?? 0}</ThemedText>
        </View>
        <View style={styles.summaryItem}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>Trenches</ThemedText>
          <ThemedText type="smallBold" style={{ color: theme.accent }}>{shownSummary?.trenches ?? 0}</ThemedText>
        </View>
      </View>

      <View style={styles.filterRow}>
        <Pressable
          onPress={toggleVolMcap}
          accessibilityRole="button"
          accessibilityState={{ selected: volMcapOnly }}
          style={[styles.filterChip, {
            borderColor: volMcapOnly ? theme.accent : theme.border,
            backgroundColor: volMcapOnly ? theme.backgroundSelected : 'transparent',
          }]}
        >
          <Ionicons name="stats-chart" size={12} color={volMcapOnly ? theme.accent : theme.textSecondary} />
          <ThemedText type="small" style={{ color: volMcapOnly ? theme.accent : theme.textSecondary }}>
            Vol ≈ MCap · &gt;20K
          </ThemedText>
        </Pressable>
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Buscar por símbolo o mint..."
          placeholderTextColor={theme.textSecondary}
          style={[styles.searchInput, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item, i) => `track-${item.address}-${i}`}
        renderItem={renderItem}
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        windowSize={7}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
        ListEmptyComponent={
          <ThemedText style={styles.empty}>
            {search
              ? 'Sin resultados'
              : volMcapOnly
                ? 'Sin tokens con Vol ≈ MCap y mcap >20K'
                : 'Ningún token en rastreo todavía'}
          </ThemedText>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1 },
  summary: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 10, borderWidth: 1, gap: 24 },
  summaryItem: { alignItems: 'center' },
  filterRow: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8 },
  filterChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  searchWrap: { marginHorizontal: 16, marginBottom: 8 },
  searchInput: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 14 },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  card: { marginBottom: 8, padding: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  cardInfo: { flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  cardRight: { alignItems: 'flex-end', gap: 2 },
  volRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  empty: { textAlign: 'center', marginTop: 40, opacity: 0.5 },
});
