import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BodyMap, type BodyView } from '@/components/body-map';
import { EmergencyActions } from '@/components/emergency-actions';
import { Button, Card, Disclaimer, Field, Row, Screen, Segmented, T, TestBanner } from '@/components/ui';
import { Colors, Radius, SeverityColors, Spacing } from '@/constants/theme';
import { relayConfigured } from '@/lib/alerts';
import { endIncident, useIsTestCrash } from '@/lib/flow';
import { BODY_PART_LABELS, SEVERITY_INFO, highestSeverity, outcomeFor } from '@/lib/injury';
import { backgroundCapable, rideSession } from '@/lib/ride-session';
import { actions, getState, newId, useApp } from '@/lib/store';
import type { BodyPart, Severity } from '@/lib/types';

const SEVERITIES: Severity[] = ['minor', 'moderate', 'severe'];

export default function CheckIn() {
  const { crashId, auto } = useLocalSearchParams<{ crashId?: string; auto?: string }>();
  const crash = useApp((s) => s.crashes.find((c) => c.id === crashId));
  const [step, setStep] = useState<'map' | 'severity'>('map');
  const [view, setView] = useState<BodyView>('front');
  const [selected, setSelected] = useState<Partial<Record<BodyPart, Severity | null>>>({});
  const [notes, setNotes] = useState<Partial<Record<BodyPart, string>>>({});
  const [saving, setSaving] = useState(false);
  const isTest = useIsTestCrash(crashId);

  const parts = Object.keys(selected) as BodyPart[];
  const allRated = parts.length > 0 && parts.every((p) => selected[p]);

  function toggle(part: BodyPart) {
    setSelected((prev) => {
      const next = { ...prev };
      if (part in next) delete next[part];
      else next[part] = null;
      return next;
    });
  }

  function notHurt() {
    if (crashId) actions.updateCrash(crashId, { response: 'confirmed_fine' });
    endIncident({ crashId }, 'not_hurt');
    rideSession.resumeDetection();
    router.dismissTo(rideSession.getSnapshot().active ? '/active-ride' : '/');
  }

  async function submit() {
    setSaving(true);
    const areas = parts.map((p) => ({ bodyPart: p, severity: selected[p]!, note: notes[p]?.trim() ?? '' }));
    const outcome = outcomeFor(highestSeverity(areas));
    const location =
      getState().crashes.find((c) => c.id === crashId)?.location ?? (await rideSession.currentLocation());
    const id = newId();
    actions.addReport({
      id,
      crashEventId: crashId ?? null,
      rideId: crash?.rideId ?? rideSession.getSnapshot().rideId,
      timestamp: Date.now(),
      location,
      affectedAreas: areas,
      outcomePath: outcome,
      handled: false,
      contactsNotified: false,
      test: isTest,
    });
    setSaving(false);
    const pathname =
      outcome === 'emergency'
        ? '/outcome/emergency'
        : outcome === 'hospital'
          ? '/outcome/hospitals'
          : '/outcome/first-aid';
    router.replace({ pathname, params: { reportId: id } });
  }

  return (
    <Screen edges={['bottom', 'left', 'right']}>
      <Stack.Screen options={{ title: step === 'map' ? 'Where does it hurt?' : 'How bad is it?' }} />
      <EmergencyActions crashId={crashId} isTest={isTest} />
      {isTest && <TestBanner />}

      {auto === '1' && (
        <Card style={{ borderColor: Colors.danger, backgroundColor: Colors.dangerDim }}>
          <Row>
            <Ionicons name="alert-circle" size={20} color={Colors.danger} />
            <T.Body style={{ flex: 1, fontWeight: '700' }}>
              {isTest
                ? 'Test countdown ended. In a real crash your emergency contacts would now be texted your location.'
                : crash?.contactsNotified
                  ? 'Your emergency contacts have been texted your location'
                : relayConfigured || backgroundCapable
                  ? 'Alerting your emergency contacts…'
                  : 'Alert message ready in your SMS app. Tap Send.'}
            </T.Body>
          </Row>
          <T.Dim>If you can, tell us where you&apos;re hurt so we can point you to the right help.</T.Dim>
          {backgroundCapable && (
            <Button label="Stop siren" icon="volume-mute" variant="secondary" onPress={() => rideSession.stopSiren()} />
          )}
        </Card>
      )}

      {step === 'map' ? (
        <>
          <T.Dim>Tap every area that hurts. Tap again to deselect.</T.Dim>
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'front', label: 'Front' },
              { value: 'back', label: 'Back' },
            ]}
          />
          <BodyMap view={view} selected={selected} onToggle={toggle} />
          {parts.length > 0 && (
            <View style={styles.chips}>
              {parts.map((p) => (
                <Pressable key={p} onPress={() => toggle(p)} style={styles.chip}>
                  <Text style={styles.chipText}>{BODY_PART_LABELS[p]}</Text>
                  <Ionicons name="close" size={14} color={Colors.text} />
                </Pressable>
              ))}
            </View>
          )}
          <Button
            label={parts.length ? `Next: rate ${parts.length} area${parts.length > 1 ? 's' : ''}` : 'Select an area'}
            size="lg"
            disabled={!parts.length}
            onPress={() => setStep('severity')}
          />
          {crashId && <Button label="I'm not hurt" variant="ghost" onPress={notHurt} />}
        </>
      ) : (
        <>
          {parts.map((p) => (
            <Card key={p}>
              <T.H2>{BODY_PART_LABELS[p]}</T.H2>
              <View style={{ gap: Spacing.sm }}>
                {SEVERITIES.map((sev) => {
                  const on = selected[p] === sev;
                  const color = SeverityColors[sev];
                  return (
                    <Pressable
                      key={sev}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      onPress={() => setSelected((prev) => ({ ...prev, [p]: sev }))}
                      style={[
                        styles.sevOption,
                        { borderColor: on ? color : Colors.border },
                        on && { backgroundColor: color + '22' },
                      ]}>
                      <View style={[styles.sevDot, { backgroundColor: color }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.sevLabel, on && { color }]}>{SEVERITY_INFO[sev].label}</Text>
                        <T.Dim style={{ fontSize: 13 }}>{SEVERITY_INFO[sev].description}</T.Dim>
                      </View>
                      {on && <Ionicons name="checkmark-circle" size={22} color={color} />}
                    </Pressable>
                  );
                })}
              </View>
              <Field
                label="Describe it (optional)"
                placeholder="e.g. deep scrape, swelling"
                value={notes[p] ?? ''}
                onChangeText={(t) => setNotes((prev) => ({ ...prev, [p]: t }))}
              />
            </Card>
          ))}
          <Button
            label="Get help"
            icon="arrow-forward"
            size="lg"
            disabled={!allRated}
            loading={saving}
            onPress={submit}
          />
          <Button label="Back to body map" variant="ghost" onPress={() => setStep('map')} />
          <Disclaimer />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.accentDim,
    borderColor: Colors.accent,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: { color: Colors.text, fontWeight: '600' },
  sevOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderWidth: 2,
    borderRadius: Radius.md,
    padding: Spacing.md,
    minHeight: 64,
  },
  sevDot: { width: 16, height: 16, borderRadius: 8 },
  sevLabel: { color: Colors.text, fontSize: 17, fontWeight: '800' },
});
