/**
 * The active ride: GPS logging, hard-brake detection and crash monitoring.
 *
 * A module-level singleton so it survives navigation (the crash alert and
 * injury check-in screens open on top of the ride without stopping it).
 *
 * Location is only polled while a ride is active. In Expo Go the app has to
 * stay in the foreground, so the ride screen keeps the display awake.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { Accelerometer, Gyroscope } from 'expo-sensors';

import { CrashDetector, SENSITIVITY_PRESETS, type DetectorEvent } from './crash-detector';
import { distanceM } from './geo';
import { actions, getState, newId } from './store';
import type { HardBrakeEvent, LatLng, Ride, RoutePoint } from './types';

const SENSOR_INTERVAL_MS = 20; // 50 Hz
const HARD_BRAKE_MPS2 = 3.5; // ~0.35 g sustained deceleration
const HARD_BRAKE_MIN_SPEED = 5; // m/s (18 km/h)
const MAX_GOOD_ACCURACY_M = 30;
const KEEP_AWAKE_TAG = 'active-ride';

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
  lastBump: { at: number; peakG: number } | null;
};

export type CrashTrigger = {
  rideId: string | null;
  location: LatLng | null;
  peakG: number | null;
  via: 'sensor' | 'simulated';
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
  lastBump: null,
};

let snap: RideSnapshot = IDLE;
const listeners = new Set<() => void>();
const crashListeners = new Set<(t: CrashTrigger) => void>();

const detector = new CrashDetector();
let suspended = false;
let locationSub: Location.LocationSubscription | null = null;
let accelSub: { remove(): void } | null = null;
let gyroSub: { remove(): void } | null = null;
let lastGEmit = 0;

function update(patch: Partial<RideSnapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
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

  async requestPermissions() {
    const loc = await Location.requestForegroundPermissionsAsync();
    // Motion permission is needed on iOS; Android grants accelerometer access by default.
    const motion = await Accelerometer.requestPermissionsAsync().catch(() => null);
    return { location: loc.granted, motion: motion?.granted ?? true };
  },

  async start() {
    if (snap.active) return;
    const perms = await this.requestPermissions();
    if (!perms.location) throw new Error('Location permission is needed to record a ride.');

    update({ ...IDLE, active: true, rideId: newId(), startTime: Date.now() });
    await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});

    locationSub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 5 },
      onLocation,
    );

    this.startMonitoring();
  },

  startMonitoring() {
    const { sensitivity } = getState().settings;
    detector.setConfig(SENSITIVITY_PRESETS[sensitivity]);
    detector.reset();
    suspended = false;

    Accelerometer.setUpdateInterval(SENSOR_INTERVAL_MS);
    Gyroscope.setUpdateInterval(SENSOR_INTERVAL_MS);
    accelSub = Accelerometer.addListener(({ x, y, z }) => {
      const t = Date.now();
      const g = Math.sqrt(x * x + y * y + z * z);
      if (t - lastGEmit > 250) {
        lastGEmit = t;
        update({ liveG: g });
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

  /** Pause crash detection while the "Are you OK?" flow is on screen. */
  suspendDetection() {
    suspended = true;
    detector.reset();
  },

  resumeDetection() {
    detector.reset();
    suspended = false;
  },

  /** Demo / testing: fire the crash flow without falling off a bike. */
  simulateCrash() {
    emitCrash({ rideId: snap.rideId, location: snap.lastLocation, peakG: null, via: 'simulated' });
  },

  async stop(): Promise<Ride | null> {
    if (!snap.active) return null;
    locationSub?.remove();
    accelSub?.remove();
    gyroSub?.remove();
    locationSub = accelSub = gyroSub = null;
    deactivateKeepAwake(KEEP_AWAKE_TAG);

    const endTime = Date.now();
    const moving = snap.points.filter((p) => (p.speed ?? 0) > 1);
    const ride: Ride = {
      id: snap.rideId!,
      startTime: snap.startTime,
      endTime,
      routePoints: downsample(snap.points, 1500),
      distanceM: snap.distanceM,
      avgSpeed: moving.length ? moving.reduce((a, p) => a + (p.speed ?? 0), 0) / moving.length : 0,
      maxSpeed: snap.maxSpeed,
      hardBrakeEvents: snap.hardBrakes,
    };
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

function onLocation(loc: Location.LocationObject) {
  const { latitude: lat, longitude: lng, speed, accuracy } = loc.coords;
  const t = loc.timestamp;
  const point: RoutePoint = { lat, lng, t, speed: speed != null && speed >= 0 ? speed : null };
  const prev = snap.points[snap.points.length - 1];

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
}

function onDetectorEvent(event: DetectorEvent) {
  if (event.type === 'bump') {
    update({ lastBump: { at: event.impactAt, peakG: event.peakG } });
    return;
  }
  emitCrash({ rideId: snap.rideId, location: snap.lastLocation, peakG: event.peakG, via: 'sensor' });
}

function emitCrash(trigger: CrashTrigger) {
  rideSession.suspendDetection();
  crashListeners.forEach((l) => l(trigger));
}

function downsample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.floor(i * step)]);
  out.push(xs[xs.length - 1]);
  return out;
}
