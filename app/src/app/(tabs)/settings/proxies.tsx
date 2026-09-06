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
import { getProxies, saveProxy, testProxy } from '@/api/market';
import { ApiError } from '@/api/client';
import type { ProxyConfig, ProxyTestResult } from '@/api/types';

const TAB_LABELS: Record<string, string> = {
  new_creation: 'Nueva creación (SOL)',
  completed: 'Completado (SOL)',
  new_creation_robinhood: 'Nueva creación (Robinhood)',
  completed_robinhood: 'Completado (Robinhood)',
  new_creation_bsc: 'Nueva creación (BSC)',
  completed_bsc: 'Completado (BSC)',
  token_info: 'Token Info (Detalle)',
};
const TAB_ORDER = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood', 'new_creation_bsc', 'completed_bsc', 'token_info'];

export default function ProxiesScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { proxyStatuses, loadProxyStatuses } = useSettings();

  const [proxyConfigs, setProxyConfigs] = useState<Record<string, ProxyConfig>>({
    new_creation: { url: '', apiKey: '' },
    completed: { url: '', apiKey: '' },
    new_creation_robinhood: { url: '', apiKey: '' },
    completed_robinhood: { url: '', apiKey: '' },
    new_creation_bsc: { url: '', apiKey: '' },
    completed_bsc: { url: '', apiKey: '' },
    token_info: { url: '', apiKey: '' },
  });
  const [proxyTesting, setProxyTesting] = useState<Record<string, boolean>>({});
  const [proxyTestResults, setProxyTestResults] = useState<Record<string, ProxyTestResult | null>>({});

  const loadAll = useCallback(async () => {
    try {
      const proxies = await getProxies().catch(() => null);
      if (proxies) setProxyConfigs(proxies);
    } catch {}
    loadProxyStatuses();
  }, [loadProxyStatuses]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

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
      const { proxyStatuses: current } = useSettings.getState();
      const next = current.filter((s) => s.tab !== tab);
      next.push({ tab, url: cfg.url, egressIp: null, working: true, lastCheck: new Date().toISOString(), error: null });
      useSettings.setState({ proxyStatuses: next });
      Alert.alert('Guardado', `Proxy de ${TAB_LABELS[tab]} guardado`);
      loadProxyStatuses();
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'No se pudo guardar');
    }
  };

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={theme.text} />
          </Pressable>
          <ThemedText type="smallBold" style={{ color: theme.text }}>Proxies GMGN</ThemedText>
        </View>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Card>
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
  proxyBlock: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, marginTop: 4 },
  proxyHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  proxyDot: { width: 8, height: 8, borderRadius: 4 },
  proxyBtnRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  proxyBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center', borderWidth: 1 },
});
