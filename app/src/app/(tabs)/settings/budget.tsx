import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/store/settings';
import { getWallet, resetWallet } from '@/api/trading';
import { ApiError } from '@/api/client';
import type { Wallet } from '@/api/types';
import { fmtNum, fmtUsd } from '@/utils/format';

export default function BudgetScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { serverUrl } = useSettings();

  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [budget, setBudget] = useState('10000');
  const [gas, setGas] = useState('0.001');

  const loadAll = useCallback(async () => {
    try {
      const w = await getWallet();
      setWallet(w.wallet);
      setBudget(String(w.wallet.balance_usd || w.wallet.balance_sol * 150 || 10000));
      setGas(String(w.wallet.gas_per_trade_sol));
    } catch {}
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const doReset = async () => {
    const b = Number(budget);
    const g = Number(gas);
    if (!b || b <= 0) return Alert.alert('Error', 'Presupuesto inválido');
    try {
      const res = await resetWallet(b, g);
      setWallet(res.wallet);
      Alert.alert('Listo', `Presupuesto reiniciado: ${fmtNum(res.wallet.balance_sol)} SOL (≈ ${fmtUsd(res.wallet.balance_sol * res.sol_price)})`);
      loadAll();
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'No se pudo reiniciar');
    }
  };

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={theme.text} />
          </Pressable>
          <ThemedText type="smallBold" style={{ color: theme.text }}>Presupuesto</ThemedText>
        </View>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Card>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              USD: {wallet ? fmtUsd(wallet.balance_usd) : '—'} · SOL: {wallet ? fmtNum(wallet.balance_sol) : '—'} · Gas: {wallet ? fmtNum(wallet.gas_per_trade_sol) : '—'} SOL
            </ThemedText>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>Budget (USD)</ThemedText>
                <TextInput value={budget} onChangeText={setBudget} keyboardType="decimal-pad" style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]} />
              </View>
              <View style={{ flex: 1 }}>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>Gas (SOL)</ThemedText>
                <TextInput value={gas} onChangeText={setGas} keyboardType="decimal-pad" style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]} />
              </View>
            </View>
            <Pressable onPress={doReset} style={[styles.btn, { backgroundColor: theme.accent }]}>
              <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>Reiniciar presupuesto</ThemedText>
            </Pressable>
          </Card>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: { padding: 4 },
  scroll: { padding: 16, gap: 12, paddingBottom: 40 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    fontSize: 14,
    marginTop: 6,
  },
  btn: { marginTop: 10, paddingVertical: 12, borderRadius: 10 },
  row: { flexDirection: 'row', gap: 10, marginTop: 4 },
});
