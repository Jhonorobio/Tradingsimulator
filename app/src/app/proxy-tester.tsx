import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { batchTestProxies, type BatchTestResult } from '@/api/market';

const PROXY_TESTER_KEY = 'trading-sim/proxy-tester-apikey';

export default function ProxyTesterScreen() {
  const theme = useTheme();
  const [proxyList, setProxyList] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [results, setResults] = useState<BatchTestResult[]>([]);

  // Load saved API key on mount
  useEffect(() => {
    AsyncStorage.getItem(PROXY_TESTER_KEY).then((saved) => {
      if (saved) setApiKey(saved);
    });
  }, []);

  // Save API key when it changes
  const updateApiKey = useCallback((val: string) => {
    setApiKey(val);
    AsyncStorage.setItem(PROXY_TESTER_KEY, val);
  }, []);

  const parseProxies = useCallback(() => {
    return proxyList
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  }, [proxyList]);

  const runTest = useCallback(async () => {
    const proxies = parseProxies();
    if (!proxies.length) return;
    if (!apiKey.trim()) return;

    setTesting(true);
    setResults([]);
    setProgress({ current: 0, total: proxies.length });

    try {
      const res = await batchTestProxies(proxies, apiKey.trim());
      setResults(res.results);
    } catch {
      // error handled by display
    } finally {
      setTesting(false);
    }
  }, [parseProxies, apiKey]);

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top', 'bottom']} style={styles.safe}>
        <FlatList
          data={results}
          keyExtractor={(_, i) => String(i)}
          contentContainerStyle={styles.scroll}
          ListHeaderComponent={
            <>
              <ThemedText type="subtitle">Proxy Tester</ThemedText>
              <ThemedText type="small" style={{ color: theme.textSecondary, marginBottom: 12 }}>
                Pega una lista de proxies (uno por línea) y haz test contra GMGN.
              </ThemedText>

              <Card>
                <ThemedText type="smallBold">API Key GMGN</ThemedText>
                <TextInput
                  value={apiKey}
                  onChangeText={updateApiKey}
                  placeholder="gmgn_xxx"
                  placeholderTextColor={theme.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]}
                />
              </Card>

              <Card>
                <ThemedText type="smallBold">Lista de Proxies</ThemedText>
                <ThemedText type="small" style={{ color: theme.textSecondary, marginBottom: 6 }}>
                  Formato: host:port (http) o socks5://host:port
                </ThemedText>
                <TextInput
                  value={proxyList}
                  onChangeText={setProxyList}
                  placeholder={"185.200.188.234:10001\n85.198.82.207:1080\n93.93.207.219:8088"}
                  placeholderTextColor={theme.textSecondary}
                  multiline
                  numberOfLines={8}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[styles.textarea, { backgroundColor: theme.backgroundSelected, color: theme.text, borderColor: theme.border }]}
                />
                <ThemedText type="small" style={{ color: theme.textSecondary }}>
                  {parseProxies().length} proxies detectados
                </ThemedText>
              </Card>

              <Pressable
                onPress={runTest}
                disabled={testing || !apiKey.trim() || !parseProxies().length}
                style={[styles.btn, { backgroundColor: testing ? theme.backgroundSelected : theme.accent }]}>
                {testing ? (
                  <View style={styles.btnRow}>
                    <ActivityIndicator size="small" color={theme.text} />
                    <ThemedText type="smallBold" style={{ color: theme.text, marginLeft: 8 }}>
                      Probando {progress.current}/{progress.total}...
                    </ThemedText>
                  </View>
                ) : (
                  <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>
                    Probar {parseProxies().length} Proxies
                  </ThemedText>
                )}
              </Pressable>

              {results.length > 0 && (
                <Card>
                  <View style={styles.summaryRow}>
                    <ThemedText type="smallBold" style={{ color: theme.positive }}>
                      ✓ {okCount} funcionales
                    </ThemedText>
                    <ThemedText type="smallBold" style={{ color: theme.negative }}>
                      ✗ {failCount} fallidos
                    </ThemedText>
                  </View>
                </Card>
              )}
            </>
          }
          renderItem={({ item: r }) => (
            <View style={[styles.resultRow, { borderColor: theme.border }]}>
              <View style={styles.resultHeader}>
                <Ionicons
                  name={r.ok ? 'checkmark-circle' : 'close-circle'}
                  size={18}
                  color={r.ok ? theme.positive : theme.negative}
                />
                <ThemedText type="small" style={{ flex: 1, marginLeft: 6 }} numberOfLines={1}>
                  {r.proxy}
                </ThemedText>
                {r.ok && (
                  <ThemedText type="small" style={{ color: theme.positive, marginLeft: 4 }}>
                    {r.latencyMs}ms
                  </ThemedText>
                )}
              </View>
              {r.ok && r.egressIp && (
                <ThemedText type="small" style={{ color: theme.textSecondary, marginLeft: 24 }}>
                  IP: {r.egressIp}
                </ThemedText>
              )}
              {!r.ok && r.error && (
                <ThemedText type="small" style={{ color: theme.negative, marginLeft: 24 }}>
                  {r.error}
                </ThemedText>
              )}
            </View>
          )}
          ListEmptyComponent={
            testing ? null : (
              <ThemedText type="small" style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 20 }}>
                Los resultados aparecerán aquí
              </ThemedText>
            )
          }
        />
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
  textarea: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    fontSize: 13,
    fontFamily: 'monospace',
    marginTop: 6,
    minHeight: 120,
    textAlignVertical: 'top',
  },
  btn: { marginTop: 4, paddingVertical: 12, borderRadius: 10 },
  btnRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between' },
  resultRow: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, paddingBottom: 4 },
  resultHeader: { flexDirection: 'row', alignItems: 'center' },
});
