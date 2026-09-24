import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';

import type { IconName } from '@/components/ui';
import { Colors } from '@/constants/theme';
import { useApp } from '@/lib/store';

function icon(name: IconName) {
  return function TabBarIcon({ color, size }: { color: ColorValue; size: number }) {
    return <Ionicons name={name} color={color} size={size} />;
  };
}

export default function TabLayout() {
  const onboarded = useApp((s) => s.onboarded);
  if (!onboarded) return <Redirect href="/onboarding" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.textFaint,
        tabBarStyle: { backgroundColor: Colors.surface, borderTopColor: Colors.border },
        tabBarLabelStyle: { fontWeight: '600' },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon('speedometer') }} />
      <Tabs.Screen name="history" options={{ title: 'History', tabBarIcon: icon('time') }} />
      <Tabs.Screen name="profile" options={{ title: 'Contacts', tabBarIcon: icon('people') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('settings') }} />
    </Tabs>
  );
}
