/**
 * Threshold-based fall/crash detector.
 *
 * A crash is the sequence:
 *   1. IMPACT      — acceleration magnitude spikes above `impactG`.
 *   2. SETTLE      — ignore the tumble for `settleMs` after the impact.
 *   3. STILLNESS   — for `stillMs`, the phone is (nearly) motionless: low variance
 *                    in acceleration magnitude and low rotation rate.
 *   4. ORIENTATION — the gravity direction after the fall differs from the one
 *                    before it by at least `orientationDeg` (the bike / rider went
 *                    down). A very hard impact (>= 2x impactG) skips this check.
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
};

export const SENSITIVITY_PRESETS: Record<Sensitivity, DetectorConfig> = {
  // Fewer false alarms; needs a harder hit.
  low: { impactG: 5, settleMs: 1000, stillMs: 3000, stillStdG: 0.1, stillGyro: 0.4, orientationDeg: 50 },
  medium: { impactG: 3.5, settleMs: 1000, stillMs: 3000, stillStdG: 0.15, stillGyro: 0.5, orientationDeg: 40 },
  // Catches gentler falls; more "Are you OK?" prompts.
  high: { impactG: 2.5, settleMs: 1000, stillMs: 2500, stillStdG: 0.2, stillGyro: 0.7, orientationDeg: 30 },
};

export type DetectorEvent =
  | { type: 'crash'; impactAt: number; peakG: number; orientationChangeDeg: number }
  | { type: 'bump'; impactAt: number; peakG: number };

type Vec = [number, number, number];

const PRE_WINDOW_MS = 1500;
const PRE_GUARD_MS = 250;

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

  constructor(config: DetectorConfig = SENSITIVITY_PRESETS.medium) {
    this.config = config;
  }

  setConfig(config: DetectorConfig) {
    this.config = config;
  }

  reset() {
    this.phase = 'idle';
    this.history = [];
    this.window = [];
    this.gyroWindow = [];
    this.preGravity = null;
    this.peakG = 0;
  }

  pushGyro(s: GyroSample) {
    if (this.phase !== 'impact') return;
    const stillStart = this.impactAt + this.config.settleMs;
    if (s.t >= stillStart) this.gyroWindow.push(mag(s.x, s.y, s.z));
  }

  pushAccel(s: AccelSample): DetectorEvent | null {
    const g = mag(s.x, s.y, s.z);
    const c = this.config;

    if (this.phase === 'idle') {
      this.history.push(s);
      while (this.history.length && s.t - this.history[0].t > PRE_WINDOW_MS + PRE_GUARD_MS) {
        this.history.shift();
      }
      if (g >= c.impactG) {
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
      if (std(recent) > c.stillStdG * 4) return this.finishAsBump();
    }

    if (s.t < stillEnd) return null;

    const mags = this.window.map((w) => mag(w.x, w.y, w.z));
    const meanG = mags.reduce((a, b) => a + b, 0) / mags.length;
    const isStill =
      std(mags) <= c.stillStdG &&
      Math.abs(meanG - 1) < 0.3 &&
      (this.gyroWindow.length === 0 || avg(this.gyroWindow) <= c.stillGyro);

    if (!isStill) return this.finishAsBump();

    const postGravity = meanVec(this.window);
    const orientationChangeDeg =
      this.preGravity && postGravity ? angleDeg(this.preGravity, postGravity) : 90;
    const veryHard = this.peakG >= c.impactG * 2;

    if (orientationChangeDeg >= c.orientationDeg || veryHard) {
      const event: DetectorEvent = {
        type: 'crash',
        impactAt: this.impactAt,
        peakG: round(this.peakG),
        orientationChangeDeg: Math.round(orientationChangeDeg),
      };
      this.reset();
      return event;
    }
    return this.finishAsBump();
  }

  private finishAsBump(): DetectorEvent {
    const event: DetectorEvent = { type: 'bump', impactAt: this.impactAt, peakG: round(this.peakG) };
    this.reset();
    return event;
  }
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
