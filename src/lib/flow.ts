import { router } from 'expo-router';

import { stopLocationFollowUps } from './alerts';
import { rideSession } from './ride-session';
import { actions, useApp } from './store';

/** Close out a crash / injury flow and go back to the ride (if one is running) or home. */
export function finishIncident(reportId?: string) {
  if (reportId) actions.updateReport(reportId, { handled: true });
  stopLocationFollowUps();
  rideSession.resumeDetection();
  router.dismissTo(rideSession.getSnapshot().active ? '/active-ride' : '/');
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
    const crashId = reportId ? s.reports.find((r) => r.id === reportId)?.crashEventId : null;
    return crashId ? s.crashes.find((c) => c.id === crashId)?.detectedVia === 'simulated' : false;
  });
}
