import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { TokenAvatar } from '@/components/token-avatar';
import { PriceChange } from '@/components/price-change';
import { useTheme } from '@/hooks/use-theme';
import { getTokenDetail, getLiveTokenPrice, getTokenMarketCap } from '@/api/market';
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
  const [solPrice, setSolPrice] = useState<number>(0);
  const [solBalance, setSolBalance] = useState<number>(0);
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
      setSolPrice(pf.sol_price ?? 0);
      setSolBalance(pf.wallet.balance_sol);
      const pos = pf.positions.find((p) => p.token_address === address);
      setPosition(pos ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al cargar el token');
    } finally {
      setLoading(false);
    }
  }, [address, chain]);

  // "Resto" de la info (nombre, liquidez, volumen, holders, DEX…): cada 3s.
  // No depende del proxy GMGN: si el token está en trenches usa el store en
  // memoria; si no, getTokenInfo tiene cache de 15s en el server.
  const loadDetail = useCallback(async () => {
    if (!address) return;
    try {
      const d = await getTokenDetail(chain || 'sol', address);
      setDetail(d);
      setError(null);
    } catch {
      // mantén el último detalle conocido
    }
  }, [address, chain]);

  // Posición del token + balance SOL en vivo (portfolio): cada 2s.
  const loadPosition = useCallback(async () => {
    if (!address) return;
    try {
      const pf = await getPortfolio();
      setSolPrice(pf.sol_price ?? 0);
      setSolBalance(pf.wallet.balance_sol);
      const pos = pf.positions.find((p) => p.token_address === address);
      setPosition(pos ?? null);
    } catch {
      // mantén la última posición conocida
    }
  }, [address]);

  // Precio + marketcap vía GMGN proxy (con fallback Dexscreener): cada 2s.
  const loadLive = useCallback(async () => {
    if (!address) return;
    try {
      const live = await getLiveTokenPrice(chain || 'sol', address);
      setDetail((prev) => {
        if (!prev) return prev;
        const oldPc = prev.priceChange;
        const priceChange = oldPc
          ? { ...oldPc, h24: live.priceChange24h ?? oldPc.h24 }
          : live.priceChange24h != null
            ? { m5: 0, h1: 0, h6: 0, h24: live.priceChange24h }
            : null;
        return {
          ...prev,
          price: live.price ?? prev.price,
          marketCap: live.marketCap ?? prev.marketCap,
          supply: live.supply ?? prev.supply,
          liquidity: live.liquidity ?? prev.liquidity,
          priceChange,
        };
      });
    } catch {
      // mantén el último precio conocido
    }
  }, [address, chain]);

  // Market cap vía GMGN proxy (2ª key): cada 1s. Si el proxy falla, el server
  // hace fallback a Dexscreener y devuelve source: 'dexscreener'.
  const loadMcap = useCallback(async () => {
    if (!address) return;
    try {
      const mcap = await getTokenMarketCap(chain || 'sol', address);
      if (mcap.marketCap != null) {
        setDetail((prev) => (prev ? { ...prev, marketCap: mcap.marketCap } : prev));
      }
    } catch {
      // mantén el último marketcap conocido
    }
  }, [address, chain]);

  useEffect(() => {
    load();
    const liveTimer = setInterval(loadLive, 2000);
    const mcapTimer = setInterval(loadMcap, 1000);
    const detailTimer = setInterval(loadDetail, 3000);
    const posTimer = setInterval(loadPosition, 2000);
    return () => {
      clearInterval(liveTimer);
      clearInterval(mcapTimer);
      clearInterval(detailTimer);
      clearInterval(posTimer);
    };
  }, [load, loadLive, loadMcap, loadDetail, loadPosition]);

  const doBuy = async () => {
    if (!address) return;
    const usd = Number(amount);
    if (!usd || usd <= 0) return Alert.alert('Error', 'Introduce un monto en USD');
    setSubmitting(true);
    try {
      const res = await buy(address, usd, chain || 'sol');
      setResult(res);
      setSolBalance(res.balance_sol);
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
                Market Cap
              </ThemedText>
              <ThemedText type="subtitle" style={{ color: theme.text }}>
                {fmtUsd(detail.marketCap, { compact: true })}
              </ThemedText>
            </View>
          </View>
          <View style={styles.metrics}>
            <Metric label="Liquidez" value={fmtUsd(detail.liquidity, { compact: true })} />
            {detail.dex ? <Metric label="DEX" value={detail.dex} /> : null}
          </View>
        </Card>

        {position && (
          <Card style={styles.posCard}>
            <View style={styles.priceRow}>
              <View>
                <ThemedText type="smallBold">Tu posición</ThemedText>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>
                  {fmtUsd(position.entry_market_cap, { compact: true })} al entrar · MC actual {fmtUsd(position.market_cap ?? 0, { compact: true })}
                </ThemedText>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <ThemedText type="smallBold">{fmtUsd(position.value)}</ThemedText>
                <PriceChange value={position.pnl_percent} />
              </View>
            </View>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Costo: {fmtUsd(position.cost_usdc)} · P&L: {fmtUsd(position.pnl)} ({position.pnl_percent.toFixed(2)}%)
            </ThemedText>
          </Card>
        )}

        {result && (
          <Card style={{ borderColor: result.side === 'buy' ? theme.positive : theme.negative }}>
            <ThemedText type="smallBold" style={{ color: result.side === 'buy' ? theme.positive : theme.negative }}>
              {result.side === 'buy' ? 'Compra ejecutada' : 'Venta ejecutada'}
            </ThemedText>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {fmtUsd(result.total_usdc)} al MC {fmtUsd(result.market_cap, { compact: true })} · gas {fmtNum(result.gas_sol, { decimals: 4 })} SOL
              {result.pnl_usdc != null ? ` · P&L ${fmtUsd(result.pnl_usdc)}` : ''}
            </ThemedText>
            <ThemedText type="smallBold">SOL: {fmtNum(result.balance_sol)} · USD: {fmtUsd(result.balance_usd)}</ThemedText>
          </Card>
        )}

        <View style={styles.tabs}>
          <TabButton label="Comprar" active={tab === 'buy'} onPress={() => setTab('buy')} />
          <TabButton label="Vender" active={tab === 'sell'} onPress={() => setTab('sell')} disabled={!position} />
        </View>

        {tab === 'buy' ? (
          <Card>
            <ThemedText type="smallBold">Comprar {symbol} (presupuesto SOL)</ThemedText>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Balance SOL: {fmtNum(solBalance, { decimals: 4 })} ({fmtUsd(solBalance * solPrice)})
            </ThemedText>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              placeholder="Monto en USD (ej. 50)"
              placeholderTextColor={theme.textSecondary}
              keyboardType="decimal-pad"
              style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]}
            />
            {detail.marketCap && Number(amount) > 0 && solPrice > 0 ? (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                ≈ {fmtNum((Number(amount) / solPrice) - 0.001, { decimals: 4 })} SOL gastados · ≈ {fmtNum((Number(amount) / detail.marketCap) * 100, { decimals: 6 })}% del MC · gas {fmtNum(0.001, { decimals: 4 })} SOL
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
            {position && detail.marketCap ? (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Venderás {pct}% de tu posición por ≈ {fmtNum(((position.quantity * (pct / 100)) * detail.marketCap) / (solPrice || 1))} SOL (menos gas)
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