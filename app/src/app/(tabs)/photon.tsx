import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TokenAvatar } from '@/components/token-avatar';
import { useTheme } from '@/hooks/use-theme';
import { getMemescope } from '@/api/market';
import type { MemescopeColKey, MemescopeResponse, PhotonToken } from '@/api/market';
import { fmtNum, fmtUsd, timeAgo } from '@/utils/format';

const COLS: MemescopeColKey[] = ['col1', 'col2', 'col3'];
const FALLBACK_TITLES: Record<MemescopeColKey, string> = {
  col1: 'New',
  col2: 'Graduating',
  col3: 'Graduated',
};
const POLL_MS = 1000;

interface StatItem {
  icon: keyof typeof Ionicons.glyphMap;
  value: string | null;
  color: string;
}

function PhotonRow({ token }: { token: PhotonToken }) {
  const router = useRouter();
  const theme = useTheme();

  const address = token.address || token.tokenAddress || '';
  const fdv = token.fdv ?? null;
  const volume = token.volume ?? null;
  const holders = token.holders_count ?? null;
  const liqUsd = token.cur_liq?.usd ?? null;
  const topHolders = token.audit?.top_holders_perc ?? null;
  const lpBurned = token.audit?.lp_burned_perc ?? null;
  const devPct = token.dev_holding_perc ?? null;
  const snipers = token.snipers_count ?? null;

  const stats: StatItem[] = [
    { icon: 'people', value: holders != null ? `${fmtNum(holders)}` : null, color: theme.textSecondary },
    { icon: 'stats-chart', value: liqUsd != null ? fmtUsd(liqUsd, { compact: true }) : null, color: theme.textSecondary },
    { icon: 'bar-chart', value: topHolders != null ? `${topHolders.toFixed(0)}%` : null, color: '#f59e0b' },
    { icon: 'flame', value: lpBurned != null ? `LP ${lpBurned.toFixed(0)}%` : null, color: lpBurned === 100 ? '#22c55e' : theme.textSecondary },
    { icon: 'locate', value: snipers != null && snipers > 0 ? `Snp ${snipers}` : null, color: '#ef4444' },
    { icon: 'code-slash', value: devPct != null && devPct > 0 ? `Dev ${devPct.toFixed(1)}%` : null, color: devPct && devPct > 5 ? '#ef4444' : theme.textSecondary },
    { icon: 'trophy', value: token.ath ? `ATH ${fmtUsd(token.ath, { compact: true })}` : null, color: '#a855f7' },
  ];
  const visible = stats.filter((s) => s.value != null);

  return (
    <Pressable
      onPress={() => address && router.push(`/token/solana/${address}`)}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.75 }]}>
      <View style={styles.mainRow}>
        <View style={[styles.avatarWrap, { borderColor: '#a855f7' }]}>
          <TokenAvatar logo={token.imgUrl} symbol={token.symbol} size={50} borderRadius={4} />
        </View>

        <View style={styles.contentCol}>
          <View style={styles.row}>
            <View style={styles.leftGroup}>
              <ThemedText type="smallBold" numberOfLines={1} style={[styles.symbolText, { color: theme.text }]}>
                {token.symbol || '???'}
              </ThemedText>
              <ThemedText numberOfLines={1} style={[styles.nameText, { color: theme.textSecondary }]}>
                {token.name || 'Token'}
              </ThemedText>
            </View>
            <View style={styles.rightGroup}>
              <ThemedText style={[styles.valueLabel, { color: theme.textSecondary }]}>FDV</ThemedText>
              <ThemedText type="small" style={[styles.valueText, { fontWeight: '500', color: theme.text }]}>
                {fmtUsd(fdv, { compact: true })}
              </ThemedText>
            </View>
          </View>

          <View style={styles.row}>
            <View style={styles.leftGroup}>
              <ThemedText style={[styles.ageText, { color: theme.textSecondary }]}>
                {timeAgo(token.created_timestamp ?? undefined)}
                {token.fromPump ? ' · pump' : ''}
              </ThemedText>
            </View>
            <View style={styles.rightGroup}>
              <ThemedText style={[styles.valueLabel, { color: theme.textSecondary }]}>V</ThemedText>
              <ThemedText type="small" style={[styles.valueText, { fontWeight: '500', color: theme.text }]}>
                {fmtUsd(volume, { compact: true })}
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
    </Pressable>
  );
}

export default function PhotonScreen() {
  const theme = useTheme();
  const [resp, setResp] = useState<MemescopeResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [activeCol, setActiveCol] = useState<MemescopeColKey>('col1');

  const load = useCallback(() => {
    getMemescope()
      .then((r) => {
        setResp(r);
        setFetchError(r.error ?? null);
      })
      .catch((e: unknown) => setFetchError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const tokens = useMemo(
    () => resp?.columns?.[activeCol]?.data?.map((d) => d.attributes) ?? [],
    [resp, activeCol],
  );
  const titles = resp?.titles ?? FALLBACK_TITLES;
  const ageMs = resp?.ageMs ?? null;
  const live = fetchError == null && ageMs != null && ageMs < 3000;

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.topBar}>
          <View style={styles.titleGroup}>
            <ThemedText type="title" style={{ color: theme.text }}>Photon</ThemedText>
            <View style={[styles.liveDot, { backgroundColor: live ? '#22c55e' : '#ef4444' }]} />
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {fetchError
                ? fetchError
                : ageMs != null
                  ? `live · ${(ageMs / 1000).toFixed(1)}s`
                  : 'cargando…'}
            </ThemedText>
          </View>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            {tokens.length} tokens
          </ThemedText>
        </View>

        <View style={styles.tabsRow}>
          {COLS.map((col) => {
            const active = activeCol === col;
            const count = resp?.columns?.[col]?.data?.length ?? 0;
            return (
              <Pressable key={col} onPress={() => setActiveCol(col)} style={styles.tab}>
                <ThemedText
                  type="smallBold"
                  style={{ color: active ? theme.text : theme.textSecondary }}>
                  {titles[col] ?? FALLBACK_TITLES[col]} ({count})
                </ThemedText>
                {active && <View style={[styles.tabUnderline, { backgroundColor: theme.text }]} />}
              </Pressable>
            );
          })}
        </View>

        <FlatList
          data={tokens}
          keyExtractor={(item, i) => `ph-${item.address || item.tokenAddress || i}-${i}`}
          renderItem={({ item }) => <PhotonRow token={item} />}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.emptyCard}>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                {fetchError ? `Error: ${fetchError}` : 'Cargando feed de Photon…'}
              </ThemedText>
            </View>
          }
        />

        <View style={styles.footer}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            Memescope · servidor 750ms · app 1s
          </ThemedText>
        </View>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0d0d' },
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
  titleGroup: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },

  tabsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  tab: { alignItems: 'center', paddingVertical: 10, paddingHorizontal: 8, position: 'relative' },
  tabUnderline: {
    position: 'absolute',
    bottom: 0,
    left: '15%',
    width: '70%',
    height: 2,
    borderRadius: 1,
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
});
