import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/store/settings';
import { getWallet, resetWallet } from '@/api/trading';
import { saveNotificationConfig, getNotificationConfig } from '@/api/notifications';
import { getGmgnStatus, getProxies, saveProxy, testProxy } from '@/api/market';
import { ApiError } from '@/api/client';
import type { ProxyConfig, ProxyStatus, ProxyTestResult, NotificationConfig, Wallet } from '@/api/types';
import { registerForPushNotificationsAsync, notificationsAvailable } from '@/utils/notifications';
import { fmtNum, fmtUsd, shortAddress } from '@/utils/format';

const TAB_LABELS: Record<string, string> = {
  new_creation: 'Nueva creación (SOL)',
  completed: 'Completado (SOL)',
  new_creation_robinhood: 'Nueva creación (Robinhood)',
  completed_robinhood: 'Completado (Robinhood)',
  token_info: 'Token Info (Detalle)',
};
const TAB_ORDER = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood', 'token_info'];
const NOTIF_CATEGORIES = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood'] as const;
const NOTIF_LABELS: Record<string, string> = {
  new_creation: 'Nueva creación (SOL)',
  completed: 'Completado (SOL)',
  new_creation_robinhood: 'Nueva creación (Robinhood)',
  completed_robinhood: 'Completado (Robinhood)',
};

