import { router } from 'expo-router';
import { Alert, Linking, Platform } from 'react-native';

import { RideMonitor } from '@modules/ride-monitor';

import { sendAllClear, stopLocationFollowUps, type AllClearKind } from './alerts';
import { rideSession } from './ride-session';
import { actions, emergencyNumberOf, getState, useApp } from './store';
import type { NotifyChannel } from './types';

export { emergencyNumberOf };

type IncidentRef = { reportId?: string | null; crashId?: string | null };

export function useEmergencyNumber() {
  return useApp((s) => emergencyNumberOf(s.settings));
}

/**
 * Record that contacts were alerted about an incident, on the report if there
 * is one, else on the crash, so "I'm OK" can follow later.
 */
export function markIncidentNotified(
  { reportId, crashId }: IncidentRef,
  patch: { channel?: NotifyChannel; severeAlertSent?: boolean },
) {
  const { reports, crashes } = getState();
  const report = reportId ? reports.find((r) => r.id === reportId) : undefined;
  const crash = crashes.find((c) => c.id === (crashId || report?.crashEventId));
  const flags = patch.severeAlertSent ? { severeAlertSent: true } : {};
  if (report) actions.updateReport(report.id, { contactsNotified: true, ...flags });
  else if (crash) {
    actions.updateCrash(crash.id, {
      contactsNotified: true,
      ...(patch.channel ? { notifyChannel: patch.channel } : {}),
      ...flags,
    });
  }
}

/** The Emergency screen already auto-sent its SEVERE alert for this incident. */
export function severeAlertAlreadySent({ reportId, crashId }: IncidentRef) {
  const { reports, crashes } = getState();
  const report = reportId ? reports.find((r) => r.id === reportId) : undefined;
  if (report) return Boolean(report.severeAlertSent);
  const crash = crashId ? crashes.find((c) => c.id === crashId) : undefined;
  return Boolean(crash?.severeAlertSent);
}

/** Flag the SEVERE alert as sent before sending, so a second Emergency screen can't send it again. */
export function markSevereAlertSent({ reportId, crashId }: IncidentRef) {
  const { reports, crashes } = getState();
  const report = reportId ? reports.find((r) => r.id === reportId) : undefined;
  if (report) actions.updateReport(report.id, { severeAlertSent: true });
  else if (crashId && crashes.some((c) => c.id === crashId)) actions.updateCrash(crashId, { severeAlertSent: true });
}

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

  const setAllClearSent = (allClearSent: boolean) => {
    if (report) actions.updateReport(report.id, { allClearSent });
    if (crash) actions.updateCrash(crash.id, { allClearSent });
  };
  const failed = (error?: string) => {
    // Let a later "I'm OK" try again.
    setAllClearSent(false);
    Alert.alert("Couldn't text your contacts", `Let them know you're OK yourself. ${error ?? ''}`.trim());
  };
  setAllClearSent(true);
  sendAllClear(kind)
    .then((result) => {
      if (result.delivered && result.channel !== 'sms_composer') {
        Alert.alert('Contacts updated', "We texted your emergency contacts that you're OK.");
      } else if (!result.delivered) {
        failed(result.error);
      }
    })
    .catch((e) => failed(e instanceof Error ? e.message : String(e)));
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
export function callEmergencyNumber(number: string, isTest: boolean) {
  const emergencyNumber = emergencyNumberOf({ emergencyNumber: number });
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
export function openNearbyHospitals({ reportId, crashId }: IncidentRef) {
  router.push({ pathname: '/outcome/hospitals', params: { reportId: reportId ?? '', crashId: crashId ?? '' } });
}

/** True for anything that came from a simulated crash, whether we know the report, the crash, or both. */
export function useIsTest({ reportId, crashId }: IncidentRef) {
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
