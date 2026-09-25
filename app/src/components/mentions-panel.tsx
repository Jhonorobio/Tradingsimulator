import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Card } from '@/components/card';
import { useTheme } from '@/hooks/use-theme';
import { getMentions, type MentionItem } from '@/api/market';
import { ApiError } from '@/api/client';

const REFRESH_MS = 30_000;

function fmtCount(n?: number): string {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** "Hoy 14:32" / "Ayer 09:10" / "12/03 18:45" (mirrors the extension). */
function fmtTweetTime(ts?: string | number): string {
  let n = Number(ts);
  if (!ts || !Number.isFinite(n)) return '';
  if (n < 1e11) n *= 1000; // seconds -> ms
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  if (d.toDateString() === now.toDateString()) return `Hoy ${hm}`;
  if (d.toDateString() === yesterday.toDateString()) return `Ayer ${hm}`;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
}

function openTweet(handle?: string, tweetId?: string) {
  if (!handle || !tweetId) return;
  const url = `https://x.com/${handle}/status/${tweetId}`;
  Linking.openURL(url).catch(() => {});
}

function MentionRow({ item, onPress }: { item: MentionItem; onPress: () => void }) {
  const theme = useTheme();
  const u = item.user || {};
  const media = (item.content?.media || []).find((m) => m.type === 'image');
  const isReply = item.tw_type === 'reply';
  const timeLabel = fmtTweetTime(item.tw_timestamp);

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.mention, pressed && { opacity: 0.7 }]}>
      {u.avatar ? (
        <Image source={{ uri: u.avatar }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: theme.backgroundSelected }]} />
      )}
      <View style={{ flex: 1 }}>
        <View style={styles.mentionHead}>
          <ThemedText type="smallBold" numberOfLines={1} style={{ flexShrink: 1 }}>
            @{u.screen_name || 'user'}{u.verified ? ' ✓' : ''}{isReply ? ' · reply' : ''}
          </ThemedText>
          <ThemedText type="small" style={{ color: theme.textSecondary, fontSize: 11 }}>
            {fmtCount(u.followers)} seg{timeLabel ? ` · ${timeLabel}` : ''}
          </ThemedText>
        </View>
        <ThemedText type="small" style={{ color: theme.text }} numberOfLines={4}>
          {item.content?.text || ''}
        </ThemedText>
        {media?.url ? <Image source={{ uri: media.url }} style={styles.media} /> : null}
      </View>
    </Pressable>
  );
}

/**
 * "X Tracker": token mentions pulled from GMGN's internal Twitter endpoint.
 * Polls every 30s (server caches 60s and paces upstream at 1 req/s).
 */
export function MentionsPanel({ mint, limit = 10 }: { mint: string; limit?: number }) {
  const theme = useTheme();
  const [items, setItems] = useState<MentionItem[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!mint) return;
    try {
      const res = await getMentions(mint, limit);
      setItems(res.items || []);
      setError(res.error || null);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setError('Server sin endpoint de menciones — actualiza el server');
      } else if (e instanceof ApiError) {
        setError(`Server: ${e.message}`);
      } else {
        setError('No se pudo conectar con el server');
      }
    } finally {
      setLoading(false);
    }
  }, [mint, limit]);

  useEffect(() => {
    // Defer the first fetch so setState never runs synchronously in the effect.
    const first = setTimeout(load, 0);
    const timer = setInterval(load, REFRESH_MS);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [load]);

  return (
    <Card>
      <View style={styles.header}>
        <View style={[styles.xBadge, { backgroundColor: theme.backgroundSelected }]}>
          <ThemedText type="smallBold" style={{ fontSize: 11 }}>X</ThemedText>
        </View>
        <ThemedText type="smallBold" style={{ flex: 1 }}>
          X Tracker{items.length ? ` · ${items.length} menc.` : ''}
        </ThemedText>
        {updatedAt ? (
          <ThemedText type="small" style={{ color: theme.textSecondary, fontSize: 11 }}>
            act. {new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </ThemedText>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.stateRow}>
          <ActivityIndicator size="small" color={theme.accent} />
          <ThemedText type="small" style={{ color: theme.textSecondary }}>Cargando menciones…</ThemedText>
        </View>
      ) : error === 'BACKOFF' ? (
        <ThemedText type="small" style={{ color: theme.warn }}>
          GMGN limitó las peticiones. Se reintentará en ~60s.
        </ThemedText>
      ) : error && !items.length ? (
        <ThemedText type="small" style={{ color: theme.negative }}>Error: {error}</ThemedText>
      ) : !items.length ? (
        <ThemedText type="small" style={{ color: theme.textSecondary }}>Sin menciones todavía.</ThemedText>
      ) : (
        <View style={{ gap: 12 }}>
          {items.map((item, i) => (
            <MentionRow
              key={item.tweet_id || i}
              item={item}
              onPress={() => openTweet(item.user?.screen_name, item.tweet_id)}
            />
          ))}
          {error ? (
            <ThemedText type="small" style={{ color: theme.textSecondary, fontSize: 11 }}>
              Datos cacheados — GMGN limitó las peticiones.
            </ThemedText>
          ) : null}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  xBadge: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  mention: { flexDirection: 'row', gap: 10 },
  avatar: { width: 32, height: 32, borderRadius: 16 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  mentionHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginBottom: 2 },
  media: { width: '100%', height: 140, borderRadius: 8, marginTop: 6, backgroundColor: '#00000020' },
});
