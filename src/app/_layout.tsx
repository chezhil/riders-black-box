import { DarkTheme, Stack, ThemeProvider, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { Colors } from '@/constants/theme';
import { pendingNativeCrash, rideSession, type CrashTrigger } from '@/lib/ride-session';
import { actions, getState, newId, useApp } from '@/lib/store';

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
  useEffect(() => {
    if (!loaded) return;
    const open = (trigger: CrashTrigger) => {
      const id = trigger.id ?? newId();
      if (!getState().crashes.some((c) => c.id === id)) {
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
      }
      router.push({
        pathname: '/crash-alert',
        params: { crashId: id, deadline: trigger.deadline ? String(trigger.deadline) : '' },
      });
    };
    const offCrash = rideSession.onCrash(open);

    // Native service answered/escalated the crash (notification, lock screen, or timeout).
    const offResolved = rideSession.onCrashResolved((r) => {
      actions.updateCrash(r.id, {
        response: r.outcome === 'fine' ? 'confirmed_fine' : r.outcome === 'help' ? 'needs_help' : 'no_response',
        ...(r.outcome === 'alerted'
          ? { contactsNotified: r.smsSent > 0, notifyChannel: r.smsSent > 0 ? 'sim' : 'none' }
          : {}),
        ...(r.location ? { location: r.location } : {}),
      });
    });

    // Reopened the app mid-countdown (e.g. from the notification) before JS saw the event.
    const pending = pendingNativeCrash();
    const pendingTimer =
      pending && !getState().crashes.some((c) => c.id === pending.id)
        ? setTimeout(() =>
            open({
              id: pending.id,
              rideId: rideSession.getSnapshot().rideId,
              location: pending.lat != null && pending.lng != null ? { lat: pending.lat, lng: pending.lng } : null,
              peakG: pending.peakG,
              via: pending.via,
              deadline: pending.deadline,
            }),
          300,
          )
        : null;
    return () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      offCrash();
      offResolved();
    };
  }, [loaded]);

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
