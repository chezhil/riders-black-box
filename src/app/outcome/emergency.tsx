import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Disclaimer, Row, Screen, T, TestBanner } from '@/components/ui';
import { Colors, Spacing } from '@/constants/theme';
import { notifyContacts, relayConfigured, startLocationFollowUps, type NotifyResult } from '@/lib/alerts';
import { finishIncident, useIsTestReport } from '@/lib/flow';
import { mapsLink } from '@/lib/geo';
import { backgroundCapable, rideSession } from '@/lib/ride-session';
import { actions, useApp } from '@/lib/store';
import type { LatLng } from '@/lib/types';

export default function Emergency() {
  const { reportId } = useLocalSearchParams<{ reportId?: string }>();
  const report = useApp((s) => s.reports.find((r) => r.id === reportId));
  const emergencyNumber = useApp((s) => s.settings.emergencyNumber);
  const contacts = useApp((s) => s.contacts);
  const [location, setLocation] = useState<LatLng | null>(report?.location ?? null);
  const [address, setAddress] = useState<string | null>(null);
  const [notify, setNotify] = useState<NotifyResult | 'sending' | null>(null);
  const sent = useRef(false);
  const isTest = useIsTestReport(reportId);

  function callEmergency() {
    if (isTest) {
      Alert.alert(
        'Test: not calling ' + emergencyNumber,
        `This is a simulated crash, so emergency services aren't called. In a real emergency this button calls ${emergencyNumber} immediately.`,
      );
      return;
    }
    Linking.openURL(`tel:${emergencyNumber}`);
  }

  useEffect(() => {
    (async () => {
      const loc = location ?? (await rideSession.currentLocation());
      if (!loc) return;
      setLocation(loc);
      try {
        const [place] = await Location.reverseGeocodeAsync({ latitude: loc.lat, longitude: loc.lng });
        if (place) {
          setAddress(
            [place.name, place.street, place.district ?? place.subregion, place.city, place.postalCode]
              .filter((v, i, a) => v && a.indexOf(v) === i)
              .join(', '),
          );
        }
      } catch {
        // Address is a nice-to-have; coordinates are still shown.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendAlert(loc: LatLng | null) {
    setNotify('sending');
    const result = await notifyContacts('severe', loc, { test: isTest });
    setNotify(result);
    if (reportId && result.delivered) actions.updateReport(reportId, { contactsNotified: true });
    if (!isTest) startLocationFollowUps(() => rideSession.currentLocation());
  }

  // Severe: alert contacts automatically, once location is known (or after a short wait).
  useEffect(() => {
    if (sent.current) return;
    const go = () => {
      if (sent.current) return;
      sent.current = true;
      sendAlert(location);
    };
    if (location) go();
    else {
      const t = setTimeout(go, 6000);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  const notifyText =
    notify === 'sending'
      ? 'Alerting your emergency contacts…'
      : notify == null
        ? 'Getting your location…'
        : notify.channel === 'relay' || notify.channel === 'sim'
          ? `${isTest ? 'TEST ' : ''}SEVERE alert texted to ${contacts.length} contact${contacts.length === 1 ? '' : 's'}`
          : notify.channel === 'sms_composer'
            ? 'SEVERE alert opened in your SMS app. Make sure it was sent.'
            : `Contacts not alerted: ${notify.error}`;
  const notifyOk = notify !== 'sending' && notify != null && notify.delivered;

  return (
    <Screen edges={['top', 'bottom', 'left', 'right']} style={{ backgroundColor: '#140607' }}>
      <View style={{ alignItems: 'center', gap: Spacing.xs, marginTop: Spacing.md }}>
        <T.Label style={{ color: Colors.danger }}>Emergency</T.Label>
        <T.Title style={{ textAlign: 'center' }}>Call for help now</T.Title>
      </View>
      {isTest && <TestBanner />}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Call emergency services ${emergencyNumber}`}
        onPress={callEmergency}
        style={({ pressed }) => [
          styles.callButton,
          isTest && { opacity: 0.6 },
          pressed && { transform: [{ scale: 0.97 }] },
        ]}>
        <Ionicons name="call" size={64} color="#FFFFFF" />
        <Text style={styles.callText}>Call {emergencyNumber}</Text>
        <Text style={styles.callSub}>{isTest ? 'Disabled in test' : 'Emergency services'}</Text>
      </Pressable>

      <Card>
        <Row>
          <Ionicons name="location" size={20} color={Colors.accent} />
          <T.Label>Read this to the operator</T.Label>
        </Row>
        {location ? (
          <>
            {address && <T.Body style={{ fontSize: 18, fontWeight: '700' }}>{address}</T.Body>}
            <T.Body style={{ fontVariant: ['tabular-nums'] }}>
              {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
            </T.Body>
            <Button
              label="Open in Maps"
              icon="map"
              variant="secondary"
              onPress={() => Linking.openURL(mapsLink(location))}
            />
          </>
        ) : (
          <Row>
            <ActivityIndicator color={Colors.accent} />
            <T.Dim>Finding your location…</T.Dim>
          </Row>
        )}
      </Card>

      <Card style={{ borderColor: notifyOk ? Colors.ok : Colors.border }}>
        <Row>
          {notify === 'sending' || notify == null ? (
            <ActivityIndicator color={Colors.accent} />
          ) : (
            <Ionicons
              name={notifyOk ? 'checkmark-circle' : 'alert-circle'}
              size={22}
              color={notifyOk ? Colors.ok : Colors.danger}
            />
          )}
          <T.Body style={{ flex: 1, fontWeight: '600' }}>{notifyText}</T.Body>
        </Row>
        {contacts.length > 0 && (
          <T.Dim>{contacts.map((c) => `${c.name} (${c.relationship || 'contact'})`).join(', ')}</T.Dim>
        )}
        {notify !== 'sending' && notify != null && (
          <Button label="Send alert again" icon="refresh" variant="secondary" onPress={() => sendAlert(location)} />
        )}
        {!relayConfigured && !backgroundCapable && (
          <T.Dim style={{ fontSize: 12 }}>
            Tip: set up the SMS relay so alerts go out automatically, with no tap needed.
          </T.Dim>
        )}
      </Card>

      {contacts[0] && (
        <Button
          label={`Call ${contacts[0].name}`}
          icon="person"
          variant="secondary"
          size="lg"
          onPress={() => Linking.openURL(`tel:${contacts[0].phone}`)}
        />
      )}
      <Button
        label="Find nearest hospital"
        icon="business"
        variant="secondary"
        onPress={() => router.push({ pathname: '/outcome/hospitals', params: { reportId: reportId ?? '' } })}
      />
      <Button label="Help has arrived / I'm safe" variant="ghost" onPress={() => finishIncident(reportId)} />
      <Disclaimer>
        While you wait: stay still if your neck or back hurts, and keep your helmet on. Press firmly on heavy
        bleeding with a clean cloth.
      </Disclaimer>
    </Screen>
  );
}

const styles = StyleSheet.create({
  callButton: {
    backgroundColor: Colors.danger,
    borderRadius: 32,
    paddingVertical: 36,
    alignItems: 'center',
    gap: 4,
    shadowColor: Colors.danger,
    shadowOpacity: 0.5,
    shadowRadius: 24,
    elevation: 12,
  },
  callText: { color: '#FFFFFF', fontSize: 40, fontWeight: '900', letterSpacing: -1 },
  callSub: { color: '#FFD6D6', fontSize: 16, fontWeight: '700' },
});
