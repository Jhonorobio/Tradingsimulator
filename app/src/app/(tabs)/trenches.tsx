import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Image } from 'expo-image';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TokenRow } from '@/components/token-row';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/store/settings';
import { useWs } from '@/store/ws';
import { getSavedTrenchesFilters } from '@/api/market';
import type { TrenchesItem } from '@/api/types';

type MainTab = 'new' | 'completed';
type ChainKey = 'solana' | 'robinhood' | 'bsc';
type TabKey = 'new_creation' | 'completed' | 'new_creation_robinhood' | 'completed_robinhood' | 'new_creation_bsc' | 'completed_bsc';

const MAIN_TABS: { key: MainTab; label: string }[] = [
  { key: 'new', label: 'Nueva' },
  { key: 'completed', label: 'Completado' },
];

const CHAIN_OPTIONS: { key: ChainKey; label: string; icon: any; color: string }[] = [
  { key: 'solana', label: 'SOL', icon: require('@/assets/images/chains/solana.png'), color: '#a855f7' },
  { key: 'bsc', label: 'BSC', icon: require('@/assets/images/chains/bsc.webp'), color: '#f97316' },
  { key: 'robinhood', label: 'HOOD', icon: require('@/assets/images/chains/robinhood.png'), color: '#CCFF00' },
];

const ALL_TABS: TabKey[] = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood', 'new_creation_bsc', 'completed_bsc'];

function getTabKeysForSelection(main: MainTab, chains: ChainKey[]): TabKey[] {
  const tabs: TabKey[] = [];
  for (const chain of chains) {
    const suffix = chain === 'robinhood' ? '_robinhood' : chain === 'bsc' ? '_bsc' : '';
    tabs.push((main === 'new' ? `new_creation${suffix}` : `completed${suffix}`) as TabKey);
  }
  return tabs;
}

function getChainForTab(tab: TabKey): ChainKey {
  if (tab.includes('robinhood')) return 'robinhood';
  if (tab.includes('bsc')) return 'bsc';
  return 'solana';
}

function getTabKeyForChainFilter(main: MainTab, chain: ChainKey): TabKey {
  const suffix = chain === 'robinhood' ? '_robinhood' : chain === 'bsc' ? '_bsc' : '';
  return (main === 'new' ? `new_creation${suffix}` : `completed${suffix}`) as TabKey;
}

type RangeValues = { min: string; max: string };
type Filters = Record<string, RangeValues>;

interface FilterField {
  key: string;
  label: string;
  unit: string;
}

const FILTER_FIELDS: FilterField[] = [
  { key: 'progress', label: 'Progreso', unit: '%' },
  { key: 'created', label: 'Fecha de creación', unit: 'm' },
  { key: 'liquidity', label: 'Pool de liquidez', unit: 'K' },
  { key: 'marketcap', label: 'Capitalización de Mercado ($)', unit: 'K' },
  { key: 'topHolderRate', label: 'Participación de los 10 mayores tenedores', unit: '%' },
  { key: 'creatorBalanceRate', label: 'Porcentaje en manos de los desarrolladores', unit: '%' },
  { key: 'totalFee', label: 'Comisiones totales', unit: 'SOL' },
  { key: 'bundlerRate', label: 'Bundler', unit: '%' },
  { key: 'rugRatio', label: 'Rug ratio', unit: '%' },
  { key: 'insiderRatio', label: 'Insider', unit: '%' },
  { key: 'entrapmentRatio', label: 'Entrapment', unit: '%' },
  { key: 'privateVaultHoldRate', label: 'Private vault', unit: '%' },
  { key: 'top70SniperHoldRate', label: 'Top70 sniper', unit: '%' },
  { key: 'botDegenRate', label: 'Bot degen', unit: '%' },
  { key: 'freshWalletRate', label: 'Fresh wallet', unit: '%' },
  { key: 'creatorCreatedOpenRatio', label: 'Ratio de graduación del creador', unit: '%' },
  { key: 'volume24h', label: 'Volumen 24h', unit: '$' },
  { key: 'netBuy24h', label: 'Compras netas 24h', unit: '$' },
  { key: 'swaps24h', label: 'Swaps 24h', unit: '' },
  { key: 'buys24h', label: 'Compras 24h', unit: '' },
  { key: 'sells24h', label: 'Ventas 24h', unit: '' },
  { key: 'visitingCount', label: 'Visitantes', unit: '' },
  { key: 'holderCount', label: 'Tenedores', unit: '' },
  { key: 'botCount', label: 'Bots', unit: '' },
  { key: 'smartDegen', label: 'Smart degen', unit: '' },
  { key: 'renowned', label: 'Renombrados', unit: '' },
  { key: 'creatorCreatedCount', label: 'Creador · tokens creados', unit: '' },
  { key: 'creatorCreatedOpenCount', label: 'Creador · tokens graduados', unit: '' },
  { key: 'xFollowers', label: 'Seguidores X', unit: '' },
  { key: 'twitterRenameCount', label: 'Renombres Twitter', unit: '' },
  { key: 'tgCallCount', label: 'Llamadas Telegram', unit: '' },
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
    new_creation_bsc: emptyFilters(),
    completed_bsc: emptyFilters(),
  };
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  for (const tab of ALL_TABS) {
    const tabRaw = obj[tab];
    if (!tabRaw || typeof tabRaw !== 'object') continue;
    for (const f of FILTER_FIELDS) {
      const v = (tabRaw as Record<string, unknown>)[f.key];
      if (v && typeof v === 'object') {
        const rv = v as { min?: unknown; max?: unknown };
        fallback[tab][f.key] = {
          min: typeof rv.min === 'string' ? rv.min : '',
          max: typeof rv.max === 'string' ? rv.max : '',
        };
      }
    }
  }
  return fallback;
}

