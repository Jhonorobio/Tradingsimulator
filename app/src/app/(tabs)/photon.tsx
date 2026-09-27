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
import { useRouter } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TokenAvatar } from '@/components/token-avatar';
import { useTheme } from '@/hooks/use-theme';
import { useMemescope } from '@/store/memescope';
import { getPhotonFilters, savePhotonFilters } from '@/api/market';
import type { MemescopeColKey, PhotonCol, PhotonColFilters, PhotonFilters, PhotonRange, PhotonToken } from '@/api/market';
import { fmtNum, fmtUsd, timeAgo } from '@/utils/format';

const COLS: PhotonCol[] = ['col1', 'col3'];
// Photon's image CDN (tpi.tradewithphoton.com) returns 403 without a
// photon-sol.tinyastro.io Referer — verified: any UA + this referer = 200.
const PHOTON_IMG_HEADERS = { referer: 'https://photon-sol.tinyastro.io/' };

interface PhotonFilterField {
  key: string;
  label: string;
  unit: string;
}

/** Field keys must match FILTER_FIELDS in server photon-memescope.js. */
const FILTER_FIELDS: PhotonFilterField[] = [
  { key: 'age', label: 'Edad', unit: 'm' },
  { key: 'holders', label: 'Holders count', unit: '' },
  { key: 'tpHolders', label: 'Bot holders', unit: '' },
  { key: 'mktCap', label: 'Market cap', unit: '$' },
  { key: 'buys', label: 'Compras', unit: '' },
  { key: 'freshPct', label: 'Fresh holding', unit: '%' },
];

/** Same defaults the server uses when nothing is saved yet. */
const FILTER_DEFAULTS: PhotonFilters = {
  col1: {},
  col3: { age: { max: '30' }, tpHolders: { min: '100' } },
};

function emptyColFilters(): PhotonColFilters {
  const o: PhotonColFilters = {};
  for (const f of FILTER_FIELDS) o[f.key] = { min: '', max: '' };
  return o;
}

function normalizeColFilters(raw: unknown): PhotonColFilters {
  const out = emptyColFilters();
  if (!raw || typeof raw !== 'object') return out;
  for (const f of FILTER_FIELDS) {
    const v = (raw as Record<string, unknown>)[f.key];
    if (v && typeof v === 'object') {
      const rv = v as PhotonRange;
      out[f.key] = {
        min: typeof rv.min === 'string' ? rv.min : '',
        max: typeof rv.max === 'string' ? rv.max : '',
      };
    }
  }
  return out;
}

function normalizeFilters(raw: unknown): Record<PhotonCol, PhotonColFilters> {
  const obj = (raw ?? {}) as Partial<Record<PhotonCol, unknown>>;
  return {
    col1: normalizeColFilters(obj.col1 ?? FILTER_DEFAULTS.col1),
    col3: normalizeColFilters(obj.col3 ?? FILTER_DEFAULTS.col3),
  };
}

