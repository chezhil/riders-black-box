import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Disclaimer, HazardStripes, Row, Screen, T, TestBanner } from '@/components/ui';
import { Colors, Fonts, Spacing } from '@/constants/theme';
import { notifyContacts, relayConfigured, startLocationFollowUps, type NotifyResult } from '@/lib/alerts';
import { LocateHospitalButton } from '@/components/emergency-actions';
import {
  callContact,
  callEmergencyNumber,
  finishIncident,
  markIncidentNotified,
  markSevereAlertSent,
  severeAlertAlreadySent,
  useEmergencyNumber,
  useIsTest,
} from '@/lib/flow';
import { mapsLink } from '@/lib/geo';
import { backgroundCapable, rideSession } from '@/lib/ride-session';
import { useApp } from '@/lib/store';
import type { LatLng } from '@/lib/types';

export default function Emergency() {
  const { reportId, crashId } = useLocalSearchParams<{ reportId?: string; crashId?: string }>();
  const report = useApp((s) => s.reports.find((r) => r.id === reportId));
  const crash = useApp((s) => s.crashes.find((c) => c.id === (crashId || report?.crashEventId)));
  const emergencyNumber = useEmergencyNumber();
  const contacts = useApp((s) => s.contacts);
  const [location, setLocation] = useState<LatLng | null>(report?.location ?? crash?.location ?? null);
  const [address, setAddress] = useState<string | null>(null);
  // Another Emergency screen for this incident may already have alerted contacts.
  const [alreadyAlerted] = useState(() => severeAlertAlreadySent({ reportId, crashId }));
  const [notify, setNotify] = useState<NotifyResult | 'sending' | null>(null);
  const sent = useRef(alreadyAlerted);
  const isTest = useIsTest({ reportId, crashId });
  const incident = { reportId, crashId };

  const callEmergency = () => callEmergencyNumber(emergencyNumber, isTest);

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
    if (result.delivered) markIncidentNotified(incident, { channel: result.channel });
    if (!isTest) startLocationFollowUps(() => rideSession.currentLocation());
  }

  // Severe: alert contacts automatically, once location is known (or after a short wait).
  useEffect(() => {
    if (sent.current) return;
    const go = () => {
      if (sent.current) return;
      sent.current = true;
      // Demo crashes send nothing, so there's nothing to deduplicate.
      if (!isTest) markSevereAlertSent(incident);
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
    notify == null && alreadyAlerted
      ? 'SEVERE alert already sent for this incident.'
      : notify !== 'sending' && notify?.skippedTest
      ? `Test: no SMS sent. In a real emergency your ${contacts.length} contact${contacts.length === 1 ? ' is' : 's are'} texted automatically.`
      : notify === 'sending'
      ? 'Alerting your emergency contacts…'
      : notify == null
        ? 'Getting your location…'
        : notify.channel === 'relay' || notify.channel === 'sim'
          ? `SEVERE alert texted to ${contacts.length} contact${contacts.length === 1 ? '' : 's'}`
          : notify.channel === 'sms_composer'
            ? 'SEVERE alert opened in your SMS app. Make sure it was sent.'
            : `Contacts not alerted: ${notify.error}`;
  const notifyOk = notify !== 'sending' && notify != null && notify.delivered;

  return (
    <Screen edges={['top', 'bottom', 'left', 'right']} style={{ backgroundColor: '#140607' }}>
      <HazardStripes color={isTest ? Colors.info : Colors.danger} height={10} />
      <View style={{ alignItems: 'center', gap: Spacing.xs }}>
        <T.Label style={{ color: Colors.danger }}>Emergency</T.Label>
        <T.Title style={{ textAlign: 'center' }}>Call for help now</T.Title>
      </View>
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
      <LocateHospitalButton reportId={reportId} crashId={crashId} />
      {isTest && <TestBanner />}

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
          {notify == null && alreadyAlerted ? (
            <Ionicons name="checkmark-circle" size={22} color={Colors.ok} />
          ) : notify === 'sending' || notify == null ? (
            <ActivityIndicator color={Colors.accent} />
          ) : (
            <Ionicons
              name={notify.skippedTest ? 'information-circle' : notifyOk ? 'checkmark-circle' : 'alert-circle'}
              size={22}
              color={notify.skippedTest ? Colors.info : notifyOk ? Colors.ok : Colors.danger}
            />
          )}
          <T.Body style={{ flex: 1, fontWeight: '600' }}>{notifyText}</T.Body>
        </Row>
        {contacts.length > 0 && (
          <T.Dim>{contacts.map((c) => `${c.name} (${c.relationship || 'contact'})`).join(', ')}</T.Dim>
        )}
        {((notify !== 'sending' && notify != null && !notify.skippedTest) || (notify == null && alreadyAlerted)) && (
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
          label={contacts[0].relationship ? `${contacts[0].name} · ${contacts[0].relationship}` : contacts[0].name}
          icon="call"
          variant="secondary"
          size="lg"
          onPress={() => callContact(contacts[0].phone)}
        />
      )}
      <Button
        label="Help has arrived / I'm safe"
        variant="ghost"
        onPress={() => finishIncident(reportId, 'help_arrived', crashId)}
      />
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
  callText: { color: '#FFFFFF', fontFamily: Fonts.display, fontSize: 56, lineHeight: 60, textTransform: 'uppercase' },
  callSub: { color: '#FFD6D6', fontFamily: Fonts.label, fontSize: 17, letterSpacing: 1.5, textTransform: 'uppercase' },
});
