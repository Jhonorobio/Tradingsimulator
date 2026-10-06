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
import { getFomoGraduated, setFomoProxy } from '@/api/market';
import type { FomoFilters, FomoGraduatedResponse, FomoPushData, FomoToken } from '@/api/market';
import { getWsClient } from '@/api/ws-client';
import { fmtNum, fmtPct, fmtUsd, timeAgo } from '@/utils/format';

const FILTERS_KEY = 'trading-sim/fomo-filters';
const POLL_MS = 10_000;

/** Default screen: graduated ≤1h ago with $60K–$450K market cap, any KOL count. */
const FILTER_DEFAULTS: FomoFilters = { ageMaxMin: '60', mcapMin: '60000', mcapMax: '450000', kolMin: '' };

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
  { key: 'kolMin', label: 'KOLs mínimo', unit: 'KOL', placeholder: 'sin límite' },
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

/** ''/junk → null (no bound) — mirrors the server's toN(). */
function toBound(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Client-side filter over the live map — same semantics as the server's
 * GET /fomo/graduated (WS pushes are unfiltered, so the view filters here).
 * A token without `kolCount` never passes an active KOL filter; the REST poll
 * backfills counts for candidates so the list fills in within one poll.
 */
function filterTokens(map: Map<string, FomoToken>, f: FomoFilters): FomoToken[] {
  const now = Math.floor(Date.now() / 1000);
  const ageMaxMin = toBound(f.ageMaxMin);
  const mcapMin = toBound(f.mcapMin);
  const mcapMax = toBound(f.mcapMax);
  const kolMin = toBound(f.kolMin);
  const out: FomoToken[] = [];
  for (const t of map.values()) {
    if (ageMaxMin != null && (t.createdAt == null || now - t.createdAt > ageMaxMin * 60)) continue;
    if (
      (mcapMin != null || mcapMax != null) &&
      (t.mcap == null || (mcapMin != null && t.mcap < mcapMin) || (mcapMax != null && t.mcap > mcapMax))
    ) {
      continue;
    }
    if (kolMin != null && (t.kolCount == null || t.kolCount < kolMin)) continue;
    out.push(t);
  }
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return out;
}

/**
 * Merge tokens into the map. WS payloads (and snapshot rebuilds) drop
 * `kolCount` when the record wasn't enriched server-side — keep the value we
 * already know instead of letting every push erase it.
 */
function mergeTokens(next: Map<string, FomoToken>, list: FomoToken[], old: Map<string, FomoToken>) {
  for (const t of list) {
    const prev = old.get(t.address);
    next.set(t.address, t.kolCount != null || prev?.kolCount == null ? t : { ...t, kolCount: prev.kolCount });
  }
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
    // KOL count (Pulse) — only present once the server enriched the record.
    { icon: 'star', value: token.kolCount != null ? `${fmtNum(token.kolCount)} KOL` : null, color: '#a855f7' },
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
  /** Live token map: WS pushes (unfiltered) + REST backfill; display filters client-side. */
  const [map, setMap] = useState<Map<string, FomoToken>>(() => new Map());
  const [resp, setResp] = useState<FomoGraduatedResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  /** True while pushes arrived recently — flipped by the WS handler + a stale timer. */
  const [pushFresh, setPushFresh] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const [editorVisible, setEditorVisible] = useState(false);
  const [draft, setDraft] = useState<FomoFilters>(FILTER_DEFAULTS);
  /** Proxy draft — persisted on the SERVER (reconnects the FOMO WS). */
  const [proxyDraft, setProxyDraft] = useState('');
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [proxySaving, setProxySaving] = useState(false);

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
      // Merge (never replace): WS owns the truth, REST just backfills.
      setMap((prev) => {
        const next = new Map(prev);
        mergeTokens(next, res.tokens, prev);
        return next;
      });
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Real-time feed: server pushes batched changes (~1/s) on topic `fomo`.
  // Subscribing also triggers an immediate full snapshot push from the server.
  // Freshness is a flag flipped here and expired by a timer — Date.now() in
  // render would break react-hooks/purity.
  useEffect(() => {
    const client = getWsClient();
    client.subscribe('fomo');
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    const off = client.on('fomo_updated', (msg) => {
      const data = (msg?.data ?? null) as FomoPushData | null;
      if (!data?.tokens?.length) return;
      setPushFresh(true);
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => setPushFresh(false), 15_000);
      setMap((prev) => {
        if (data.snapshot) {
          // Authoritative upstream rebuild — entries missing here are gone.
          const next = new Map<string, FomoToken>();
          mergeTokens(next, data.tokens, prev);
          return next;
        }
        const next = new Map(prev);
        mergeTokens(next, data.tokens, prev);
        return next;
      });
    });
    return () => {
      if (staleTimer) clearTimeout(staleTimer);
      off();
      client.unsubscribe('fomo');
    };
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
    setProxyDraft(resp?.status.proxy?.url ?? '');
    setProxyError(null);
    setEditorVisible(true);
  }, [filters, resp]);

  const closeFilterEditor = useCallback(() => setEditorVisible(false), []);

  const resetDraft = useCallback(() => {
    setDraft({ ...FILTER_DEFAULTS });
    setProxyDraft('');
    setProxyError(null);
  }, []);

  const setDraftValue = useCallback((key: keyof FomoFilters, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const confirmFilters = useCallback(async () => {
    const next: FomoFilters = { ...draft };
    setFilters(next);
    AsyncStorage.setItem(FILTERS_KEY, JSON.stringify(next)).catch(() => {});

    // Proxy lives on the server: PUT only when it actually changed.
    const currentProxy = resp?.status.proxy?.url ?? '';
    const nextProxy = proxyDraft.trim();
    if (nextProxy !== currentProxy) {
      setProxySaving(true);
      try {
        await setFomoProxy(nextProxy);
        setProxyError(null);
      } catch (err) {
        setProxyError(err instanceof Error ? err.message : String(err));
        setProxySaving(false);
        return; // keep the sheet open so the error is visible
      }
      setProxySaving(false);
    }
    setEditorVisible(false);
  }, [draft, proxyDraft, resp]);

  const tokens = useMemo(() => filterTokens(map, filters), [map, filters]);
  const status = resp?.status;
  // Live = recent WS push (primary) OR upstream feed healthy per REST status.
  const live = pushFresh || (fetchError == null && status?.live === true);

  const statusText = pushFresh
    ? `en vivo · ${status?.count ?? map.size} tokens${status?.proxy?.transport === 'proxy' ? ' · px' : ''}`
    : fetchError
      ? fetchError
      : status
        ? status.connected
          ? `${status.count} tokens${status.lastMsgAgeMs != null ? ` · ${(status.lastMsgAgeMs / 1000).toFixed(0)}s` : ''}${status.proxy?.transport === 'proxy' ? ' · px' : ''}`
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
    const kol = Number(filters.kolMin);
    if (filters.kolMin && Number.isFinite(kol)) parts.push(`≥${kol} KOL`);
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
              {tokens.length}
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
                {fetchError && map.size === 0
                  ? `Error: ${fetchError}`
                  : map.size === 0 && (!hydrated || !resp)
                    ? 'Conectando con el feed de FOMO…'
                    : 'Ningún token coincide con estos filtros.'}
              </ThemedText>
            </View>
          }
        />

        <View style={styles.footer}>
          <ThemedText type="small" style={{ color: theme.textSecondary }}>
            Graduados Solana · tiempo real (push ~1s · respaldo 10s) · fomo.family
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
                Vacío = sin límite. Los KOLs se resuelven en el servidor (Pulse → GMGN).
              </ThemedText>

              <View style={styles.sectionDivider} />
              <ThemedText type="smallBold" style={{ color: theme.text }}>
                Conexión del feed (servidor)
              </ThemedText>
              <View style={styles.fieldRow}>
                <ThemedText type="small" style={[styles.fieldLabel, { color: theme.textSecondary }]}>
                  Proxy para el WS de FOMO
                </ThemedText>
                <View style={styles.inputGroup}>
                  <TextInput
                    value={proxyDraft}
                    onChangeText={setProxyDraft}
                    placeholder="host:puerto o http://… (vacío = directo)"
                    placeholderTextColor={theme.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.fieldInput, { color: theme.text }]}
                  />
                </View>
              </View>
              <ThemedText type="small" style={{ color: theme.textSecondary }}>
                {status?.proxy?.enabled
                  ? `Actual: ${status.proxy.url} · vía ${status.proxy.transport === 'proxy' ? 'proxy' : 'directo (fallback)'}`
                  : 'Sin proxy — conexión directa.'}
                {' '}Se guarda en el servidor y reconecta el feed.
              </ThemedText>
              {proxyError != null && (
                <ThemedText type="small" style={{ color: '#ef4444' }}>
                  Error al guardar el proxy: {proxyError}
                </ThemedText>
              )}
            </ScrollView>
            <View style={styles.sheetFooter}>
              <Pressable onPress={closeFilterEditor} style={styles.cancelBtn}>
                <ThemedText type="smallBold" style={{ color: '#ffffff' }}>Cancelar</ThemedText>
              </Pressable>
              <Pressable onPress={confirmFilters} disabled={proxySaving} style={[styles.confirmBtn, proxySaving && styles.btnDisabled]}>
                <ThemedText type="smallBold" style={{ color: '#000000' }}>
                  {proxySaving ? 'Guardando…' : 'Confirmar'}
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
  btnDisabled: { opacity: 0.5 },

  /* ── Filter fields ── */
  fieldRow: { marginBottom: 14 },
  fieldLabel: { fontSize: 12, marginBottom: 6 },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#333333',
    marginVertical: 14,
  },
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
