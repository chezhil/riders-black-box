/**
 * Threshold-based fall/crash detector.
 *
 * Only ARMED while the rider is actually riding: GPS speed >= `minSpeedMps` at
 * some point in the last 30 s, AND not stopped since (GPS below ~5 km/h for
 * 4 s). A crash happens at speed, so pulling the phone out of a pocket at a
 * red light never counts. (Can be disabled with `requireMotion: false` for
 * bench testing.)
 *
 * A crash is the sequence:
 *   0. NOT HANDLING — the 2 s before the impact weren't a burst of repeated
 *                    jolts (someone shaking / fiddling with the phone), and
 *                    nobody unlocked or touched the phone around it.
 *   1. IMPACT      — acceleration magnitude spikes above `impactG`.
 *   2. SETTLE      — ignore the tumble for `settleMs` after the impact.
 *   3. STILLNESS   — for `stillMs`, the phone is (nearly) motionless: low variance
 *                    in acceleration magnitude and low rotation rate.
 *   4. ORIENTATION — the gravity direction after the fall differs from the one
 *                    before it by at least `orientationDeg` (the bike / rider went
 *                    down). A very hard impact (>= 2x impactG) skips this check.
 *   5. STOPPED     — a GPS reading from 3 s or more after the impact shows the
 *                    rider is no longer riding (a pothole, then the phone settling
 *                    at a new angle in a pocket, is otherwise indistinguishable).
 *                    No reading within ~2.5 s of the stillness window: alert anyway.
 *
 * If motion resumes during the stillness window it was a pothole / dropped
 * phone that was picked up, and it is reported as a "bump" instead.
 *
 * Pure TypeScript with no React Native imports, so it can be unit-tested and
 * later swapped for an on-device ML model with the same interface.
 */
import type { Sensitivity } from './types';

/** Accelerometer sample in g (1g = 9.81 m/s²), timestamp in ms. */
export type AccelSample = { t: number; x: number; y: number; z: number };
/** Gyroscope sample in rad/s, timestamp in ms. */
export type GyroSample = { t: number; x: number; y: number; z: number };

export type DetectorConfig = {
  impactG: number;
  settleMs: number;
  stillMs: number;
  /** Max std-dev of |a| (in g) during the stillness window. */
  stillStdG: number;
  /** Max mean rotation rate (rad/s) during the stillness window. */
  stillGyro: number;
  orientationDeg: number;
  /** Only detect while GPS says the rider was recently moving. */
  requireMotion: boolean;
  minSpeedMps: number;
  /** >= `handlingPeaks` separate jolts above `handlingPeakG` just before impact = handling, not a crash. */
  handlingPeakG: number;
  handlingPeaks: number;
};

const COMMON = {
  settleMs: 1000,
  requireMotion: true,
  minSpeedMps: 3, // ~11 km/h
  handlingPeakG: 2,
  handlingPeaks: 3,
};

export const SENSITIVITY_PRESETS: Record<Sensitivity, DetectorConfig> = {
  // Fewer false alarms; needs a harder hit.
  low: { ...COMMON, impactG: 5, stillMs: 3000, stillStdG: 0.1, stillGyro: 0.4, orientationDeg: 50 },
  medium: { ...COMMON, impactG: 4, stillMs: 3000, stillStdG: 0.12, stillGyro: 0.5, orientationDeg: 40 },
  // Catches gentler falls; more "Are you OK?" prompts.
  high: { ...COMMON, impactG: 3, stillMs: 2500, stillStdG: 0.18, stillGyro: 0.7, orientationDeg: 30 },
};

export type BumpReason = 'moving_again' | 'not_moving' | 'handling' | 'no_fall';

export type DetectorEvent =
  | { type: 'crash'; impactAt: number; peakG: number; orientationChangeDeg: number }
  | { type: 'bump'; impactAt: number; peakG: number; reason: BumpReason };

type Vec = [number, number, number];

const PRE_WINDOW_MS = 2000;
const PRE_GUARD_MS = 250;
const MOTION_WINDOW_MS = 30_000;
/** Below this GPS speed (≈5 km/h, walking pace) the rider counts as stopped… */
const STOP_SPEED_MPS = 1.5;
/** …once it has lasted this long. Long enough to ride through a GPS glitch, short enough for a red light. */
const STOPPED_MS = 4000;
/** An impact this soon after the rider unlocked or touched the phone is them handling it. */
const INTERACTION_MS = 2000;
/**
 * GPS readings from this long after an impact say whether the rider is still riding
 * (a pothole) or has stopped (a crash). Earlier readings can still carry the pre-crash speed.
 */
