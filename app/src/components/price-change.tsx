import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { fmtPct } from '@/utils/format';

export function PriceChange({ value, style }: { value: number | null | undefined; style?: object }) {
  const theme = useTheme();
  if (value == null || isNaN(value)) {
    return <ThemedText type="small" style={[{ color: theme.textSecondary }, style]}>—</ThemedText>;
  }
  const color = value > 0 ? theme.positive : value < 0 ? theme.negative : theme.textSecondary;
  return (
    <ThemedText type="smallBold" style={[{ color }, style]}>
      {fmtPct(value)}
    </ThemedText>
  );
}