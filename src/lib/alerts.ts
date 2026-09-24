/**
 * Emergency-contact alerts. Delivery channels, in order of preference:
 *  - relay: POST to a tiny server (see /relay) that sends SMS via Twilio.
 *    Enabled by EXPO_PUBLIC_ALERT_RELAY_URL.
 *  - sim: texts straight from the phone's SIM (Android build with the native
 *    RideMonitor module and SEND_SMS permission). No tap needed.
 *  - sms_composer: opens the phone's SMS app pre-filled with every contact and
 *    the message. Works everywhere (incl. Expo Go) but needs someone to tap Send.
 *
 * When the rider doesn't answer the crash countdown, the native service sends
 * the alert itself from buildAlertTemplate(), so it works in the background.
 */
import * as SMS from 'expo-sms';
import { PermissionsAndroid, Platform } from 'react-native';

import { RideMonitor } from '@modules/ride-monitor';

import { formatTime, mapsLink } from './geo';
import { getState } from './store';
import type { LatLng, NotifyChannel } from './types';

const RELAY_URL = process.env.EXPO_PUBLIC_ALERT_RELAY_URL;
const RELAY_KEY = process.env.EXPO_PUBLIC_ALERT_RELAY_KEY;

export const relayConfigured = Boolean(RELAY_URL);

export type AlertSeverity = 'unresponsive' | 'minor' | 'moderate' | 'severe' | 'unknown';

const SEVERITY_TEXT: Record<AlertSeverity, string> = {
  unresponsive: 'NO RESPONSE: they did not answer the "Are you OK?" check',
  unknown: 'not reported yet',
  minor: 'minor',
  moderate: 'moderate',
  severe: 'SEVERE',
};

export function buildAlertMessage(severity: AlertSeverity, location: LatLng | null, at = Date.now()) {
  return renderAlert(severity, location ? mapsLink(location) : '(location unavailable)', formatTime(at));
}

/** The no-response alert with {LINK} and {TIME} placeholders, filled in by the native service. */
export function buildAlertTemplate() {
  return renderAlert('unresponsive', '{LINK}', '{TIME}');
}

function renderAlert(severity: AlertSeverity, where: string, time: string) {
  const { profile, settings } = getState();
  const name = profile.name.trim() || 'Your contact';
  const flag = severity === 'severe' ? '🚨 SEVERE 🚨 ' : '🚨 ';

  let msg =
    `${flag}${name} may have had a bike accident near ${where}. ` +
    `Last update: ${time}. ` +
    `Severity self-reported as: ${SEVERITY_TEXT[severity]}. ` +
    `Please check on them or call them directly${profile.phone ? `: ${profile.phone}` : ''}.`;

  if (settings.includeMedicalInfo) {
    const m = profile.medical;
    const parts = [
      m.bloodGroup && `Blood group ${m.bloodGroup}`,
      m.allergies && `Allergies: ${m.allergies}`,
      m.conditions && `Conditions: ${m.conditions}`,
    ].filter(Boolean);
    if (parts.length) msg += ` Medical info: ${parts.join('; ')}.`;
  }
  return msg;
}

export type NotifyResult = { channel: NotifyChannel; delivered: boolean; error?: string };

export function notifyContacts(severity: AlertSeverity, location: LatLng | null) {
  return sendToContacts(buildAlertMessage(severity, location));
}

async function sendToContacts(
  body: string,
  opts: { allowComposer?: boolean } = {},
): Promise<NotifyResult> {
  const { contacts } = getState();
  const phones = contacts.map((c) => c.phone.trim()).filter(Boolean);
  if (phones.length === 0) return { channel: 'none', delivered: false, error: 'No emergency contacts saved' };

  if (RELAY_URL) {
    try {
      const res = await fetch(RELAY_URL.replace(/\/$/, '') + '/alert', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(RELAY_KEY ? { Authorization: `Bearer ${RELAY_KEY}` } : {}),
        },
        body: JSON.stringify({ to: phones, body }),
      });
      if (res.ok) return { channel: 'relay', delivered: true };
      console.warn('Relay responded', res.status);
    } catch (e) {
      console.warn('Relay failed, falling back to SMS app', e);
    }
  }

  if (RideMonitor && (await canSendFromSim())) {
    const { sent, error } = await RideMonitor.sendSms(phones, body);
    if (sent > 0) return { channel: 'sim', delivered: true, error: error ?? undefined };
    console.warn('SIM send failed', error);
  }

  if (opts.allowComposer === false) {
    return { channel: 'none', delivered: false, error: 'SMS relay unavailable' };
  }

  if (!(await SMS.isAvailableAsync())) {
    return { channel: 'none', delivered: false, error: 'SMS is not available on this device' };
  }
  const { result } = await SMS.sendSMSAsync(phones, body);
  // Android always reports "unknown"; treat the composer opening as best effort.
  return { channel: 'sms_composer', delivered: result !== 'cancelled' };
}

let followUpTimer: ReturnType<typeof setInterval> | null = null;

/**
 * After an alert, keep contacts updated with the rider's latest position.
 * Only possible through the relay or the SIM: the composer would need a tap each time.
 */
export function startLocationFollowUps(getLocation: () => Promise<LatLng | null>) {
  stopLocationFollowUps();
  if ((!RELAY_URL && !RideMonitor) || !getState().settings.liveLocation) return;
  let sent = 0;
  followUpTimer = setInterval(async () => {
    sent += 1;
    if (sent > 5) return stopLocationFollowUps();
    const loc = await getLocation();
    if (!loc) return;
    const name = getState().profile.name.trim() || 'Your contact';
    await sendToContacts(`📍 Location update for ${name} (${formatTime(Date.now())}): ${mapsLink(loc)}`, {
      allowComposer: false,
    });
  }, 2 * 60 * 1000);
}

export function stopLocationFollowUps() {
  if (followUpTimer) clearInterval(followUpTimer);
  followUpTimer = null;
}

async function canSendFromSim() {
  if (Platform.OS !== 'android') return false;
  return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.SEND_SMS);
}
