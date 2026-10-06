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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TokenAvatar } from '@/components/token-avatar';
import { useTheme } from '@/hooks/use-theme';
import { getFomoGraduated } from '@/api/market';
import type { FomoFilters, FomoGraduatedResponse, FomoToken } from '@/api/market';
import { fmtNum, fmtPct, fmtUsd, timeAgo } from '@/utils/format';

const FILTERS_KEY = 'trading-sim/fomo-filters';
const POLL_MS = 10_000;

/** Default screen: graduated ≤1h ago with $60K–$450K market cap. */
const FILTER_DEFAULTS: FomoFilters = { ageMaxMin: '60', mcapMin: '60000', mcapMax: '450000' };

interface FilterField {
  key: keyof FomoFilters;
  label: string;
  unit: string;
  placeholder: string;
}

const FILTER_FIELDS: FilterField[] = [
  { key: 'ageMaxMin', label: 'Edad máxima', unit: 'm', placeholder: 'sin límite' },
  { key: 'mcapMin', label: 'Market cap mínimo', unit: '$', placeholder: 'sin límite' },
  { key: 'mcapMax', label: 'Market cap máximo', unit: '$', placeholder: 'sin límite' },
];

function normalizeFilters(raw: unknown): FomoFilters {
  const out: FomoFilters = { ...FILTER_DEFAULTS };
  if (raw && typeof raw === 'object') {
    const o = raw as Partial<FomoFilters>;
    for (const f of FILTER_FIELDS) {
      const v = o[f.key];
      if (typeof v === 'string') out[f.key] = v;
    }
  }
  return out;
}

interface StatItem {
  icon: keyof typeof Ionicons.glyphMap;
  value: string | null;
  color: string;
}

function FomoRow({ token }: { token: FomoToken }) {
  const theme = useTheme();

  // change24 is a FRACTION upstream — ×100 for percent display (FOMO does the same).
  const changePct = token.change24 != null ? token.change24 * 100 : null;
  const changeColor =
    changePct == null ? theme.textSecondary : changePct >= 0 ? '#22c55e' : '#ef4444';

  const stats: StatItem[] = [
    { icon: 'people', value: token.holders != null ? fmtNum(token.holders) : null, color: theme.textSecondary },
    { icon: 'bar-chart', value: token.vol24 != null ? fmtUsd(token.vol24, { compact: true }) : null, color: theme.textSecondary },
    { icon: 'trending-up', value: fmtPct(changePct), color: changeColor },
    { icon: 'pricetag', value: token.price != null ? fmtUsd(token.price) : null, color: theme.textSecondary },
  ];
  const visible = stats.filter((s) => s.value != null && s.value !== '—');

  return (
    <Pressable style={styles.card}>
      <View style={styles.mainRow}>
        <View style={[styles.avatarWrap, { borderColor: '#a855f7' }]}>
          <TokenAvatar logo={token.image} symbol={token.symbol} size={50} borderRadius={4} />
        </View>

        <View style={styles.contentCol}>
          <View style={styles.row}>
            <View style={styles.leftGroup}>
              <ThemedText type="smallBold" numberOfLines={1} style={[styles.symbolText, { color: theme.text }]}>
                {token.symbol || '???'}
              </ThemedText>
              <ThemedText numberOfLines={1} style={[styles.nameText, { color: theme.textSecondary }]}>
                {token.name || 'Token'}
              </ThemedText>
            </View>
            <View style={styles.rightGroup}>
              <ThemedText style={[styles.valueLabel, { color: theme.textSecondary }]}>MC</ThemedText>
              <ThemedText type="small" style={[styles.valueText, { fontWeight: '500', color: theme.text }]}>
                {fmtUsd(token.mcap, { compact: true })}
              </ThemedText>
            </View>
          </View>

          <View style={styles.row}>
            <View style={styles.leftGroup}>
              <ThemedText style={[styles.ageText, { color: theme.textSecondary }]}>
                {token.createdAt != null ? timeAgo(token.createdAt) : '—'}
                {token.launchpad ? ` · ${token.launchpad}` : ''}
              </ThemedText>
            </View>
            <View style={styles.rightGroup}>
              <ThemedText style={[styles.valueLabel, { color: theme.textSecondary }]}>V24</ThemedText>
              <ThemedText type="small" style={[styles.valueText, { fontWeight: '500', color: theme.text }]}>
                {fmtUsd(token.vol24, { compact: true })}
              </ThemedText>
            </View>
          </View>
        </View>
      </View>

      {visible.length > 0 && (
        <View style={styles.statsBar}>
          {visible.map((s, i) => (
            <View key={i} style={styles.statItem}>
              <Ionicons name={s.icon} size={13} color={s.color} />
              <ThemedText style={[styles.statValue, { color: s.color }]}>{s.value}</ThemedText>
            </View>
          ))}
        </View>
      )}
    </Pressable>
  );
}

