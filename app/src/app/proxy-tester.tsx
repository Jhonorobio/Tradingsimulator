import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { batchTestProxies, tcpTestProxies, type BatchTestResult, type TcpTestResult } from '@/api/market';

const PROXY_TESTER_KEY = 'trading-sim/proxy-tester-apikey';

type TestResult = BatchTestResult | TcpTestResult;

export default function ProxyTesterScreen() {
  const theme = useTheme();
  const [proxyList, setProxyList] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<TestResult[]>([]);
  const [testMode, setTestMode] = useState<'tcp' | 'gmgn'>('tcp');

  useEffect(() => {
    AsyncStorage.getItem(PROXY_TESTER_KEY).then((saved) => {
      if (saved) setApiKey(saved);
    });
  }, []);

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

  const runTest = useCallback(async (mode: 'tcp' | 'gmgn') => {
    const proxies = parseProxies();
    if (!proxies.length) return;
    if (mode === 'gmgn' && !apiKey.trim()) return;

    setTestMode(mode);
    setTesting(true);
    setResults([]);

    try {
      if (mode === 'tcp') {
        const res = await tcpTestProxies(proxies);
        setResults(res.results);
      } else {
        const res = await batchTestProxies(proxies, apiKey.trim());
        setResults(res.results);
      }
    } catch {
      // error handled by display
    } finally {
      setTesting(false);
    }
  }, [parseProxies, apiKey]);

  const proxyCount = parseProxies().length;
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
                Pega proxies y elige el tipo de test.
              </ThemedText>

              <Card>
                <ThemedText type="smallBold">API Key GMGN (para test GMGN)</ThemedText>
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
                  {proxyCount} proxies detectados
                </ThemedText>
              </Card>

              {/* Two test buttons */}
              <View style={styles.btnRow}>
                <Pressable
                  onPress={() => runTest('tcp')}
                  disabled={testing || !proxyCount}
                  style={[styles.btn, { backgroundColor: testing && testMode === 'tcp' ? theme.backgroundSelected : theme.accent, flex: 1 }]}>
                  {testing && testMode === 'tcp' ? (
                    <View style={styles.btnInner}>
                      <ActivityIndicator size="small" color="#fff" />
                    </View>
                  ) : (
                    <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>
                      TCP Rápido
                    </ThemedText>
                  )}
                </Pressable>
                <Pressable
                  onPress={() => runTest('gmgn')}
                  disabled={testing || !proxyCount || !apiKey.trim()}
                  style={[styles.btn, { backgroundColor: testing && testMode === 'gmgn' ? theme.backgroundSelected : theme.accent, flex: 1 }]}>
                  {testing && testMode === 'gmgn' ? (
                    <View style={styles.btnInner}>
                      <ActivityIndicator size="small" color="#fff" />
                    </View>
                  ) : (
                    <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>
                      GMGN Full
                    </ThemedText>
                  )}
                </Pressable>
              </View>

              {testing && (
                <ThemedText type="small" style={{ color: theme.textSecondary, textAlign: 'center' }}>
                  {testMode === 'tcp' ? 'Verificando conectividad...' : `Probando GMGN 1 req/s...`}
                </ThemedText>
              )}

              {results.length > 0 && !testing && (
                <Card>
                  <View style={styles.summaryRow}>
                    <ThemedText type="smallBold" style={{ color: theme.positive }}>
                      ✓ {okCount} {testMode === 'tcp' ? 'abiertos' : 'funcionales'}
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
              {'egressIp' in r && r.ok && (r as BatchTestResult).egressIp && (
                <ThemedText type="small" style={{ color: theme.textSecondary, marginLeft: 24 }}>
                  IP: {(r as BatchTestResult).egressIp}
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
  btnRow: { flexDirection: 'row', gap: 8 },
  btn: { paddingVertical: 12, borderRadius: 10 },
  btnInner: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between' },
  resultRow: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, paddingBottom: 4 },
  resultHeader: { flexDirection: 'row', alignItems: 'center' },
});
