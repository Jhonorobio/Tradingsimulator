import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/store/settings';
import { getWallet, resetWallet } from '@/api/trading';
import {
  deleteSubscription,
  getSubscriptions,
  setSubscriptionEnabled,
  subscribe,
} from '@/api/notifications';
import { getGmgnStatus, getProxies, saveProxy, testProxy } from '@/api/market';
import { ApiError } from '@/api/client';
import type { ProxyConfig, ProxyStatus, ProxyTestResult, PushSubscription, Wallet } from '@/api/types';
import { registerForPushNotificationsAsync, notificationsAvailable } from '@/utils/notifications';
import { fmtNum, fmtUsd, shortAddress } from '@/utils/format';

const TAB_LABELS: Record<string, string> = {
  new_creation: 'Nueva creación',
  near_completion: 'Completando',
  completed: 'Completado',
  token_info: 'Token Info (Detalle)',
};
const TAB_ORDER = ['new_creation', 'near_completion', 'completed', 'token_info'];

export default function SettingsScreen() {
  const theme = useTheme();
  const { serverUrl, setUrl, deviceId, pushToken, setPushToken, proxyStatuses, loadProxyStatuses } = useSettings();

  const [urlInput, setUrlInput] = useState(serverUrl);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [budget, setBudget] = useState('10000');
  const [gas, setGas] = useState('0.001');
  const [gmgnOk, setGmgnOk] = useState<boolean | null>(null);

  // proxy config state (per tab)
  const [proxyConfigs, setProxyConfigs] = useState<Record<string, ProxyConfig>>({
    new_creation: { url: '', apiKey: '' },
    near_completion: { url: '', apiKey: '' },
    completed: { url: '', apiKey: '' },
    token_info: { url: '', apiKey: '' },
  });
  const [proxyTesting, setProxyTesting] = useState<Record<string, boolean>>({});
  const [proxyTestResults, setProxyTestResults] = useState<Record<string, ProxyTestResult | null>>({});

  // notification config
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [notifTypes, setNotifTypes] = useState<string[]>(['new_creation']);
  const [notifPreset, setNotifPreset] = useState('safe');
  const [notifMinSmart, setNotifMinSmart] = useState('1');
  const [notifMinVol, setNotifMinVol] = useState('');
  const [notifMaxRug, setNotifMaxRug] = useState('');
  const [subscriptions, setSubscriptions] = useState<PushSubscription[]>([]);
  const [savingNotif, setSavingNotif] = useState(false);

  useEffect(() => {
    setUrlInput(serverUrl);
  }, [serverUrl]);

  const loadAll = useCallback(async () => {
    try {
      const [w, subs, status, proxies] = await Promise.all([
        getWallet(),
        getSubscriptions(),
        getGmgnStatus().catch(() => ({ ok: false })),
        getProxies().catch(() => null),
      ]);
      setWallet(w.wallet);
      setBudget(String(w.wallet.balance_usd || w.wallet.balance_sol * 150 || 10000));
      setGas(String(w.wallet.gas_per_trade_sol));
      setSubscriptions(subs.subscriptions);
      setGmgnOk(status.ok);
      setNotifEnabled(subs.subscriptions.some((s) => s.enabled));
      if (proxies) {
        setProxyConfigs(proxies);
      }
    } catch {
      // wallet/subscription calls may fail if server unreachable
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
    if (!cfg.url || !cfg.apiKey) {
      Alert.alert('Error', 'URL y API Key son requeridas');
      return;
    }
    try {
      await saveProxy(tab, cfg.url, cfg.apiKey);
      Alert.alert('Guardado', `Proxy de ${TAB_LABELS[tab]} guardado`);
      loadProxyStatuses();
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'No se pudo guardar');
    }
  };

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

  const toggleNotifs = async (value: boolean) => {
    setNotifEnabled(value);
    if (value) {
      if (!notificationsAvailable()) {
        Alert.alert(
          'Push no disponible',
          'En Android, expo-notifications ya no funciona dentro de Expo Go (desde SDK 53). Necesitas un development build o probarlo en iOS para recibir notificaciones.'
        );
        setNotifEnabled(false);
        return;
      }
      if (!pushToken) {
        const token = await registerForPushNotificationsAsync();
        if (!token) {
          Alert.alert(
            'Push no disponible',
            'Solo funciona en un dispositivo físico (no simulador/web). Configura expo-notifications y vuelve a intentarlo.'
          );
          setNotifEnabled(false);
          return;
        }
        setPushToken(token);
      }
    }
  };

  const saveNotif = async () => {
    const token = pushToken ?? (await registerForPushNotificationsAsync());
    if (!token) {
      Alert.alert('Push no disponible', 'Registra el token push en un dispositivo físico primero.');
      return;
    }
    setPushToken(token);
    setSavingNotif(true);
    try {
      await subscribe({
        push_token: token,
        chain: 'sol',
        types: notifTypes,
        filter_preset: notifPreset || undefined,
        min_smart_degen: notifMinSmart ? Number(notifMinSmart) : undefined,
        min_volume_24h: notifMinVol ? Number(notifMinVol) : undefined,
        max_rug_ratio: notifMaxRug ? Number(notifMaxRug) : undefined,
      });
      Alert.alert('Suscripción creada', 'El servidor avisará por push cuando lleguen tokens que cumplan tus filtros.');
      loadAll();
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'No se pudo suscribir');
    } finally {
      setSavingNotif(false);
    }
  };

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
              <Switch value={notifEnabled} onValueChange={toggleNotifs} trackColor={{ true: theme.accent }} />
            </View>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Avísame cuando lleguen tokens nuevos a Trenches que cumplan mis filtros (sol).
            </ThemedText>
            {pushToken ? (
              <ThemedText type="small" style={{ color: theme.positive }}>
                Push token registrado ✓
              </ThemedText>
            ) : null}

            <ThemedText type="small" style={{ color: theme.textSecondary, marginTop: 4 }}>Tipos</ThemedText>
            <View style={styles.pctRow}>
              {['new_creation', 'near_completion', 'completed'].map((t) => {
                const active = notifTypes.includes(t);
                return (
                  <Pressable
                    key={t}
                    onPress={() =>
                      setNotifTypes((prev) => (active ? prev.filter((x) => x !== t) : [...prev, t]))
                    }
                    style={[styles.pctBtn, { backgroundColor: active ? theme.accent : theme.backgroundSelected, borderColor: theme.border }]}>
                    <ThemedText type="small" style={{ color: active ? '#fff' : theme.text, fontSize: 11, lineHeight: 14 }}>
                      {t.replace('_', ' ')}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </View>

            <ThemedText type="small" style={{ color: theme.textSecondary, marginTop: 4 }}>Preset</ThemedText>
            <View style={styles.pctRow}>
              {['', 'safe', 'smart-money', 'strict'].map((p) => (
                <Pressable
                  key={p || 'none'}
                  onPress={() => setNotifPreset(p)}
                  style={[styles.pctBtn, { backgroundColor: notifPreset === p ? theme.accent : theme.backgroundSelected, borderColor: theme.border }]}>
                  <ThemedText type="small" style={{ color: notifPreset === p ? '#fff' : theme.text, fontSize: 11, lineHeight: 14 }}>
                    {p || 'sin preset'}
                  </ThemedText>
                </Pressable>
              ))}
            </View>

            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>Min smart degens</ThemedText>
                <TextInput value={notifMinSmart} onChangeText={setNotifMinSmart} keyboardType="numeric" style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]} />
              </View>
              <View style={{ flex: 1 }}>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>Min vol 24h ($)</ThemedText>
                <TextInput value={notifMinVol} onChangeText={setNotifMinVol} keyboardType="numeric" style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]} />
              </View>
              <View style={{ flex: 1 }}>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>Max rug</ThemedText>
                <TextInput value={notifMaxRug} onChangeText={setNotifMaxRug} keyboardType="numeric" style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]} />
              </View>
            </View>

            <Pressable onPress={saveNotif} disabled={savingNotif} style={[styles.btn, { backgroundColor: theme.accent }]}>
              <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>
                {savingNotif ? 'Guardando…' : 'Guardar suscripción'}
              </ThemedText>
            </Pressable>
          </Card>

          {subscriptions.length > 0 && (
            <Card>
              <ThemedText type="smallBold">Suscripciones activas</ThemedText>
              {subscriptions.map((s) => (
                <View key={s.id} style={styles.subRow}>
                  <View style={{ flex: 1 }}>
                    <ThemedText type="small">
                      #{s.id} · {s.types.join(', ')} · {s.filter_preset || 'sin preset'}
                    </ThemedText>
                    <ThemedText type="small" style={{ color: theme.textSecondary }}>
                      smart≥{s.min_smart_degen ?? '—'} vol≥{s.min_volume_24h ?? '—'} rug≤{s.max_rug_ratio ?? '—'}
                    </ThemedText>
                  </View>
                  <Switch
                    value={!!s.enabled}
                    onValueChange={(v) => setSubscriptionEnabled(s.id, v).then(loadAll)}
                    trackColor={{ true: theme.accent }}
                  />
                  <Pressable
                    onPress={() => deleteSubscription(s.id).then(loadAll)}
                    hitSlop={8}>
                    <ThemedText type="smallBold" style={{ color: theme.negative }}>Eliminar</ThemedText>
                  </Pressable>
                </View>
              ))}
            </Card>
          )}
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
  pctRow: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  pctBtn: { flex: 1, minWidth: 90, paddingVertical: 8, borderRadius: 8, alignItems: 'center', borderWidth: 1 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  proxyBlock: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, marginTop: 4 },
  proxyHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  proxyDot: { width: 8, height: 8, borderRadius: 4 },
  proxyBtnRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  proxyBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1 },
});