import { router } from 'expo-router';

import { stopLocationFollowUps } from './alerts';
import { rideSession } from './ride-session';
import { actions } from './store';

/** Close out a crash / injury flow and go back to the ride (if one is running) or home. */
export function finishIncident(reportId?: string) {
  if (reportId) actions.updateReport(reportId, { handled: true });
  stopLocationFollowUps();
  rideSession.resumeDetection();
  router.dismissTo(rideSession.getSnapshot().active ? '/active-ride' : '/');
}
