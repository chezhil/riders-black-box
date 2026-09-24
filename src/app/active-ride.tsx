import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';

import { RouteTrail } from '@/components/route-trail';
import { Button, Card, Row, Screen, Stat, T } from '@/components/ui';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { formatDistance, formatDuration, toKmh } from '@/lib/geo';
import { backgroundCapable, rideSession } from '@/lib/ride-session';

export default function ActiveRide() {
  const ride = useSyncExternalStore(rideSession.subscribe, rideSession.getSnapshot);
  const now = useNow();

  useEffect(() => {
    if (!ride.active) router.replace('/');
  }, [ride.active]);

  function endRide() {
    Alert.alert('End ride?', 'Your route and stats will be saved to ride history.', [
      { text: 'Keep riding', style: 'cancel' },
      {
        text: 'End ride',
        style: 'destructive',
        onPress: async () => {
          const saved = await rideSession.stop();
          if (saved) router.replace({ pathname: '/ride/[id]', params: { id: saved.id } });
        },
      },
    ]);
  }

  const bumpRecent = ride.lastBump && now - ride.lastBump.at < 8000;

  return (
    <Screen edges={['top', 'bottom', 'left', 'right']}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row style={{ flex: 1 }}>
          <View
            style={[
              styles.dot,
              { backgroundColor: !ride.monitoring ? Colors.textFaint : ride.armed ? Colors.ok : Colors.accent },
            ]}
          />
          <T.Body style={{ fontWeight: '700', flex: 1 }}>
            {!ride.monitoring
              ? 'Starting sensors…'
              : ride.armed
                ? 'Crash detection active'
                : "Crash detection turns on once you're moving"}
          </T.Body>
        </Row>
        <T.Dim>{ride.liveG.toFixed(1)} g</T.Dim>
      </Row>

      {bumpRecent && (
        <Row style={styles.bump}>
          <Ionicons name="pulse" size={16} color={Colors.accent} />
          <T.Dim style={{ flex: 1 }}>
            Jolt detected ({ride.lastBump!.peakG} g), no alert: {BUMP_REASONS[ride.lastBump!.reason]}
          </T.Dim>
        </Row>
      )}

      <View style={styles.speedBox}>
        <Text style={styles.speed}>{toKmh(ride.currentSpeed).toFixed(0)}</Text>
        <T.Label>km/h</T.Label>
      </View>

      <Card>
        <Row gap={Spacing.lg}>
          <Stat label="Time" value={formatDuration(now - ride.startTime)} />
          <Stat label="Distance" value={formatDistance(ride.distanceM)} />
          <Stat label="Max" value={toKmh(ride.maxSpeed).toFixed(0)} unit="km/h" />
        </Row>
        {ride.hardBrakes.length > 0 && (
          <T.Dim>
            {ride.hardBrakes.length} hard-braking event{ride.hardBrakes.length > 1 ? 's' : ''}
          </T.Dim>
        )}
      </Card>

      <RouteTrail
        points={ride.points}
        markers={ride.hardBrakes.map((b) => ({ ...b, color: Colors.danger }))}
      />
      <T.Dim style={{ textAlign: 'center', fontSize: 12 }}>
        {ride.gpsAccuracy != null ? `GPS ±${Math.round(ride.gpsAccuracy)} m · ` : ''}
        {backgroundCapable
          ? 'Tracking continues in the background. Switch to Google Maps any time.'
          : 'Keep this screen open. It stays on while you ride.'}
      </T.Dim>

      {backgroundCapable && (
        <Button
          label="Open Google Maps"
          icon="navigate"
          variant="secondary"
          size="lg"
          onPress={() => Linking.openURL('https://www.google.com/maps')}
        />
      )}

      <Button label="I need help" icon="medkit" variant="danger" size="lg" onPress={() => router.push('/checkin')} />
      <Button label="End ride" icon="stop" variant="secondary" size="lg" onPress={endRide} />
      <Button
        label="Simulate a crash (demo)"
        icon="flask"
        variant="ghost"
        onPress={() => rideSession.simulateCrash()}
      />
    </Screen>
  );
}

const BUMP_REASONS = {
  moving_again: 'you kept moving.',
  not_moving: "you weren't riding.",
  handling: 'looked like the phone was being handled.',
  no_fall: 'no sign of a fall.',
} as const;

const styles = StyleSheet.create({
  dot: { width: 10, height: 10, borderRadius: 5 },
  speedBox: { alignItems: 'center', paddingVertical: Spacing.sm },
  speed: { color: Colors.text, fontSize: 96, fontWeight: '900', letterSpacing: -4, lineHeight: 100 },
  bump: {
    backgroundColor: Colors.accentDim,
    padding: Spacing.md,
    borderRadius: Radius.md,
  },
});
