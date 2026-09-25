/**
 * The active ride: GPS logging, hard-brake detection and crash monitoring.
 *
 * Two engines behind one interface:
 *  - native (Android build): the RideMonitor foreground service in
 *    modules/ride-monitor keeps tracking and detecting crashes while the rider
 *    uses Google Maps or the screen is off, and texts contacts from the SIM if
 *    they don't respond.
 *  - js (Expo Go / iOS): foreground-only; the ride screen keeps the display on.
 *
 * A module-level singleton so it survives navigation (the crash alert and
 * injury check-in screens open on top of the ride without stopping it).
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import { AppState, PermissionsAndroid, Platform } from 'react-native';

import {
  RideMonitor,
  type BumpReason,
  type NativeCrash,
  type NativeSnapshot,
} from '@modules/ride-monitor';

import { buildAlertTemplate } from './alerts';
import {
  CrashDetector,
  SENSITIVITY_PRESETS,
  type DetectorConfig,
  type DetectorEvent,
} from './crash-detector';
import { distanceM } from './geo';
import { prefetchNearby } from './hospitals';
import { actions, getState, newId } from './store';
import type { HardBrakeEvent, LatLng, Ride, RoutePoint } from './types';

const SENSOR_INTERVAL_MS = 20; // 50 Hz
const HARD_BRAKE_MPS2 = 3.5; // ~0.35 g sustained deceleration
const HARD_BRAKE_MIN_SPEED = 5; // m/s (18 km/h)
const MAX_GOOD_ACCURACY_M = 30;
const KEEP_AWAKE_TAG = 'active-ride';

/** True when rides keep running in the background (Android build with the native module). */
export const backgroundCapable = RideMonitor != null;

export type RideSnapshot = {
  active: boolean;
  rideId: string | null;
  startTime: number;
  points: RoutePoint[];
  distanceM: number;
  currentSpeed: number;
  maxSpeed: number;
  hardBrakes: HardBrakeEvent[];
  lastLocation: LatLng | null;
  gpsAccuracy: number | null;
  /** Live acceleration magnitude in g, for the monitoring indicator. */
  liveG: number;
  monitoring: boolean;
  /** Crash detection is armed: the rider has been moving recently (or motion gating is off). */
  armed: boolean;
  lastBump: { at: number; peakG: number; reason: BumpReason } | null;
};

export type CrashTrigger = {
  /** Native crash id, reused as the CrashEvent id so both sides agree. */
  id: string | null;
  rideId: string | null;
  location: LatLng | null;
  peakG: number | null;
  via: 'sensor' | 'simulated';
  /** Epoch ms when contacts get alerted, if the native service owns the countdown. */
  deadline: number | null;
};

export type CrashResolution = {
  id: string;
  outcome: 'fine' | 'help' | 'alerted';
  smsSent: number;
  smsError: string | null;
  location: LatLng | null;
};

const IDLE: RideSnapshot = {
  active: false,
  rideId: null,
  startTime: 0,
  points: [],
  distanceM: 0,
  currentSpeed: 0,
  maxSpeed: 0,
  hardBrakes: [],
  lastLocation: null,
  gpsAccuracy: null,
  liveG: 1,
  monitoring: false,
  armed: false,
  lastBump: null,
};

function detectorConfig(): DetectorConfig {
  const { sensitivity, detectOnlyWhenMoving } = getState().settings;
  return { ...SENSITIVITY_PRESETS[sensitivity], requireMotion: detectOnlyWhenMoving };
}

let snap: RideSnapshot = IDLE;
const listeners = new Set<() => void>();
const crashListeners = new Set<(t: CrashTrigger) => void>();
const resolvedListeners = new Set<(r: CrashResolution) => void>();

