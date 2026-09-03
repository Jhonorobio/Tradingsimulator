import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
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
import { useSettings } from '@/store/settings';
import { useWs } from '@/store/ws';
import { getSavedTrenchesFilters } from '@/api/market';
import type { TrenchesItem } from '@/api/types';

type TabKey = 'new_creation' | 'completed' | 'new_creation_robinhood' | 'completed_robinhood';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'new_creation', label: 'Nueva' },
  { key: 'completed', label: 'Hecha' },
  { key: 'new_creation_robinhood', label: 'Nueva RH' },
  { key: 'completed_robinhood', label: 'Hecha RH' },
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
    completed: emptyFilters(),
    new_creation_robinhood: emptyFilters(),
    completed_robinhood: emptyFilters(),
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
  const { proxyStatuses, loadProxyStatuses } = useSettings();
  const { connected: wsConnected, trenches: wsTrenches, subscribeTrenches, unsubscribeTrenches, setTrenchesFilters } = useWs();
  const [activeTab, setActiveTab] = useState<TabKey>('new_creation');

  const [filters, setFilters] = useState<Record<TabKey, Filters>>({
    new_creation: emptyFilters(),
    completed: emptyFilters(),
    new_creation_robinhood: emptyFilters(),
    completed_robinhood: emptyFilters(),
  });
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [draft, setDraft] = useState<Filters>(emptyFilters());

  const [data, setData] = useState<Record<TabKey, TrenchesItem[]>>({
    new_creation: [],
    completed: [],
    new_creation_robinhood: [],
    completed_robinhood: [],
  });

  // Subscribe to WS trenches for all tabs on mount.
  // Server pushes current store data immediately on subscribe, then
  // the refresher pushes live updates. No HTTP fetch needed.
  useEffect(() => {
    for (const tab of TABS) {
      subscribeTrenches(tab.key);
    }
    const unsub = useWs.subscribe((state, prev) => {
      for (const tab of TABS) {
        if (state.trenches[tab.key] !== prev.trenches[tab.key]) {
          setData((p) => ({ ...p, [tab.key]: state.trenches[tab.key] ?? [] }));
        }
      }
    });
    return () => {
      unsub();
      for (const tab of TABS) {
        unsubscribeTrenches(tab.key);
      }
    };
  }, [subscribeTrenches, unsubscribeTrenches]);

  // Load saved filters on mount
  useEffect(() => {
    let cancelled = false;
    getSavedTrenchesFilters()
      .then((res) => {
        if (cancelled || !res.filters) return;
        setFilters(normalizeFilters(res.filters));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Load proxy statuses on mount
  useEffect(() => {
    loadProxyStatuses();
  }, [loadProxyStatuses]);

  const openFilters = useCallback(() => {
    setDraft(filters[activeTab]);
    setFiltersVisible(true);
  }, [filters, activeTab]);

  const closeFilters = useCallback(() => setFiltersVisible(false), []);

  const resetDraft = useCallback(() => setDraft(emptyFilters()), []);

  const setDraftValue = useCallback((key: string, side: 'min' | 'max', value: string) => {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], [side]: value } }));
  }, []);

  const confirmFilters = useCallback(() => {
    const next = { ...filters, [activeTab]: draft };
    setFilters(next);
    setFiltersVisible(false);
    setTrenchesFilters(next);
  }, [activeTab, draft, filters, setTrenchesFilters]);

  const activeTokens = data[activeTab] ?? [];

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        {/* Tabs (top) */}
        <View style={styles.tabBar}>
          {TABS.map((tab) => {
            const tabStatus = proxyStatuses.find((s) => s.tab === tab.key);
            const isTabOk = tabStatus?.working ?? false;
            return (
              <Pressable
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                style={styles.tab}>
                <View style={styles.tabLabelRow}>
                  <View style={[styles.tabDot, { backgroundColor: isTabOk ? theme.positive : theme.negative }]} />
                  <ThemedText
                    type="smallBold"
                    style={[
                      styles.tabLabel,
                      { color: activeTab === tab.key ? theme.text : theme.textSecondary },
                    ]}>
                    {tab.label}
                  </ThemedText>
                </View>
                {activeTab === tab.key && (
                  <View style={[styles.tabUnderline, { backgroundColor: theme.text }]} />
                )}
              </Pressable>
            );
          })}
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

        {(() => {
          const activeStatus = proxyStatuses.find((s) => s.tab === activeTab);
          const isProxyOk = activeStatus?.working ?? false;
          if (!isProxyOk) {
            return (
              <View style={styles.emptyCard}>
                <ThemedText type="smallBold" style={{ color: theme.negative, marginBottom: 4 }}>
                  Proxy no configurado
                </ThemedText>
                <ThemedText type="small" style={{ color: theme.textSecondary, textAlign: 'center' }}>
                  {activeStatus?.error === 'Not configured'
                    ? `Configura el proxy para "${TABS.find((t) => t.key === activeTab)?.label}" en Settings → Proxies GMGN.`
                    : `Proxy de "${TABS.find((t) => t.key === activeTab)?.label}" no funciona. Verifica la configuración en Settings → Proxies.`}
                </ThemedText>
              </View>
            );
          }
          return (
            <FlatList
              data={activeTokens}
              keyExtractor={(item, i) => `t-${item.address}-${i}`}
              renderItem={({ item }) => <TokenRow token={item} chain={activeTab.includes('robinhood') ? 'robinhood' : 'sol'} />}
              contentContainerStyle={styles.list}
              ListEmptyComponent={
                !wsConnected ? (
                  <View style={styles.emptyCard}>
                    <ThemedText type="small" style={{ color: theme.textSecondary }}>
                      Conectando al servidor...
                    </ThemedText>
                  </View>
                ) : (
                  <View style={styles.emptyCard}>
                    <ThemedText type="small" style={{ color: theme.textSecondary }}>
                      Sin resultados con estos filtros.
                    </ThemedText>
                  </View>
                )
              }
            />
          );
        })()}

        <View style={styles.footer}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            {wsConnected ? 'Conectado' : 'Desconectado'} · Fin de la Página
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
  tabLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tabDot: { width: 6, height: 6, borderRadius: 3 },
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
