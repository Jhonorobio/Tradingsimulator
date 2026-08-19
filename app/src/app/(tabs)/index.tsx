import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { TokenAvatar } from '@/components/token-avatar';
import { PriceChange } from '@/components/price-change';
import { useTheme } from '@/hooks/use-theme';
import { convertWallet, getPortfolio } from '@/api/trading';
import { getSolPrice } from '@/api/market';
import { ApiError } from '@/api/client';
import type { PortfolioResponse } from '@/api/types';
import { fmtNum, fmtUsd } from '@/utils/format';

export default function DashboardScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [solPrice, setSolPrice] = useState<number>(0);
  const [convAmount, setConvAmount] = useState('');
  const [converting, setConverting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // Precio de SOL en vivo (vía GMGN proxy, batch global en el server): cada 3s.
  const loadSolPrice = useCallback(async () => {
    try {
      const r = await getSolPrice();
      if (r.sol_price != null) setSolPrice(r.sol_price);
    } catch {
      // mantén el último precio conocido
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(loadSolPrice, 3000);
    return () => clearInterval(timer);
  }, [load, loadSolPrice]);

  const doConvert = async (direction: 'usd_to_sol' | 'sol_to_usd') => {
    const amt = Number(convAmount);
    if (!amt || amt <= 0) return Alert.alert('Error', 'Introduce un monto válido');
    setConverting(true);
    try {
      await convertWallet(direction, amt);
      setConvAmount('');
      await load();
      Alert.alert('Listo', direction === 'usd_to_sol' ? 'USD convertidos a SOL' : 'SOL convertidos a USD');
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'No se pudo convertir');
    } finally {
      setConverting(false);
    }
  };

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
  const solValueUsd = summary.balance_sol * (solPrice || 0);
  const totalEquity = summary.balance_usd + solValueUsd + summary.total_value;

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
                  Balance USD
                </ThemedText>
                <ThemedText type="subtitle" style={{ color: theme.text }}>
                  {fmtUsd(summary.balance_usd)}
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
            <View style={styles.solBox}>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Balance SOL
              </ThemedText>
              <ThemedText type="smallBold" style={{ color: theme.text }}>
                {fmtNum(summary.balance_sol)} SOL ≈ {fmtUsd(solValueUsd)}
              </ThemedText>
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

          <Card style={styles.convCard}>
            <ThemedText type="smallBold">Convertir USD ↔ SOL</ThemedText>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              1 SOL = {fmtUsd(solPrice, { decimals: 2 })}
            </ThemedText>
            <TextInput
              value={convAmount}
              onChangeText={setConvAmount}
              placeholder="Monto"
              placeholderTextColor={theme.textSecondary}
              keyboardType="decimal-pad"
              style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]}
            />
            <View style={styles.convRow}>
              <Pressable
                onPress={() => doConvert('usd_to_sol')}
                disabled={converting}
                style={({ pressed }) => [styles.convBtn, { backgroundColor: theme.accent }, pressed && { opacity: 0.8 }]}>
                <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>
                  USD → SOL
                </ThemedText>
              </Pressable>
              <Pressable
                onPress={() => doConvert('sol_to_usd')}
                disabled={converting}
                style={({ pressed }) => [styles.convBtn, { backgroundColor: theme.accent }, pressed && { opacity: 0.8 }]}>
                <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>
                  SOL → USD
                </ThemedText>
              </Pressable>
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
  solBox: { gap: 2 },
  summaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  summaryItem: { minWidth: 90, gap: 2 },
  convCard: { gap: 8 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    fontSize: 14,
  },
  convRow: { flexDirection: 'row', gap: 10 },
  convBtn: { flex: 1, paddingVertical: 12, borderRadius: 10 },
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