function ChainIcon({ chain, size = 24 }: { chain: ChainKey; size?: number }) {
  const opt = CHAIN_OPTIONS.find((c) => c.key === chain)!;
  return (
    <Image
      source={opt.icon}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      contentFit="contain"
    />
  );
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
  const [activeMainTab, setActiveMainTab] = useState<MainTab>('new');
  const [selectedChains, setSelectedChains] = useState<ChainKey[]>(['solana']);

  const [filters, setFilters] = useState<Record<TabKey, Filters>>({
    new_creation: emptyFilters(),
    completed: emptyFilters(),
    new_creation_robinhood: emptyFilters(),
    completed_robinhood: emptyFilters(),
    new_creation_bsc: emptyFilters(),
    completed_bsc: emptyFilters(),
  });

  const [chainSheetVisible, setChainSheetVisible] = useState(false);
  const [tempSelectedChains, setTempSelectedChains] = useState<ChainKey[]>([]);

  const [filterChainVisible, setFilterChainVisible] = useState(false);
  const [filterEditChain, setFilterEditChain] = useState<ChainKey | null>(null);
  const [filterEditorVisible, setFilterEditorVisible] = useState(false);
  const [draft, setDraft] = useState<Filters>(emptyFilters());

  const [data, setData] = useState<Record<TabKey, TrenchesItem[]>>({
    new_creation: [],
    completed: [],
    new_creation_robinhood: [],
    completed_robinhood: [],
    new_creation_bsc: [],
    completed_bsc: [],
  });

  useEffect(() => {
    for (const tab of ALL_TABS) {
      subscribeTrenches(tab);
    }
    const unsub = useWs.subscribe((state, prev) => {
      for (const tab of ALL_TABS) {
        if (state.trenches[tab] !== prev.trenches[tab]) {
          setData((p) => ({ ...p, [tab]: state.trenches[tab] ?? [] }));
        }
      }
    });
    return () => {
      unsub();
      for (const tab of ALL_TABS) {
        unsubscribeTrenches(tab);
      }
    };
  }, [subscribeTrenches, unsubscribeTrenches]);

  useEffect(() => {
    let cancelled = false;
    getSavedTrenchesFilters()
      .then((res) => {
        if (cancelled || !res.filters) return;
        const parsed = normalizeFilters(res.filters);
        setFilters(parsed);
        setTrenchesFilters(parsed);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    loadProxyStatuses();
  }, [loadProxyStatuses]);

  const activeTabKeys = useMemo(
    () => getTabKeysForSelection(activeMainTab, selectedChains),
    [activeMainTab, selectedChains]
  );

  const activeTokens = useMemo(() => {
    const merged: (TrenchesItem & { _chain: ChainKey })[] = [];
    for (const key of activeTabKeys) {
      const chain = getChainForTab(key);
      const items = data[key] ?? [];
      for (const item of items) {
        merged.push({ ...item, _chain: chain });
      }
    }
    merged.sort((a, b) => {
      const ta = a.created_timestamp ?? a.open_timestamp ?? 0;
      const tb = b.created_timestamp ?? b.open_timestamp ?? 0;
      return tb - ta;
    });
    return merged;
  }, [data, activeTabKeys]);

  const openChainSheet = useCallback(() => {
    setTempSelectedChains([...selectedChains]);
    setChainSheetVisible(true);
  }, [selectedChains]);

  const toggleTempChain = useCallback((chain: ChainKey) => {
    setTempSelectedChains((prev) => {
      if (prev.includes(chain)) {
        if (prev.length === 1) return prev;
        return prev.filter((c) => c !== chain);
      }
      return [...prev, chain];
    });
  }, []);

  const confirmChainSelection = useCallback(() => {
    setSelectedChains(tempSelectedChains);
    setChainSheetVisible(false);
  }, [tempSelectedChains]);

  const openFilterChainPicker = useCallback(() => {
    setFilterChainVisible(true);
  }, []);

  const selectFilterChain = useCallback((chain: ChainKey) => {
    setFilterChainVisible(false);
    setFilterEditChain(chain);
    const tabKey = getTabKeyForChainFilter(activeMainTab, chain);
    setDraft(filters[tabKey]);
    setFilterEditorVisible(true);
  }, [activeMainTab, filters]);

  const closeFilterEditor = useCallback(() => {
    setFilterEditorVisible(false);
    setFilterEditChain(null);
  }, []);

  const resetDraft = useCallback(() => setDraft(emptyFilters()), []);

  const setDraftValue = useCallback((key: string, side: 'min' | 'max', value: string) => {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], [side]: value } }));
  }, []);

  const confirmFilters = useCallback(() => {
    if (!filterEditChain) return;
    const tabKey = getTabKeyForChainFilter(activeMainTab, filterEditChain);
    const next = { ...filters, [tabKey]: draft };
    setFilters(next);
    setFilterEditorVisible(false);
    setFilterEditChain(null);
    setTrenchesFilters(next);
  }, [filterEditChain, activeMainTab, draft, filters, setTrenchesFilters]);

  const selectedChainOpt = CHAIN_OPTIONS.filter((c) => selectedChains.includes(c.key));
  const filterEditLabel = filterEditChain
    ? CHAIN_OPTIONS.find((c) => c.key === filterEditChain)?.label ?? ''
    : '';

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <View style={styles.tabsLeft}>
            {MAIN_TABS.map((tab) => (
              <Pressable
                key={tab.key}
                onPress={() => setActiveMainTab(tab.key)}
                style={styles.tab}>
                <ThemedText
                  type="smallBold"
                  style={[
                    styles.tabLabel,
                    { color: activeMainTab === tab.key ? theme.text : theme.textSecondary },
                  ]}>
                  {tab.label}
                </ThemedText>
                {activeMainTab === tab.key && (
                  <View style={[styles.tabUnderline, { backgroundColor: theme.text }]} />
                )}
              </Pressable>
            ))}
          </View>

          <Pressable onPress={openChainSheet} style={styles.chainSelector}>
            <View style={styles.chainIconsRow}>
              {selectedChainOpt.map((c, i) => (
                <View
                  key={c.key}
                    style={[
                      styles.chainIconWrap,
                      { marginLeft: i > 0 ? -8 : 0, zIndex: selectedChainOpt.length - i },
                    ]}>
                  <ChainIcon chain={c.key} size={24} />
                </View>
              ))}
            </View>
            <Ionicons name="chevron-down" size={14} color={theme.textSecondary} />
          </Pressable>
        </View>

        {/* Action bar */}
        <View style={styles.actionBar}>
          <Pressable
            onPress={openFilterChainPicker}
            style={[styles.filterBtn, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
            <Ionicons name="funnel" size={17} color={theme.textSecondary} />
          </Pressable>
        </View>

        {/* Token list */}
        <FlatList
          data={activeTokens}
          keyExtractor={(item, i) => `t-${item._chain}-${item.address}-${i}`}
          renderItem={({ item }) => <TokenRow token={item} chain={item._chain} />}
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

        <View style={styles.footer}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            {wsConnected ? 'Conectado' : 'Desconectado'} · Fin de la Página
          </ThemedText>
        </View>
      </SafeAreaView>

      {/* ── Chain selector sheet ── */}
      <Modal visible={chainSheetVisible} transparent animationType="slide" onRequestClose={() => setChainSheetVisible(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.backdropTouch} onPress={() => setChainSheetVisible(false)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <ThemedText type="smallBold" style={styles.sheetTitle}>Seleccionar red</ThemedText>
              <Pressable onPress={() => setTempSelectedChains(CHAIN_OPTIONS.map((c) => c.key))} hitSlop={8}>
                <ThemedText type="small" style={styles.resetText}>Seleccionar todo</ThemedText>
              </Pressable>
            </View>
            <View style={styles.chainGrid}>
              {CHAIN_OPTIONS.map((c) => {
                const sel = tempSelectedChains.includes(c.key);
                return (
                  <Pressable
                    key={c.key}
                    onPress={() => toggleTempChain(c.key)}
                    style={[styles.chainCard, { borderColor: sel ? c.color : theme.border, backgroundColor: theme.backgroundSelected }]}>
                    <ChainIcon chain={c.key} size={40} />
                    <ThemedText type="small" style={{ color: theme.text }}>{c.label}</ThemedText>
                    {sel && (
                      <View style={[styles.chainCheck, { backgroundColor: c.color }]}>
                        <Ionicons name="checkmark" size={12} color="#000" />
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.sheetFooter}>
              <Pressable onPress={() => setChainSheetVisible(false)} style={styles.cancelBtn}>
                <ThemedText type="smallBold" style={{ color: '#ffffff' }}>Cancelar</ThemedText>
              </Pressable>
              <Pressable onPress={confirmChainSelection} style={styles.confirmBtn}>
                <ThemedText type="smallBold" style={{ color: '#000000' }}>Confirmar</ThemedText>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Filter chain picker sheet ── */}
      <Modal visible={filterChainVisible} transparent animationType="slide" onRequestClose={() => setFilterChainVisible(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.backdropTouch} onPress={() => setFilterChainVisible(false)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <ThemedText type="smallBold" style={styles.sheetTitle}>Editar filtros</ThemedText>
            </View>
            {CHAIN_OPTIONS.filter((c) => selectedChains.includes(c.key)).map((c) => (
              <Pressable
                key={c.key}
                onPress={() => selectFilterChain(c.key)}
                style={[styles.filterChainRow, { borderBottomColor: theme.border }]}>
                <ChainIcon chain={c.key} size={28} />
                <ThemedText type="smallBold" style={{ color: theme.text }}>
                  {c.label} Configuraciones
                </ThemedText>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>

      {/* ── Filter editor sheet ── */}
      <Modal visible={filterEditorVisible} transparent animationType="slide" onRequestClose={closeFilterEditor}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.backdropTouch} onPress={closeFilterEditor} />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <ThemedText type="smallBold" style={styles.sheetTitle}>
                Filtros — {filterEditLabel}
              </ThemedText>
              <Pressable onPress={resetDraft} hitSlop={8}>
                <ThemedText type="small" style={styles.resetText}>Restablecer</ThemedText>
              </Pressable>
            </View>
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
            <View style={styles.sheetFooter}>
              <Pressable onPress={closeFilterEditor} style={styles.cancelBtn}>
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

  /* ── Top bar ── */
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  tabsLeft: { flexDirection: 'row' },
  tab: {
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    position: 'relative',
  },
  tabLabel: { fontSize: 15 },
  tabUnderline: {
    position: 'absolute',
    bottom: 0,
    left: '15%',
    width: '70%',
    height: 2,
    borderRadius: 1,
  },
  chainSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  chainIconsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  chainIconWrap: {
    borderRadius: 14,
  },

  /* ── Action bar ── */
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filterBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ── List ── */
  list: { padding: 10, gap: 8, paddingBottom: 40 },
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

  /* ── Sheets ── */
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
  sheetBody: { flexGrow: 0 },
  sheetBodyContent: { paddingBottom: 8 },
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

  /* ── Chain grid ── */
  chainGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingVertical: 8,
  },
  chainCard: {
    width: '30%',
    aspectRatio: 1,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  chainCheck: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ── Filter chain picker ── */
  filterChainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },

  /* ── Filter editor ── */
  fieldRow: { marginBottom: 14 },
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
});
