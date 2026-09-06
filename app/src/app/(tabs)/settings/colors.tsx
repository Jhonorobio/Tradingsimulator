import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { useSettings, COLOR_OPTIONS } from '@/store/settings';
import type { MetricKey } from '@/store/settings';
import { METRIC_LABELS, DEFAULT_RANGES } from '@/store/settings';

export default function ColorsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { colorRanges, setColorRange, addColorRange, removeColorRange } = useSettings();
  const [colorPickerTarget, setColorPickerTarget] = useState<{ metric: MetricKey; index: number } | null>(null);

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
          <Card>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Define rangos de valores y sus colores para cada métrica.
            </ThemedText>
            {(Object.keys(METRIC_LABELS) as MetricKey[]).map((metric) => {
              const ranges = colorRanges[metric] || DEFAULT_RANGES[metric];
              return (
                <View key={metric} style={[styles.rangeSection, { borderColor: theme.border }]}>
                  <ThemedText type="smallBold" style={{ color: theme.text }}>{METRIC_LABELS[metric].unit}</ThemedText>
                  {ranges.map((r, i) => (
                    <View key={i} style={[styles.rangeRow, { backgroundColor: theme.background }]}>
                      <Pressable
                        onPress={() => setColorPickerTarget({ metric, index: i })}
                        style={[styles.colorCircleSmall, { backgroundColor: r.color }]}
                      />
                      <TextInput
                        style={[styles.rangeInput, { color: theme.text, borderColor: theme.border }]}
                        keyboardType="numeric"
                        placeholder="Max"
                        placeholderTextColor={theme.textSecondary}
                        value={r.max != null ? String(r.max) : ''}
                        onChangeText={(t) => {
                          const num = t === '' ? null : Number(t);
                          setColorRange(metric, i, 'max', num);
                        }}
                      />
                      <ThemedText type="small" style={{ color: theme.textSecondary }}>
                        {ranges[i + 1] ? ` → ` : ` → ∞`}
                      </ThemedText>
                      <Pressable
                        onPress={() => removeColorRange(metric, i)}
                        style={styles.rangeRemove}
                      >
                        <Ionicons name="close-circle" size={18} color={theme.negative} />
                      </Pressable>
                    </View>
                  ))}
                  <Pressable
                    onPress={() => addColorRange(metric)}
                    style={[styles.rangeAddBtn, { borderColor: theme.border }]}
                  >
                    <Ionicons name="add" size={16} color={theme.text} />
                    <ThemedText type="small" style={{ color: theme.text }}>Agregar rango</ThemedText>
                  </Pressable>
                </View>
              );
            })}
          </Card>
        </ScrollView>
      </SafeAreaView>

      <Modal visible={colorPickerTarget !== null} transparent animationType="fade">
        <Pressable style={styles.modalOverlay} onPress={() => setColorPickerTarget(null)}>
          <Pressable style={[styles.modalContent, { backgroundColor: theme.background }]} onPress={() => {}}>
            <ThemedText type="smallBold" style={{ color: theme.text }}>Seleccionar color</ThemedText>
            <View style={styles.colorGrid}>
              {COLOR_OPTIONS.map((opt) => {
                const current = colorPickerTarget
                  ? (colorRanges[colorPickerTarget.metric]?.[colorPickerTarget.index]?.color ?? '#ffffff')
                  : '#ffffff';
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => {
                      if (colorPickerTarget) {
                        setColorRange(colorPickerTarget.metric, colorPickerTarget.index, 'color', opt.value);
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
  scroll: { padding: 16, gap: 12, paddingBottom: 40 },
  rangeSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
    marginTop: 4,
    gap: 6,
  },
  rangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 6,
    borderRadius: 8,
  },
  colorCircleSmall: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  rangeInput: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 13,
    width: 70,
    textAlign: 'center',
  },
  rangeRemove: {
    padding: 2,
    marginLeft: 'auto',
  },
  rangeAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 8,
    paddingVertical: 8,
    marginTop: 4,
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
