import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

const LAUNCHPAD_ICONS: Record<string, string> = {
  'pump.fun': 'P',
  robinhood: 'R',
  PancakeSwap: '🥞',
  'Raydium CLMM': 'R',
  Raydium: 'R',
  Meteora: 'M',
};

export function TokenAvatar({
  logo,
  symbol,
  size = 40,
  borderRadius,
  launchpad,
  borderColor,
}: {
  logo?: string | null;
  symbol?: string | null;
  size?: number;
  borderRadius?: number;
  launchpad?: string | null;
  borderColor?: string;
}) {
  const theme = useTheme();
  const br = borderRadius ?? size / 2;
  const badgeSize = Math.max(16, size * 0.32);
  const launchpadLabel = launchpad ? LAUNCHPAD_ICONS[launchpad] ?? launchpad.charAt(0).toUpperCase() : null;

  const image = logo ? (
    <Image
      source={{ uri: logo }}
      style={{ width: size, height: size, borderRadius: br }}
      contentFit="cover"
      transition={150}
    />
  ) : (
    <View
      style={[
        styles.fallback,
        { width: size, height: size, borderRadius: br, backgroundColor: theme.backgroundSelected },
      ]}>
      <ThemedText type="smallBold" style={{ fontSize: size * 0.32 }}>
        {(symbol ?? '?').slice(0, 3).toUpperCase()}
      </ThemedText>
    </View>
  );

  if (!launchpadLabel) return image;

  return (
    <View style={{ width: size, height: size }}>
      {image}
      <View style={[styles.badge, { width: badgeSize, height: badgeSize, borderRadius: badgeSize / 2, bottom: -2, right: -2 }]}>
        <ThemedText style={{ fontSize: badgeSize * 0.55, fontWeight: '700', color: '#fff' }}>
          {launchpadLabel}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    backgroundColor: '#1a6bba',
    borderWidth: 1.5,
    borderColor: '#111111',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
