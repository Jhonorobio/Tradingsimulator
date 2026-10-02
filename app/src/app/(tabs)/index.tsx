import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { TrackingPanel } from '@/components/tracking-panel';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/store/settings';
import { getWallet } from '@/api/trading';
import { ApiError } from '@/api/client';
import type { Wallet } from '@/api/types';
import { fmtUsd } from '@/utils/format';

export default function DashboardScreen() {
  const theme = useTheme();
  const { proxyStatuses, loadProxyStatuses } = useSettings();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [solPrice, setSolPrice] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getWallet();
      setWallet(res.wallet);
      setSolPrice(res.sol_price ?? 0);
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
    const timer = setInterval(load, 500);
    return () => {
      clearInterval(timer);
    };
  }, [load, loadProxyStatuses]);

  if (loading && !wallet) {
    return (
      <ThemedView style={styles.center}>
        <ThemedText type="subtitle">Cargando…</ThemedText>
      </ThemedView>
    );
  }

  if (error && !wallet) {
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

  if (!wallet) return null;

  const floatingUsd = wallet.balance_usd + wallet.balance_sol * (solPrice || 0);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.header}>
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
            </View>
            <View style={styles.summaryRow}>
              <SummaryItem label="USD" value={fmtUsd(wallet.balance_usd)} />
              <SummaryItem label="SOL" value={String(wallet.balance_sol)} />
              {solPrice > 0 ? <SummaryItem label="Precio SOL" value={fmtUsd(solPrice, { decimals: 2 })} /> : null}
            </View>
          </Card>
        </View>

        <TrackingPanel />
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
  header: { paddingHorizontal: 16, paddingTop: 12, gap: 12, paddingBottom: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  centerText: { textAlign: 'center' },
  balanceCard: { gap: 14 },
  balanceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  summaryItem: { minWidth: 90, gap: 2 },
});
