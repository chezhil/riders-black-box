import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

import { AppIcon, Button, Card, HazardStripes, Row, Screen, Section, Stat, T } from '@/components/ui';
import { Colors, Fonts, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { formatDateTime, formatDistance, formatDuration, toKmh } from '@/lib/geo';
import { backgroundCapable, rideSession } from '@/lib/ride-session';
import { useApp } from '@/lib/store';

const IGNITION_SIZE = 230;

export default function Home() {
  const profile = useApp((s) => s.profile);
  const rides = useApp((s) => s.rides);
  const contacts = useApp((s) => s.contacts);
  const ride = useSyncExternalStore(rideSession.subscribe, rideSession.getSnapshot);
  const [starting, setStarting] = useState(false);
  // Only the running ride's clock needs per-second updates.
  const now = useNow(ride.active ? 1000 : 60_000);

  const totalKm = rides.reduce((a, r) => a + r.distanceM, 0) / 1000;
  const last = rides[0];

  async function startRide() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    if (ride.active) return router.push('/active-ride');
    setStarting(true);
    try {
      await rideSession.start();
      router.push('/active-ride');
    } catch (e) {
      Alert.alert("Can't start ride", e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Screen>
      <View>
        <Row gap={6}>
          <AppIcon name="mci:shield-car" size={16} color={Colors.accent} />
          <T.Label style={{ color: Colors.accent }}>Rider&apos;s Black Box</T.Label>
        </Row>
        <T.Title>{profile.name ? `Ride safe, ${profile.name.split(' ')[0]}` : 'Ride safe'}</T.Title>
      </View>

      <Ignition
        active={ride.active}
        starting={starting}
        elapsed={ride.active ? formatDuration(now - ride.startTime) : null}
        onPress={startRide}
      />
      <T.Dim style={{ textAlign: 'center', marginTop: -Spacing.sm }}>
        {ride.active ? 'Ride in progress · tap to open the ride screen' : 'Crash detection arms itself once you’re moving'}
      </T.Dim>

      <Button label="Report an injury" icon="medkit" variant="secondary" size="lg" onPress={() => router.push('/checkin')} />

      {contacts.length === 0 && (
        <Card style={{ borderColor: Colors.danger, gap: Spacing.md }} onPress={() => router.push('/profile')}>
          <HazardStripes color={Colors.danger} />
          <Row>
            <Ionicons name="warning" size={20} color={Colors.danger} />
            <T.H2 style={{ flex: 1 }}>No emergency contacts yet</T.H2>
          </Row>
          <T.Dim>Nobody will be alerted if you crash. Tap to add someone.</T.Dim>
        </Card>
      )}

      <Section>Odometer</Section>
      <Card>
        <Row gap={Spacing.lg}>
          <Stat label="Total" value={totalKm.toFixed(1)} unit="km" />
          <Stat label="Rides" value={String(rides.length)} />
          <Stat label="Contacts" value={String(contacts.length)} />
        </Row>
      </Card>

      <Section>Last ride</Section>
      {last ? (
        <Card onPress={() => router.push({ pathname: '/ride/[id]', params: { id: last.id } })}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T.Dim>{formatDateTime(last.startTime)}</T.Dim>
            <Ionicons name="chevron-forward" size={18} color={Colors.textFaint} />
          </Row>
          <Row gap={Spacing.lg}>
            <Stat label="Distance" value={formatDistance(last.distanceM)} />
            <Stat label="Time" value={formatDuration(last.endTime - last.startTime)} />
            <Stat label="Avg" value={toKmh(last.avgSpeed).toFixed(0)} unit="km/h" />
          </Row>
          {last.hardBrakeEvents.length > 0 && (
            <Row gap={6}>
              <AppIcon name="mci:car-brake-alert" size={16} color={Colors.danger} />
              <T.Dim>
                {last.hardBrakeEvents.length} hard-braking event{last.hardBrakeEvents.length > 1 ? 's' : ''}
              </T.Dim>
            </Row>
          )}
        </Card>
      ) : (
        <Card>
          <T.Dim>
            {backgroundCapable
              ? 'No rides yet. Tap Start before you set off, then use Google Maps as normal.'
              : 'No rides yet. Tap Start before you set off. Keep the app open and the phone mounted or in a pocket.'}
          </T.Dim>
        </Card>
      )}
    </Screen>
  );
}

/** The big round start button, styled like an ignition / engine-start switch inside a dial. */
function Ignition({
  active,
  starting,
  elapsed,
  onPress,
}: {
  active: boolean;
  starting: boolean;
  elapsed: string | null;
  onPress: () => void;
}) {
  const [pulse] = useState(() => new Animated.Value(0));

  // A slow "engine running" glow while a ride is live.
  useEffect(() => {
    if (!active) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  const ringColor = active ? Colors.ok : Colors.accent;
  const c = IGNITION_SIZE / 2;
  const ticks = Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * 2 * Math.PI;
    const major = i % 3 === 0;
    const r1 = c - 4;
    const r2 = c - (major ? 16 : 10);
    return (
      <Line
        key={i}
        x1={c + r1 * Math.cos(a)}
        y1={c + r1 * Math.sin(a)}
        x2={c + r2 * Math.cos(a)}
        y2={c + r2 * Math.sin(a)}
        stroke={major ? ringColor : Colors.border}
        strokeWidth={major ? 3 : 2}
        strokeLinecap="round"
      />
    );
  });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={active ? 'Return to active ride' : 'Start ride'}
      onPress={onPress}
      disabled={starting}
      style={({ pressed }) => [styles.ignition, pressed && { transform: [{ scale: 0.97 }] }]}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          styles.glow,
          { backgroundColor: ringColor, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.06, 0.22] }) },
        ]}
      />
      <Svg width={IGNITION_SIZE} height={IGNITION_SIZE} style={StyleSheet.absoluteFill}>
        <Circle cx={c} cy={c} r={c - 2} fill={Colors.surface} stroke={Colors.border} strokeWidth={2} />
        {ticks}
      </Svg>
      <View style={[styles.core, { backgroundColor: active ? Colors.okDim : Colors.accent, borderColor: ringColor }]}>
        {active ? (
          <>
            <AppIcon name="mci:motorbike" size={34} color={Colors.ok} />
            <Text style={[styles.coreText, { color: Colors.ok, fontSize: 30 }]}>Riding</Text>
            <Text style={styles.coreTime}>{elapsed}</Text>
          </>
        ) : (
          <>
            <AppIcon name="mci:power" size={36} color={Colors.onAccent} />
            <Text style={styles.coreText}>{starting ? 'Starting' : 'Start'}</Text>
            <Text style={styles.coreSub}>Ride</Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

const CORE = IGNITION_SIZE - 58;

const styles = StyleSheet.create({
  ignition: {
    width: IGNITION_SIZE,
    height: IGNITION_SIZE,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: Spacing.sm,
  },
  glow: { borderRadius: IGNITION_SIZE / 2, transform: [{ scale: 1.08 }] },
  core: {
    width: CORE,
    height: CORE,
    borderRadius: CORE / 2,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coreText: {
    color: Colors.onAccent,
    fontFamily: Fonts.display,
    fontSize: 44,
    lineHeight: 46,
    textTransform: 'uppercase',
  },
  coreSub: {
    color: Colors.onAccent,
    fontFamily: Fonts.heading,
    fontSize: 16,
    letterSpacing: 4,
    textTransform: 'uppercase',
    marginTop: -4,
  },
  coreTime: { color: Colors.text, fontFamily: Fonts.displayBold, fontSize: 22, fontVariant: ['tabular-nums'] },
});
