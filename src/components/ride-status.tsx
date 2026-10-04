/** Dashboard "telltale" lights shared by the ride screen and the lock-screen dash. */
import { StyleSheet, Text } from 'react-native';

import { Colors, Fonts, Radius } from '@/constants/theme';
import type { RideSnapshot } from '@/lib/ride-session';

import { AppIcon, Row, type AppIconName } from './ui';

export type DetectionState = { label: string; hint: string; color: string; icon: AppIconName };

export function detectionState(
  ride: Pick<RideSnapshot, 'monitoring' | 'suspended' | 'armed' | 'noSensors'>,
): DetectionState {
  if (ride.noSensors) {
    return {
      label: 'No sensor',
      hint: "This phone has no motion sensor, so crashes can't be detected. Your route is still logged.",
      color: Colors.danger,
      icon: 'alert-circle',
    };
  }
  if (!ride.monitoring) return { label: 'Starting', hint: 'Starting sensors…', color: Colors.textFaint, icon: 'hourglass' };
  if (ride.suspended) {
    return { label: 'Paused', hint: 'Crash detection paused', color: Colors.danger, icon: 'pause-circle' };
  }
  if (ride.armed) return { label: 'Armed', hint: 'Crash detection active', color: Colors.ok, icon: 'shield-checkmark' };
  return {
    label: 'Standby',
    hint: "Crash detection turns on once you're moving",
    color: Colors.accent,
    icon: 'shield-outline',
  };
}

export function Telltale({ icon, label, color }: { icon: AppIconName; label: string; color: string }) {
  return (
    <Row gap={6} style={[styles.telltale, { borderColor: color }]}>
      <AppIcon name={icon} size={15} color={color} />
      <Text style={[styles.telltaleText, { color }]}>{label}</Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  telltale: {
    borderWidth: 1.5,
    borderRadius: Radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: Colors.surface,
  },
  telltaleText: { fontFamily: Fonts.heading, fontSize: 15, letterSpacing: 1, textTransform: 'uppercase' },
});
