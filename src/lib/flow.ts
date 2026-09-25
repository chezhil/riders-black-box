import { router } from 'expo-router';
import { Alert, Linking } from 'react-native';

import { stopLocationFollowUps } from './alerts';
import { rideSession } from './ride-session';
import { actions, useApp } from './store';

/** Close out a crash / injury flow and go back to the ride (if one is running) or home. */
export function finishIncident(reportId?: string) {
  if (reportId) actions.updateReport(reportId, { handled: true });
  stopLocationFollowUps();
  rideSession.endEmergency();
  rideSession.resumeDetection();
  router.dismissTo(rideSession.getSnapshot().active ? '/active-ride' : '/');
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

/** Same, for an injury report (true when it came from a simulated crash). */
export function useIsTestReport(reportId: string | null | undefined) {
  return useApp((s) => {
    const report = reportId ? s.reports.find((r) => r.id === reportId) : undefined;
    if (report?.test) return true;
    const crashId = report?.crashEventId;
    return crashId ? s.crashes.find((c) => c.id === crashId)?.detectedVia === 'simulated' : false;
  });
}
