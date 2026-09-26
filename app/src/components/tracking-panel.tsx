import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { ThemedText } from '@/components/themed-text';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { getXTrackerTokens, type XTrackerToken, type XTrackerTokensResponse } from '@/api/market';
import { fmtUsd, shortAddress } from '@/utils/format';

const REFRESH_MS = 10_000;

const STATUS_TABS = [
  { key: 'active', label: 'Rastreando' },
  { key: 'stopped', label: 'Detenidos' },
  { key: 'all', label: 'Todos' },
] as const;
type StatusKey = (typeof STATUS_TABS)[number]['key'];

const STOP_LABELS: Record<string, string> = {
  mcap_below_10k: 'MCap < 10K',
  no_pairs: 'Sin par',
  max_age: '1h cumplida',
};

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

const TrackingCard = React.memo(function TrackingCard({ item, theme, onPress }: {
  item: XTrackerToken; theme: any; onPress: () => void;
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
    <Pressable onPress={onPress}>
      <Card style={[styles.card, { borderColor: theme.border, opacity: active ? 1 : 0.65 }]}>
        <View style={styles.cardHeader}>
          <View style={[styles.logo, { backgroundColor: theme.backgroundSelected }]}>
            {item.logo ? (
              <Image source={{ uri: item.logo }} style={styles.logoImg} />
            ) : (
              <ThemedText type="small">{item.symbol?.charAt(0) || '?'}</ThemedText>
            )}
          </View>
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
            {item.checks > 0 && (
              <ThemedText type="small" style={{ color: theme.textSecondary, fontSize: 11 }}>
                {item.checks} chequeos
              </ThemedText>
            )}
          </View>
        </View>

        <View style={styles.statsRow}>
          {item.twitter ? stat('logo-twitter', `@${item.twitter}`, theme.accent) : null}
          {item.tweets > 0 ? stat('chatbubble-ellipses', `${item.tweets} tweets`, theme.accent) : null}
          {item.notified_tweets > 0 ? stat('notifications', `${item.notified_tweets} avisos`, theme.positive) : null}
          {item.liquidity != null && item.liquidity > 0
            ? stat('water', `Liq ${fmtUsd(item.liquidity, { compact: true })}`, theme.textSecondary)
            : null}
          {!active && item.stopped_at ? stat('pause', fmtTime(item.stopped_at), theme.negative) : null}
        </View>

        <View style={styles.cardFooter}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            {shortAddress(item.address)}
          </ThemedText>
          <ThemedText type="small" style={{ color: theme.textSecondary, fontSize: 11 }}>
            {active && item.last_x_check ? `X ${fmtTime(item.last_x_check)}` : ''}
            {active && item.last_x_check && item.last_dex_check ? ' · ' : ''}
            {active && item.last_dex_check ? `DEX ${fmtTime(item.last_dex_check)}` : ''}
          </ThemedText>
        </View>
      </Card>
    </Pressable>
  );
});

export function TrackingPanel() {
  const theme = useTheme();
  const router = useRouter();
  const [tokens, setTokens] = useState<XTrackerToken[]>([]);
  const [summary, setSummary] = useState<XTrackerTokensResponse['summary'] | null>(null);
  const [status, setStatus] = useState<StatusKey>('active');
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await getXTrackerTokens({ status: 'all', limit: 1000 });
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

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tokens.filter((t) => {
      if (status !== 'all' && t.status !== status) return false;
      if (!q) return true;
      return (t.symbol || '').toLowerCase().includes(q)
        || (t.name || '').toLowerCase().includes(q)
        || t.address.toLowerCase().includes(q)
        || (t.twitter || '').toLowerCase().includes(q);
    });
  }, [tokens, status, search]);

  const renderItem = useCallback(({ item }: { item: XTrackerToken }) => (
    <TrackingCard
      item={item}
      theme={theme}
      onPress={() => router.push(`/token/${item.chain}/${item.address}`)}
    />
  ), [theme, router]);

  return (
    <View style={styles.panel}>
      <View style={styles.statusTabs}>
        {STATUS_TABS.map((tab) => {
          const count = tab.key === 'active' ? summary?.active
            : tab.key === 'stopped' ? summary?.stopped
            : summary ? summary.active + summary.stopped : null;
          const on = status === tab.key;
          return (
            <Pressable
              key={tab.key}
              onPress={() => setStatus(tab.key)}
              style={[styles.statusTab, on && { backgroundColor: theme.accent }]}
            >
              <ThemedText type="small" style={{ color: on ? '#000' : theme.textSecondary }}>
                {tab.label}{count != null ? ` ${count}` : ''}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.summary, { backgroundColor: theme.backgroundSelected, borderColor: theme.border }]}>
        <View style={styles.summaryItem}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>Con X</ThemedText>
          <ThemedText type="smallBold" style={{ color: theme.accent }}>{summary?.with_twitter ?? 0}</ThemedText>
        </View>
        <View style={styles.summaryItem}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>Con tweets</ThemedText>
          <ThemedText type="smallBold" style={{ color: theme.accent }}>{summary?.with_tweets ?? 0}</ThemedText>
        </View>
        <View style={styles.summaryItem}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>Avisos</ThemedText>
          <ThemedText type="smallBold" style={{ color: theme.positive }}>{summary?.notified ?? 0}</ThemedText>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Buscar por símbolo, X o mint..."
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
            {search ? 'Sin resultados' : 'Ningún token en rastreo todavía'}
          </ThemedText>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1 },
  statusTabs: { flexDirection: 'row', marginBottom: 8, gap: 6, marginHorizontal: 16 },
  statusTab: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, backgroundColor: '#1a1a1a' },
  summary: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 10, borderWidth: 1, gap: 24 },
  summaryItem: { alignItems: 'center' },
  searchWrap: { marginHorizontal: 16, marginBottom: 8 },
  searchInput: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 14 },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  card: { marginBottom: 8, padding: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  logo: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginRight: 10, overflow: 'hidden' },
  logoImg: { width: 32, height: 32, borderRadius: 16 },
  cardInfo: { flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  cardRight: { alignItems: 'flex-end', gap: 2 },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  empty: { textAlign: 'center', marginTop: 40, opacity: 0.5 },
});
