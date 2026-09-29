import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/store/settings';
import { saveNotificationConfig, getNotificationConfig } from '@/api/notifications';
import { ApiError } from '@/api/client';
import type { NotificationConfig, NotificationCategoryFilters, NotificationFilterFields } from '@/api/types';
import { registerForPushNotificationsAsync, notificationsAvailable } from '@/utils/notifications';

// The legacy `x_tracker` key is kept in config/state (round-trip compat) but
// no longer rendered: the Tracker sends no notifications.
const NOTIF_CATEGORIES = ['new_creation', 'completed', 'photon_new', 'photon_graduated'] as const;
const NOTIF_LABELS: Record<string, string> = {
  new_creation: 'Nueva creación (SOL)',
  completed: 'Completado (SOL)',
  photon_new: 'Photon — New',
  photon_graduated: 'Photon — Graduated',
};
const NOTIF_HINTS: Record<string, string> = {
  photon_new: 'Aviso cuando un token entre a la columna New de Photon. Se respetan los filtros de la pestaña Photon.',
  photon_graduated: 'Aviso cuando un token aparezca en la columna Graduated de Photon. Se respetan los filtros de la pestaña Photon.',
};
// Solo estas categorías admiten filtros numéricos (photon no tiene).
const FILTERABLE_CATEGORIES = new Set(['new_creation', 'completed']);

type TrackerTweets = NonNullable<NotificationConfig['tracker_tweets']>;
const EMPTY_TWEET_FLAGS: TrackerTweets = {
  watchlist: { new_creation: false, completed: false, photon_new: false, photon_graduated: false },
  others: { new_creation: false, completed: false, photon_new: false, photon_graduated: false },
};

const FILTER_FIELDS: { key: NotificationFilterFields; label: string; suffix?: string }[] = [
  { key: 'smart_degen_count', label: 'Smart Degen' },
  { key: 'renowned_count', label: 'KOL' },
  { key: 'bot_degen_count', label: 'Bot Degen' },
  { key: 'bot_degen_rate', label: 'Bot %', suffix: '%' },
  { key: 'fresh_wallet_rate', label: 'Fresh Wallet %', suffix: '%' },
  { key: 'rug_ratio', label: 'Rug %', suffix: '%' },
  { key: 'bundler_trader_amount_rate', label: 'Bundler', suffix: '%' },
  { key: 'entrapment_ratio', label: 'Phishing', suffix: '%' },
  { key: 'volume_24h', label: 'Vol 24h', suffix: '$' },
  { key: 'usd_market_cap', label: 'MCap', suffix: '$' },
];

