import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import {
  batchTestProxiesStream,
  tcpTestProxies,
  latencyTestProxies,
  type BatchTestResult,
  type TcpTestResult,
  type LatencyTestResult,
} from '@/api/market';

const PROXY_TESTER_KEY = 'trading-sim/proxy-tester-apikey';

type TestResult = BatchTestResult | TcpTestResult | LatencyTestResult;

export default function ProxyTesterScreen() {
  const theme = useTheme();
  const [proxyList, setProxyList] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<TestResult[]>([]);
  const [testMode, setTestMode] = useState<'tcp' | 'gmgn' | 'latency'>('tcp');
  const resultsRef = useRef<TestResult[]>([]);

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

  const runGmgnTest = useCallback(async () => {
    const proxies = parseProxies();
    if (!proxies.length || !apiKey.trim()) return;
    setTestMode('gmgn');
    setTesting(true);
    setResults([]);
    resultsRef.current = [];
    try {
      await batchTestProxiesStream(proxies, apiKey.trim(), (result) => {
        resultsRef.current = [...resultsRef.current, result];
        setResults([...resultsRef.current]);
      });
    } catch {} finally { setTesting(false); }
  }, [parseProxies, apiKey]);

  const runLatencyTest = useCallback(async () => {
    const proxies = parseProxies();
    if (!proxies.length) return;
    setTestMode('latency');
    setTesting(true);
    setResults([]);
    try {
      const res = await latencyTestProxies(proxies);
      setResults(res.results);
    } catch {} finally { setTesting(false); }
  }, [parseProxies]);

  const runTcpTest = useCallback(async () => {
    const proxies = parseProxies();
    if (!proxies.length) return;
    setTestMode('tcp');
    setTesting(true);
    setResults([]);
    try {
      const res = await tcpTestProxies(proxies);
      setResults(res.results);
    } catch {} finally { setTesting(false); }
  }, [parseProxies]);

  const proxyCount = parseProxies().length;
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;

  const testLabel = testMode === 'tcp' ? 'conexión' : testMode === 'latency' ? 'latencia' : 'API';

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
                TCP = rápido, solo verifica conexión. Latencia = mide tiempo a gmgn.ai (sin key). GMGN = test completo con API key.
              </ThemedText>

              <Card>
                <ThemedText type="smallBold">API Key GMGN (solo para test GMGN)</ThemedText>
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

              {/* Three test buttons */}
              <View style={styles.btnRow}>
                <Pressable
                  onPress={runTcpTest}
                  disabled={testing || !proxyCount}
                  style={[styles.btn, { backgroundColor: testing && testMode === 'tcp' ? theme.backgroundSelected : theme.accent, flex: 1 }]}>
                  {testing && testMode === 'tcp' ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>TCP</ThemedText>
                  )}
                </Pressable>
                <Pressable
                  onPress={runLatencyTest}
                  disabled={testing || !proxyCount}
                  style={[styles.btn, { backgroundColor: testing && testMode === 'latency' ? theme.backgroundSelected : '#e67e22', flex: 1 }]}>
                  {testing && testMode === 'latency' ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>Latencia GMGN</ThemedText>
                  )}
                </Pressable>
                <Pressable
                  onPress={runGmgnTest}
                  disabled={testing || !proxyCount || !apiKey.trim()}
                  style={[styles.btn, { backgroundColor: testing && testMode === 'gmgn' ? theme.backgroundSelected : '#8e44ad', flex: 1 }]}>
                  {testing && testMode === 'gmgn' ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <ThemedText type="smallBold" style={{ color: '#fff', textAlign: 'center' }}>GMGN Full</ThemedText>
                  )}
                </Pressable>
              </View>

              {testing && (
                <ThemedText type="small" style={{ color: theme.textSecondary, textAlign: 'center' }}>
                  {testMode === 'tcp'
                    ? 'Verificando conectividad...'
                    : `Probando ${testLabel}... ${results.length}/${proxyCount}`}
                </ThemedText>
              )}

              {results.length > 0 && !testing && (
                <Card>
                  <View style={styles.summaryRow}>
                    <ThemedText type="smallBold" style={{ color: theme.positive }}>
                      ✓ {okCount} {testMode === 'tcp' ? 'abiertos' : 'respondieron'}
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
              {'httpStatus' in r && r.ok && (
                <ThemedText type="small" style={{ color: theme.textSecondary, marginLeft: 24 }}>
                  HTTP {(r as LatencyTestResult).httpStatus}
                </ThemedText>
              )}
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
  btnRow: { flexDirection: 'row', gap: 6 },
  btn: { paddingVertical: 12, borderRadius: 10 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between' },
  resultRow: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, paddingBottom: 4 },
  resultHeader: { flexDirection: 'row', alignItems: 'center' },
});
