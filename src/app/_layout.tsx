import { DarkTheme, Stack, ThemeProvider, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { Colors } from '@/constants/theme';
import { rideSession } from '@/lib/ride-session';
import { actions, newId, useApp } from '@/lib/store';

SplashScreen.preventAutoHideAsync();

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: Colors.accent,
    background: Colors.bg,
    card: Colors.surface,
    text: Colors.text,
    border: Colors.border,
  },
};

export default function RootLayout() {
  const loaded = useApp((s) => s.loaded);

  useEffect(() => {
    actions.load().finally(() => SplashScreen.hideAsync());
  }, []);

  // Any detected (or simulated) crash opens the full-screen "Are you OK?" alert.
  useEffect(
    () =>
      rideSession.onCrash((trigger) => {
        const id = newId();
        actions.addCrash({
          id,
          rideId: trigger.rideId,
          timestamp: Date.now(),
          location: trigger.location,
          detectedVia: trigger.via,
          peakG: trigger.peakG,
          response: 'pending',
          contactsNotified: false,
          notifyChannel: 'none',
        });
        router.push({ pathname: '/crash-alert', params: { crashId: id } });
      }),
    [],
  );

  if (!loaded) return null;

  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: Colors.bg },
          headerTintColor: Colors.text,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: Colors.bg },
        }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="active-ride" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen
          name="crash-alert"
          options={{ headerShown: false, presentation: 'fullScreenModal', gestureEnabled: false, animation: 'fade' }}
        />
        <Stack.Screen name="checkin" options={{ title: 'Injury check-in' }} />
        <Stack.Screen name="outcome/first-aid" options={{ title: 'First aid' }} />
        <Stack.Screen name="outcome/hospitals" options={{ title: 'Nearby help' }} />
        <Stack.Screen name="outcome/emergency" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="ride/[id]" options={{ title: 'Ride' }} />
      </Stack>
    </ThemeProvider>
  );
}
