import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TokenRow } from '@/components/token-row';
import { useTheme } from '@/hooks/use-theme';
import { getTrenches, getSavedTrenchesFilters, saveTrenchesFilters, type TrenchesParams } from '@/api/market';
import { ApiError } from '@/api/client';
import type { TrenchesItem } from '@/api/types';

type TabKey = 'new_creation' | 'near_completion' | 'completed';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'new_creation', label: 'Nueva' },
  { key: 'near_completion', label: 'Completando' },
  { key: 'completed', label: 'Completado' },
];

type RangeValues = { min: string; max: string };
type Filters = Record<string, RangeValues>;

type FieldScale = 'none' | 'percent' | 'thousand' | 'minute';
interface FilterField {
  key: string;
  label: string;
  unit: string;
  scale: FieldScale;
}

const FILTER_FIELDS: FilterField[] = [
  { key: 'progress', label: 'Progreso', unit: '%', scale: 'percent' },
  { key: 'created', label: 'Fecha de creación', unit: 'm', scale: 'minute' },
  { key: 'liquidity', label: 'Pool de liquidez', unit: 'K', scale: 'thousand' },
  { key: 'marketcap', label: 'Capitalización de Mercado ($)', unit: 'K', scale: 'thousand' },
  { key: 'topHolderRate', label: 'Participación de los 10 mayores tenedores', unit: '%', scale: 'percent' },
  { key: 'creatorBalanceRate', label: 'Porcentaje en manos de los desarrolladores', unit: '%', scale: 'percent' },
  { key: 'totalFee', label: 'Comisiones totales', unit: 'SOL', scale: 'none' },
  { key: 'bundlerRate', label: 'Bundler', unit: '%', scale: 'percent' },
  { key: 'rugRatio', label: 'Rug ratio', unit: '%', scale: 'percent' },
  { key: 'insiderRatio', label: 'Insider', unit: '%', scale: 'percent' },
  { key: 'entrapmentRatio', label: 'Entrapment', unit: '%', scale: 'percent' },
  { key: 'privateVaultHoldRate', label: 'Private vault', unit: '%', scale: 'percent' },
  { key: 'top70SniperHoldRate', label: 'Top70 sniper', unit: '%', scale: 'percent' },
  { key: 'botDegenRate', label: 'Bot degen', unit: '%', scale: 'percent' },
  { key: 'freshWalletRate', label: 'Fresh wallet', unit: '%', scale: 'percent' },
  { key: 'creatorCreatedOpenRatio', label: 'Ratio de graduación del creador', unit: '%', scale: 'percent' },
  { key: 'volume24h', label: 'Volumen 24h', unit: '$', scale: 'none' },
  { key: 'netBuy24h', label: 'Compras netas 24h', unit: '$', scale: 'none' },
  { key: 'swaps24h', label: 'Swaps 24h', unit: '', scale: 'none' },
  { key: 'buys24h', label: 'Compras 24h', unit: '', scale: 'none' },
  { key: 'sells24h', label: 'Ventas 24h', unit: '', scale: 'none' },
  { key: 'visitingCount', label: 'Visitantes', unit: '', scale: 'none' },
  { key: 'holderCount', label: 'Tenedores', unit: '', scale: 'none' },
  { key: 'botCount', label: 'Bots', unit: '', scale: 'none' },
  { key: 'smartDegen', label: 'Smart degen', unit: '', scale: 'none' },
  { key: 'renowned', label: 'Renombrados', unit: '', scale: 'none' },
  { key: 'creatorCreatedCount', label: 'Creador · tokens creados', unit: '', scale: 'none' },
  { key: 'creatorCreatedOpenCount', label: 'Creador · tokens graduados', unit: '', scale: 'none' },
  { key: 'xFollowers', label: 'Seguidores X', unit: '', scale: 'none' },
  { key: 'twitterRenameCount', label: 'Renombres Twitter', unit: '', scale: 'none' },
  { key: 'tgCallCount', label: 'Llamadas Telegram', unit: '', scale: 'none' },
];

function emptyFilters(): Filters {
  const o: Filters = {};
  for (const f of FILTER_FIELDS) o[f.key] = { min: '', max: '' };
  return o;
}

