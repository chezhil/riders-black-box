import { Redirect, Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon, type AppIconName } from '@/components/ui';
import { Colors, Fonts } from '@/constants/theme';
import { useApp } from '@/lib/store';

function icon(name: AppIconName) {
  return function TabBarIcon({ color, size }: { color: ColorValue; size: number }) {
    return <AppIcon name={name} color={color as string} size={size} />;
  };
}

export default function TabLayout() {
  const onboarded = useApp((s) => s.onboarded);
  const insets = useSafeAreaInsets();
  if (!onboarded) return <Redirect href="/onboarding" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.textFaint,
        // Taller than the default so the condensed labels aren't clipped; big targets for gloves.
        tabBarStyle: {
          backgroundColor: Colors.surface,
          borderTopColor: Colors.border,
          borderTopWidth: 1,
          height: 62 + insets.bottom,
          paddingTop: 6,
          paddingBottom: insets.bottom + 6,
        },
        tabBarLabelStyle: {
          fontFamily: Fonts.heading,
          fontSize: 13,
          lineHeight: 16,
          minHeight: 16,
          flexShrink: 0,
          letterSpacing: 1,
          textTransform: 'uppercase',
        },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Ride', tabBarIcon: icon('mci:motorbike') }} />
      <Tabs.Screen name="history" options={{ title: 'Logbook', tabBarIcon: icon('mci:book-open-variant') }} />
      <Tabs.Screen name="profile" options={{ title: 'Contacts', tabBarIcon: icon('people') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('mci:tune-vertical') }} />
    </Tabs>
  );
}
