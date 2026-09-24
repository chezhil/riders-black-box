import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, View } from 'react-native';

import { Badge, Button, Card, Disclaimer, Row, Screen, T } from '@/components/ui';
import { Colors, SeverityColors, Spacing } from '@/constants/theme';
import { notifyContacts } from '@/lib/alerts';
import { finishIncident } from '@/lib/flow';
import { directionsLink, formatDistance } from '@/lib/geo';
import { findNearbyFacilities, type Facility } from '@/lib/hospitals';
import { highestSeverity } from '@/lib/injury';
import { rideSession } from '@/lib/ride-session';
import { actions, useApp } from '@/lib/store';
import type { LatLng } from '@/lib/types';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; location: LatLng | null }
  | { status: 'done'; facilities: Facility[]; location: LatLng };

export default function Hospitals() {
  const { reportId } = useLocalSearchParams<{ reportId?: string }>();
  const report = useApp((s) => s.reports.find((r) => r.id === reportId));
  const emergencyNumber = useApp((s) => s.settings.emergencyNumber);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [notifying, setNotifying] = useState(false);

  const reportLocation = report?.location ?? null;

  useEffect(() => {
    lookup(reportLocation).then(setState);
  }, [reportLocation]);

  function retry() {
    setState({ status: 'loading' });
    lookup(reportLocation).then(setState);
  }

  async function notify() {
    if (!report) return;
    setNotifying(true);
    const result = await notifyContacts(highestSeverity(report.affectedAreas), report.location);
    setNotifying(false);
    if (result.delivered) actions.updateReport(report.id, { contactsNotified: true });
    else if (result.error) Alert.alert("Couldn't notify contacts", result.error);
  }

  function openMapsSearch() {
    const loc = state.status !== 'loading' ? state.location : null;
    Linking.openURL(
      loc
        ? `https://www.google.com/maps/search/hospital/@${loc.lat},${loc.lng},14z`
        : 'https://www.google.com/maps/search/hospital+near+me',
    );
  }

  return (
    <Screen edges={['bottom', 'left', 'right']}>
      <Row>
        <Ionicons name="business" size={28} color={SeverityColors.moderate} />
        <View style={{ flex: 1 }}>
          <T.H2>Get checked at a hospital or clinic</T.H2>
          <T.Dim>Nearest first. Call ahead if you can.</T.Dim>
        </View>
      </Row>

      <Row>
        <Button
          label={report?.contactsNotified ? 'Contacts notified' : 'Notify contacts'}
          icon={report?.contactsNotified ? 'checkmark' : 'chatbubbles'}
          variant="secondary"
          style={{ flex: 1 }}
          disabled={!report || report.contactsNotified}
          loading={notifying}
          onPress={notify}
        />
        <Button label="Map" icon="map" variant="secondary" style={{ flex: 1 }} onPress={openMapsSearch} />
      </Row>

      {state.status === 'loading' && (
        <Card style={{ alignItems: 'center', paddingVertical: Spacing.xxl }}>
          <ActivityIndicator color={Colors.accent} />
          <T.Dim>Finding hospitals near you…</T.Dim>
        </Card>
      )}

      {state.status === 'error' && (
        <Card>
          <T.Body>{state.message}</T.Body>
          <Button label="Try again" variant="secondary" onPress={retry} />
          <Button label="Search in Google Maps" icon="map" variant="secondary" onPress={openMapsSearch} />
        </Card>
      )}

      {state.status === 'done' && state.facilities.length === 0 && (
        <Card>
          <T.Body>No hospitals found nearby in OpenStreetMap.</T.Body>
          <Button label="Search in Google Maps" icon="map" variant="secondary" onPress={openMapsSearch} />
        </Card>
      )}

      {state.status === 'done' &&
        state.facilities.map((f) => (
          <Card key={f.id}>
            <Row style={{ alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 4 }}>
                <T.Body style={{ fontWeight: '700' }}>{f.name}</T.Body>
                <Row gap={6} style={{ flexWrap: 'wrap' }}>
                  <Badge
                    label={f.kind === 'hospital' ? 'Hospital' : f.kind === 'doctors' ? 'Doctor' : 'Clinic'}
                    color={Colors.info}
                  />
                  {f.emergency && <Badge label="Emergency dept" color={Colors.danger} icon="medical" />}
                </Row>
                {f.address && <T.Dim numberOfLines={2}>{f.address}</T.Dim>}
              </View>
              <T.Body style={{ fontWeight: '800', color: Colors.accent }}>{formatDistance(f.distanceM)}</T.Body>
            </Row>
            <Row>
              <Button
                label="Directions"
                icon="navigate"
                style={{ flex: 1 }}
                onPress={() => Linking.openURL(directionsLink(f.location))}
              />
              <Button
                label="Call"
                icon="call"
                variant="secondary"
                style={{ flex: 1 }}
                disabled={!f.phone}
                onPress={() => f.phone && Linking.openURL(`tel:${f.phone.split(/[;,]/)[0].replace(/\s/g, '')}`)}
              />
            </Row>
          </Card>
        ))}

      <Button
        label={`It's worse: call ${emergencyNumber}`}
        icon="call"
        variant="danger"
        size="lg"
        onPress={() => {
          if (reportId) actions.updateReport(reportId, { outcomePath: 'emergency' });
          router.replace({ pathname: '/outcome/emergency', params: { reportId: reportId ?? '' } });
        }}
      />
      <Button label="Mark as handled" icon="checkmark" variant="ghost" onPress={() => finishIncident(reportId)} />
      <Disclaimer>Hospital data from OpenStreetMap contributors. Distances are straight-line.</Disclaimer>
    </Screen>
  );
}

async function lookup(known: LatLng | null): Promise<LoadState> {
  const location = known ?? (await rideSession.currentLocation());
  if (!location) return { status: 'error', message: "Couldn't get your location.", location: null };
  try {
    return { status: 'done', facilities: await findNearbyFacilities(location), location };
  } catch {
    return { status: 'error', message: "Couldn't load nearby hospitals. You may be offline.", location };
  }
}
