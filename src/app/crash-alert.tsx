import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';

import { Colors, Spacing } from '@/constants/theme';
import { notifyContacts, startLocationFollowUps } from '@/lib/alerts';
import { rideSession } from '@/lib/ride-session';
import { actions, getState, useApp } from '@/lib/store';

export default function CrashAlert() {
  const { crashId, deadline: deadlineParam } = useLocalSearchParams<{ crashId: string; deadline?: string }>();
  const countdownSeconds = useApp((s) => s.settings.countdownSeconds);
  // When the native service owns the countdown, follow its deadline exactly.
  const nativeDeadline = deadlineParam ? Number(deadlineParam) : null;
  const [deadline] = useState(() => nativeDeadline ?? Date.now() + countdownSeconds * 1000);
  const total = countdownSeconds;
  const [left, setLeft] = useState(total);
  const done = useRef(false);

  // Alarm: vibrate continuously until the rider responds (the native service vibrates on its own).
  useEffect(() => {
    if (!nativeDeadline) Vibration.vibrate([0, 700, 400], true);
    const back = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => {
      Vibration.cancel();
      back.remove();
    };
  }, [nativeDeadline]);

  // Answered from the notification or lock screen, or the service already texted contacts.
  useEffect(
    () =>
      rideSession.onCrashResolved((r) => {
        if (r.id !== crashId || !finish()) return;
        if (r.outcome === 'fine') router.back();
        else router.replace({ pathname: '/checkin', params: { crashId, auto: r.outcome === 'alerted' ? '1' : '' } });
      }),
    [crashId],
  );

  function finish() {
    if (done.current) return false;
    done.current = true;
    Vibration.cancel();
    return true;
  }

  function onFine() {
    if (!finish()) return;
    actions.updateCrash(crashId, { response: 'confirmed_fine' });
    rideSession.resolveCrash('fine');
    rideSession.resumeDetection();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  }

  function onNeedHelp() {
    if (!finish()) return;
    actions.updateCrash(crashId, { response: 'needs_help' });
    rideSession.resolveCrash('help');
    router.replace({ pathname: '/checkin', params: { crashId } });
  }

  function onNoResponse() {
    if (!finish()) return;
    actions.updateCrash(crashId, { response: 'no_response' });
    router.replace({ pathname: '/checkin', params: { crashId, auto: '1' } });
    // The native service texts contacts from the SIM itself.
    if (nativeDeadline) return;

    const crash = getState().crashes.find((c) => c.id === crashId);
    (async () => {
      const location = crash?.location ?? (await rideSession.currentLocation());
      const result = await notifyContacts('unresponsive', location);
      actions.updateCrash(crashId, {
        location,
        contactsNotified: result.delivered,
        notifyChannel: result.channel,
      });
      startLocationFollowUps(() => rideSession.currentLocation());
    })();
  }

  useEffect(() => {
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setLeft(remaining);
      if (remaining === 0) {
        clearInterval(id);
        onNoResponse();
      }
    }, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadline]);

  const progress = left / total;
  const R = 110;
  const C = 2 * Math.PI * R;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.top}>
        <Ionicons name="warning" size={40} color={Colors.danger} />
        <Text style={styles.title}>Are you OK?</Text>
        <Text style={styles.sub}>
          We detected a possible crash. If you don&apos;t respond, your emergency contacts will get your
          location.
        </Text>
      </View>

      <View style={styles.ring}>
        <Svg width={260} height={260} viewBox="0 0 260 260">
          <Circle cx={130} cy={130} r={R} stroke={Colors.dangerDim} strokeWidth={14} fill="none" />
          <Circle
            cx={130}
            cy={130}
            r={R}
            stroke={Colors.danger}
            strokeWidth={14}
            fill="none"
            strokeDasharray={`${C} ${C}`}
            strokeDashoffset={C * (1 - progress)}
            strokeLinecap="round"
            transform="rotate(-90 130 130)"
          />
        </Svg>
        <View style={styles.ringCenter}>
          <Text style={styles.count}>{left}</Text>
          <Text style={styles.countLabel}>seconds</Text>
        </View>
      </View>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="I'm fine"
          onPress={onFine}
          style={({ pressed }) => [styles.fine, pressed && { opacity: 0.85 }]}>
          <Ionicons name="checkmark-circle" size={40} color="#04140A" />
          <Text style={styles.fineText}>I&apos;m Fine</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="I need help"
          onPress={onNeedHelp}
          style={({ pressed }) => [styles.help, pressed && { opacity: 0.85 }]}>
          <Ionicons name="medkit" size={22} color={Colors.text} />
          <Text style={styles.helpText}>I Need Help</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#140607',
    padding: Spacing.xl,
    justifyContent: 'space-between',
  },
  top: { alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.lg },
  title: { color: Colors.text, fontSize: 40, fontWeight: '900', letterSpacing: -1 },
  sub: { color: Colors.textDim, fontSize: 16, textAlign: 'center', lineHeight: 22 },
  ring: { alignItems: 'center', justifyContent: 'center' },
  ringCenter: { position: 'absolute', alignItems: 'center' },
  count: { color: Colors.text, fontSize: 88, fontWeight: '900', letterSpacing: -3 },
  countLabel: { color: Colors.textDim, fontSize: 14, fontWeight: '700', marginTop: -8 },
  actions: { gap: Spacing.md },
  fine: {
    backgroundColor: Colors.ok,
    borderRadius: 28,
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: Spacing.md,
  },
  fineText: { color: '#04140A', fontSize: 36, fontWeight: '900' },
  help: {
    borderRadius: 18,
    minHeight: 64,
    borderWidth: 2,
    borderColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  helpText: { color: Colors.text, fontSize: 20, fontWeight: '800' },
});
