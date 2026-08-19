import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { TokenAvatar } from '@/components/token-avatar';
import { PriceChange } from '@/components/price-change';
import { useTheme } from '@/hooks/use-theme';
import { getTokenDetail } from '@/api/market';
import { buy, getPortfolio, sell } from '@/api/trading';
import { ApiError } from '@/api/client';
import type { Position, TokenDetail, TradeResult } from '@/api/types';
import { fmtNum, fmtUsd, shortAddress } from '@/utils/format';

type Tab = 'buy' | 'sell';

export default function TokenScreen() {
  const { chain, address } = useLocalSearchParams<{ chain: string; address: string }>();
  const theme = useTheme();

  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('buy');
  const [amount, setAmount] = useState('');
  const [pct, setPct] = useState(100);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<TradeResult | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const [d, pf] = await Promise.all([getTokenDetail(chain || 'sol', address), getPortfolio()]);
      setDetail(d);
      const pos = pf.positions.find((p) => p.token_address === address);
      setPosition(pos ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al cargar el token');
    } finally {
      setLoading(false);
    }
  }, [address, chain]);

  useEffect(() => {
    load();
  }, [load]);

  const doBuy = async () => {
    if (!address) return;
    const usdc = Number(amount);
    if (!usdc || usdc <= 0) return Alert.alert('Error', 'Introduce un monto en USDC');
    setSubmitting(true);
    try {
      const res = await buy(address, usdc, chain || 'sol');
      setResult(res);
      setAmount('');
      await load();
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'No se pudo comprar');
    } finally {
      setSubmitting(false);
    }
  };

  const doSell = async () => {
    if (!address || !position) return;
    const qty = position.quantity * (pct / 100);
    setSubmitting(true);
    try {
      const res = await sell(address, chain || 'sol', qty);
      setResult(res);
      await load();
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'No se pudo vender');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !detail) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText type="subtitle">Cargando…</ThemedText>
      </ThemedView>
    );
  }

  if (error && !detail) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText type="subtitle">Sin datos</ThemedText>
        <ThemedText style={styles.centerText}>{error}</ThemedText>
        <Pressable onPress={load}>
          <ThemedText type="linkPrimary">Reintentar</ThemedText>
        </Pressable>
      </ThemedView>
    );
  }

  if (!detail) return null;
  const symbol = detail.symbol ?? 'TOKEN';

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={undefined}>
        <View style={styles.header}>
          <TokenAvatar logo={detail.logo} symbol={symbol} size={56} />
          <View style={{ flex: 1 }}>
            <ThemedText type="subtitle">{symbol}</ThemedText>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {detail.name ?? ''} · {shortAddress(detail.address)}
            </ThemedText>
          </View>
        </View>

        <Card style={styles.priceCard}>
          <View style={styles.priceRow}>
            <View>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Precio (Jupiter)
              </ThemedText>
              <ThemedText type="subtitle" style={{ color: theme.text }}>
                {fmtUsd(detail.price, { decimals: 8 })}
              </ThemedText>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Change 24h
              </ThemedText>
              <PriceChange value={detail.priceChange?.h24} />
            </View>
          </View>
          <View style={styles.metrics}>
            <Metric label="Market Cap" value={fmtUsd(detail.marketCap, { compact: true })} />
            <Metric label="Liquidez" value={fmtUsd(detail.liquidity, { compact: true })} />
            <Metric label="Vol 24h" value={fmtUsd(detail.volume24h, { compact: true })} />
            <Metric label="Supply" value={fmtNum(detail.supply)} />
            <Metric label="Cambios" value={`5m ${(detail.priceChange?.m5 ?? 0).toFixed(1)}% · 1h ${(detail.priceChange?.h1 ?? 0).toFixed(1)}%`} wide />
            {detail.dex ? <Metric label="DEX" value={detail.dex} /> : null}
          </View>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            Market cap calculado con Jupiter: price × circulating supply. Info del token vía Dexscreener.
          </ThemedText>
        </Card>

        {position && (
          <Card style={styles.posCard}>
            <View style={styles.priceRow}>
              <View>
                <ThemedText type="smallBold">Tu posición</ThemedText>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>
                  {fmtNum(position.quantity)} tokens
                </ThemedText>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <ThemedText type="smallBold">{fmtUsd(position.value)}</ThemedText>
                <PriceChange value={position.pnl_percent} />
              </View>
            </View>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Costo: {fmtUsd(position.cost_usdc)} · Promedio: {fmtUsd(position.avg_price_usdc, { decimals: 8 })} · P&L: {fmtUsd(position.pnl)} ({position.pnl_percent.toFixed(2)}%)
            </ThemedText>
          </Card>
        )}

        {result && (
          <Card style={{ borderColor: result.side === 'buy' ? theme.positive : theme.negative }}>
            <ThemedText type="smallBold" style={{ color: result.side === 'buy' ? theme.positive : theme.negative }}>
              {result.side === 'buy' ? 'Compra ejecutada' : 'Venta ejecutada'}
            </ThemedText>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {fmtNum(result.quantity)} tokens @ {fmtUsd(result.price, { decimals: 8 })} = {fmtUsd(result.total_usdc)} · gas {fmtUsd(result.gas_usdc)}
              {result.pnl_usdc != null ? ` · P&L ${fmtUsd(result.pnl_usdc)}` : ''}
            </ThemedText>
            <ThemedText type="smallBold">Nuevo balance: {fmtUsd(result.balance_usdc)}</ThemedText>
          </Card>
        )}

        <View style={styles.tabs}>
          <TabButton label="Comprar" active={tab === 'buy'} onPress={() => setTab('buy')} />
          <TabButton label="Vender" active={tab === 'sell'} onPress={() => setTab('sell')} disabled={!position} />
        </View>

        {tab === 'buy' ? (
          <Card>
            <ThemedText type="smallBold">Comprar {symbol} con USDC</ThemedText>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              placeholder="Monto en USDC (ej. 100)"
              placeholderTextColor={theme.textSecondary}
              keyboardType="decimal-pad"
              style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]}
            />
            {detail.price && Number(amount) > 0 ? (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                ≈ {fmtNum(Number(amount) / detail.price)} {symbol} · gas estimado {fmtUsd(0.25)}
              </ThemedText>
            ) : null}
            <Pressable onPress={doBuy} disabled={submitting} style={({ pressed }) => [styles.buyBtn, { backgroundColor: theme.positive }, pressed && { opacity: 0.8 }]}>
              <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>
                {submitting ? 'Ejecutando…' : 'Comprar'}
              </ThemedText>
            </Pressable>
          </Card>
        ) : (
          <Card>
            <ThemedText type="smallBold">Vender {symbol}</ThemedText>
            <View style={styles.pctRow}>
              {[25, 50, 75, 100].map((p) => (
                <Pressable
                  key={p}
                  onPress={() => setPct(p)}
                  style={[
                    styles.pctBtn,
                    { backgroundColor: pct === p ? theme.accent : theme.backgroundSelected, borderColor: theme.border },
                  ]}>
                  <ThemedText type="smallBold" style={{ color: pct === p ? '#fff' : theme.text }}>
                    {p}%
                  </ThemedText>
                </Pressable>
              ))}
            </View>
            {detail.price ? (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Venderás ≈ {fmtNum((position?.quantity ?? 0) * (pct / 100))} {symbol} por ≈ {fmtUsd((position?.quantity ?? 0) * (pct / 100) * detail.price)} (menos gas)
              </ThemedText>
            ) : null}
            <Pressable onPress={doSell} disabled={submitting} style={({ pressed }) => [styles.buyBtn, { backgroundColor: theme.negative }, pressed && { opacity: 0.8 }]}>
              <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>
                {submitting ? 'Ejecutando…' : 'Vender'}
              </ThemedText>
            </Pressable>
          </Card>
        )}
      </ScrollView>
    </ThemedView>
  );
}

function Metric({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  const theme = useTheme();
  return (
    <View style={[styles.metric, wide && { minWidth: 140 }]}>
      <ThemedText type="small" style={{ color: theme.textSecondary, fontSize: 11, lineHeight: 14 }}>
        {label}
      </ThemedText>
      <ThemedText type="smallBold">{value}</ThemedText>
    </View>
  );
}

function TabButton({ label, active, onPress, disabled }: { label: string; active: boolean; onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.tab,
        { backgroundColor: active ? theme.accent : theme.backgroundElement, borderColor: theme.border },
        disabled && { opacity: 0.4 },
      ]}>
      <ThemedText type="smallBold" style={{ color: active ? '#fff' : theme.text }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, gap: 14, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  centerText: { textAlign: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  priceCard: { gap: 12 },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metric: { minWidth: 80, gap: 2 },
  posCard: { gap: 6 },
  tabs: { flexDirection: 'row', gap: 10 },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    marginTop: 8,
  },
  buyBtn: { marginTop: 12, paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  pctRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  pctBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1 },
});