import { View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { callEmergencyNumber, openNearbyHospitals } from '@/lib/flow';
import { useApp } from '@/lib/store';

import { Button } from './ui';

/** "Locate nearest hospital", shown right under every post-crash Call 112 button. */
export function LocateHospitalButton({
  reportId,
  crashId,
}: {
  reportId?: string | null;
  crashId?: string | null;
}) {
  return (
    <Button
      label="Locate nearest hospital"
      icon="business"
      variant="secondary"
      onPress={() => openNearbyHospitals({ reportId, crashId })}
    />
  );
}

/** Call 112 now, with Locate nearest hospital directly under it. */
export function EmergencyActions({
  reportId,
  crashId,
  isTest,
}: {
  reportId?: string | null;
  crashId?: string | null;
  isTest: boolean;
}) {
  const emergencyNumber = useApp((s) => s.settings.emergencyNumber);
  return (
    <View style={{ gap: Spacing.sm }}>
      <Button
        label={`Call ${emergencyNumber} now`}
        icon="call"
        variant="danger"
        onPress={() => callEmergencyNumber(emergencyNumber, isTest)}
      />
      <LocateHospitalButton reportId={reportId} crashId={crashId} />
    </View>
  );
}
