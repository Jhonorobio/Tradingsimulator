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
import { getWallet } from '@/api/trading';
import { getGmgnStatus } from '@/api/market';
import { shortAddress } from '@/utils/format';
import type { Wallet } from '@/api/types';

export default function ServerScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { serverUrl, setUrl, deviceId } = useSettings();

  const [urlInput, setUrlInput] = useState(serverUrl);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [gmgnOk, setGmgnOk] = useState<boolean | null>(null);

  useEffect(() => {
    setUrlInput(serverUrl);
  }, [serverUrl]);

  const loadAll = useCallback(async () => {
    try {
      const [w, status] = await Promise.all([
        getWallet(),
        getGmgnStatus().catch(() => ({ ok: false })),
      ]);
      setWallet(w.wallet);
      setGmgnOk(status.ok);
    } catch {}
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const saveUrl = async () => {
    await setUrl(urlInput);
    Alert.alert('Guardado', `Servidor: ${urlInput.replace(/\/+$/, '')}`);
    loadAll();
  };

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={theme.text} />
          </Pressable>
          <ThemedText type="smallBold" style={{ color: theme.text }}>Servidor</ThemedText>
        </View>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Card>
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
});
