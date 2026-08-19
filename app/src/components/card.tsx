import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/use-theme';

export function Card({ style, children }: { style?: ViewStyle; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 8,
  },
});