const SPEED_CHECK_AFTER_MS = 3000;
/** How long past the stillness window to wait for that reading before alerting anyway. */
const GPS_GRACE_MS = 2500;

const mag = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

function meanVec(samples: AccelSample[]): Vec | null {
  if (samples.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const s of samples) {
    x += s.x;
    y += s.y;
    z += s.z;
  }
  return [x / samples.length, y / samples.length, z / samples.length];
}

function angleDeg(a: Vec, b: Vec) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const denom = mag(...a) * mag(...b);
  if (denom === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot / denom))) * 180) / Math.PI;
}

export class CrashDetector {
  private config: DetectorConfig;
  private history: AccelSample[] = [];
  private phase: 'idle' | 'impact' = 'idle';
  private impactAt = 0;
  private peakG = 0;
  private preGravity: Vec | null = null;
  private window: AccelSample[] = [];
  private gyroWindow: number[] = [];
  private lastMovingAt = -Infinity;
  /** Start of the current run of slow GPS readings, or null while moving. */
  private slowSince: number | null = null;
  private lastInteractionAt = -Infinity;
  private lastIgnoredAt = -Infinity;
  /** A GPS reading came in late enough after the impact to judge it… */
  private speedSeenAfterImpact = false;
  /** …and it showed the rider still riding. */
  private movedAfterImpact = false;
  /** Looked like a crash; waiting for that GPS reading before alerting. */
  private pending: { orientationChangeDeg: number } | null = null;

  constructor(config: DetectorConfig = SENSITIVITY_PRESETS.medium) {
    this.config = config;
  }

  setConfig(config: DetectorConfig) {
    this.config = config;
  }

  reset() {
    this.history = [];
    this.backToIdle();
  }

  /** End an impact evaluation but keep the rolling history, so a burst of jolts stays visible. */
  private backToIdle() {
    this.phase = 'idle';
    this.window = [];
    this.gyroWindow = [];
    this.preGravity = null;
    this.peakG = 0;
    this.speedSeenAfterImpact = false;
    this.movedAfterImpact = false;
    this.pending = null;
  }

  /** Feed GPS speed (m/s) so the detector knows whether the rider is riding. */
  pushSpeed(t: number, speedMps: number | null) {
    if (speedMps == null) return; // no speed in this fix: tells us nothing
    if (this.phase === 'impact' && t >= this.impactAt + SPEED_CHECK_AFTER_MS) {
      this.speedSeenAfterImpact = true;
      if (speedMps >= this.config.minSpeedMps) this.movedAfterImpact = true;
    }
    if (speedMps >= this.config.minSpeedMps) this.lastMovingAt = t;
    if (speedMps < STOP_SPEED_MPS) this.slowSince ??= t;
    else this.slowSince = null;
  }

  /** The rider has come to a stop (slow GPS readings for a few seconds). */
  isStopped(t: number) {
    return this.slowSince != null && t - this.slowSince >= STOPPED_MS;
  }

  isArmed(t: number) {
    return !this.config.requireMotion || (t - this.lastMovingAt <= MOTION_WINDOW_MS && !this.isStopped(t));
  }

  /**
   * The rider unlocked or touched the phone: a spike around now is them handling
   * it (e.g. taking it out of a pocket), not a crash. Ends an impact being evaluated.
   */
  noteInteraction(t: number): DetectorEvent | null {
    this.lastInteractionAt = t;
    return this.phase === 'impact' ? this.finishAsBump('handling') : null;
  }

  pushGyro(s: GyroSample) {
    if (this.phase !== 'impact') return;
    const stillStart = this.impactAt + this.config.settleMs;
    if (s.t >= stillStart) this.gyroWindow.push(mag(s.x, s.y, s.z));
  }