function update(patch: Partial<RideSnapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

function emitCrash(trigger: CrashTrigger) {
  crashListeners.forEach((l) => l(trigger));
}

export const rideSession = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getSnapshot() {
    return snap;
  },

  onCrash(listener: (t: CrashTrigger) => void) {
    crashListeners.add(listener);
    return () => {
      crashListeners.delete(listener);
    };
  },

  /** Native only: the crash was answered from the notification / lock screen, or contacts were texted. */
  onCrashResolved(listener: (r: CrashResolution) => void) {
    resolvedListeners.add(listener);
    return () => {
      resolvedListeners.delete(listener);
    };
  },

  async requestPermissions() {
    const loc = await Location.requestForegroundPermissionsAsync();
    // Motion permission is needed on iOS; Android grants accelerometer access by default.
    const motion = await Accelerometer.requestPermissionsAsync().catch(() => null);
    let notifications = true;
    let sms = false;
    if (Platform.OS === 'android' && backgroundCapable) {
      const wanted = [PermissionsAndroid.PERMISSIONS.SEND_SMS];
      if (Number(Platform.Version) >= 33) wanted.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      const res = await PermissionsAndroid.requestMultiple(wanted);
      sms = res[PermissionsAndroid.PERMISSIONS.SEND_SMS] === 'granted';
      if (Number(Platform.Version) >= 33) {
        notifications = res[PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS] === 'granted';
      }
    }
    return { location: loc.granted, motion: motion?.granted ?? true, notifications, sms };
  },

  async start() {
    if (snap.active) return;
    const perms = await this.requestPermissions();
    if (!perms.location) throw new Error('Location permission is needed to record a ride.');
    const rideId = newId();

    if (RideMonitor) {
      const { settings, contacts } = getState();
      await RideMonitor.start({
        rideId,
        detector: detectorConfig(),
        countdownSeconds: settings.countdownSeconds,
        contactPhones: contacts.map((c) => c.phone),
        alertTemplate: buildAlertTemplate(),
        autoSms: true,
      });
      update({ ...IDLE, active: true, rideId, startTime: Date.now(), monitoring: true });
      return;
    }

    update({ ...IDLE, active: true, rideId, startTime: Date.now() });
    await jsEngine.start();
  },

  /** Pause crash detection while the "Are you OK?" flow is on screen. */
  suspendDetection() {
    if (!RideMonitor) jsEngine.suspend();
    // Native suspends itself when it raises a crash.
  },

  resumeDetection() {
    if (RideMonitor) RideMonitor.resumeDetection();
    else jsEngine.resume();
  },

  /** Answer the native countdown ("I'm fine" / "I need help"). */
  resolveCrash(outcome: 'fine' | 'help') {
    RideMonitor?.resolveCrash(outcome);
  },

  /** Demo / testing: fire the crash flow without falling off a bike. */
  simulateCrash() {
    if (RideMonitor?.isRunning()) {
      RideMonitor.simulateCrash();
      return;
    }
    jsEngine.suspend();
    emitCrash({
      id: null,
      rideId: snap.rideId,
      location: snap.lastLocation,
      peakG: null,
      via: 'simulated',
      deadline: null,
    });
  },

  async stop(): Promise<Ride | null> {
    if (!snap.active) return null;
    let ride: Ride;

    if (RideMonitor) {
      const result = await RideMonitor.stop();
      const points = result?.route ?? snap.points;
      ride = buildRide(snap.rideId!, snap.startTime, Date.now(), points, {
        distanceM: result?.distanceM ?? snap.distanceM,
        maxSpeed: result?.maxSpeed ?? snap.maxSpeed,
        hardBrakes: result?.hardBrakes ?? snap.hardBrakes,
      });
    } else {
      jsEngine.stop();
      ride = buildRide(snap.rideId!, snap.startTime, Date.now(), snap.points, snap);
    }

    actions.addRide(ride);
    update(IDLE);
    return ride;
  },

  /** Best current position: live ride fix, else a fresh one-off GPS read. */
  async currentLocation(): Promise<LatLng | null> {
    if (snap.active && snap.lastLocation) return snap.lastLocation;
    try {
      const perm = await Location.getForegroundPermissionsAsync();
      if (!perm.granted) {
        const req = await Location.requestForegroundPermissionsAsync();
        if (!req.granted) return null;
      }
      const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
      const fix =
        last ??
        (await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
          new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
        ]));
      return fix ? { lat: fix.coords.latitude, lng: fix.coords.longitude } : null;
    } catch {
      return null;
    }
  },
};

