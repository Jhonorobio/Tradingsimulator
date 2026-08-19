import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

export function TokenAvatar({
  logo,
  symbol,
  size = 40,
  borderRadius,
}: {
  logo?: string | null;
  symbol?: string | null;
  size?: number;
  borderRadius?: number;
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
      <ThemedText type="smallBold" style={{ fontSize: size * 0.32 }}>
        {(symbol ?? '?').slice(0, 3).toUpperCase()}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});