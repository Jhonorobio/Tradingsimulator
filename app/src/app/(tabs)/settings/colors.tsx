import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';
import { useSettings, COLOR_OPTIONS } from '@/store/settings';
import type { MetricKey, ChainKey } from '@/store/settings';
import { METRIC_LABELS, DEFAULT_RANGES, CHAIN_OPTIONS } from '@/store/settings';

function formatNum(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(0)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

export default function ColorsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { colorRangesByChain, setColorRange, resetMetricRanges } = useSettings();
  const [activeChain, setActiveChain] = useState<ChainKey>('solana');
  const [colorPickerTarget, setColorPickerTarget] = useState<{ chain: ChainKey; metric: MetricKey; index: number } | null>(null);

  const currentRanges = colorRangesByChain[activeChain] || DEFAULT_RANGES;

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={theme.text} />
          </Pressable>
          <ThemedText type="smallBold" style={{ color: theme.text }}>Colores de métricas</ThemedText>
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          {/* Chain tabs */}
          <View style={[styles.chainTabs, { backgroundColor: theme.backgroundSelected }]}>
            {CHAIN_OPTIONS.map((c) => (
              <Pressable
                key={c.key}
                onPress={() => setActiveChain(c.key)}
                style={[
                  styles.chainTab,
                  activeChain === c.key && { backgroundColor: theme.accent },
                ]}>
                <ThemedText
                  type="small"
                  style={{ color: activeChain === c.key ? '#fff' : theme.textSecondary }}>
                  {c.label}
                </ThemedText>
              </Pressable>
            ))}
          </View>

          {/* Metric sections */}
          {(Object.keys(METRIC_LABELS) as MetricKey[]).map((metric) => {
            const ranges = currentRanges[metric] || DEFAULT_RANGES[metric];
            return (
              <View key={metric} style={styles.metricSection}>
                <View style={styles.metricHeader}>
                  <ThemedText type="smallBold" style={{ color: theme.text }}>
                    {METRIC_LABELS[metric].name}
                  </ThemedText>
                  <Pressable onPress={() => resetMetricRanges(activeChain, metric)} style={styles.resetBtn}>
                    <Ionicons name="refresh" size={18} color={theme.textSecondary} />
                  </Pressable>
                </View>

                {/* Chips row */}
                <View style={styles.chipsRow}>
                  {ranges.map((r, i) => {
                    const isLast = i === ranges.length - 1;
                    return (
                      <View key={i} style={[styles.chip, { backgroundColor: theme.backgroundSelected, borderColor: theme.border }]}>
                        <View style={styles.chipTop}>
                          {isLast ? (
                            <ThemedText type="smallBold" style={{ color: theme.text }}>Above</ThemedText>
                          ) : (
                            <TextInput
                              style={[styles.chipInput, { color: theme.text, borderColor: theme.border }]}
                              keyboardType="numeric"
                              placeholder="Max"
                              placeholderTextColor={theme.textSecondary}
                              value={r.max != null ? String(r.max) : ''}
                              onChangeText={(t) => {
                                const num = t === '' ? null : Number(t);
                                setColorRange(activeChain, metric, i, 'max', num);
                              }}
                            />
                          )}
                          <Pressable
                            onPress={() => setColorPickerTarget({ chain: activeChain, metric, index: i })}
                            style={[styles.chipColor, { backgroundColor: r.color }]}
                          />
                        </View>
                        <ThemedText type="small" style={{ color: theme.textSecondary, fontSize: 10 }}>
                          {isLast
                            ? `${ranges.length > 1 ? formatNum(ranges[ranges.length - 2]?.max ?? 0) : '0'}+`
                            : `${formatNum(i > 0 ? ranges[i - 1]?.max ?? 0 : 0)} - ${formatNum(r.max ?? 0)}`}
                        </ThemedText>
                      </View>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </ScrollView>
      </SafeAreaView>

      <Modal visible={colorPickerTarget !== null} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => setColorPickerTarget(null)}>
          <Pressable style={[styles.modalContent, { backgroundColor: theme.background }]} onPress={() => {}}>
            <ThemedText type="smallBold" style={{ color: theme.text }}>Seleccionar color</ThemedText>
            <View style={styles.colorGrid}>
              {COLOR_OPTIONS.map((opt) => {
                const current = colorPickerTarget
                  ? (colorRangesByChain[colorPickerTarget.chain]?.[colorPickerTarget.metric]?.[colorPickerTarget.index]?.color ?? '#ffffff')
                  : '#ffffff';
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => {
                      if (colorPickerTarget) {
                        setColorRange(colorPickerTarget.chain, colorPickerTarget.metric, colorPickerTarget.index, 'color', opt.value);
                        setColorPickerTarget(null);
                      }
                    }}
                    style={[
                      styles.colorCircle,
                      { backgroundColor: opt.value as string },
                      current === opt.value ? styles.colorSelected : undefined,
                    ]}
                  />
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
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
  scroll: { padding: 16, gap: 16, paddingBottom: 40 },
  chainTabs: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
  },
  chainTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  metricSection: {
    gap: 8,
  },
  metricHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  resetBtn: {
    padding: 4,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    minWidth: 80,
    gap: 4,
  },
  chipTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chipInput: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 13,
    width: 60,
    textAlign: 'center',
  },
  chipColor: {
    width: 16,
    height: 16,
    borderRadius: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    borderRadius: 14,
    padding: 20,
    gap: 14,
    minWidth: 200,
  },
  colorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'center',
  },
  colorCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorSelected: {
    borderColor: '#ffffff',
    transform: [{ scale: 1.15 }],
  },
});
