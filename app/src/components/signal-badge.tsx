import { StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { signalFromToken } from '@/utils/format';
import type { TrenchesItem } from '@/api/types';

const LABELS = { pass: 'PASS', watch: 'WATCH', skip: 'SKIP' } as const;

export function SignalBadge({ token }: { token: TrenchesItem }) {
  const theme = useTheme();
  const signal = signalFromToken(token);
  const colors: Record<string, string> = {
    pass: theme.positive,
    watch: theme.warn,
    skip: theme.negative,
  };
  const bg: Record<string, string> = {
    pass: theme.positive + '22',
    watch: theme.warn + '22',
    skip: theme.negative + '22',
  };
  return (
    <View style={[styles.badge, { backgroundColor: bg[signal] }]}>
      <ThemedText type="smallBold" style={[styles.text, { color: colors[signal] }]}>
        {LABELS[signal]}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: 11,
    lineHeight: 14,
  },
});