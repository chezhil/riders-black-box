import { BarlowCondensed_600SemiBold } from '@expo-google-fonts/barlow-condensed/600SemiBold';
import { BarlowCondensed_700Bold } from '@expo-google-fonts/barlow-condensed/700Bold';
import { BarlowCondensed_800ExtraBold_Italic } from '@expo-google-fonts/barlow-condensed/800ExtraBold_Italic';
import { BarlowCondensed_900Black_Italic } from '@expo-google-fonts/barlow-condensed/900Black_Italic';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider, router, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AppState, View } from 'react-native';

import { RideMonitor } from '@modules/ride-monitor';

import { Colors, Fonts } from '@/constants/theme';
import { rideSession, unseenNativeCrash, type CrashTrigger } from '@/lib/ride-session';
import { actions, getState, newId, useApp } from '@/lib/store';

SplashScreen.preventAutoHideAsync();

/**
 * Screens allowed to show over the lock screen: the ride dash, and the crash /
 * help flow (the same info the native bystander screen shows). Leaving them
 * while locked drops back to the lock screen, so the rest of the app (contacts,
 * medical card, settings, history) always needs an unlock.
 */
const LOCK_SCREEN_ROUTES = new Set([
  '/ride-dash',
  '/crash-alert',
  '/checkin',
  '/outcome/emergency',
  '/outcome/hospitals',
  '/outcome/first-aid',
]);

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
  // A font that fails to load falls back to the system face; never block on it.
  const [fontsLoaded, fontError] = useFonts({
    BarlowCondensed_600SemiBold,
    BarlowCondensed_700Bold,
    BarlowCondensed_800ExtraBold_Italic,
    BarlowCondensed_900Black_Italic,
  });
  const fontsReady = fontsLoaded || fontError != null;
  // Read inside the crash listeners below, which are set up once.
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  const rideActive = useSyncExternalStore(rideSession.subscribe, () => rideSession.getSnapshot().active);
  useEffect(() => {
    if (!RideMonitor) return;
    const allowed = LOCK_SCREEN_ROUTES.has(pathname) && (rideActive || pathname === '/crash-alert');
    RideMonitor.setShowWhenLocked(allowed).catch(() => {});
  }, [pathname, rideActive]);

  useEffect(() => {
    actions.load();
  }, []);

  useEffect(() => {
    if (loaded && fontsReady) SplashScreen.hideAsync();
  }, [loaded, fontsReady]);

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

    // Reopened the app (e.g. from the notification or the lock-screen alert) after the
    // service raised a crash JS never saw: mid-countdown, or already escalated.
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const catchUp = () => {
      const c = unseenNativeCrash();
      if (!c || pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (getState().crashes.some((x) => x.id === c.id)) return;
        const location = c.lat != null && c.lng != null ? { lat: c.lat, lng: c.lng } : null;
        const rideId = rideSession.getSnapshot().rideId;
        if (c.status === 'countdown') {
          open({ id: c.id, rideId, location, peakG: c.peakG, via: c.via, deadline: c.deadline });
          return;
        }
        // 'alerted' (no response: contacts texted, siren, calls) or 'help' (asked from the lock screen).
        const alerted = c.status === 'alerted';
        actions.addCrash({
          id: c.id,
          rideId,
          timestamp: c.startedAt,
          location,
          detectedVia: c.via,
          peakG: c.peakG,
          response: alerted ? 'no_response' : 'needs_help',
          contactsNotified: alerted && c.smsSent > 0,
          notifyChannel: alerted && c.smsSent > 0 ? 'sim' : 'none',
        });
        // Already in the incident flow (e.g. the lock screen's "Locate nearest hospital"
        // opened Nearby help): record the crash but don't cover that screen.
        const path = pathnameRef.current;
        if (path.startsWith('/outcome') || path === '/checkin' || path === '/crash-alert') return;
        router.push({ pathname: '/checkin', params: { crashId: c.id, auto: alerted ? '1' : '' } });
      }, 300);
    };
    catchUp();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') catchUp();
    });
    return () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      appState.remove();
      offCrash();
      offResolved();
    };
  }, [loaded]);

  if (!loaded || !fontsReady) return null;

  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      {/* Any touch = the rider is handling the phone: a jolt now isn't a crash. */}
      <View
        style={{ flex: 1 }}
        onStartShouldSetResponderCapture={() => {
          rideSession.noteInteraction();
          return false; // only listening: the touch still goes to whatever was tapped
        }}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: Colors.bg },
          headerTintColor: Colors.text,
          headerTitleStyle: { fontFamily: Fonts.displayBold, fontSize: 22 },
          headerShadowVisible: false,
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
        <Stack.Screen name="ride-dash" options={{ headerShown: false, animation: 'fade' }} />
      </Stack>
      </View>
    </ThemeProvider>
  );
}
