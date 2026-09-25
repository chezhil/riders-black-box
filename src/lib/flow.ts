import { router } from 'expo-router';
import { Alert, Linking, Platform } from 'react-native';

import { RideMonitor } from '@modules/ride-monitor';


import { sendAllClear, stopLocationFollowUps, type AllClearKind } from './alerts';
import { rideSession } from './ride-session';
import { actions, getState, useApp } from './store';

/**
 * End the emergency: stop the siren, auto-calls and location follow-ups, and
 * if contacts were alerted about this incident, text them that it's over.
 */
export function endIncident(
  { crashId, reportId }: { crashId?: string | null; reportId?: string | null },
  kind: AllClearKind,
) {
  stopLocationFollowUps();
  rideSession.endEmergency();

  const { reports, crashes } = getState();
  const report = reportId ? reports.find((r) => r.id === reportId) : undefined;
  const crash = crashes.find((c) => c.id === (crashId ?? report?.crashEventId));
  const isTest = report?.test || crash?.detectedVia === 'simulated';
  const alerted = Boolean(report?.contactsNotified || crash?.contactsNotified);
  const alreadySent = Boolean(report?.allClearSent || crash?.allClearSent);
  if (isTest || !alerted || alreadySent) return;

  if (report) actions.updateReport(report.id, { allClearSent: true });
  if (crash) actions.updateCrash(crash.id, { allClearSent: true });
  sendAllClear(kind).then((result) => {
    if (result.delivered && result.channel !== 'sms_composer') {
      Alert.alert('Contacts updated', "We texted your emergency contacts that you're OK.");
    } else if (!result.delivered && result.channel !== 'sms_composer') {
      Alert.alert("Couldn't text your contacts", `Let them know you're OK yourself. ${result.error ?? ''}`.trim());
    }
  });
}

/** Close out a crash / injury flow and go back to the ride (if one is running) or home. */
export function finishIncident(reportId?: string, kind: AllClearKind = 'handled', crashId?: string) {
  if (reportId) actions.updateReport(reportId, { handled: true });
  endIncident({ reportId: reportId || null, crashId: crashId || null }, kind);
  rideSession.resumeDetection();
  router.dismissTo(rideSession.getSnapshot().active ? '/active-ride' : '/');
}

/** Phone an emergency contact: rings straight away on Android, else opens the dialer. */
export function callContact(phone: string) {
  const number = phone.replace(/[^\d+]/g, '');
  if (Platform.OS === 'android' && RideMonitor?.placeCall(number)) return;
  Linking.openURL(`tel:${number}`);
}

/**
 * Dial the emergency number, unless this is a simulated crash: then explain
 * instead, so a demo can never reach emergency services.
 */
export function callEmergencyNumber(emergencyNumber: string, isTest: boolean) {
  if (isTest) {
    Alert.alert(
      `Test: not calling ${emergencyNumber}`,
      `This is a simulated crash, so emergency services aren't called. In a real emergency this button calls ${emergencyNumber} immediately.`,
    );
    return;
  }
  Linking.openURL(`tel:${emergencyNumber}`);
}

/**
 * A simulated crash is a test run: it only contacts the rider's emergency
 * contacts (with messages marked TEST) and never calls 112 or hospitals.
 */
export function useIsTestCrash(crashId: string | null | undefined) {
  return useApp((s) => (crashId ? s.crashes.find((c) => c.id === crashId)?.detectedVia === 'simulated' : false));
}

/** Open the nearby-hospitals list, carrying the incident so demo protection still applies. */
export function openNearbyHospitals({ reportId, crashId }: { reportId?: string | null; crashId?: string | null }) {
  router.push({ pathname: '/outcome/hospitals', params: { reportId: reportId ?? '', crashId: crashId ?? '' } });
}

/** True for anything that came from a simulated crash, whether we know the report, the crash, or both. */
export function useIsTest({ reportId, crashId }: { reportId?: string | null; crashId?: string | null }) {
  const reportIsTest = useIsTestReport(reportId);
  const crashIsTest = useIsTestCrash(crashId);
  return reportIsTest || crashIsTest;
}

/** Same, for an injury report (true when it came from a simulated crash). */
export function useIsTestReport(reportId: string | null | undefined) {
  return useApp((s) => {
    const report = reportId ? s.reports.find((r) => r.id === reportId) : undefined;
    if (report?.test) return true;
    const crashId = report?.crashEventId;
    return crashId ? s.crashes.find((c) => c.id === crashId)?.detectedVia === 'simulated' : false;
  });
}
