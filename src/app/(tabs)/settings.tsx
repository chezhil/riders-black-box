import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { router, useFocusEffect } from 'expo-router';
import * as SMS from 'expo-sms';
import { Accelerometer } from 'expo-sensors';
import { useCallback, useState } from 'react';
import { Alert, Linking, Switch, View } from 'react-native';

import { Button, Card, Field, Row, Screen, Segmented, T } from '@/components/ui';
import { Colors, Spacing } from '@/constants/theme';
import { relayConfigured } from '@/lib/alerts';
import { SENSITIVITY_PRESETS } from '@/lib/crash-detector';
import { rideSession } from '@/lib/ride-session';
import { actions, useApp } from '@/lib/store';
import type { Sensitivity } from '@/lib/types';

const SENSITIVITY_HELP: Record<Sensitivity, string> = {
  low: 'Fewest false alarms. Needs a hard impact.',
  medium: 'Balanced. Recommended for most riders.',
  high: 'Catches gentler falls. Expect more "Are you OK?" checks on bad roads.',
};

type PermStatus = { location: boolean; motion: boolean; sms: boolean };

export default function SettingsScreen() {
  const settings = useApp((s) => s.settings);
  const [perms, setPerms] = useState<PermStatus | null>(null);

  const refresh = useCallback(() => {
    (async () => {
      const [loc, motion, sms] = await Promise.all([
        Location.getForegroundPermissionsAsync(),
        Accelerometer.getPermissionsAsync().catch(() => ({ granted: true })),
        SMS.isAvailableAsync(),
      ]);
      setPerms({ location: loc.granted, motion: motion.granted, sms });
    })();
  }, []);
  useFocusEffect(refresh);

  function clearData() {
    Alert.alert(
      'Delete all data?',
      'Rides, incident logs, contacts and your profile will be permanently removed from this phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete everything',
          style: 'destructive',
          onPress: async () => {
            await rideSession.stop();
            await actions.clearAll();
            router.replace('/onboarding');
          },
        },
      ],
    );
  }

  const preset = SENSITIVITY_PRESETS[settings.sensitivity];

  return (
    <Screen>
      <T.Title>Settings</T.Title>

      <T.Label>Crash detection</T.Label>
      <Card>
        <T.Body style={{ fontWeight: '700' }}>Sensitivity</T.Body>
        <Segmented
          value={settings.sensitivity}
          onChange={(sensitivity) => actions.updateSettings({ sensitivity })}
          options={[
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]}
        />
        <T.Dim>{SENSITIVITY_HELP[settings.sensitivity]}</T.Dim>
        <T.Dim style={{ fontSize: 12 }}>
          Triggers on an impact of at least {preset.impactG} g, then {preset.stillMs / 1000}s of stillness and a{' '}
          {preset.orientationDeg}° change in orientation. Takes effect on your next ride.
        </T.Dim>
      </Card>
      <Card>
        <T.Body style={{ fontWeight: '700' }}>&quot;Are you OK?&quot; countdown</T.Body>
        <Segmented
          value={settings.countdownSeconds}
          onChange={(countdownSeconds) => actions.updateSettings({ countdownSeconds })}
          options={[
            { value: 20, label: '20 s' },
            { value: 30, label: '30 s' },
            { value: 45, label: '45 s' },
          ]}
        />
      </Card>

      <T.Label>Alerts</T.Label>
      <Card>
        <ToggleRow
          title="Live location follow-ups"
          body="After an alert, text contacts your updated location every 2 minutes (up to 10 min). Needs the SMS relay."
          value={settings.liveLocation}
          onChange={(liveLocation) => actions.updateSettings({ liveLocation })}
        />
        <ToggleRow
          title="Include medical info"
          body="Adds blood group, allergies and conditions to emergency alerts."
          value={settings.includeMedicalInfo}
          onChange={(includeMedicalInfo) => actions.updateSettings({ includeMedicalInfo })}
        />
        <Field
          label="Emergency number"
          value={settings.emergencyNumber}
          keyboardType="phone-pad"
          onChangeText={(emergencyNumber) => actions.updateSettings({ emergencyNumber: emergencyNumber.trim() })}
          hint="112 works across India and most of the world."
        />
        <Row style={{ marginTop: Spacing.xs }}>
          <Ionicons
            name={relayConfigured ? 'cloud-done' : 'cloud-offline'}
            size={18}
            color={relayConfigured ? Colors.ok : Colors.textDim}
          />
          <T.Dim style={{ flex: 1 }}>
            {relayConfigured
              ? 'SMS relay connected: alerts send automatically.'
              : 'SMS relay not configured: alerts open in your SMS app for you to send.'}
          </T.Dim>
        </Row>
      </Card>

      <T.Label>Permissions</T.Label>
      <Card>
        <PermRow label="Location" ok={perms?.location} />
        <PermRow label="Motion sensors" ok={perms?.motion} />
        <PermRow label="SMS" ok={perms?.sms} />
        <Row>
          <Button
            label="Request again"
            variant="secondary"
            style={{ flex: 1 }}
            onPress={() => rideSession.requestPermissions().then(refresh)}
          />
          <Button label="Open settings" variant="secondary" style={{ flex: 1 }} onPress={() => Linking.openSettings()} />
        </Row>
      </Card>

      <T.Label>Privacy</T.Label>
      <Card>
        <T.Dim>
          Everything (rides, routes, incidents, contacts, medical info) is stored only on this phone. Location is
          tracked only during an active ride or when you ask for help, and is shared only in emergency alerts.
        </T.Dim>
        <Button label="Delete all data" icon="trash" variant="ghost" onPress={clearData} />
      </Card>
    </Screen>
  );
}

function ToggleRow({
  title,
  body,
  value,
  onChange,
}: {
  title: string;
  body: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row style={{ alignItems: 'flex-start' }} gap={Spacing.md}>
      <View style={{ flex: 1 }}>
        <T.Body style={{ fontWeight: '700' }}>{title}</T.Body>
        <T.Dim>{body}</T.Dim>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: Colors.accent, false: Colors.surfaceRaised }}
        thumbColor={Colors.text}
      />
    </Row>
  );
}

function PermRow({ label, ok }: { label: string; ok: boolean | undefined }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <T.Body>{label}</T.Body>
      <Row gap={4}>
        <Ionicons
          name={ok == null ? 'ellipsis-horizontal' : ok ? 'checkmark-circle' : 'close-circle'}
          size={18}
          color={ok == null ? Colors.textDim : ok ? Colors.ok : Colors.danger}
        />
        <T.Dim>{ok == null ? 'Checking' : ok ? 'Allowed' : 'Not allowed'}</T.Dim>
      </Row>
    </Row>
  );
}
