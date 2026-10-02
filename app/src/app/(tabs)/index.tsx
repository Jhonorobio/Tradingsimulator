import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { TrackingPanel } from '@/components/tracking-panel';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/store/settings';

export default function DashboardScreen() {
  const theme = useTheme();
  const { proxyStatuses, loadProxyStatuses } = useSettings();

  useEffect(() => {
    loadProxyStatuses();
  }, [loadProxyStatuses]);

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
        </View>

        <TrackingPanel />
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 12, gap: 12, paddingBottom: 4 },
});
