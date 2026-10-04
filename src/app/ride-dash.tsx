/**
 * Lock-screen ride dash: just the important stuff, big enough to read at a
 * glance. While a ride is running, this screen (and the crash / help screens)
 * may show over the lock screen: lock the phone on it and it's what you see
 * when you wake the phone. Everything else in the app still needs an unlock
 * (see the root layout).
 */
import { router } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { StyleSheet, Text, useWindowDimensions } from 'react-native';

import { RideMonitor } from '@modules/ride-monitor';

import { detectionState, Telltale } from '@/components/ride-status';
import { Speedometer } from '@/components/speedometer';
import { AppIcon, Button, Card, Row, Screen, Stat, T, type AppIconName } from '@/components/ui';
import { Colors, Fonts, Radius, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useResumeDetectionOnFocus } from '@/hooks/use-resume-detection';
import { formatDistance, formatDuration, formatTime, toKmh } from '@/lib/geo';
import { backgroundCapable, rideSession, type RideSnapshot } from '@/lib/ride-session';
import { useApp } from '@/lib/store';
import type { CrashEvent } from '@/lib/types';

const JOLT_SHOWN_MS = 10 * 60_000;

export default function RideDash() {
  const ride = useSyncExternalStore(rideSession.subscribe, rideSession.getSnapshot);
  // Newest first, so this is the latest crash of this ride.
  const crash = useApp((s) => (ride.rideId ? s.crashes.find((c) => c.rideId === ride.rideId) : undefined));
  const now = useNow();
  const { width, height } = useWindowDimensions();
  useResumeDetectionOnFocus();

  if (!ride.active) {
    return (
      <Screen edges={['top', 'bottom', 'left', 'right']} contentStyle={{ flexGrow: 1, justifyContent: 'center' }}>
        <T.Title style={{ textAlign: 'center' }}>No ride running</T.Title>
        <T.Dim style={{ textAlign: 'center' }}>Start a ride and the dash shows here, even on the lock screen.</T.Dim>
        <Button label="Open the app" icon="home" size="lg" onPress={openFullApp} />
      </Screen>
    );
  }

  const detection = detectionState(ride);
  const info = crashInfo(crash, ride.lastBump, now);
  // Fit on one screen without scrolling on most phones: the dial gives way first.
  const dial = Math.min(width - Spacing.lg * 2, height * 0.42, 340);

  return (
    <Screen edges={['top', 'bottom', 'left', 'right']}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Telltale icon={detection.icon} label={detection.label} color={detection.color} />
        <Row gap={6}>
          <AppIcon name="lock-closed" size={14} color={Colors.textFaint} />
          <T.Label>Ride dash</T.Label>
        </Row>
      </Row>

      <Speedometer
        kmh={toKmh(ride.currentSpeed)}
        maxKmh={toKmh(ride.maxSpeed)}
        size={dial}
        color={ride.armed && !ride.suspended ? Colors.accent : Colors.textDim}
      />

      <Card>
        <Row gap={Spacing.lg}>
          <Stat label="Time" value={formatDuration(now - ride.startTime)} />
          <Stat label="Distance" value={formatDistance(ride.distanceM)} />
        </Row>
      </Card>

      {/* The small crash bit: latest crash of this ride, else a recent jolt, else all clear. */}
      <Row style={[styles.info, { borderColor: info.color }]} gap={Spacing.sm}>
        <AppIcon name={info.icon} size={18} color={info.color} />
        <Text style={styles.infoText} numberOfLines={2}>
          {info.text}
        </Text>
      </Row>

      <Button label="I need help" icon="medkit" variant="danger" size="xl" onPress={() => router.push('/checkin')} />
      <Button label="Full app" icon="apps" variant="secondary" onPress={openFullApp} />
      {backgroundCapable && (
        <T.Dim style={{ textAlign: 'center', fontSize: 12 }}>
          Lock your phone on this screen and it stays visible on the lock screen while you ride. The rest of the app
          still needs your unlock.
        </T.Dim>
      )}
    </Screen>
  );
}

/** Leave the dash for the rest of the app; asks for PIN / fingerprint first if the phone is locked. */
async function openFullApp() {
  if (RideMonitor?.isDeviceLocked() && !(await RideMonitor.requestUnlock())) return;
  if (router.canGoBack()) router.back();
  else router.replace(rideSession.getSnapshot().active ? '/active-ride' : '/');
}

function crashInfo(
  crash: CrashEvent | undefined,
  bump: RideSnapshot['lastBump'],
  now: number,
): { text: string; color: string; icon: AppIconName } {
  if (crash) {
    const at = formatTime(crash.timestamp);
    const test = crash.detectedVia === 'simulated' ? ' (test)' : '';
    switch (crash.response) {
      case 'pending':
        return { text: `Possible crash at ${at}${test}: answer "Are you OK?"`, color: Colors.danger, icon: 'warning' };
      case 'confirmed_fine':
        return { text: `Crash check at ${at}${test}: you said you're OK`, color: Colors.ok, icon: 'checkmark-circle' };
      case 'needs_help':
        return { text: `Crash at ${at}${test}: you asked for help`, color: Colors.danger, icon: 'medkit' };
      case 'no_response':
        return {
          text: crash.contactsNotified
            ? `Crash at ${at}${test}: emergency contacts were texted`
            : `Crash at ${at}${test}: no response`,
          color: Colors.danger,
          icon: 'warning',
        };
    }
  }
  if (bump && now - bump.at < JOLT_SHOWN_MS) {
    return {
      text: `Jolt ${bump.peakG} g at ${formatTime(bump.at)}, no alert: ${JOLT_REASONS[bump.reason]}`,
      color: Colors.accent,
      icon: 'pulse',
    };
  }
  return { text: 'No crashes detected this ride', color: Colors.ok, icon: 'shield-checkmark' };
}

const JOLT_REASONS = {
  moving_again: 'you kept moving',
  not_moving: "you weren't riding",
  handling: 'phone was being handled',
  no_fall: 'no sign of a fall',
} as const;

const styles = StyleSheet.create({
  info: {
    borderWidth: 1,
    borderLeftWidth: 4,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
  },
  infoText: { flex: 1, color: Colors.text, fontFamily: Fonts.heading, fontSize: 17, lineHeight: 21 },
});
