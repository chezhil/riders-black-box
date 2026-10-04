import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

import { rideSession } from '@/lib/ride-session';

/**
 * Coming back to a ride screen means every crash / injury screen above it was
 * closed, however the rider left them (including Back): make sure crash
 * detection is on again.
 */
export function useResumeDetectionOnFocus() {
  useFocusEffect(
    useCallback(() => {
      if (rideSession.getSnapshot().suspended) rideSession.resumeDetection();
    }, []),
  );
}
