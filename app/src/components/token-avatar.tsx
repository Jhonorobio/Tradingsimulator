import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/hooks/use-theme';

export function TokenAvatar({
  logo,
  symbol,
  size = 40,
  borderRadius,
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

  if (logo) {
    return (
      <Image
        source={{ uri: logo }}
        style={{ width: size, height: size, borderRadius: br }}
        contentFit="cover"
        transition={150}
      />
    );
  }

  return (
    <View
      style={[
        styles.fallback,
        { width: size, height: size, borderRadius: br, backgroundColor: theme.backgroundSelected },
      ]}>
      <Text style={{ fontSize: size * 0.32, fontWeight: '700', color: '#ffffff' }}>
        {(symbol ?? '?').slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
