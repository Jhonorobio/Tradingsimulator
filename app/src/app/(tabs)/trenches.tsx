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

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TokenRow } from '@/components/token-row';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/store/settings';
import { useWs } from '@/store/ws';
import { getSavedTrenchesFilters } from '@/api/market';
import { getServerFilters } from '@/api/ws-client';
import type { TrenchesItem } from '@/api/types';

type MainTab = 'new' | 'completed';
type ChainFilter = 'solana' | 'robinhood' | 'bsc' | 'todas';
type TabKey = 'new_creation' | 'completed' | 'new_creation_robinhood' | 'completed_robinhood' | 'new_creation_bsc' | 'completed_bsc';

const MAIN_TABS: { key: MainTab; label: string }[] = [
  { key: 'new', label: 'Nuevo' },
  { key: 'completed', label: 'Completado' },
];

const CHAIN_OPTIONS: { key: ChainFilter; label: string }[] = [
  { key: 'solana', label: 'Solana' },
  { key: 'robinhood', label: 'Robinhood' },
  { key: 'bsc', label: 'BSC' },
  { key: 'todas', label: 'Todas' },
];

const ALL_TABS: TabKey[] = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood', 'new_creation_bsc', 'completed_bsc'];

function getTabKeysForSelection(main: MainTab, chain: ChainFilter): TabKey[] {
  if (chain === 'todas') {
    return main === 'new'
      ? ['new_creation', 'new_creation_robinhood', 'new_creation_bsc']
      : ['completed', 'completed_robinhood', 'completed_bsc'];
  }
  const suffix = chain === 'robinhood' ? '_robinhood' : chain === 'bsc' ? '_bsc' : '';
  return [main === 'new' ? `new_creation${suffix}` : `completed${suffix}`] as TabKey[];
}

function getChainForTab(tab: TabKey): string {
  if (tab.includes('robinhood')) return 'robinhood';
  if (tab.includes('bsc')) return 'bsc';
  return 'solana';
}

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
  const [activeChain, setActiveChain] = useState<ChainFilter>('todas');

  const [filters, setFilters] = useState<Record<TabKey, Filters>>({
    new_creation: emptyFilters(),
    completed: emptyFilters(),
    new_creation_robinhood: emptyFilters(),
    completed_robinhood: emptyFilters(),
    new_creation_bsc: emptyFilters(),
    completed_bsc: emptyFilters(),
  });
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [draft, setDraft] = useState<Filters>(emptyFilters());

  const [data, setData] = useState<Record<TabKey, TrenchesItem[]>>({
    new_creation: [],
    completed: [],
    new_creation_robinhood: [],
    completed_robinhood: [],
    new_creation_bsc: [],
    completed_bsc: [],
  });

  // Subscribe to WS trenches for all tabs on mount.
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

  // Load saved filters on mount and sync with server
  useEffect(() => {
    let cancelled = false;
    // First: check if server already has filters (sent on WS connect)
    const serverF = getServerFilters();
    if (serverF) {
      const parsed = normalizeFilters(serverF);
      setFilters(parsed);
      return;
    }
    // Fallback: fetch from HTTP API
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

  // Compute active tab keys based on selection
  const activeTabKeys = useMemo(
    () => getTabKeysForSelection(activeMainTab, activeChain),
    [activeMainTab, activeChain]
  );

  // Merge tokens from selected tabs and sort by time
  const activeTokens = useMemo(() => {
    const merged: (TrenchesItem & { _chain: string })[] = [];
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

  // Filter button uses the first tab key for config
  const filterTabKey = activeTabKeys[0];

  const openFilters = useCallback(() => {
    setDraft(filters[filterTabKey]);
    setFiltersVisible(true);
  }, [filters, filterTabKey]);

  const closeFilters = useCallback(() => setFiltersVisible(false), []);

  const resetDraft = useCallback(() => setDraft(emptyFilters()), []);

  const setDraftValue = useCallback((key: string, side: 'min' | 'max', value: string) => {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], [side]: value } }));
  }, []);

  const confirmFilters = useCallback(() => {
    const next = { ...filters, [filterTabKey]: draft };
    setFilters(next);
    setFiltersVisible(false);
    setTrenchesFilters(next);
  }, [filterTabKey, draft, filters, setTrenchesFilters]);

  // Check proxy status for selected tabs
  const anyProxyOk = activeTabKeys.some((key) => {
    const s = proxyStatuses.find((p) => p.tab === key);
    return s?.working ?? false;
  });

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        {/* Main tabs */}
        <View style={styles.tabBar}>
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

        {/* Chain selector */}
        <View style={styles.chainBar}>
          {CHAIN_OPTIONS.map((c) => {
            const isActive = activeChain === c.key;
            return (
              <Pressable
                key={c.key}
                onPress={() => setActiveChain(c.key)}
                style={[
                  styles.chainBtn,
                  { backgroundColor: isActive ? theme.accent : theme.backgroundSelected },
                ]}>
                <ThemedText
                  type="small"
                  style={{ color: isActive ? '#fff' : theme.textSecondary }}>
                  {c.label}
                </ThemedText>
              </Pressable>
            );
          })}
        </View>

        {/* Action bar */}
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

        {!anyProxyOk ? (
          <View style={styles.emptyCard}>
            <ThemedText type="smallBold" style={{ color: theme.negative, marginBottom: 4 }}>
              Proxy no configurado
            </ThemedText>
            <ThemedText type="small" style={{ color: theme.textSecondary, textAlign: 'center' }}>
              Configura el proxy en Settings → Proxies GMGN para las cadenas que quieras usar.
            </ThemedText>
          </View>
        ) : (
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
        )}

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

            <View style={styles.sectionHeader}>
              <ThemedText type="smallBold" style={styles.sectionTitle}>Filtrado</ThemedText>
              <View style={[styles.sectionIndicator, { backgroundColor: theme.text }]} />
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
  chainBar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  chainBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
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
