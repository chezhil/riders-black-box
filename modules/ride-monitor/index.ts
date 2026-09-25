/**
 * Native Android ride monitor: a foreground service that keeps GPS logging and
 * crash detection running while the rider uses Google Maps or the screen is off.
 *
 * `RideMonitor` is null in Expo Go and on iOS; the app then falls back to the
 * foreground-only JS implementation in src/lib/ride-session.ts.
 */
import { requireOptionalNativeModule } from 'expo';
import type { EventSubscription } from 'expo-modules-core';

export type NativePoint = { lat: number; lng: number; t: number; speed: number | null };
export type NativeHardBrake = { lat: number; lng: number; t: number; decel: number };
export type BumpReason = 'moving_again' | 'not_moving' | 'handling' | 'no_fall';
export type NativeBump = { at: number; peakG: number; reason: BumpReason };

export type NativeCrash = {
  id: string;
  startedAt: number;
  deadline: number;
  peakG: number | null;
  lat: number | null;
  lng: number | null;
  via: 'sensor' | 'simulated';
  status: 'countdown' | 'fine' | 'help' | 'alerted';
  smsSent: number;
  smsError: string | null;
};

export type NativeSnapshot = {
  rideId: string;
  startTime: number;
  distanceM: number;
  currentSpeed: number;
  maxSpeed: number;
  gpsAccuracy: number | null;
  liveG: number;
  /** Crash detection is armed (rider moved recently, or motion gating is off). */
  armed: boolean;
  pointCount: number;
  lastPoint: NativePoint | null;
  hardBrakes: NativeHardBrake[];
  lastBump: NativeBump | null;
  crash: NativeCrash | null;
};

export type StartOptions = {
  rideId: string;
  detector: {
    impactG: number;
    settleMs: number;
    stillMs: number;
    stillStdG: number;
    stillGyro: number;
    orientationDeg: number;
    requireMotion: boolean;
    minSpeedMps: number;
    handlingPeakG: number;
    handlingPeaks: number;
  };
  countdownSeconds: number;
  contactPhones: string[];
  /** Alert SMS with {LINK} and {TIME} placeholders. */
  alertTemplate: string;
  autoSms: boolean;
  /** Shown to bystanders on the lock screen after no response. */
  riderName: string;
  medicalSummary: string;
  /** Same order as contactPhones. */
  contactNames: string[];
  /** Phone the contacts on speakerphone after the alert SMS. */
  autoCall: boolean;
  /** Loud siren + bystander screen after no response. */
  siren: boolean;
  emergencyNumber: string;
  /** Text updated locations every 3 minutes for 15 minutes after the alert. */
  followUps: boolean;
};

export type NativeEmergency = {
  active: boolean;
  sirenOn: boolean;
  callingName: string | null;
  callsFinished: boolean;
  pendingRetries: number;
};

type Events = {
  onRideUpdate: (s: NativeSnapshot) => void;
  onLiveG: (e: { g: number; armed: boolean }) => void;
  onBump: (e: NativeBump) => void;
  onCrash: (c: NativeCrash) => void;
  onCrashResolved: (c: NativeCrash) => void;
};

type RideMonitorNative = {
  start(options: StartOptions): Promise<void>;
  stop(): Promise<(NativeSnapshot & { route: NativePoint[]; endTime: number }) | null>;
  isRunning(): boolean;
  getSnapshot(): NativeSnapshot | null;
  getRoute(): NativePoint[];
  getCrash(): NativeCrash | null;
  simulateCrash(): void;
  resolveCrash(outcome: 'fine' | 'help'): void;
  resumeDetection(): void;
  stopEmergency(): void;
  /** Ring a non-emergency number directly (CALL_PHONE). False if not permitted. */
  placeCall(phone: string): boolean;
  stopSiren(): void;
  getEmergency(): NativeEmergency | null;
  sendSms(phones: string[], body: string): Promise<{ sent: number; error: string | null }>;
  getSystemStatus(): {
    notificationsEnabled: boolean;
    fullScreenIntentAllowed: boolean;
    ignoringBatteryOptimizations: boolean;
  };
  openFullScreenIntentSettings(): void;
  requestIgnoreBatteryOptimizations(): void;
  addListener<E extends keyof Events>(event: E, listener: Events[E]): EventSubscription;
};

export const RideMonitor = requireOptionalNativeModule<RideMonitorNative>('RideMonitor');
