import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Row, Screen, Stat, T } from '@/components/ui';
import { Colors, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { formatDateTime, formatDistance, formatDuration, toKmh } from '@/lib/geo';
import { rideSession } from '@/lib/ride-session';
import { useApp } from '@/lib/store';

export default function Home() {
  const profile = useApp((s) => s.profile);
  const rides = useApp((s) => s.rides);
  const contacts = useApp((s) => s.contacts);
  const ride = useSyncExternalStore(rideSession.subscribe, rideSession.getSnapshot);
  const [starting, setStarting] = useState(false);
  const now = useNow();

  const totalKm = rides.reduce((a, r) => a + r.distanceM, 0);
  const last = rides[0];

  async function startRide() {
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
        <T.Label>Rider&apos;s Black Box</T.Label>
        <T.Title>{profile.name ? `Ride safe, ${profile.name.split(' ')[0]}` : 'Ride safe'}</T.Title>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={ride.active ? 'Return to active ride' : 'Start ride'}
        onPress={startRide}
        disabled={starting}
        style={({ pressed }) => [styles.startButton, pressed && { transform: [{ scale: 0.98 }] }]}>
        <Ionicons name={ride.active ? 'navigate' : 'play'} size={44} color="#140A02" />
        <Text style={styles.startText}>
          {starting ? 'Starting…' : ride.active ? 'Ride in progress' : 'Start Ride'}
        </Text>
        <Text style={styles.startSub}>
          {ride.active
            ? `${formatDuration(now - ride.startTime)} · tap to open`
            : 'Crash detection turns on automatically'}
        </Text>
      </Pressable>

      <Button
        label="Report an injury"
        icon="medkit"
        variant="secondary"
        size="lg"
        onPress={() => router.push('/checkin')}
      />

      {contacts.length === 0 && (
        <Card style={{ borderColor: Colors.danger }} onPress={() => router.push('/profile')}>
          <Row>
            <Ionicons name="warning" size={20} color={Colors.danger} />
            <T.Body style={{ flex: 1, fontWeight: '700' }}>No emergency contacts yet</T.Body>
          </Row>
          <T.Dim>Nobody will be alerted if you crash. Tap to add someone.</T.Dim>
        </Card>
      )}

      <Card>
        <T.Label>Your riding</T.Label>
        <Row gap={Spacing.lg}>
          <Stat label="Rides" value={String(rides.length)} />
          <Stat label="Distance" value={(totalKm / 1000).toFixed(1)} unit="km" />
          <Stat label="Contacts" value={String(contacts.length)} />
        </Row>
      </Card>

      {last ? (
        <Card onPress={() => router.push({ pathname: '/ride/[id]', params: { id: last.id } })}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T.Label>Last ride</T.Label>
            <T.Dim>{formatDateTime(last.startTime)}</T.Dim>
          </Row>
          <Row gap={Spacing.lg}>
            <Stat label="Distance" value={formatDistance(last.distanceM)} />
            <Stat label="Time" value={formatDuration(last.endTime - last.startTime)} />
            <Stat label="Avg" value={toKmh(last.avgSpeed).toFixed(0)} unit="km/h" />
          </Row>
          {last.hardBrakeEvents.length > 0 && (
            <T.Dim>
              {last.hardBrakeEvents.length} hard-braking event{last.hardBrakeEvents.length > 1 ? 's' : ''}
            </T.Dim>
          )}
        </Card>
      ) : (
        <Card>
          <T.Label>Last ride</T.Label>
          <T.Dim>No rides yet. Tap Start Ride before you set off. Keep the app open and the phone mounted or in a pocket.</T.Dim>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  startButton: {
    backgroundColor: Colors.accent,
    borderRadius: 28,
    paddingVertical: Spacing.xxl,
    alignItems: 'center',
    gap: Spacing.xs,
  },
  startText: { color: '#140A02', fontSize: 30, fontWeight: '900', letterSpacing: -0.5 },
  startSub: { color: '#3A1E08', fontSize: 14, fontWeight: '600' },
});