function normalizeFilters(raw: unknown): Record<TabKey, Filters> {
  const fallback: Record<TabKey, Filters> = {
    new_creation: emptyFilters(),
    near_completion: emptyFilters(),
    completed: emptyFilters(),
  };
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  for (const tab of TABS) {
    const tabRaw = obj[tab.key];
    if (!tabRaw || typeof tabRaw !== 'object') continue;
    for (const f of FILTER_FIELDS) {
      const v = (tabRaw as Record<string, unknown>)[f.key];
      if (v && typeof v === 'object') {
        const rv = v as { min?: unknown; max?: unknown };
        fallback[tab.key][f.key] = {
          min: typeof rv.min === 'string' ? rv.min : '',
          max: typeof rv.max === 'string' ? rv.max : '',
        };
      }
    }
  }
  return fallback;
}

function capFirst(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parseParam(raw: string | undefined, f: FilterField): number | string | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (isNaN(n)) return undefined;
  switch (f.scale) {
    case 'percent':
      return n / 100;
    case 'thousand':
      return n * 1000;
    case 'minute':
      return `${n}m`;
    default:
      return n;
  }
}

function RangeField({
  field,
  values,
  onChange,
}: {
  field: FilterField;
  values: RangeValues;
  onChange: (side: 'min' | 'max', value: string) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.fieldRow}>
      <ThemedText type="small" style={[styles.fieldLabel, { color: theme.textSecondary }]}>
        {field.label}
      </ThemedText>
      <View style={styles.fieldInputs}>
        <View style={styles.inputGroup}>
          <TextInput
            value={values.min}
            onChangeText={(v) => onChange('min', v)}
            placeholder="mín"
            placeholderTextColor={theme.textSecondary}
            keyboardType="numeric"
            style={[styles.fieldInput, { color: theme.text }]}
          />
          <ThemedText style={[styles.inputUnit, { color: theme.textSecondary }]}>
            {field.unit}
          </ThemedText>
        </View>
        <ThemedText style={[styles.rangeSep, { color: theme.textSecondary }]}>—</ThemedText>
        <View style={styles.inputGroup}>
          <TextInput
            value={values.max}
            onChangeText={(v) => onChange('max', v)}
            placeholder="máx"
            placeholderTextColor={theme.textSecondary}
            keyboardType="numeric"
            style={[styles.fieldInput, { color: theme.text }]}
          />
          <ThemedText style={[styles.inputUnit, { color: theme.textSecondary }]}>
            {field.unit}
          </ThemedText>
        </View>
      </View>
    </View>
  );
}

