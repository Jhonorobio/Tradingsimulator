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
import { getPortfolio, getOrders } from '@/api/trading';
import { ApiError } from '@/api/client';
import type { Order, PortfolioResponse } from '@/api/types';
import { fmtNum, fmtUsd, fmtTime } from '@/utils/format';

export default function DashboardScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [pf, ord] = await Promise.all([getPortfolio(), getOrders(30)]);
      setData(pf);
      setOrders(ord.orders);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error cargando el dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  const { wallet, stats, positions, summary } = data;

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.textSecondary} />}>
          <ThemedText type="subtitle">Dashboard</ThemedText>

          <Card style={styles.balanceCard}>
            <View style={styles.balanceHeader}>
              <View>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>
                  Balance simulado
                </ThemedText>
                <ThemedText type="subtitle" style={{ color: theme.text }}>
                  {fmtUsd(wallet.balance_usdc)}
                </ThemedText>
              </View>
              <View style={styles.equityBox}>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>
                  Equity total
                </ThemedText>
                <ThemedText type="default" style={{ fontWeight: '700' }}>
                  {fmtUsd(summary.total_equity)}
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
                      {fmtNum(p.quantity)} · avg {fmtUsd(p.avg_price_usdc, { decimals: 6 })}
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

          <View style={styles.sectionHeader}>
            <ThemedText type="smallBold">Historial</ThemedText>
          </View>
          {orders.length === 0 ? (
            <Card>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Aún no hay operaciones.
              </ThemedText>
            </Card>
          ) : (
            orders.map((o) => (
              <Card key={o.id} style={styles.orderCard}>
                <View style={styles.orderSide}>
                  <ThemedText
                    type="smallBold"
                    style={{ color: o.side === 'buy' ? theme.positive : theme.negative }}>
                    {o.side === 'buy' ? 'BUY' : 'SELL'}
                  </ThemedText>
                  <ThemedText type="small" style={{ color: theme.textSecondary }}>
                    {fmtTime(o.created_at)}
                  </ThemedText>
                </View>
                <View style={styles.posIdentity}>
                  <ThemedText type="smallBold">{o.symbol || o.name}</ThemedText>
                  <ThemedText type="small" style={{ color: theme.textSecondary }}>
                    {fmtNum(o.quantity)} @ {fmtUsd(o.price_usdc, { decimals: 6 })}
                  </ThemedText>
                </View>
                <View style={styles.posValue}>
                  <ThemedText type="smallBold">{fmtUsd(o.total_usdc)}</ThemedText>
                  <ThemedText type="small" style={{ color: theme.textSecondary }}>
                    gas {fmtUsd(o.gas_usdc)}
                  </ThemedText>
                </View>
              </Card>
            ))
          )}
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
  orderCard: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  orderSide: { gap: 2 },
});