export default function NotificationsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { pushToken, setPushToken } = useSettings();

  const [notifCategories, setNotifCategories] = useState<NotificationConfig['categories']>({
    new_creation: false,
    completed: false,
    x_tracker: false,
    photon_new: false,
    photon_graduated: false,
  });
  const [filters, setFilters] = useState<Record<string, NotificationCategoryFilters>>({});
  const [trackerTweets, setTrackerTweets] = useState<TrackerTweets>(EMPTY_TWEET_FLAGS);
  const [expandedCat, setExpandedCat] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const notifCfg = await getNotificationConfig().catch(() => null);
      if (notifCfg) {
        setNotifCategories(notifCfg.categories);
        setFilters(notifCfg.filters || {});
        setTrackerTweets(notifCfg.tracker_tweets ?? EMPTY_TWEET_FLAGS);
      }
    } catch {}
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const persistConfig = async (
    cats: NotificationConfig['categories'],
    f: Record<string, NotificationCategoryFilters>,
    tt: TrackerTweets,
  ) => {
    let token = pushToken;
    if (!token) {
      if (!notificationsAvailable()) {
        Alert.alert('Push no disponible', 'En Android, expo-notifications ya no funciona dentro de Expo Go (desde SDK 53). Necesitas un development build.');
        return;
      }
      token = await registerForPushNotificationsAsync();
      if (!token) {
        Alert.alert('Push no disponible', 'Solo funciona en un dispositivo físico.');
        return;
      }
      setPushToken(token);
    }
    try {
      await saveNotificationConfig(token, cats, f, tt);
    } catch (err) {
      Alert.alert('Error', err instanceof ApiError ? err.message : 'No se pudo guardar');
    }
  };

  const toggleNotifCategory = async (cat: string) => {
    const next = { ...notifCategories, [cat]: !notifCategories[cat as keyof typeof notifCategories] };
    setNotifCategories(next);
    await persistConfig(next, filters, trackerTweets);
  };

  // Unified conditions: one switch applies the flag to ALL categories, so the
  // tweet notification is global (trenches + photon alike).
  const setTweetCondition = async (cond: 'watchlist' | 'others', value: boolean) => {
    const next: TrackerTweets = {
      ...trackerTweets,
      [cond]: { new_creation: value, completed: value, photon_new: value, photon_graduated: value },
    };
    setTrackerTweets(next);
    await persistConfig(notifCategories, filters, next);
  };

  const updateFilter = async (cat: string, field: NotificationFilterFields, bound: 'min' | 'max', value: string) => {
    const numVal = value === '' ? undefined : Number(value);
    const catFilters = { ...(filters[cat] || {}) };
    const range = { ...(catFilters[field] || {}) };
    range[bound] = numVal;
    if (range.min == null && range.max == null) {
      delete catFilters[field];
    } else {
      catFilters[field] = range;
    }
    const next = { ...filters, [cat]: catFilters };
    if (Object.keys(catFilters).length === 0) delete next[cat];
    setFilters(next);
    await persistConfig(notifCategories, next, trackerTweets);
  };

  const clearCategoryFilters = async (cat: string) => {
    const next = { ...filters };
    delete next[cat];
    setFilters(next);
    await persistConfig(notifCategories, next, trackerTweets);
  };

  const watchlistTweetsOn = Object.values(trackerTweets.watchlist).some(Boolean);
  const othersTweetsOn = Object.values(trackerTweets.others).some(Boolean);
  const tweetFlagsOn = watchlistTweetsOn || othersTweetsOn;
  const isAnyNotifOn = Object.values(notifCategories).some(Boolean) || tweetFlagsOn;

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={theme.text} />
          </Pressable>
          <ThemedText type="smallBold" style={{ color: theme.text }}>Notificaciones</ThemedText>
        </View>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Card>
            <View style={styles.rowBetween}>
              <ThemedText type="smallBold">Notificaciones push</ThemedText>
              {pushToken && isAnyNotifOn && (
                <ThemedText type="small" style={{ color: theme.positive }}>Activo</ThemedText>
              )}
            </View>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Recibe un aviso por push cuando llegue un token nuevo a cada categoría.
            </ThemedText>
            {pushToken ? (
              <ThemedText type="small" style={{ color: theme.positive }}>
                Push token registrado
              </ThemedText>
            ) : null}

            {NOTIF_CATEGORIES.map((cat) => {
              const isExpanded = expandedCat === cat;
              const expandable = FILTERABLE_CATEGORIES.has(cat);
              const hasFilters = filters[cat] && Object.keys(filters[cat]).length > 0;
              const toggleExpand = () => setExpandedCat(isExpanded ? null : cat);
              return (
                <View key={cat}>
                  <View style={[styles.notifRow, { borderColor: theme.border }]}>
                    <Pressable style={{ flex: 1 }} onPress={expandable ? toggleExpand : undefined}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <ThemedText type="smallBold">{NOTIF_LABELS[cat]}</ThemedText>
                        {hasFilters && <ThemedText type="small" style={{ color: theme.accent }}>*</ThemedText>}
                      </View>
                      {NOTIF_HINTS[cat] && (
                        <ThemedText type="small" style={{ color: theme.textSecondary }}>{NOTIF_HINTS[cat]}</ThemedText>
                      )}
                    </Pressable>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      {expandable && (
                        <Pressable onPress={toggleExpand}>
                          <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={18} color={theme.textSecondary} />
                        </Pressable>
                      )}
                      <Switch
                        value={notifCategories[cat]}
                        onValueChange={() => toggleNotifCategory(cat)}
                        trackColor={{ true: theme.accent }}
                      />
                    </View>
                  </View>

                  {isExpanded && expandable && (
                    <View style={[styles.filterPanel, { backgroundColor: theme.backgroundSelected }]}>
                      <View style={styles.filterHeader}>
                        <ThemedText type="small" style={{ color: theme.textSecondary }}>Filtros de notificación</ThemedText>
                        {hasFilters && (
                          <Pressable onPress={() => clearCategoryFilters(cat)}>
                            <ThemedText type="small" style={{ color: theme.warn }}>Limpiar</ThemedText>
                          </Pressable>
                        )}
                      </View>
                      {FILTER_FIELDS.map((f) => {
                        const range = filters[cat]?.[f.key];
                        return (
                          <View key={f.key} style={styles.filterRow}>
                            <ThemedText type="small" style={{ color: theme.textSecondary, width: 110 }}>{f.label}</ThemedText>
                            <TextInput
                              value={range?.min != null ? String(range.min) : ''}
                              onChangeText={(v) => updateFilter(cat, f.key, 'min', v)}
                              placeholder="Min"
                              keyboardType="numeric"
                              placeholderTextColor={theme.textSecondary}
                              style={[styles.filterInput, { backgroundColor: theme.background, color: theme.text, borderColor: theme.border }]}
                            />
                            <ThemedText type="small" style={{ color: theme.textSecondary }}>-</ThemedText>
                            <TextInput
                              value={range?.max != null ? String(range.max) : ''}
                              onChangeText={(v) => updateFilter(cat, f.key, 'max', v)}
                              placeholder="Max"
                              keyboardType="numeric"
                              placeholderTextColor={theme.textSecondary}
                              style={[styles.filterInput, { backgroundColor: theme.background, color: theme.text, borderColor: theme.border }]}
                            />
                          </View>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
            })}
          </Card>

          <Card>
            <View style={styles.rowBetween}>
              <ThemedText type="smallBold">Tweets de tokens en Tracker</ThemedText>
              {tweetFlagsOn && <ThemedText type="small" style={{ color: theme.positive }}>Activo</ThemedText>}
            </View>
            <ThemedText type="small" style={{ color: theme.textSecondary }}>
              Vale para todas las categorías: avisa cuando un token que está en rastreo tenga un tweet,
              venga de trenches o de photon.
            </ThemedText>
            <View style={[styles.tweetBox, { backgroundColor: theme.backgroundSelected, borderColor: theme.border }]}>
              <View style={styles.tweetRow}>
                <View style={{ flex: 1 }}>
                  <ThemedText type="small">Cuentas vigiladas</ThemedText>
                  <ThemedText type="small" style={{ color: theme.textSecondary, fontSize: 11 }}>@AutorunAlert · @bitecong</ThemedText>
                </View>
                <Switch
                  value={watchlistTweetsOn}
                  onValueChange={(v) => setTweetCondition('watchlist', v)}
                  trackColor={{ true: theme.accent }}
                />
              </View>
              <View style={styles.tweetRow}>
                <View style={{ flex: 1 }}>
                  <ThemedText type="small">Otras cuentas</ThemedText>
                  <ThemedText type="small" style={{ color: theme.textSecondary, fontSize: 11 }}>Cada tweet que no sea de esas dos</ThemedText>
                </View>
                <Switch
                  value={othersTweetsOn}
                  onValueChange={(v) => setTweetCondition('others', v)}
                  trackColor={{ true: theme.accent }}
                />
              </View>
            </View>
          </Card>
        </ScrollView>
      </SafeAreaView>
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
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  notifRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  filterPanel: { padding: 12, borderRadius: 8, marginTop: 4, marginBottom: 8, gap: 8 },
  filterHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  filterInput: { flex: 1, borderWidth: 1, borderRadius: 6, padding: 6, fontSize: 12, textAlign: 'center' },
  tweetBox: {
    padding: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 6,
    marginBottom: 8,
    gap: 8,
  },
  tweetRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
});
