import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '@/components/themed-text';
import { TokenAvatar } from '@/components/token-avatar';
import { useTheme } from '@/hooks/use-theme';
import { fmtUsd, timeAgo } from '@/utils/format';
import { useSettings, DEFAULT_RANGES, getColorForValue } from '@/store/settings';
import type { ColorRanges, ChainKey } from '@/store/settings';
import type { TrenchesItem } from '@/api/types';

interface StatItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string | null;
  color: string;
}

function StatsBar({ stats }: { stats: StatItem[] }) {
  const visible = stats.filter((s) => s.value != null);
  if (visible.length === 0) return null;
  return (
    <View style={styles.statsBar}>
      {visible.map((s, i) => (
        <View key={i} style={styles.statItem}>
          <Ionicons name={s.icon} size={13} color={s.color} />
          <ThemedText style={[styles.statValue, { color: s.color }]}>
            {s.value}
          </ThemedText>
        </View>
      ))}
    </View>
  );
}

export function TokenRow({ token, chain = 'sol' }: { token: TrenchesItem; chain?: string }) {
  const router = useRouter();
  const theme = useTheme();
  const { colorRangesByChain } = useSettings();

  const chainKey: ChainKey = chain === 'robinhood' ? 'robinhood' : chain === 'bsc' ? 'bsc' : 'solana';
  const c = colorRangesByChain[chainKey] ?? DEFAULT_RANGES;

  const mcap = token.usd_market_cap ?? token.market_cap ?? 0;
  const volume = token.volume_24h ?? token.volume_1h ?? 0;
  const age = timeAgo(token.created_timestamp ?? token.open_timestamp);

  const fmt = (n: number | null | undefined, pct = true) => {
    if (n == null) return null;
    return pct ? `${(n * 100).toFixed(0)}%` : String(n);
  };

  const fresh = token.fresh_wallet_rate;
  const kol = token.renowned_count;
  const smart = token.smart_degen_count;
  const botRate = token.bot_degen_rate;
  const botCount = token.bot_degen_count;
  const rug = token.rug_ratio;
  const phish = token.entrapment_ratio;
  const bundler = token.bundler_rate ?? token.bundler_trader_amount_rate;

  const stats: StatItem[] = [
    { icon: 'leaf', label: 'Fresh', value: fmt(fresh), color: getColorForValue(c.fresh, fresh != null ? fresh * 100 : null) },
    { icon: 'star', label: 'KOL', value: fmt(kol, false), color: getColorForValue(c.kol, kol) },
    { icon: 'wallet', label: 'Smart', value: fmt(smart, false), color: getColorForValue(c.smart, smart) },
    { icon: 'bug', label: 'Bot', value: botRate != null ? `${fmt(botRate)} (${fmt(botCount, false)})` : fmt(botCount, false), color: getColorForValue(c.bot, botRate != null ? botRate * 100 : botCount) },
    { icon: 'warning', label: 'Rug', value: fmt(rug), color: getColorForValue(c.rug, rug != null ? rug * 100 : null) },
    { icon: 'layers', label: 'Bundle', value: fmt(bundler), color: getColorForValue(c.phish, bundler != null ? bundler * 100 : null) },
    { icon: 'fish', label: 'Phish', value: fmt(phish), color: getColorForValue(c.phish, phish != null ? phish * 100 : null) },
  ];

  return (
    <Pressable
      onPress={() => router.push(`/token/${chain}/${token.address}`)}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.75 }]}>
      <View style={styles.mainRow}>
        {/* Avatar */}
        <View style={[styles.avatarWrap, { borderColor: chain === 'robinhood' ? '#CCFF00' : chain === 'bsc' ? '#f97316' : '#a855f7' }]}>
          <TokenAvatar
            logo={token.logo}
            symbol={token.symbol}
            size={50}
            borderRadius={4}
          />
        </View>

        {/* Content */}
        <View style={styles.contentCol}>
          {/* Row 1: symbol + name · MC */}
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
              <ThemedText type="small" style={[styles.valueText, { fontWeight: '500', color: getColorForValue(c.mcap, mcap) }]}>
                {fmtUsd(mcap, { compact: true })}
              </ThemedText>
            </View>
          </View>

          {/* Row 2: time · V */}
          <View style={styles.row}>
            <View style={styles.leftGroup}>
              <ThemedText style={[styles.ageText, { color: getColorForValue(c.fresh, fresh != null ? fresh * 100 : null) }]}>{age}</ThemedText>
            </View>
            <View style={styles.rightGroup}>
              <ThemedText style={[styles.valueLabel, { color: theme.textSecondary }]}>V</ThemedText>
              <ThemedText type="small" style={[styles.valueText, { fontWeight: '500', color: getColorForValue(c.volume, volume) }]}>
                {fmtUsd(volume, { compact: true })}
              </ThemedText>
            </View>
          </View>
        </View>
      </View>

      {/* Stats bar */}
      <StatsBar stats={stats} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#111111',
    borderRadius: 12,
    padding: 10,
    gap: 8,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  avatarWrap: {
    borderWidth: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  contentCol: { flex: 1, gap: 0 },
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
  symbolText: { fontSize: 17, fontWeight: '600' },
  nameText: { fontSize: 13, maxWidth: 160 },
  ageText: { fontSize: 13, fontWeight: '400' },
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
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
  },
  statValue: {
    fontSize: 12,
    fontWeight: '500',
  },
});