export default function FomoScreen() {
  const theme = useTheme();
  const [filters, setFilters] = useState<FomoFilters>(FILTER_DEFAULTS);
  const [resp, setResp] = useState<FomoGraduatedResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const [editorVisible, setEditorVisible] = useState(false);
  const [draft, setDraft] = useState<FomoFilters>(FILTER_DEFAULTS);

  // Load saved filters once (defaults: edad ≤1h, mcap 60K–450K).
  useEffect(() => {
    AsyncStorage.getItem(FILTERS_KEY)
      .then((raw) => {
        if (raw) {
          try {
            setFilters(normalizeFilters(JSON.parse(raw)));
          } catch {
            // corrupted value → keep defaults
          }
        }
      })
      .catch(() => {})
      .finally(() => setHydrated(true));
  }, []);

  const load = useCallback(async (f: FomoFilters) => {
    try {
      const res = await getFomoGraduated(f);
      setResp(res);
      setFetchError(null);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Poll the server-side filtered feed (server holds the live WS connection).
  useEffect(() => {
    if (!hydrated) return;
    // Defer the first fetch so setState never runs synchronously in the effect.
    const first = setTimeout(() => load(filters), 0);
    const timer = setInterval(() => load(filters), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [hydrated, filters, load]);

  const openFilterEditor = useCallback(() => {
    setDraft(filters);
    setEditorVisible(true);
  }, [filters]);

  const closeFilterEditor = useCallback(() => setEditorVisible(false), []);

  const resetDraft = useCallback(() => setDraft({ ...FILTER_DEFAULTS }), []);

  const setDraftValue = useCallback((key: keyof FomoFilters, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const confirmFilters = useCallback(() => {
    const next: FomoFilters = { ...draft };
    setFilters(next);
    AsyncStorage.setItem(FILTERS_KEY, JSON.stringify(next)).catch(() => {});
    setEditorVisible(false);
  }, [draft]);

  const tokens = useMemo(() => resp?.tokens ?? [], [resp]);
  const status = resp?.status;
  const live = fetchError == null && status?.live === true;

  const statusText = fetchError
    ? fetchError
    : status
      ? status.connected
        ? `${status.count} tokens${status.lastMsgAgeMs != null ? ` · ${(status.lastMsgAgeMs / 1000).toFixed(0)}s` : ''}`
        : 'conectando…'
      : 'cargando…';

  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    const age = Number(filters.ageMaxMin);
    if (filters.ageMaxMin && Number.isFinite(age)) parts.push(`≤${age}m`);
    const lo = Number(filters.mcapMin);
    const hi = Number(filters.mcapMax);
    if (filters.mcapMin && Number.isFinite(lo)) parts.push(`≥${fmtUsd(lo, { compact: true })}`);
    if (filters.mcapMax && Number.isFinite(hi)) parts.push(`≤${fmtUsd(hi, { compact: true })}`);
    return parts.length > 0 ? parts.join(' · ') : 'sin filtros';
  }, [filters]);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.topBar}>
          <View style={styles.titleGroup}>
            <ThemedText type="title" style={{ color: theme.text }}>FOMO</ThemedText>
            <View style={[styles.liveDot, { backgroundColor: live ? '#22c55e' : '#ef4444' }]} />
            <ThemedText type="small" numberOfLines={1} style={{ color: theme.textSecondary, flexShrink: 1 }}>
              {statusText}
            </ThemedText>
          </View>
          <View style={styles.topActions}>
            <Pressable
              onPress={openFilterEditor}
              style={[styles.filterBtn, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
              <Ionicons name="funnel" size={16} color={theme.textSecondary} />
            </Pressable>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {resp?.total ?? tokens.length}
            </ThemedText>
          </View>
        </View>

        <View style={styles.filterBar}>
          <Ionicons name="options-outline" size={13} color={theme.textSecondary} />
          <ThemedText type="small" style={{ color: theme.textSecondary }}>{filterSummary}</ThemedText>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>· FOMO graduated</ThemedText>
        </View>

        <FlatList
          data={tokens}
          keyExtractor={(item) => `fomo-${item.address}`}
          renderItem={({ item }) => <FomoRow token={item} />}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.emptyCard}>
              <ThemedText type="small" style={{ color: theme.textSecondary, textAlign: 'center' }}>
                {fetchError
                  ? `Error: ${fetchError}`
                  : !hydrated || !resp
                    ? 'Conectando con el feed de FOMO…'
                    : 'Ningún token coincide con estos filtros.'}
              </ThemedText>
            </View>
          }
        />

        <View style={styles.footer}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            Graduados Solana · servidor 10s · fomo.family
          </ThemedText>
        </View>
      </SafeAreaView>

      {/* ── Filter editor ── */}
      <Modal visible={editorVisible} transparent animationType="slide" onRequestClose={closeFilterEditor}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.backdropTouch} onPress={closeFilterEditor} />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <ThemedText type="smallBold" style={styles.sheetTitle}>Filtros — graduados FOMO</ThemedText>
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
                <View key={f.key} style={styles.fieldRow}>
                  <ThemedText type="small" style={[styles.fieldLabel, { color: theme.textSecondary }]}>
                    {f.label}
                  </ThemedText>
                  <View style={styles.inputGroup}>
                    <TextInput
                      value={draft[f.key]}
                      onChangeText={(v) => setDraftValue(f.key, v)}
                      placeholder={f.placeholder}
                      placeholderTextColor={theme.textSecondary}
                      keyboardType="numeric"
                      style={[styles.fieldInput, { color: theme.text }]}
                    />
                    <ThemedText style={[styles.inputUnit, { color: theme.textSecondary }]}>{f.unit}</ThemedText>
                  </View>
                </View>
              ))}
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                Vacío = sin límite. El filtro se aplica en el servidor.
              </ThemedText>
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
  container: { flex: 1 },
  safe: { flex: 1 },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  titleGroup: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  filterBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
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
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1e1e1e',
  },

  card: {
    backgroundColor: '#111111',
    borderRadius: 12,
    padding: 10,
    gap: 8,
  },
  mainRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatarWrap: { borderWidth: 2, borderRadius: 6, overflow: 'hidden' },
  contentCol: { flex: 1, gap: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  leftGroup: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  rightGroup: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0 },
  symbolText: { fontSize: 17, fontWeight: '600' },
  nameText: { fontSize: 13, maxWidth: 150 },
  ageText: { fontSize: 13 },
  valueLabel: { fontSize: 11 },
  valueText: { fontSize: 13 },

  statsBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    backgroundColor: '#1a1a1a',
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 1,
    alignSelf: 'flex-start',
  },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  statValue: { fontSize: 12, fontWeight: '500' },

  /* ── Sheets (filter editor) ── */
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
  sheetBodyContent: { paddingBottom: 8, gap: 4 },
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

  /* ── Filter fields ── */
  fieldRow: { marginBottom: 14 },
  fieldLabel: { fontSize: 12, marginBottom: 6 },
  inputGroup: {
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
});
