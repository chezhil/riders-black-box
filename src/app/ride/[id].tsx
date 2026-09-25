import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Alert } from 'react-native';

import { RouteMap } from '@/components/route-map';
import { Button, Card, ListItem, Row, Screen, Stat, T } from '@/components/ui';
import { Colors, SeverityColors, Spacing } from '@/constants/theme';
import { formatDateTime, formatDistance, formatDuration, formatTime, toKmh } from '@/lib/geo';
import { BODY_PART_LABELS, OUTCOME_LABELS, SEVERITY_INFO, highestSeverity } from '@/lib/injury';
import { actions, useApp } from '@/lib/store';

export default function RideDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const ride = useApp((s) => s.rides.find((r) => r.id === id));
  const allCrashes = useApp((s) => s.crashes);
  const allReports = useApp((s) => s.reports);
  if (!ride) return null;

  const crashes = allCrashes.filter((c) => c.rideId === id);
  // Injury check-ins from this ride, plus manual ones logged the same day.
  const sameDay = (t: number) => new Date(t).toDateString() === new Date(ride.startTime).toDateString();
  const reports = allReports.filter((r) => r.rideId === id || (!r.rideId && sameDay(r.timestamp)));

  function remove() {
    Alert.alert('Delete this ride?', 'The route and stats will be removed. Incident logs are kept.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          actions.deleteRide(id);
          router.back();
        },
      },
    ]);
  }

  return (
    <Screen edges={['bottom', 'left', 'right']}>
      <Stack.Screen options={{ title: formatDateTime(ride.startTime) }} />
      <RouteMap
        points={ride.routePoints}
        height={260}
        markers={[
          ...ride.hardBrakeEvents.map((b) => ({ ...b, color: SeverityColors.moderate })),
          ...crashes.filter((c) => c.location).map((c) => ({ ...c.location!, color: Colors.danger })),
        ]}
      />
      <Card>
        <Row gap={Spacing.lg}>
          <Stat label="Distance" value={formatDistance(ride.distanceM)} />
          <Stat label="Duration" value={formatDuration(ride.endTime - ride.startTime)} />
        </Row>
        <Row gap={Spacing.lg}>
          <Stat label="Avg speed" value={toKmh(ride.avgSpeed).toFixed(0)} unit="km/h" />
          <Stat label="Max speed" value={toKmh(ride.maxSpeed).toFixed(0)} unit="km/h" />
        </Row>
        <T.Dim>
          {formatTime(ride.startTime)} → {formatTime(ride.endTime)} · {ride.routePoints.length} GPS points
        </T.Dim>
      </Card>

      <T.Label>Hard braking ({ride.hardBrakeEvents.length})</T.Label>
      {ride.hardBrakeEvents.length === 0 ? (
        <T.Dim>None. Smooth riding.</T.Dim>
      ) : (
        ride.hardBrakeEvents.map((b) => (
          <ListItem
            key={b.t}
            icon="speedometer"
            iconColor={SeverityColors.moderate}
            title={formatTime(b.t)}
            subtitle={`${(b.decel / 9.81).toFixed(2)} g deceleration`}
          />
        ))
      )}

      {(crashes.length > 0 || reports.length > 0) && <T.Label>Incidents</T.Label>}
      {crashes.map((c) => (
        <ListItem
          key={c.id}
          icon="pulse"
          iconColor={Colors.danger}
          title={`Crash alert at ${formatTime(c.timestamp)}${c.detectedVia === 'simulated' ? ' (simulated)' : ''}`}
          subtitle={c.response.replace('_', ' ') + (c.contactsNotified ? ' · contacts alerted' : '')}
        />
      ))}
      {reports.map((r) => {
        const sev = highestSeverity(r.affectedAreas);
        return (
          <ListItem
            key={r.id}
            icon="medkit"
            iconColor={SeverityColors[sev]}
            title={`${SEVERITY_INFO[sev].label} injury · ${formatTime(r.timestamp)}`}
            subtitle={`${r.affectedAreas.map((a) => BODY_PART_LABELS[a.bodyPart]).join(', ')} → ${OUTCOME_LABELS[r.outcomePath]}`}
          />
        );
      })}

      <Button label="Delete ride" icon="trash" variant="ghost" onPress={remove} />
    </Screen>
  );
}
