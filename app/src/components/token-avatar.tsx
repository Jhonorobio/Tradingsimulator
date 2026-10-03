import { useState } from 'react';
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/hooks/use-theme';

export function TokenAvatar({
  logo,
  symbol,
  size = 40,
  borderRadius,
  borderColor,
  headers,
}: {
  logo?: string | null;
  symbol?: string | null;
  size?: number;
  borderRadius?: number;
  launchpad?: string | null;
  borderColor?: string;
  /** Extra HTTP headers for the image request (some CDNs check Referer). */
  headers?: Record<string, string>;
}) {
  const theme = useTheme();
  const br = borderRadius ?? size / 2;
  // Track WHICH uri failed so a different logo renders again (no effect needed).
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const failed = logo != null && failedUri === logo;

  // Photon's CDN 403s image requests without its own Referer (hotlink guard).
  const autoHeaders = (uri: string): Record<string, string> | undefined => {
    try {
      if (new URL(uri).hostname.endsWith('tradewithphoton.com')) {
        return { referer: 'https://photon-sol.tinyastro.io/' };
      }
    } catch {}
    return undefined;
  };

  if (logo && !failed) {
    const reqHeaders = headers ?? autoHeaders(logo);
    return (
      <Image
        source={reqHeaders ? { uri: logo, headers: reqHeaders } : { uri: logo }}
        style={{ width: size, height: size, borderRadius: br }}
        contentFit="cover"
        transition={150}
        onError={() => setFailedUri(logo)}
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