export default function TrenchesScreen() {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<TabKey>('new_creation');

  const [filters, setFilters] = useState<Record<TabKey, Filters>>({
    new_creation: emptyFilters(),
    near_completion: emptyFilters(),
    completed: emptyFilters(),
  });
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [draft, setDraft] = useState<Filters>(emptyFilters());

  const [data, setData] = useState<Record<TabKey, TrenchesItem[]>>({
    new_creation: [],
    near_completion: [],
    completed: [],
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openFilters = useCallback(() => {
    setDraft(filters[activeTab]);
    setFiltersVisible(true);
  }, [filters, activeTab]);

  const closeFilters = useCallback(() => setFiltersVisible(false), []);

  const resetDraft = useCallback(() => setDraft(emptyFilters()), []);

  const confirmFilters = useCallback(() => {
    setFilters((prev) => {
      const next = { ...prev, [activeTab]: draft };
      saveTrenchesFilters(next).catch(() => {});
      return next;
    });
    setFiltersVisible(false);
  }, [activeTab, draft]);

  useEffect(() => {
    let cancelled = false;
    getSavedTrenchesFilters()
      .then((res) => {
        if (cancelled || !res.filters) return;
        setFilters(normalizeFilters(res.filters));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setDraftValue = useCallback((key: string, side: 'min' | 'max', value: string) => {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], [side]: value } }));
  }, []);

  const buildParams = useCallback(
    (tab: TabKey): TrenchesParams => {
      const p: Record<string, unknown> = { chain: 'sol', limit: 50, types: [tab] };
      const vals = filters[tab];
      for (const f of FILTER_FIELDS) {
        const v = vals?.[f.key];
        const minV = parseParam(v?.min, f);
        const maxV = parseParam(v?.max, f);
        if (minV !== undefined) p[`min${capFirst(f.key)}`] = minV;
        if (maxV !== undefined) p[`max${capFirst(f.key)}`] = maxV;
      }
      return p as unknown as TrenchesParams;
    },
    [filters],
  );

  const pollingRef = useRef(false);

  const fetchTab = useCallback(
    async (tab: TabKey, opts: { silent?: boolean } = {}) => {
      const { silent = false } = opts;
      if (!silent) setLoading(true);
      try {
        const result = await getTrenches(buildParams(tab));
        setData((prev) => ({ ...prev, [tab]: result[tab] ?? [] }));
        setError(null);
      } catch (err) {
        if (!silent) setError(err instanceof ApiError ? err.message : 'Error al cargar Trenches');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [buildParams],
  );

  const initialLoad = useCallback(async () => {
    for (const tab of TABS) {
      await fetchTab(tab.key);
    }
  }, [fetchTab]);

  const loadCycleIndex = useRef(0);

  const pollNext = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    try {
      const tab = TABS[loadCycleIndex.current % TABS.length].key;
      loadCycleIndex.current += 1;
      await fetchTab(tab, { silent: true });
    } finally {
      pollingRef.current = false;
    }
  }, [fetchTab]);

  useEffect(() => {
    initialLoad();
  }, [initialLoad]);

  useEffect(() => {
    const id = setInterval(pollNext, 1000);
    return () => clearInterval(id);
  }, [pollNext]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await initialLoad();
    setRefreshing(false);
  }, [initialLoad]);

  const activeTokens = data[activeTab] ?? [];

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        {/* Tabs (top) */}
        <View style={styles.tabBar}>
          {TABS.map((tab) => (
            <Pressable
              key={tab.key}
              onPress={() => setActiveTab(tab.key)}
              style={styles.tab}>
              <ThemedText
                type="smallBold"
                style={[
                  styles.tabLabel,
                  { color: activeTab === tab.key ? theme.text : theme.textSecondary },
                ]}>
                {tab.label}
              </ThemedText>
              {activeTab === tab.key && (
                <View style={[styles.tabUnderline, { backgroundColor: theme.text }]} />
              )}
            </Pressable>
          ))}
        </View>

        {/* Action bar: pause · % · funnel */}
        <View style={styles.actionBar}>
          <View style={styles.actionsRight}>
            <Pressable style={styles.iconBtn}>
              <Ionicons name="pause" size={20} color={theme.textSecondary} />
            </Pressable>
            <View style={styles.sortBtn}>
              <ThemedText style={{ color: theme.textSecondary, fontSize: 13, fontWeight: '700' }}>%</ThemedText>
              <Ionicons name="chevron-down" size={12} color={theme.textSecondary} />
            </View>
            <Pressable
              onPress={openFilters}
              style={[styles.filterBtn, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
              <Ionicons name="funnel" size={17} color={theme.textSecondary} />
            </Pressable>
          </View>
        </View>

        {error ? (
          <ThemedText type="small" style={{ color: theme.negative, paddingHorizontal: 16, paddingTop: 8 }}>
            {error}
          </ThemedText>
        ) : null}

        <FlatList
          data={activeTokens}
          keyExtractor={(item, i) => `t-${item.address}-${i}`}
          renderItem={({ item }) => <TokenRow token={item} chain="sol" />}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing || loading}
              onRefresh={onRefresh}
              tintColor={theme.textSecondary}
            />
          }
          ListHeaderComponent={loading ? (
            <View style={styles.skelCard}>
              <View style={[styles.skelBar, { width: '45%' }]} />
              <View style={{ marginTop: 6 }}>
                <View style={[styles.skelBar, { width: '70%' }]} />
                <View style={[styles.skelBar, { width: '30%', marginTop: 6 }]} />
              </View>
            </View>
          ) : null}
          ListEmptyComponent={
            !loading && !error ? (
              <View style={styles.emptyCard}>
                <ThemedText type="small" style={{ color: theme.textSecondary }}>
                  Sin resultados con estos filtros.
                </ThemedText>
              </View>
            ) : null
          }
        />

        <View style={styles.footer}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            Fin de la Página
          </ThemedText>
        </View>
      </SafeAreaView>

      {/* Bottom Sheet Modal */}
      <Modal
        visible={filtersVisible}
        transparent
        animationType="slide"
        onRequestClose={closeFilters}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.backdropTouch} onPress={closeFilters} />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.sheet}>
            <View style={styles.sheetHandle} />

            {/* Header */}
            <View style={styles.sheetHeader}>
              <ThemedText type="smallBold" style={styles.sheetTitle}>
                Configuración de pantalla
              </ThemedText>
              <Pressable onPress={resetDraft} hitSlop={8}>
                <ThemedText type="small" style={styles.resetText}>
                  Restablecer
                </ThemedText>
              </Pressable>
            </View>

            {/* Section title */}
            <View style={styles.sectionHeader}>
              <ThemedText type="smallBold" style={styles.sectionTitle}>Filtrado</ThemedText>
              <View style={[styles.sectionIndicator, { backgroundColor: theme.text }]} />
            </View>

            {/* Form */}
            <ScrollView
              style={styles.sheetBody}
              contentContainerStyle={styles.sheetBodyContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled">
              {FILTER_FIELDS.map((f) => (
                <RangeField
                  key={f.key}
                  field={f}
                  values={draft[f.key] ?? { min: '', max: '' }}
                  onChange={(side, v) => setDraftValue(f.key, side, v)}
                />
              ))}
            </ScrollView>

            {/* Footer buttons */}
            <View style={styles.sheetFooter}>
              <Pressable onPress={closeFilters} style={styles.cancelBtn}>
                <ThemedText type="smallBold" style={{ color: '#ffffff' }}>Cancelar</ThemedText>
              </Pressable>
              <Pressable onPress={confirmFilters} style={styles.confirmBtn}>
                <ThemedText type="smallBold" style={{ color: '#000000' }}>Confirmar</ThemedText>
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0d0d' },
  safe: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    paddingTop: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
    marginHorizontal: 16,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    position: 'relative',
  },
  tabLabel: { fontSize: 14 },
  tabUnderline: {
    position: 'absolute',
    bottom: 0,
    left: '25%',
    width: '50%',
    height: 2,
    borderRadius: 1,
  },
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  iconBtn: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  actionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sortBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: '#1e1e1e',
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 32,
  },
  filterBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { padding: 10, gap: 8, paddingBottom: 40 },
  skelCard: {
    backgroundColor: '#111111',
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  skelBar: { height: 12, borderRadius: 4 },
  emptyCard: {
    backgroundColor: '#111111',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
  },
  footer: {
    alignItems: 'center',
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1e1e1e',
  },

  /* Bottom Sheet */
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000088',
    justifyContent: 'flex-end',
  },
  backdropTouch: { flex: 1 },
  sheet: {
    backgroundColor: '#121212',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    maxHeight: '88%',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#333333',
    marginTop: 10,
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  sheetTitle: { fontSize: 16, color: '#ffffff' },
  resetText: { color: '#9a9a9a', fontSize: 14 },
  sectionHeader: {
    marginTop: 4,
    marginBottom: 8,
  },
  sectionTitle: { fontSize: 16, color: '#ffffff' },
  sectionIndicator: {
    width: 28,
    height: 2,
    borderRadius: 1,
    marginTop: 6,
  },
  sheetBody: { flexGrow: 0 },
  sheetBodyContent: { paddingBottom: 8 },
  fieldRow: {
    marginBottom: 14,
  },
  fieldLabel: { fontSize: 12, marginBottom: 6 },
  fieldInputs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inputGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1c1c1e',
    borderRadius: 8,
    paddingHorizontal: 10,
    height: 40,
  },
  fieldInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  inputUnit: { fontSize: 12, marginLeft: 6 },
  rangeSep: { fontSize: 13 },
  sheetFooter: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 14,
    paddingBottom: 20,
  },
  cancelBtn: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#2c2c2e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmBtn: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});