import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { Alert, Linking, StyleSheet, useWindowDimensions } from 'react-native';

import { MapColors, MapLegend, RouteMap } from '@/components/route-map';
import { Speedometer } from '@/components/speedometer';
import { detectionState, Telltale } from '@/components/ride-status';
import { AppIcon, Button, Card, Row, Screen, Stat, T } from '@/components/ui';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useResumeDetectionOnFocus } from '@/hooks/use-resume-detection';
import { formatDistance, formatDuration, toKmh } from '@/lib/geo';
import { backgroundCapable, rideSession } from '@/lib/ride-session';

export default function ActiveRide() {
  const ride = useSyncExternalStore(rideSession.subscribe, rideSession.getSnapshot);
  const now = useNow();
  const { width } = useWindowDimensions();

  useEffect(() => {
    if (!ride.active) router.replace('/');
  }, [ride.active]);

  useResumeDetectionOnFocus();

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
  const detection = detectionState(ride);

  return (
    <Screen edges={['top', 'bottom', 'left', 'right']}>
      {/* Warning lights, like the telltales on a dash. */}
      <Row style={{ justifyContent: 'space-between' }}>
        <Telltale icon={detection.icon} label={detection.label} color={detection.color} />
        <Row gap={Spacing.sm}>
          <Telltale icon="pulse" label={`${ride.liveG.toFixed(1)} g`} color={Colors.textDim} />
          <Telltale
            icon="mci:satellite-variant"
            label={ride.gpsAccuracy != null ? `±${Math.round(ride.gpsAccuracy)} m` : 'GPS…'}
            color={ride.gpsAccuracy != null && ride.gpsAccuracy <= 30 ? Colors.ok : Colors.textDim}
          />
        </Row>
      </Row>
      <T.Dim style={{ color: detection.color, marginTop: -Spacing.sm }}>{detection.hint}</T.Dim>

      <Speedometer
        kmh={toKmh(ride.currentSpeed)}
        maxKmh={toKmh(ride.maxSpeed)}
        size={Math.min(width - Spacing.lg * 2, 320)}
        color={ride.armed && !ride.suspended ? Colors.accent : Colors.textDim}
      />

      {bumpRecent && (
        <Row style={styles.bump}>
          <Ionicons name="pulse" size={16} color={Colors.accent} />
          <T.Dim style={{ flex: 1 }}>
            Jolt detected ({ride.lastBump!.peakG} g), no alert: {BUMP_REASONS[ride.lastBump!.reason]}
          </T.Dim>
        </Row>
      )}

      <Card>
        <Row gap={Spacing.lg}>
          <Stat label="Time" value={formatDuration(now - ride.startTime)} />
          <Stat label="Distance" value={formatDistance(ride.distanceM)} />
          <Stat label="Avg" value={toKmh(avgSpeed(ride.points)).toFixed(0)} unit="km/h" />
        </Row>
        {ride.hardBrakes.length > 0 && (
          <Row gap={6}>
            <AppIcon name="mci:car-brake-alert" size={16} color={Colors.danger} />
            <T.Dim>
              {ride.hardBrakes.length} hard-braking event{ride.hardBrakes.length > 1 ? 's' : ''}
            </T.Dim>
          </Row>
        )}
      </Card>

      <RouteMap
        points={ride.points}
        markers={ride.hardBrakes.map((b) => ({ ...b, color: MapColors.hardBrake }))}
      />
      {ride.points.length > 0 && (
        <MapLegend kinds={ride.hardBrakes.length ? ['start', 'now', 'hardBrake'] : ['start', 'now']} />
      )}
      <T.Dim style={{ textAlign: 'center', fontSize: 12 }}>
        {backgroundCapable
          ? 'Tracking continues in the background. Switch to Google Maps any time.'
          : 'Keep this screen open. It stays on while you ride.'}
      </T.Dim>

      {backgroundCapable && (
        <Button
          label="Lock-screen dash"
          icon="lock-closed"
          size="lg"
          onPress={() => router.push('/ride-dash')}
        />
      )}
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
      <Button label="End ride" icon="flag" variant="secondary" size="lg" onPress={endRide} />
      <Button
        label="Simulate a crash (demo)"
        icon="flask"
        variant="ghost"
        onPress={() => rideSession.simulateCrash()}
      />
    </Screen>
  );
}

/** Mean of GPS speeds while moving, matching how a saved ride's average is worked out. */
function avgSpeed(points: { speed: number | null }[]) {
  const moving = points.filter((p) => (p.speed ?? 0) > 1);
  return moving.length ? moving.reduce((a, p) => a + (p.speed ?? 0), 0) / moving.length : 0;
}


const BUMP_REASONS = {
  moving_again: 'you kept moving.',
  not_moving: "you weren't riding.",
  handling: 'looked like the phone was being handled.',
  no_fall: 'no sign of a fall.',
} as const;

const styles = StyleSheet.create({
  bump: {
    backgroundColor: Colors.accentDim,
    padding: Spacing.md,
    borderRadius: Radius.md,
  },
});
