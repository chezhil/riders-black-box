import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { router, useFocusEffect } from 'expo-router';
import * as SMS from 'expo-sms';
import { Accelerometer } from 'expo-sensors';
import { useCallback, useState } from 'react';
import { Alert, Linking, PermissionsAndroid, Platform, Switch, View } from 'react-native';

import { RideMonitor } from '@modules/ride-monitor';

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
type BackgroundStatus = {
  notifications: boolean;
  fullScreen: boolean;
  battery: boolean;
  simSms: boolean;
  calls: boolean;
};

export default function SettingsScreen() {
  const settings = useApp((s) => s.settings);
  const [perms, setPerms] = useState<PermStatus | null>(null);
  const [bg, setBg] = useState<BackgroundStatus | null>(null);

  const refresh = useCallback(() => {
    (async () => {
      const [loc, motion, sms] = await Promise.all([
        Location.getForegroundPermissionsAsync(),
        Accelerometer.getPermissionsAsync().catch(() => ({ granted: true })),
        SMS.isAvailableAsync(),
      ]);
      setPerms({ location: loc.granted, motion: motion.granted, sms });
      if (RideMonitor && Platform.OS === 'android') {
        const status = RideMonitor.getSystemStatus();
        setBg({
          notifications: status.notificationsEnabled,
          fullScreen: status.fullScreenIntentAllowed,
          battery: status.ignoringBatteryOptimizations,
          simSms: await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.SEND_SMS),
          calls:
            (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CALL_PHONE)) &&
            (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE)),
        });
      }
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
        <ToggleRow
          title="Only detect while riding"
          body="Crash detection turns on once GPS shows you moving (above ~11 km/h). Stops false alarms from handling the phone. Turn off only to test detection at a standstill."
          value={settings.detectOnlyWhenMoving}
          onChange={(detectOnlyWhenMoving) => actions.updateSettings({ detectOnlyWhenMoving })}
        />
        <T.Dim style={{ fontSize: 12 }}>
          Triggers on an impact of at least {preset.impactG} g (not after a burst of shaking), then{' '}
          {preset.stillMs / 1000}s of stillness and a {preset.orientationDeg}° change in orientation. Takes effect
          on your next ride.
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
          body="After an alert, text contacts your updated location every 3 minutes (for 15 min). Sent automatically from your SIM."
          value={settings.liveLocation}
          onChange={(liveLocation) => actions.updateSettings({ liveLocation })}
        />
        <ToggleRow
          title="Call my contacts if I don't respond"
          body="After the alert text, phones your emergency contacts one by one on speakerphone, so someone can hear what's happening."
          value={settings.autoCallContacts}
          onChange={(autoCallContacts) => actions.updateSettings({ autoCallContacts })}
        />
        <ToggleRow
          title="Siren + info for bystanders"
          body="After no response, sounds a loud siren and shows your name, medical info and call buttons on the lock screen for whoever finds you."
          value={settings.sirenOnNoResponse}
          onChange={(sirenOnNoResponse) => actions.updateSettings({ sirenOnNoResponse })}
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
            name={relayConfigured || RideMonitor ? 'cloud-done' : 'cloud-offline'}
            size={18}
            color={relayConfigured || RideMonitor ? Colors.ok : Colors.textDim}
          />
          <T.Dim style={{ flex: 1 }}>
            {relayConfigured
              ? 'SMS relay connected: alerts send automatically.'
              : RideMonitor
                ? 'Alerts are texted from your SIM automatically.'
                : 'Alerts open in your SMS app for you to send.'}
          </T.Dim>
        </Row>
      </Card>

      {RideMonitor && (
        <>
          <T.Label>Background protection</T.Label>
          <Card>
            <T.Dim>
              These keep crash detection working while you use Google Maps or the screen is off.
            </T.Dim>
            <FixRow
              label="Notifications"
              ok={bg?.notifications}
              onFix={() => Linking.openSettings()}
            />
            <FixRow
              label="Alert over lock screen"
              ok={bg?.fullScreen}
              onFix={() => RideMonitor?.openFullScreenIntentSettings()}
            />
            <FixRow
              label="Battery: unrestricted"
              ok={bg?.battery}
              onFix={() => RideMonitor?.requestIgnoreBatteryOptimizations()}
            />
            <FixRow
              label="Auto-text contacts from SIM"
              ok={bg?.simSms}
              onFix={() => rideSession.requestPermissions().then(refresh)}
            />
            <FixRow
              label="Auto-call contacts"
              ok={bg?.calls}
              onFix={() => rideSession.requestPermissions().then(refresh)}
            />
          </Card>
        </>
      )}

      {Platform.OS === 'android' && (
        <>
          <T.Label>Backup: Android Emergency SOS</T.Label>
          <Card>
            <T.Dim>
              Android has its own SOS that works even if this app can&apos;t: press the power button 5 times to call{' '}
              {settings.emergencyNumber} and share your location. Also add your medical info and contacts to Android&apos;s
              emergency information so they show on the lock screen.
            </T.Dim>
            <T.Dim style={{ fontSize: 12 }}>Settings → Safety &amp; emergency → Emergency SOS / Medical information</T.Dim>
            <Button label="Open Safety & emergency settings" icon="shield-checkmark" variant="secondary" onPress={openSafetySettings} />
          </Card>
        </>
      )}

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

function FixRow({ label, ok, onFix }: { label: string; ok: boolean | undefined; onFix: () => void }) {
  return (
    <Row style={{ justifyContent: 'space-between', minHeight: 40 }}>
      <Row gap={6} style={{ flex: 1 }}>
        <Ionicons
          name={ok == null ? 'ellipsis-horizontal' : ok ? 'checkmark-circle' : 'alert-circle'}
          size={18}
          color={ok == null ? Colors.textDim : ok ? Colors.ok : Colors.accent}
        />
        <T.Body style={{ flex: 1 }}>{label}</T.Body>
      </Row>
      {ok === false && <Button label="Fix" variant="secondary" onPress={onFix} style={{ minHeight: 36 }} />}
    </Row>
  );
}

/** Android's "Safety & emergency" page (Emergency SOS, medical info). Falls back to main Settings. */
async function openSafetySettings() {
  for (const action of ['android.settings.EMERGENCY_SETTINGS', 'android.settings.SETTINGS']) {
    try {
      await Linking.sendIntent(action);
      return;
    } catch {
      // Not available on this device: try the next one.
    }
  }
}
