import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { clearHistory, clearWinners } from '@/api/notifications';

const SECTIONS = [
  { key: 'server', label: 'Servidor', icon: 'server-outline' as const },
  { key: 'proxies', label: 'Proxies GMGN', icon: 'globe-outline' as const },
  { key: 'budget', label: 'Presupuesto', icon: 'wallet-outline' as const },
  { key: 'notifications', label: 'Notificaciones', icon: 'notifications-outline' as const },
  { key: 'colors', label: 'Colores de métricas', icon: 'color-palette-outline' as const },
] as const;

const CLEAR_OPTIONS = [
  { key: 'sol', label: 'Historial SOL', chain: 'sol' },
  { key: 'all_history', label: 'Borrar todo el historial', chain: undefined },
  { key: 'winners', label: 'Borrar Winners', chain: undefined },
] as const;

export default function SettingsIndex() {
  const theme = useTheme();
  const router = useRouter();
  const [clearing, setClearing] = useState<string | null>(null);

  const handleClear = async (key: string, chain?: string) => {
    const label = CLEAR_OPTIONS.find((o) => o.key === key)?.label ?? key;
    Alert.alert(
      'Confirmar',
      `¿Borrar ${label}?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Borrar',
          style: 'destructive',
          onPress: async () => {
            setClearing(key);
            try {
              if (key === 'winners') {
                const res = await clearWinners();
                Alert.alert('Listo', `Borrados ${res.removed} winners`);
              } else {
                const res = await clearHistory(chain);
                Alert.alert('Listo', `Borrados ${res.removed} tokens`);
              }
            } catch (err: any) {
              Alert.alert('Error', err?.message ?? 'No se pudo borrar');
            } finally {
              setClearing(null);
            }
          },
        },
      ],
    );
  };

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <ThemedText type="subtitle">Settings</ThemedText>
          <Card style={styles.menuCard}>
            {SECTIONS.map((s, i) => (
              <Pressable
                key={s.key}
                onPress={() => router.push(`/(tabs)/settings/${s.key}`)}
                style={[styles.menuRow, i < SECTIONS.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }]}>
                <Ionicons name={s.icon} size={20} color={theme.textSecondary} />
                <ThemedText type="smallBold" style={{ color: theme.text, flex: 1 }}>{s.label}</ThemedText>
                <Ionicons name="chevron-forward" size={16} color={theme.textSecondary} />
              </Pressable>
            ))}
          </Card>

          <ThemedText type="smallBold" style={{ color: theme.textSecondary, marginTop: 8 }}>Datos</ThemedText>
          <Card style={styles.menuCard}>
            {CLEAR_OPTIONS.map((opt, i) => (
              <Pressable
                key={opt.key}
                onPress={() => handleClear(opt.key, opt.chain)}
                disabled={clearing !== null}
                style={[styles.menuRow, i < CLEAR_OPTIONS.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }]}>
                <Ionicons name="trash-outline" size={18} color={theme.negative} />
                <ThemedText type="smallBold" style={{ color: theme.negative, flex: 1 }}>
                  {clearing === opt.key ? 'Borrando…' : opt.label}
                </ThemedText>
              </Pressable>
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
  menuCard: { padding: 0 },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
});