function buildRide(
  id: string,
  startTime: number,
  endTime: number,
  points: RoutePoint[],
  stats: { distanceM: number; maxSpeed: number; hardBrakes: HardBrakeEvent[] },
): Ride {
  const moving = points.filter((p) => (p.speed ?? 0) > 1);
  return {
    id,
    startTime,
    endTime,
    routePoints: downsample(points, 1500),
    distanceM: stats.distanceM,
    avgSpeed: moving.length ? moving.reduce((a, p) => a + (p.speed ?? 0), 0) / moving.length : 0,
    maxSpeed: stats.maxSpeed,
    hardBrakeEvents: stats.hardBrakes,
  };
}

// ---- Native engine wiring ---------------------------------------------------

function applyNativeSnapshot(s: NativeSnapshot, points: RoutePoint[]) {
  update({
    active: true,
    rideId: s.rideId,
    startTime: s.startTime,
    points,
    distanceM: s.distanceM,
    currentSpeed: s.currentSpeed,
    maxSpeed: s.maxSpeed,
    hardBrakes: s.hardBrakes,
    lastLocation: s.lastPoint ? { lat: s.lastPoint.lat, lng: s.lastPoint.lng } : snap.lastLocation,
    gpsAccuracy: s.gpsAccuracy,
    liveG: s.liveG,
    monitoring: true,
    armed: s.armed,
    lastBump: s.lastBump,
  });
  // Keep nearby hospitals ready in case of a crash (every ~5 km).
  if (snap.lastLocation) prefetchNearby(snap.lastLocation);
}

function nativeCrashLocation(c: NativeCrash): LatLng | null {
  return c.lat != null && c.lng != null ? { lat: c.lat, lng: c.lng } : null;
}

/** Pull the full route from the service (after the app was in the background or reloaded). */
function resyncFromNative() {
  if (!RideMonitor?.isRunning()) {
    if (snap.active) update(IDLE);
    return;
  }
  const s = RideMonitor.getSnapshot();
  if (s) applyNativeSnapshot(s, RideMonitor.getRoute());
}

if (RideMonitor) {
  const native = RideMonitor;
  native.addListener('onRideUpdate', (s) => {
    const last = snap.points[snap.points.length - 1];
    const lp = s.lastPoint;
    const points = lp && (!last || lp.t > last.t) ? [...snap.points, lp] : snap.points;
    // If we missed updates (e.g. JS was paused), resync the whole route.
    if (s.pointCount > points.length + 1) applyNativeSnapshot(s, native.getRoute());
    else applyNativeSnapshot(s, points);
  });
  native.addListener('onLiveG', ({ g, armed }) => {
    if (snap.active) update({ liveG: g, armed });
  });
  native.addListener('onBump', (b) => update({ lastBump: b }));
  native.addListener('onCrash', (c) =>
    emitCrash({
      id: c.id,
      rideId: snap.rideId,
      location: nativeCrashLocation(c),
      peakG: c.peakG,
      via: c.via,
      deadline: c.deadline,
    }),
  );
  native.addListener('onCrashResolved', (c) => {
    if (c.status === 'countdown') return;
    resolvedListeners.forEach((l) =>
      l({
        id: c.id,
        outcome: c.status as CrashResolution['outcome'],
        smsSent: c.smsSent,
        smsError: c.smsError,
        location: nativeCrashLocation(c),
      }),
    );
  });

  // A ride may already be running if the JS app was reloaded or reopened.
  resyncFromNative();
  AppState.addEventListener('change', (state) => {
    if (state === 'active') resyncFromNative();
  });
}

