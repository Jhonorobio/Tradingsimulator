import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ThemedText } from '@/components/themed-text';
import { TokenAvatar } from '@/components/token-avatar';
import { useTheme } from '@/hooks/use-theme';
import { fmtUsd, timeAgo } from '@/utils/format';
import type { TrenchesItem } from '@/api/types';

const GREEN = '#22c55e';
const AMBER = '#f59e0b';

export function TokenRow({ token, chain = 'sol' }: { token: TrenchesItem; chain?: string }) {
  const router = useRouter();
  const theme = useTheme();

  const mcap = token.usd_market_cap ?? token.market_cap ?? 0;
  const volume = token.volume_24h ?? token.volume_1h ?? 0;
  const age = timeAgo(token.created_timestamp ?? token.open_timestamp);

  return (
    <Pressable
      onPress={() => router.push(`/token/${chain}/${token.address}`)}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.75 }]}>
      <View style={styles.mainRow}>
        {/* Avatar */}
        <View style={[styles.avatarWrap, { borderColor: GREEN }]}>
          <TokenAvatar logo={token.logo} symbol={token.symbol} size={54} borderRadius={13} />
        </View>

        {/* Two clean rows to the right of the avatar */}
        <View style={styles.contentCol}>
          {/* Row 1: symbol + name (left) · MC (right) */}
          <View style={styles.row}>
            <View style={styles.leftGroup}>
              <ThemedText
                type="smallBold"
                numberOfLines={1}
                style={[styles.symbolText, { color: theme.text }]}>
                {token.symbol || '???'}
              </ThemedText>
              <ThemedText
                numberOfLines={1}
                style={[styles.nameText, { color: theme.textSecondary }]}>
                {token.name || 'Token'}
              </ThemedText>
            </View>
            <View style={styles.rightGroup}>
              <ThemedText style={[styles.valueLabel, { color: theme.textSecondary }]}>MC</ThemedText>
              <ThemedText type="smallBold" style={[styles.valueText, { color: GREEN }]}>
                {fmtUsd(mcap, { compact: true })}
              </ThemedText>
            </View>
          </View>

          {/* Row 2: time (left) · V (right) */}
          <View style={styles.row}>
            <View style={styles.leftGroup}>
              <ThemedText style={[styles.ageText, { color: GREEN }]}>{age}</ThemedText>
            </View>
            <View style={styles.rightGroup}>
              <ThemedText style={[styles.valueLabel, { color: theme.textSecondary }]}>V</ThemedText>
              <ThemedText type="smallBold" style={[styles.valueText, { color: AMBER }]}>
                {fmtUsd(volume, { compact: true })}
              </ThemedText>
            </View>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#111111',
    borderRadius: 12,
    padding: 10,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  avatarWrap: {
    width: 59,
    height: 59,
    borderRadius: 13,
    borderWidth: 1.5,
    position: 'relative',
    flexShrink: 0,
  },
  badge: {
    position: 'absolute',
    bottom: -4,
    right: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#111111',
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contentCol: { flex: 1, gap: 7 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  leftGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  rightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 0,
  },
  symbolText: { fontSize: 17, fontWeight: '700' },
  nameText: { fontSize: 13, maxWidth: 160 },
  ageText: { fontSize: 13, fontWeight: '700' },
  valueLabel: { fontSize: 11 },
  valueText: { fontSize: 13 },
});