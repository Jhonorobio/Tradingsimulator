import { Stack } from 'expo-router';

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="server" />
      <Stack.Screen name="proxies" />
      <Stack.Screen name="budget" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="colors" />
    </Stack>
  );
}