/** Crash that happened while JS wasn't listening (app reopened mid-countdown). */
export function pendingNativeCrash(): NativeCrash | null {
  const c = RideMonitor?.getCrash() ?? null;
  return c && c.status === 'countdown' ? c : null;
}

// ---- JS engine (Expo Go / iOS: foreground only) -----------------------------

const jsEngine = (() => {
  const detector = new CrashDetector();
  let suspended = false;
  let locationSub: Location.LocationSubscription | null = null;
  let accelSub: { remove(): void } | null = null;
  let gyroSub: { remove(): void } | null = null;
  let lastGEmit = 0;

  function onDetectorEvent(event: DetectorEvent) {
    if (event.type === 'bump') {
      update({ lastBump: { at: event.impactAt, peakG: event.peakG, reason: event.reason } });
      return;
    }
    suspended = true;
    detector.reset();
    emitCrash({
      id: null,
      rideId: snap.rideId,
      location: snap.lastLocation,
      peakG: event.peakG,
      via: 'sensor',
      deadline: null,
    });
  }

  function onLocation(loc: Location.LocationObject) {
    const { latitude: lat, longitude: lng, speed, accuracy } = loc.coords;
    const t = loc.timestamp;
    const point: RoutePoint = { lat, lng, t, speed: speed != null && speed >= 0 ? speed : null };
    const prev = snap.points[snap.points.length - 1];
    detector.pushSpeed(Date.now(), point.speed);

    let added = 0;
    if (prev && (accuracy ?? 0) <= MAX_GOOD_ACCURACY_M) added = distanceM(prev, point);

    const hardBrakes = [...snap.hardBrakes];
    if (prev && prev.speed != null && point.speed != null) {
      const dt = (t - prev.t) / 1000;
      const decel = dt > 0 ? (prev.speed - point.speed) / dt : 0;
      const lastBrake = hardBrakes[hardBrakes.length - 1];
      if (
        decel >= HARD_BRAKE_MPS2 &&
        prev.speed >= HARD_BRAKE_MIN_SPEED &&
        (!lastBrake || t - lastBrake.t > 5000)
      ) {
        hardBrakes.push({ lat, lng, t, decel: Math.round(decel * 10) / 10 });
      }
    }

    update({
      points: [...snap.points, point],
      distanceM: snap.distanceM + added,
      currentSpeed: point.speed ?? 0,
      maxSpeed: Math.max(snap.maxSpeed, point.speed ?? 0),
      hardBrakes,
      lastLocation: { lat, lng },
      gpsAccuracy: accuracy ?? null,
    });
    prefetchNearby({ lat, lng });
  }

  return {
    async start() {
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
      locationSub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 5 },
        onLocation,
      );
      detector.setConfig(detectorConfig());
      detector.reset();
      suspended = false;
      Accelerometer.setUpdateInterval(SENSOR_INTERVAL_MS);
      Gyroscope.setUpdateInterval(SENSOR_INTERVAL_MS);
      accelSub = Accelerometer.addListener(({ x, y, z }) => {
        const t = Date.now();
        const g = Math.sqrt(x * x + y * y + z * z);
        if (t - lastGEmit > 250) {
          lastGEmit = t;
          update({ liveG: g, armed: detector.isArmed(t) });
        }
        if (suspended) return;
        const event = detector.pushAccel({ t, x, y, z });
        if (event) onDetectorEvent(event);
      });
      gyroSub = Gyroscope.addListener(({ x, y, z }) => {
        if (!suspended) detector.pushGyro({ t: Date.now(), x, y, z });
      });
      update({ monitoring: true });
    },
    suspend() {
      suspended = true;
      detector.reset();
    },
    resume() {
      detector.reset();
      suspended = false;
    },
    stop() {
      locationSub?.remove();
      accelSub?.remove();
      gyroSub?.remove();
      locationSub = accelSub = gyroSub = null;
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    },
  };
})();

function downsample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.floor(i * step)]);
  out.push(xs[xs.length - 1]);
  return out;
}
