import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { TokenAvatar } from '@/components/token-avatar';
import { PriceChange } from '@/components/price-change';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/store/settings';
import { useWs } from '@/store/ws';
import { getPortfolio } from '@/api/trading';
import { ApiError } from '@/api/client';
import type { PortfolioResponse } from '@/api/types';
import { fmtUsd } from '@/utils/format';

export default function DashboardScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { proxyStatuses, loadProxyStatuses } = useSettings();
  const { solPrice: wsSolPrice, subscribeSolPrice, unsubscribeSolPrice } = useWs();
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [solPrice, setSolPrice] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    subscribeSolPrice();
    return () => unsubscribeSolPrice();
  }, [subscribeSolPrice, unsubscribeSolPrice]);

  useEffect(() => {
    if (wsSolPrice != null) setSolPrice(wsSolPrice);
  }, [wsSolPrice]);

  const load = useCallback(async () => {
    try {
      const pf = await getPortfolio();
      setData(pf);
      setSolPrice(pf.sol_price ?? 0);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error cargando el dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadProxyStatuses();
    const pfTimer = setInterval(load, 2000);
    return () => {
      clearInterval(pfTimer);
    };
  }, [load, loadProxyStatuses]);

  if (loading && !data) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText type="subtitle">Cargando…</ThemedText>
      </ThemedView>
    );
  }

  if (error && !data) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText type="subtitle">Sin conexión</ThemedText>
        <ThemedText style={styles.centerText}>{error}</ThemedText>
        <Pressable onPress={load}>
          <ThemedText type="linkPrimary">Reintentar</ThemedText>
        </Pressable>
      </ThemedView>
    );
  }

  if (!data) return null;

  const { stats, positions, summary } = data;
  const floatingUsd = summary.balance_usd + summary.balance_sol * (solPrice || 0);
  const totalEquity = floatingUsd + summary.total_value;

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.textSecondary} />}>
          <ThemedText type="subtitle">Dashboard</ThemedText>

          {proxyStatuses.length > 0 && proxyStatuses.some((s) => !s.working) && (
            <Card style={{ borderColor: theme.warn, backgroundColor: `${theme.warn}15` }}>
              <ThemedText type="small" style={{ color: theme.warn }}>
                Algunos datos de mercado pueden estar desactualizados. Configura los proxies en Settings → Proxies GMGN.
              </ThemedText>
            </Card>
          )}

          <Card style={styles.balanceCard}>
            <View style={styles.balanceHeader}>
              <View>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>
                  Balance
                </ThemedText>
                <ThemedText type="subtitle" style={{ color: theme.text }}>
                  {fmtUsd(floatingUsd)}
                </ThemedText>
              </View>
              <View style={styles.equityBox}>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>
                  Equity total
                </ThemedText>
                <ThemedText type="default" style={{ fontWeight: '700' }}>
                  {fmtUsd(totalEquity)}
                </ThemedText>
              </View>
            </View>
            <View style={styles.summaryRow}>
              <SummaryItem label="Invertido" value={fmtUsd(summary.invested)} />
              <SummaryItem label="Valor posiciones" value={fmtUsd(summary.total_value)} />
              <SummaryItem
                label="P&L no realizado"
                value={fmtUsd(summary.unrealized_pnl)}
                color={summary.unrealized_pnl >= 0 ? theme.positive : theme.negative}
              />
              {solPrice > 0 ? <SummaryItem label="SOL" value={fmtUsd(solPrice, { decimals: 2 })} /> : null}
            </View>
          </Card>

          <View style={styles.sectionHeader}>
            <ThemedText type="smallBold">Posiciones ({positions.length})</ThemedText>
          </View>
          {positions.length === 0 ? (
            <Card>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Sin posiciones. Explora Trenches y compra tu primer token.
              </ThemedText>
            </Card>
          ) : (
            positions.map((p) => (
              <Pressable
                key={p.token_address}
                onPress={() => router.push(`/token/${p.chain}/${p.token_address}`)}
                style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
                <Card style={styles.posCard}>
                  <TokenAvatar logo={p.logo} symbol={p.symbol} size={36} />
                  <View style={styles.posIdentity}>
                    <ThemedText type="smallBold">{p.symbol || p.name}</ThemedText>
                    <ThemedText type="small" style={{ color: theme.textSecondary }}>
                      Entrada {fmtUsd(p.entry_market_cap, { compact: true })} · MC {fmtUsd(p.market_cap ?? 0, { compact: true })}
                    </ThemedText>
                  </View>
                  <View style={styles.posValue}>
                    <ThemedText type="smallBold">{fmtUsd(p.value)}</ThemedText>
                    <PriceChange value={p.pnl_percent} />
                  </View>
                </Card>
              </Pressable>
            ))
          )}

          <View style={styles.sectionHeader}>
            <ThemedText type="smallBold">Estadísticas</ThemedText>
          </View>
          <Card>
            <View style={styles.summaryRow}>
              <SummaryItem label="Trades" value={String(stats.total_trades)} />
              <SummaryItem label="Win rate" value={`${stats.win_rate.toFixed(0)}%`} />
              <SummaryItem
                label="P&L realizado"
                value={fmtUsd(stats.realized_pnl)}
                color={stats.realized_pnl >= 0 ? theme.positive : theme.negative}
              />
              <SummaryItem label="Gas total" value={fmtUsd(stats.gas_spent)} />
            </View>
          </Card>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

function SummaryItem({ label, value, color }: { label: string; value: string; color?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.summaryItem}>
      <ThemedText type="small" style={{ color: theme.textSecondary, fontSize: 11, lineHeight: 14 }}>
        {label}
      </ThemedText>
      <ThemedText type="smallBold" style={{ color: color ?? theme.text }}>
        {value}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  scroll: { padding: 16, gap: 12, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  centerText: { textAlign: 'center' },
  balanceCard: { gap: 14 },
  balanceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  equityBox: { alignItems: 'flex-end', gap: 2 },
  summaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  summaryItem: { minWidth: 90, gap: 2 },
  sectionHeader: {
    marginTop: 8,
  },
  posCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  posIdentity: { flex: 1, gap: 2 },
  posValue: { alignItems: 'flex-end', gap: 2 },
});