function RangeField({
  field,
  values,
  onChange,
}: {
  field: PhotonFilterField;
  values: PhotonRange;
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
            value={values.min ?? ''}
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
            value={values.max ?? ''}
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
const FALLBACK_TITLES: Record<MemescopeColKey, string> = {
  col1: 'New',
  col2: 'Graduating',
  col3: 'Graduated',
};

interface StatItem {
  icon: keyof typeof Ionicons.glyphMap;
  value: string | null;
  color: string;
}

function PhotonRow({ token }: { token: PhotonToken }) {
  const router = useRouter();
  const theme = useTheme();

  const address = token.tokenAddress || token.address || '';
  // Photon sends some numbers as strings ("0.0") — coerce before math.
  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const fdv = num(token.fdv);
  const volume = num(token.volume);
  const holders = num(token.holders_count);
  const liqUsd = num(token.cur_liq?.usd);
  const topHolders = num(token.audit?.top_holders_perc);
  const lpBurned = num(token.audit?.lp_burned_perc);
  const devPct = num(token.dev_holding_perc);
  const snipers = num(token.snipers_count);
  const ath = num(token.ath);
  const createdAt = num(token.created_timestamp);

  const stats: StatItem[] = [
    { icon: 'people', value: holders != null ? `${fmtNum(holders)}` : null, color: theme.textSecondary },
    { icon: 'stats-chart', value: liqUsd != null ? fmtUsd(liqUsd, { compact: true }) : null, color: theme.textSecondary },
    { icon: 'bar-chart', value: topHolders != null ? `${topHolders.toFixed(0)}%` : null, color: '#f59e0b' },
    { icon: 'flame', value: lpBurned != null ? `LP ${lpBurned.toFixed(0)}%` : null, color: lpBurned === 100 ? '#22c55e' : theme.textSecondary },
    { icon: 'locate', value: snipers != null && snipers > 0 ? `Snp ${snipers}` : null, color: '#ef4444' },
    { icon: 'code-slash', value: devPct != null && devPct > 0 ? `Dev ${devPct.toFixed(1)}%` : null, color: devPct != null && devPct > 5 ? '#ef4444' : theme.textSecondary },
    { icon: 'trophy', value: ath ? `ATH ${fmtUsd(ath, { compact: true })}` : null, color: '#a855f7' },
  ];
  const visible = stats.filter((s) => s.value != null);

  return (
    <Pressable
      onPress={() => address && router.push(`/token/solana/${address}`)}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.75 }]}>
      <View style={styles.mainRow}>
        <View style={[styles.avatarWrap, { borderColor: '#a855f7' }]}>
          <TokenAvatar logo={token.imgUrl} symbol={token.symbol} size={50} borderRadius={4} headers={PHOTON_IMG_HEADERS} />
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
              <ThemedText style={[styles.valueLabel, { color: theme.textSecondary }]}>FDV</ThemedText>
              <ThemedText type="small" style={[styles.valueText, { fontWeight: '500', color: theme.text }]}>
                {fmtUsd(fdv, { compact: true })}
              </ThemedText>
            </View>
          </View>

          <View style={styles.row}>
            <View style={styles.leftGroup}>
              <ThemedText style={[styles.ageText, { color: theme.textSecondary }]}>
                {createdAt != null ? timeAgo(createdAt) : '—'}
                {token.fromPump ? ' · pump' : ''}
              </ThemedText>
            </View>
            <View style={styles.rightGroup}>
              <ThemedText style={[styles.valueLabel, { color: theme.textSecondary }]}>V</ThemedText>
              <ThemedText type="small" style={[styles.valueText, { fontWeight: '500', color: theme.text }]}>
                {fmtUsd(volume, { compact: true })}
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

export default function PhotonScreen() {
  const theme = useTheme();
  const { resp, error: fetchError, startListening, refresh } = useMemescope();
  const [activeCol, setActiveCol] = useState<PhotonCol>('col1');

  const [filters, setFilters] = useState<Record<PhotonCol, PhotonColFilters>>(FILTER_DEFAULTS);
  const [editorVisible, setEditorVisible] = useState(false);
  const [draft, setDraft] = useState<PhotonColFilters>(emptyColFilters());
  const [saving, setSaving] = useState(false);

  // The feed subscribes at app boot; this is just a safety net.
  useEffect(() => {
    startListening();
  }, [startListening]);

  // Saved server-side filters (shared by every client).
  useEffect(() => {
    let cancelled = false;
    getPhotonFilters()
      .then((res) => {
        if (cancelled || !res.filters) return;
        setFilters(normalizeFilters(res.filters));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const openFilterEditor = useCallback(() => {
    setDraft(filters[activeCol] ?? emptyColFilters());
    setEditorVisible(true);
  }, [activeCol, filters]);

  const closeFilterEditor = useCallback(() => setEditorVisible(false), []);

  const resetDraft = useCallback(() => {
    setDraft(normalizeFilters(FILTER_DEFAULTS)[activeCol]);
  }, [activeCol]);

  const setDraftValue = useCallback((key: string, side: 'min' | 'max', value: string) => {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], [side]: value } }));
  }, []);

  const confirmFilters = useCallback(async () => {
    if (saving) return;
    const next = { ...filters, [activeCol]: draft } as Record<PhotonCol, PhotonColFilters>;
    setSaving(true);
    try {
      const res = await savePhotonFilters(next as PhotonFilters);
      if (res?.filters) setFilters(normalizeFilters(res.filters));
      else setFilters(next);
      setEditorVisible(false);
      refresh();
    } catch {
      // keep the editor open on failure — retry possible
    } finally {
      setSaving(false);
    }
  }, [activeCol, draft, filters, refresh, saving]);

  const tokens = useMemo(
    () => resp?.columns?.[activeCol]?.data?.map((d) => d.attributes) ?? [],
    [resp, activeCol],
  );
  const titles = resp?.titles ?? FALLBACK_TITLES;
  const ageMs = resp?.ageMs ?? null;
  const live = fetchError == null && ageMs != null && ageMs < 3000;

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.topBar}>
          <View style={styles.titleGroup}>
            <ThemedText type="title" style={{ color: theme.text }}>Photon</ThemedText>
            <View style={[styles.liveDot, { backgroundColor: live ? '#22c55e' : '#ef4444' }]} />
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {fetchError
                ? fetchError
                : ageMs != null
                  ? `live · ${(ageMs / 1000).toFixed(1)}s`
                  : 'cargando…'}
            </ThemedText>
          </View>
          <View style={styles.topActions}>
            <Pressable
              onPress={openFilterEditor}
              style={[styles.filterBtn, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
              <Ionicons name="funnel" size={16} color={theme.textSecondary} />
            </Pressable>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              {tokens.length} tokens
            </ThemedText>
          </View>
        </View>

        <View style={styles.tabsRow}>
          {COLS.map((col) => {
            const active = activeCol === col;
            const count = resp?.columns?.[col]?.data?.length ?? 0;
            return (
              <Pressable key={col} onPress={() => setActiveCol(col)} style={styles.tab}>
                <ThemedText
                  type="smallBold"
                  style={{ color: active ? theme.text : theme.textSecondary }}>
                  {titles[col] ?? FALLBACK_TITLES[col]} ({count})
                </ThemedText>
                {active && <View style={[styles.tabUnderline, { backgroundColor: theme.text }]} />}
              </Pressable>
            );
          })}
        </View>

        <FlatList
          data={tokens}
          keyExtractor={(item, i) => `ph-${item.tokenAddress || item.address || i}-${i}`}
          renderItem={({ item }) => <PhotonRow token={item} />}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.emptyCard}>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                {fetchError ? `Error: ${fetchError}` : 'Cargando feed de Photon…'}
              </ThemedText>
            </View>
          }
        />

        <View style={styles.footer}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            Memescope · servidor 1.3s · push en vivo
          </ThemedText>
        </View>
      </SafeAreaView>

      {/* ── Per-column filter editor ── */}
      <Modal visible={editorVisible} transparent animationType="slide" onRequestClose={closeFilterEditor}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.backdropTouch} onPress={closeFilterEditor} />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <ThemedText type="smallBold" style={styles.sheetTitle}>
                Filtros — {titles[activeCol] ?? FALLBACK_TITLES[activeCol]}
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
              <Pressable onPress={confirmFilters} style={[styles.confirmBtn, saving && { opacity: 0.6 }]}>
                <ThemedText type="smallBold" style={{ color: '#000000' }}>
                  {saving ? 'Guardando…' : 'Confirmar'}
                </ThemedText>
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
  titleGroup: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },

  tabsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  tab: { alignItems: 'center', paddingVertical: 10, paddingHorizontal: 8, position: 'relative' },
  tabUnderline: {
    position: 'absolute',
    bottom: 0,
    left: '15%',
    width: '70%',
    height: 2,
    borderRadius: 1,
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

  /* ── Top actions (filter button) ── */
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  filterBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

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

  /* ── Filter fields ── */
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
