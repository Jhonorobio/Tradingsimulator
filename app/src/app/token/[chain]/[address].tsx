import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { TokenAvatar } from '@/components/token-avatar';
import { PriceChange } from '@/components/price-change';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/store/settings';
import { useWs } from '@/store/ws';
import { getTokenDetail } from '@/api/market';
import { buy, getPortfolio, sell } from '@/api/trading';
import { ApiError } from '@/api/client';
import type { Position, TokenDetail, TradeResult } from '@/api/types';
import { fmtNum, fmtUsd, shortAddress } from '@/utils/format';

type Tab = 'buy' | 'sell';

function v(n: number | null | undefined, opts?: { pct?: boolean; decimals?: number; compact?: boolean }): string {
  if (n == null || isNaN(n)) return '—';
  if (opts?.pct) return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
  if (opts?.decimals != null) return fmtNum(n, { decimals: opts.decimals });
  if (opts?.compact) return fmtUsd(n, { compact: true });
  return fmtUsd(n);
}

export default function TokenScreen() {
  const { chain, address } = useLocalSearchParams<{ chain: string; address: string }>();
  const theme = useTheme();
  const { proxyStatuses } = useSettings();
  const { tokenPrices, subscribeTokenPrice, unsubscribeTokenPrice, solPrice: wsSolPrice, subscribeSolPrice, unsubscribeSolPrice } = useWs();

  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [solPrice, setSolPrice] = useState<number>(0);
  const [solBalance, setSolBalance] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('buy');
  const [amount, setAmount] = useState('');
  const [pct, setPct] = useState(100);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<TradeResult | null>(null);

  useEffect(() => {
    if (address) subscribeTokenPrice(chain || 'sol', address);
    subscribeSolPrice();
    return () => {
      if (address) unsubscribeTokenPrice(chain || 'sol', address);
      unsubscribeSolPrice();
    };
  }, [address, chain, subscribeTokenPrice, unsubscribeTokenPrice, subscribeSolPrice, unsubscribeSolPrice]);

  useEffect(() => {
    if (wsSolPrice != null) setSolPrice(wsSolPrice);
  }, [wsSolPrice]);

  useEffect(() => {
    const key = `${chain || 'sol'}:${address}`;
    const wsData = tokenPrices[key];
    if (wsData && detail) {
      setDetail((prev) => prev ? { ...prev, ...wsData } : prev);
    }
  }, [tokenPrices, chain, address]);

  const loadDetail = useCallback(async () => {
    if (!address) return;
    try {
      const d = await getTokenDetail(chain || 'sol', address);
      setDetail(d);
      setError(null);
    } catch {
      if (!detail) setError('No se pudo cargar el token');
    }
  }, [address, chain]);

  const loadPosition = useCallback(async () => {
    if (!address) return;
    try {
      const pf = await getPortfolio();
      setSolPrice(pf.sol_price ?? 0);
      setSolBalance(pf.wallet.balance_sol);
      const pos = pf.positions.find((p) => p.token_address === address);
      setPosition(pos ?? null);
    } catch {}
  }, [address]);

  useEffect(() => {
    loadDetail();
    loadPosition();
    const posTimer = setInterval(loadPosition, 2000);
    return () => { clearInterval(posTimer); };
  }, [loadDetail, loadPosition]);

  const openGmgn = useCallback(async () => {
    if (!address) return;
    await WebBrowser.openBrowserAsync(`https://gmgn.ai/${chain || 'sol'}/token/${address}`).catch(() => {});
  }, [address, chain]);

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
      await loadDetail();
      await loadPosition();
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
      await loadDetail();
      await loadPosition();
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'No se pudo vender');
    } finally {
      setSubmitting(false);
    }
  };

  if (error && !detail) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText type="subtitle">Sin datos</ThemedText>
        <ThemedText style={styles.centerText}>{error}</ThemedText>
        <Pressable onPress={loadDetail}>
          <ThemedText type="linkPrimary">Reintentar</ThemedText>
        </Pressable>
      </ThemedView>
    );
  }

  if (!detail) return null;
  const d = detail;
  const symbol = d.symbol ?? 'TOKEN';
  const pc = d.priceChange;

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* ─── Header ─── */}
        <View style={styles.header}>
          <TokenAvatar logo={d.logo} symbol={symbol} size={56} />
          <View style={{ flex: 1 }}>
            <ThemedText type="subtitle">{symbol}</ThemedText>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {d.name ?? '—'} · {shortAddress(d.address)}
            </ThemedText>
          </View>
          <Pressable
            onPress={openGmgn}
            hitSlop={6}
            style={({ pressed }) => [styles.gmgnBtn, { borderColor: theme.accent }, pressed && { opacity: 0.7 }]}>
            <Ionicons name="open-outline" size={14} color={theme.accent} />
            <ThemedText type="smallBold" style={{ color: theme.accent, fontSize: 12 }}>GMGN</ThemedText>
          </Pressable>
        </View>

        {/* ─── Price Card ─── */}
        <Card style={styles.priceCard}>
          <View style={styles.priceRow}>
            <View>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>Market Cap</ThemedText>
              <ThemedText type="subtitle">{v(d.marketCap, { compact: true })}</ThemedText>
            </View>
            {d.price != null && (
              <View style={{ alignItems: 'flex-end' }}>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>Precio</ThemedText>
                <ThemedText type="smallBold">{d.price < 0.01 ? `$${d.price.toExponential(2)}` : fmtUsd(d.price)}</ThemedText>
              </View>
            )}
          </View>
          <View style={styles.metrics}>
            <Metric label="Liquidez" value={v(d.liquidity, { compact: true })} />
            {d.dex ? <Metric label="DEX" value={d.dex} /> : null}
            {d.holders != null ? <Metric label="Holders" value={fmtNum(d.holders)} /> : null}
          </View>
        </Card>

        {/* ─── Price Changes ─── */}
        <Card>
          <ThemedText type="smallBold">Cambios de Precio</ThemedText>
          <View style={styles.metrics}>
            <Metric label="5m" value={v(pc?.m5, { pct: true })} />
            <Metric label="1h" value={v(pc?.h1, { pct: true })} />
            <Metric label="6h" value={v(pc?.h6, { pct: true })} />
            <Metric label="24h" value={v(pc?.h24, { pct: true })} />
          </View>
        </Card>

        {/* ─── Volume & Activity ─── */}
        <Card>
          <ThemedText type="smallBold">Volumen y Actividad</ThemedText>
          <View style={styles.metrics}>
            <Metric label="Vol 24h" value={v(d.volume24h, { compact: true })} />
            <Metric label="Vol 1h" value={v(d.volume1h, { compact: true })} />
            <Metric label="Swaps 24h" value={v(d.swaps24h)} />
            <Metric label="Swaps 1h" value={v(d.swaps1h)} />
            <Metric label="Buys" value={v(d.buys24h)} />
            <Metric label="Sells" value={v(d.sells24h)} />
            <Metric label="Net Buy" value={v(d.netBuy24h, { compact: true })} />
          </View>
        </Card>

        {/* ─── Holder Info ─── */}
        <Card>
          <ThemedText type="smallBold">Información de Holders</ThemedText>
          <View style={styles.metrics}>
            <Metric label="Holders" value={v(d.holders)} />
            <Metric label="Top 10" value={d.top10HolderRate != null ? `${(d.top10HolderRate * 100).toFixed(1)}%` : '—'} />
            <Metric label="Smart Degen" value={v(d.smartDegenCount)} />
            <Metric label="Renowned" value={v(d.renownedCount)} />
            <Metric label="Sniper" value={v(d.sniperCount)} />
          </View>
        </Card>

        {/* ─── Risk Signals ─── */}
        <Card>
          <ThemedText type="smallBold">Señales de Riesgo</ThemedText>
          <View style={styles.metrics}>
            <Metric label="Rug Ratio" value={d.rugRatio != null ? d.rugRatio.toFixed(3) : '—'} good={d.rugRatio != null && d.rugRatio <= 0.3} warn={d.rugRatio != null && d.rugRatio > 0.3} />
            <Metric label="Wash Trading" value={d.isWashTrading != null ? (d.isWashTrading ? 'Sí' : 'No') : '—'} good={d.isWashTrading != null && !d.isWashTrading} warn={!!d.isWashTrading} />
            <Metric label="Honeypot" value={d.isHoneypot != null ? (String(d.isHoneypot) === '1' || String(d.isHoneypot) === 'yes' ? 'Sí' : 'No') : '—'} good={d.isHoneypot != null && !(String(d.isHoneypot) === '1' || String(d.isHoneypot) === 'yes')} warn={d.isHoneypot != null && (String(d.isHoneypot) === '1' || String(d.isHoneypot) === 'yes')} />
            <Metric label="Bundler Rate" value={d.bundlerRate != null ? `${(d.bundlerRate * 100).toFixed(1)}%` : '—'} />
            <Metric label="Buy Tax" value={d.buyTax != null ? `${(d.buyTax * 100).toFixed(1)}%` : '—'} />
          </View>
        </Card>

        {/* ─── Creator ─── */}
        <Card>
          <ThemedText type="smallBold">Creador / Dev</ThemedText>
          <View style={styles.metrics}>
            <Metric label="Dev Hold" value={d.devTeamHoldRate != null ? `${(d.devTeamHoldRate * 100).toFixed(1)}%` : '—'} />
            <Metric label="Creator Balance" value={d.creatorBalanceRate != null ? `${(d.creatorBalanceRate * 100).toFixed(1)}%` : '—'} />
            <Metric label="Status" value={d.creatorTokenStatus ?? '—'} good={d.creatorTokenStatus === 'creator_close'} />
            <Metric label="Mint Renounced" value={d.renouncedMint != null ? (d.renouncedMint ? 'Sí' : 'No') : '—'} good={d.renouncedMint != null && !!d.renouncedMint} />
            <Metric label="Freeze Renounced" value={d.renouncedFreeze != null ? (d.renouncedFreeze ? 'Sí' : 'No') : '—'} good={d.renouncedFreeze != null && !!d.renouncedFreeze} />
          </View>
        </Card>

        {/* ─── Social Links ─── */}
        <Card>
          <ThemedText type="smallBold">Redes Sociales</ThemedText>
          <View style={styles.socialRow}>
            {d.twitter ? (
              <Pressable onPress={() => Linking.openURL(d.twitter!)} style={styles.socialBtn}>
                <Ionicons name="logo-twitter" size={16} color={theme.accent} />
                <ThemedText type="small" style={{ color: theme.accent }}>
                  Twitter {d.xFollowers != null ? `(${fmtNum(d.xFollowers)})` : ''}
                </ThemedText>
              </Pressable>
            ) : (
              <View style={styles.socialBtn}>
                <Ionicons name="logo-twitter" size={16} color={theme.textSecondary} />
                <ThemedText type="small" style={{ color: theme.textSecondary }}>Twitter —</ThemedText>
              </View>
            )}
            {d.telegram ? (
              <Pressable onPress={() => Linking.openURL(d.telegram!)} style={styles.socialBtn}>
                <Ionicons name="paper-plane" size={16} color={theme.accent} />
                <ThemedText type="small" style={{ color: theme.accent }}>Telegram</ThemedText>
              </Pressable>
            ) : (
              <View style={styles.socialBtn}>
                <Ionicons name="paper-plane" size={16} color={theme.textSecondary} />
                <ThemedText type="small" style={{ color: theme.textSecondary }}>Telegram —</ThemedText>
              </View>
            )}
            {d.website ? (
              <Pressable onPress={() => Linking.openURL(d.website!)} style={styles.socialBtn}>
                <Ionicons name="globe" size={16} color={theme.accent} />
                <ThemedText type="small" style={{ color: theme.accent }}>Website</ThemedText>
              </Pressable>
            ) : (
              <View style={styles.socialBtn}>
                <Ionicons name="globe" size={16} color={theme.textSecondary} />
                <ThemedText type="small" style={{ color: theme.textSecondary }}>Website —</ThemedText>
              </View>
            )}
          </View>
        </Card>

        {/* ─── Trenches Warning ─── */}
        {d.sources?.trenches && (() => {
          const trenchStatus = proxyStatuses.find((s) => s.tab === 'new_creation' || s.tab === 'completed' || s.tab === 'new_creation_robinhood' || s.tab === 'completed_robinhood');
          if (trenchStatus?.working) return null;
          return (
            <Card style={{ borderColor: theme.warn, backgroundColor: `${theme.warn}15` }}>
              <ThemedText type="small" style={{ color: theme.warn }}>
                Datos de Trenches — proxy no verificado. Los datos pueden estar desactualizados.
              </ThemedText>
            </Card>
          );
        })()}

        {/* ─── Position ─── */}
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

        {/* ─── Trade Result ─── */}
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

        {/* ─── Trade Tabs ─── */}
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
            {d.marketCap && Number(amount) > 0 && solPrice > 0 ? (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                ≈ {fmtNum((Number(amount) / solPrice) - 0.001, { decimals: 4 })} SOL gastados · ≈ {fmtNum((Number(amount) / d.marketCap) * 100, { decimals: 6 })}% del MC · gas {fmtNum(0.001, { decimals: 4 })} SOL
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
                  style={[styles.pctBtn, { backgroundColor: pct === p ? theme.accent : theme.backgroundSelected, borderColor: theme.border }]}>
                  <ThemedText type="smallBold" style={{ color: pct === p ? '#fff' : theme.text }}>{p}%</ThemedText>
                </Pressable>
              ))}
            </View>
            {position && d.marketCap ? (
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Venderás {pct}% de tu posición por ≈ {fmtNum(((position.quantity * (pct / 100)) * d.marketCap) / (solPrice || 1))} SOL (menos gas)
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

function Metric({ label, value, warn, good }: { label: string; value: string; warn?: boolean; good?: boolean }) {
  const theme = useTheme();
  const color = warn ? theme.negative : good ? theme.positive : value === '—' ? theme.textSecondary : theme.text;
  return (
    <View style={styles.metric}>
      <ThemedText type="small" style={{ color: theme.textSecondary, fontSize: 11, lineHeight: 14 }}>{label}</ThemedText>
      <ThemedText type="smallBold" style={{ color }}>{value}</ThemedText>
    </View>
  );
}

function TabButton({ label, active, onPress, disabled }: { label: string; active: boolean; onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.tab, { backgroundColor: active ? theme.accent : theme.backgroundElement, borderColor: theme.border }, disabled && { opacity: 0.4 }]}>
      <ThemedText type="smallBold" style={{ color: active ? '#fff' : theme.text }}>{label}</ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, gap: 14, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  centerText: { textAlign: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  gmgnBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  priceCard: { gap: 12 },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metric: { minWidth: 80, gap: 2 },
  posCard: { gap: 6 },
  socialRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  socialBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tabs: { flexDirection: 'row', gap: 10 },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1, alignItems: 'center' },
  input: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16, marginTop: 8 },
  buyBtn: { marginTop: 12, paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  pctRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  pctBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1 },
});