  pushAccel(s: AccelSample): DetectorEvent | null {
    const g = mag(s.x, s.y, s.z);
    const c = this.config;

    this.history.push(s);
    while (this.history.length && s.t - this.history[0].t > PRE_WINDOW_MS + PRE_GUARD_MS) {
      this.history.shift();
    }

    if (this.phase === 'idle') {
      if (g >= c.impactG) {
        if (!this.isArmed(s.t)) return this.ignore(s.t, g, 'not_moving');
        if (
          s.t - this.lastInteractionAt < INTERACTION_MS ||
          countPeaks(this.history, s.t, c.handlingPeakG) >= c.handlingPeaks
        ) {
          return this.ignore(s.t, g, 'handling');
        }
        this.phase = 'impact';
        this.impactAt = s.t;
        this.peakG = g;
        // Gravity direction before the crash, excluding the moments just before impact.
        this.preGravity = meanVec(this.history.filter((h) => s.t - h.t > PRE_GUARD_MS));
        this.window = [];
        this.gyroWindow = [];
      }
      return null;
    }

    // phase === 'impact'
    // GPS says the rider is still riding along: a pothole or the phone shifting in a pocket.
    if (this.movedAfterImpact) return this.finishAsBump('moving_again');
    if (this.pending) return this.confirmCrash(s.t);

    const stillStart = this.impactAt + c.settleMs;
    const stillEnd = stillStart + c.stillMs;

    if (s.t < stillStart) {
      this.peakG = Math.max(this.peakG, g);
      return null;
    }

    this.window.push(s);

    // Early exit: clear, sustained movement means the rider is up and moving.
    if (this.window.length >= 10) {
      const recent = this.window.slice(-10).map((w) => mag(w.x, w.y, w.z));
      if (std(recent) > c.stillStdG * 4) return this.finishAsBump('moving_again');
    }

    if (s.t < stillEnd) return null;

    const mags = this.window.map((w) => mag(w.x, w.y, w.z));
    const meanG = mags.reduce((a, b) => a + b, 0) / mags.length;
    const isStill =
      std(mags) <= c.stillStdG &&
      Math.abs(meanG - 1) < 0.3 &&
      (this.gyroWindow.length === 0 || avg(this.gyroWindow) <= c.stillGyro);

    if (!isStill) return this.finishAsBump('moving_again');

    const postGravity = meanVec(this.window);
    const orientationChangeDeg =
      this.preGravity && postGravity ? angleDeg(this.preGravity, postGravity) : 90;
    const veryHard = this.peakG >= c.impactG * 2;

    if (orientationChangeDeg >= c.orientationDeg || veryHard) {
      this.pending = { orientationChangeDeg };
      return this.confirmCrash(s.t);
    }
    return this.finishAsBump('no_fall');
  }

  /**
   * It looked like a crash; alert once GPS confirms the rider stopped. No GPS reading
   * yet (weak signal, tunnel)? Wait briefly, then alert anyway: missing a crash is worse.
   */
  private confirmCrash(t: number): DetectorEvent | null {
    const c = this.config;
    if (this.movedAfterImpact) return this.finishAsBump('moving_again');
    const stillEnd = this.impactAt + c.settleMs + c.stillMs;
    if (c.requireMotion && !this.speedSeenAfterImpact && t < stillEnd + GPS_GRACE_MS) return null;
    const event: DetectorEvent = {
      type: 'crash',
      impactAt: this.impactAt,
      peakG: round(this.peakG),
      orientationChangeDeg: Math.round(this.pending?.orientationChangeDeg ?? 90),
    };
    this.backToIdle();
    return event;
  }

  private finishAsBump(reason: BumpReason): DetectorEvent {
    const event: DetectorEvent = { type: 'bump', impactAt: this.impactAt, peakG: round(this.peakG), reason };
    this.backToIdle();
    return event;
  }

  /** A spike we deliberately don't treat as an impact. Keeps history so a burst stays a burst. */
  private ignore(t: number, g: number, reason: BumpReason): DetectorEvent | null {
    // Report at most one ignored spike per second to avoid flooding the UI.
    if (t - this.lastIgnoredAt < 1000) return null;
    this.lastIgnoredAt = t;
    return { type: 'bump', impactAt: t, peakG: round(g), reason };
  }
}

/** Number of separate excursions above `threshold` in the pre-impact window (excluding the impact itself). */
function countPeaks(history: AccelSample[], now: number, threshold: number) {
  let peaks = 0;
  let above = false;
  for (const h of history) {
    if (now - h.t < 50) break; // the impact's own rising edge
    const isAbove = mag(h.x, h.y, h.z) >= threshold;
    if (isAbove && !above) peaks++;
    above = isAbove;
  }
  return peaks;
}

function avg(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]) {
  const m = avg(xs);
  return Math.sqrt(avg(xs.map((x) => (x - m) ** 2)));
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}