export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { serverUrl, setUrl, deviceId, pushToken, setPushToken, proxyStatuses, loadProxyStatuses } = useSettings();

  const [urlInput, setUrlInput] = useState(serverUrl);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [budget, setBudget] = useState('10000');
  const [gas, setGas] = useState('0.001');
  const [gmgnOk, setGmgnOk] = useState<boolean | null>(null);

  // proxy config state (per tab)
  const [proxyConfigs, setProxyConfigs] = useState<Record<string, ProxyConfig>>({
    new_creation: { url: '', apiKey: '' },
    completed: { url: '', apiKey: '' },
    new_creation_robinhood: { url: '', apiKey: '' },
    completed_robinhood: { url: '', apiKey: '' },
    token_info: { url: '', apiKey: '' },
  });
  const [proxyTesting, setProxyTesting] = useState<Record<string, boolean>>({});
  const [proxyTestResults, setProxyTestResults] = useState<Record<string, ProxyTestResult | null>>({});

  // notification config (4 toggles)
  const [notifCategories, setNotifCategories] = useState<NotificationConfig['categories']>({
    new_creation: false,
    completed: false,
    new_creation_robinhood: false,
    completed_robinhood: false,
  });

  useEffect(() => {
    setUrlInput(serverUrl);
  }, [serverUrl]);

  const loadAll = useCallback(async () => {
    try {
      const [w, status, proxies, notifCfg] = await Promise.all([
        getWallet(),
        getGmgnStatus().catch(() => ({ ok: false })),
        getProxies().catch(() => null),
        getNotificationConfig().catch(() => null),
      ]);
      setWallet(w.wallet);
      setBudget(String(w.wallet.balance_usd || w.wallet.balance_sol * 150 || 10000));
      setGas(String(w.wallet.gas_per_trade_sol));
      setGmgnOk(status.ok);
      if (proxies) setProxyConfigs(proxies);
      if (notifCfg) setNotifCategories(notifCfg.categories);
    } catch {
      // server may be unreachable
    }
    loadProxyStatuses();
  }, [loadProxyStatuses]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const saveUrl = async () => {
    await setUrl(urlInput);
    Alert.alert('Guardado', `Servidor: ${urlInput.replace(/\/+$/, '')}`);
    loadAll();
  };

  // --- Proxy handlers ---

  const updateProxyField = (tab: string, field: 'url' | 'apiKey', value: string) => {
    setProxyConfigs((prev) => ({
      ...prev,
      [tab]: { ...prev[tab], [field]: value },
    }));
  };

  const doTestProxy = async (tab: string) => {
    const cfg = proxyConfigs[tab];
    if (!cfg.url || !cfg.apiKey) {
      Alert.alert('Error', 'URL y API Key son requeridas');
      return;
    }
    setProxyTesting((prev) => ({ ...prev, [tab]: true }));
    setProxyTestResults((prev) => ({ ...prev, [tab]: null }));
    try {
      const result = await testProxy(cfg.url, cfg.apiKey);
      setProxyTestResults((prev) => ({ ...prev, [tab]: result }));
    } catch (err) {
      setProxyTestResults((prev) => ({
        ...prev,
        [tab]: { ok: false, egressIp: null, latencyMs: 0, error: err instanceof ApiError ? err.message : 'Test failed' },
      }));
    } finally {
      setProxyTesting((prev) => ({ ...prev, [tab]: false }));
    }
  };

  const doSaveProxy = async (tab: string) => {
    const cfg = proxyConfigs[tab];
    // new_creation (SOL) only needs API key, no proxy URL
    if (tab === 'new_creation') {
      if (!cfg.apiKey) {
        Alert.alert('Error', 'API Key es requerida');
        return;
      }
    } else {
      if (!cfg.url || !cfg.apiKey) {
        Alert.alert('Error', 'URL y API Key son requeridas');
        return;
      }
    }
    try {
      await saveProxy(tab, cfg.url, cfg.apiKey);
      // Optimistically mark as working so trenches tab shows data immediately
      const { proxyStatuses: current } = useSettings.getState();
      const next = current.filter((s) => s.tab !== tab);
      next.push({ tab, url: cfg.url, egressIp: null, working: true, lastCheck: new Date().toISOString(), error: null });
      useSettings.setState({ proxyStatuses: next });
      Alert.alert('Guardado', `Proxy de ${TAB_LABELS[tab]} guardado`);
      // Background health check confirms or denies
      loadProxyStatuses();
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'No se pudo guardar');
    }
  };

  // --- Budget ---

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

  // --- Notification toggle ---

  const toggleNotifCategory = async (cat: string) => {
    const next = { ...notifCategories, [cat]: !notifCategories[cat as keyof typeof notifCategories] };
    setNotifCategories(next);

    // Ensure push token exists
    let token = pushToken;
    if (!token) {
      if (!notificationsAvailable()) {
        Alert.alert(
          'Push no disponible',
          'En Android, expo-notifications ya no funciona dentro de Expo Go (desde SDK 53). Necesitas un development build.'
        );
        setNotifCategories((prev) => ({ ...prev, [cat]: false }));
        return;
      }
      token = await registerForPushNotificationsAsync();
      if (!token) {
        Alert.alert('Push no disponible', 'Solo funciona en un dispositivo físico.');
        setNotifCategories((prev) => ({ ...prev, [cat]: false }));
        return;
      }
      setPushToken(token);
    }

    try {
      await saveNotificationConfig(token, next);
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'No se pudo guardar');
      setNotifCategories((prev) => ({ ...prev, [cat]: !prev[cat as keyof typeof prev] }));
    }
  };

  const isAnyNotifOn = Object.values(notifCategories).some(Boolean);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <ThemedText type="subtitle">Settings</ThemedText>

          <Card>
            <ThemedText type="smallBold">Servidor</ThemedText>
            <TextInput
              value={urlInput}
              onChangeText={setUrlInput}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]}
            />
            <Pressable onPress={saveUrl} style={[styles.btn, { backgroundColor: theme.accent }]}>
              <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>Guardar URL</ThemedText>
            </Pressable>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Device: {shortAddress(deviceId)}
            </ThemedText>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              GMGN config: {gmgnOk === null ? '…' : gmgnOk ? 'OK' : 'falta API key (gmgn-cli config)'}
            </ThemedText>
          </Card>

          <Card>
            <ThemedText type="smallBold">Proxies GMGN</ThemedText>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Cada categoría necesita su propio proxy + API key para conectarse a GMGN.
            </ThemedText>
            <Pressable
              onPress={() => router.push('/proxy-tester')}
              style={[styles.proxyBtn, { backgroundColor: theme.backgroundSelected, borderColor: theme.border, marginTop: 8 }]}>
              <ThemedText type="small" style={{ color: theme.accent, textAlign: 'center' }}>
                Probar lista de proxies →
              </ThemedText>
            </Pressable>
            {TAB_ORDER.map((tab) => {
              const status = proxyStatuses.find((s) => s.tab === tab);
              const cfg = proxyConfigs[tab] || { url: '', apiKey: '' };
              const testing = proxyTesting[tab];
              const testResult = proxyTestResults[tab];
              const isOk = status?.working ?? false;
              return (
                <View key={tab} style={[styles.proxyBlock, { borderColor: theme.border }]}>
                  <View style={styles.proxyHeader}>
                    <View style={[styles.proxyDot, { backgroundColor: isOk ? theme.positive : theme.negative }]} />
                    <ThemedText type="smallBold">{TAB_LABELS[tab]}</ThemedText>
                  </View>
                  <TextInput
                    value={cfg.url}
                    onChangeText={(v) => updateProxyField(tab, 'url', v)}
                    placeholder="http://host:port o socks5://host:port"
                    placeholderTextColor={theme.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]}
                  />
                  <TextInput
                    value={cfg.apiKey}
                    onChangeText={(v) => updateProxyField(tab, 'apiKey', v)}
                    placeholder="gmgn_xxx"
                    placeholderTextColor={theme.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]}
                  />
                  <View style={styles.proxyBtnRow}>
                    <Pressable
                      onPress={() => doTestProxy(tab)}
                      disabled={testing}
                      style={[styles.proxyBtn, { backgroundColor: theme.backgroundSelected, borderColor: theme.border }]}>
                      <ThemedText type="small" style={{ color: theme.text }}>
                        {testing ? 'Probando…' : 'Probar'}
                      </ThemedText>
                    </Pressable>
                    <Pressable
                      onPress={() => doSaveProxy(tab)}
                      style={[styles.proxyBtn, { backgroundColor: theme.accent }]}>
                      <ThemedText type="smallBold" style={{ color: '#fff' }}>Guardar</ThemedText>
                    </Pressable>
                  </View>
                  {testResult && (
                    <ThemedText type="small" style={{ color: testResult.ok ? theme.positive : theme.negative }}>
                      {testResult.ok
                        ? `OK · IP: ${testResult.egressIp} · ${testResult.latencyMs}ms`
                        : `Error: ${testResult.error}`}
                    </ThemedText>
                  )}
                  {!testResult && status?.working && status.egressIp && (
                    <ThemedText type="small" style={{ color: theme.textSecondary }}>
                      IP: {status.egressIp}
                    </ThemedText>
                  )}
                  {!testResult && !status?.working && status?.error && (
                    <ThemedText type="small" style={{ color: theme.textSecondary }}>
                      {status.error}
                    </ThemedText>
                  )}
                </View>
              );
            })}
          </Card>

          <Card>
            <ThemedText type="smallBold">Presupuesto simulado</ThemedText>
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

          <Card>
            <View style={styles.rowBetween}>
              <ThemedText type="smallBold">Notificaciones push</ThemedText>
              {pushToken && isAnyNotifOn && (
                <ThemedText type="small" style={{ color: theme.positive }}>Activo</ThemedText>
              )}
            </View>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Recibe un aviso por push cuando llegue un token nuevo a cada categoría.
            </ThemedText>
            {pushToken ? (
              <ThemedText type="small" style={{ color: theme.positive }}>
                Push token registrado
              </ThemedText>
            ) : null}

            {NOTIF_CATEGORIES.map((cat) => (
              <View key={cat} style={[styles.notifRow, { borderColor: theme.border }]}>
                <View style={{ flex: 1 }}>
                  <ThemedText type="smallBold">{NOTIF_LABELS[cat]}</ThemedText>
                </View>
                <Switch
                  value={notifCategories[cat]}
                  onValueChange={() => toggleNotifCategory(cat)}
                  trackColor={{ true: theme.accent }}
                />
              </View>
            ))}
          </Card>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
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
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  proxyBlock: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, marginTop: 4 },
  proxyHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  proxyDot: { width: 8, height: 8, borderRadius: 4 },
  proxyBtnRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  proxyBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1 },
  notifRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
