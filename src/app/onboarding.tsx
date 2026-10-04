import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ContactsEditor, MedicalEditor } from '@/components/contacts-editor';
import { AppIcon, Button, Card, Field, HazardStripes, Row, Screen, T, type AppIconName } from '@/components/ui';
import { Colors, Spacing } from '@/constants/theme';
import { rideSession } from '@/lib/ride-session';
import { actions, useApp } from '@/lib/store';

const STEPS = ['you', 'contacts', 'medical', 'permissions'] as const;

/** What the app does, in three lines, for the first screen. */
const FEATURES: { icon: AppIconName; title: string; body: string }[] = [
  { icon: 'mci:motorbike', title: 'Detects a crash', body: 'Hard impact, then stillness: the pattern of a fall.' },
  { icon: 'chatbubbles', title: 'Alerts your people', body: "If you don't answer, they get your location." },
  { icon: 'mci:hospital-box', title: 'Finds help nearby', body: 'First aid, the nearest hospital, or 112.' },
];
type Step = (typeof STEPS)[number];

const PERMISSIONS = [
  {
    icon: 'location' as const,
    title: 'Location',
    body: 'Records your route during a ride and tells your contacts and nearby hospitals where you are. Only used while a ride is active or when you ask for help.',
  },
  {
    icon: 'phone-portrait' as const,
    title: 'Motion sensors',
    body: 'The accelerometer and gyroscope detect a hard impact followed by stillness, the pattern of a fall.',
  },
  {
    icon: 'chatbubbles' as const,
    title: 'SMS and calls',
    body: "If you don't answer after a crash: texts your emergency contacts your location from your SIM, then phones them on speakerphone. Nothing is sent without a detected crash or your tap.",
  },
  {
    icon: 'shield-checkmark' as const,
    title: 'Tip: Android Emergency SOS',
    body: "As a backup, turn on Android's Emergency SOS (Settings → Safety & emergency): pressing power 5 times calls 112 and shares your location, even if this app can't.",
  },
  {
    icon: 'notifications' as const,
    title: 'Notifications',
    body: 'Keeps crash detection running while you use Google Maps, and shows the "Are you OK?" alert over other apps and the lock screen.',
  },
];

export default function Onboarding() {
  const [step, setStep] = useState<Step>('you');
  const profile = useApp((s) => s.profile);
  const contacts = useApp((s) => s.contacts);
  const [granting, setGranting] = useState(false);
  const index = STEPS.indexOf(step);

  async function finish() {
    setGranting(true);
    try {
      await rideSession.requestPermissions();
    } catch (e) {
      // Permissions can be granted later from Settings; don't strand the rider here.
      console.warn('Permission request failed', e);
    } finally {
      setGranting(false);
    }
    actions.completeOnboarding();
    router.replace('/');
  }

  return (
    <Screen edges={['top', 'bottom', 'left', 'right']}>
      <Row gap={6}>
        {STEPS.map((s, i) => (
          <View
            key={s}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              backgroundColor: i <= index ? Colors.accent : Colors.surfaceRaised,
            }}
          />
        ))}
      </Row>

      {step === 'you' && (
        <>
          <View style={{ gap: Spacing.sm, marginTop: Spacing.lg }}>
            <AppIcon name="mci:shield-car" size={52} color={Colors.accent} />
            <T.Title>Rider&apos;s Black Box</T.Title>
            <HazardStripes height={6} style={{ width: 96 }} />
            <T.Dim>A crash co-pilot for two-wheeler riders. Set it up once, then just tap Start before you ride.</T.Dim>
          </View>
          <Card style={{ gap: Spacing.md }}>
            {FEATURES.map((f) => (
              <Row key={f.title} gap={Spacing.md} style={{ alignItems: 'flex-start' }}>
                <View style={{ width: 28, alignItems: 'center', paddingTop: 2 }}>
                  <AppIcon name={f.icon} size={22} color={Colors.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <T.H2 style={{ fontSize: 19 }}>{f.title}</T.H2>
                  <T.Dim>{f.body}</T.Dim>
                </View>
              </Row>
            ))}
          </Card>
          <Field
            label="Your name"
            value={profile.name}
            onChangeText={(name) => actions.updateProfile({ name })}
            placeholder="Shown in alerts to your contacts"
            autoCapitalize="words"
          />
          <Field
            label="Your phone number"
            value={profile.phone}
            onChangeText={(phone) => actions.updateProfile({ phone })}
            placeholder="+91 98765 43210"
            keyboardType="phone-pad"
            hint="Included in alerts so your contacts can call you back."
          />
          <Button label="Next" size="lg" disabled={!profile.name.trim()} onPress={() => setStep('contacts')} />
        </>
      )}

      {step === 'contacts' && (
        <>
          <View style={{ gap: Spacing.xs }}>
            <T.Title>Emergency contacts</T.Title>
            <T.Dim>Add 2–3 people who should hear from you if you crash.</T.Dim>
          </View>
          <ContactsEditor />
          <Button label="Next" size="lg" disabled={contacts.length === 0} onPress={() => setStep('medical')} />
          <Button label="Back" variant="ghost" onPress={() => setStep('you')} />
        </>
      )}

      {step === 'medical' && (
        <>
          <View style={{ gap: Spacing.xs }}>
            <T.Title>Medical info card</T.Title>
            <T.Dim>Optional. Included in emergency alerts to help first responders. You can edit it later.</T.Dim>
          </View>
          <MedicalEditor />
          <Button label="Next" size="lg" onPress={() => setStep('permissions')} />
          <Button label="Back" variant="ghost" onPress={() => setStep('contacts')} />
        </>
      )}

      {step === 'permissions' && (
        <>
          <View style={{ gap: Spacing.xs }}>
            <T.Title>What we&apos;ll ask for</T.Title>
            <T.Dim>Your ride data stays on this phone.</T.Dim>
          </View>
          {PERMISSIONS.map((p) => (
            <Card key={p.title}>
              <Row>
                <Ionicons name={p.icon} size={22} color={Colors.accent} />
                <T.H2>{p.title}</T.H2>
              </Row>
              <T.Dim>{p.body}</T.Dim>
            </Card>
          ))}
          <Button label="Allow & get started" size="lg" loading={granting} onPress={finish} />
          <Button label="Back" variant="ghost" onPress={() => setStep('medical')} />
        </>
      )}
    </Screen>
  );
}
