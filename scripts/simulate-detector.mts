/**
 * Sanity checks for the crash detector with synthetic sensor traces.
 * Run: npm run test:detector
 */
import assert from 'node:assert/strict';

import { CrashDetector, SENSITIVITY_PRESETS, type DetectorEvent } from '../src/lib/crash-detector.ts';

const HZ = 50;
const DT = 1000 / HZ;
type Trace = { x: number; y: number; z: number }[];

const noise = (amp: number) => (Math.random() - 0.5) * 2 * amp;
const upright = (secs: number, vib = 0.15): Trace =>
  Array.from({ length: secs * HZ }, () => ({ x: noise(vib), y: 1 + noise(vib), z: noise(vib) }));
const lyingFlat = (secs: number): Trace =>
  Array.from({ length: secs * HZ }, () => ({ x: noise(0.02), y: noise(0.02), z: 1 + noise(0.02) }));
/** Phone held still at an angle: tilted `deg` from upright, like reading it in your hand. */
const tilted = (secs: number, deg: number, vib = 0.03): Trace => {
  const r = (deg * Math.PI) / 180;
  return Array.from({ length: secs * HZ }, () => ({ x: noise(vib), y: Math.cos(r) + noise(vib), z: Math.sin(r) + noise(vib) }));
};
const spike = (g: number, n = 4): Trace => Array.from({ length: n }, () => ({ x: g * 0.6, y: g * 0.8, z: 0 }));
const tumble = (secs: number): Trace =>
  Array.from({ length: secs * HZ }, (_, i) => ({ x: Math.sin(i / 3) * 2, y: Math.cos(i / 4) * 2, z: noise(1.5) }));
/** Vigorous shaking in the hand: repeated ~3–5 g swings at ~4 Hz. */
const shaking = (secs: number, peak = 5): Trace =>
  Array.from({ length: secs * HZ }, (_, i) => {
    const a = Math.sin((i / HZ) * 2 * Math.PI * 4) * peak;
    return { x: a * 0.7, y: 1 + a * 0.7, z: noise(0.3) };
  });

/** GPS speed (m/s) at time t (ms), or null when there's no fix. */
type Speed = (t: number) => number | null;
const riding: Speed = () => 12;
const stationary: Speed = () => 0;
/** Riding at 12 m/s, then 0 from `ms` on (stopped, or down after a crash). */
const stopsAt = (ms: number): Speed => (t) => (t < ms ? 12 : 0);
/** Riding, then no GPS fix at all from `ms` on (tunnel, phone under the rider). */
const gpsLostAt = (ms: number): Speed => (t) => (t < ms ? 12 : null);
const secs = (trace: Trace) => (trace.length * 1000) / HZ;

type Sensitivity = keyof typeof SENSITIVITY_PRESETS;

function run(trace: Trace, speed: Speed, { sensitivity = 'medium' as Sensitivity, interactAt = null as number | null } = {}) {
  const d = new CrashDetector(SENSITIVITY_PRESETS[sensitivity]);
  const events: DetectorEvent[] = [];
  trace.forEach((s, i) => {
    const t = i * DT;
    // GPS delivers a speed reading every 2 s.
    if (i % (2 * HZ) === 0) d.pushSpeed(t, speed(t));
    if (interactAt != null && t === interactAt) {
      const e = d.noteInteraction(t);
      if (e) events.push(e);
    }
    const e = d.pushAccel({ t, ...s });
    if (e) events.push(e);
  });
  return events;
}

const crashTrace = [...upright(3), ...spike(6), ...tumble(0.8), ...lyingFlat(8)];
const impactMs = secs(upright(3));

// Rider's real case: ride, stop at a light or the destination, pull the phone out of a pocket.
const pocketPull = [...upright(12, 0.3), ...upright(6, 0.05), ...spike(3.5, 3), ...tumble(0.4), ...tilted(7, 45)];
// Rider's other real case: a pothole while riding, then the phone settles at a new angle in a pocket.
const potholeShift = [...upright(4, 0.3), ...spike(4.5), ...tumble(0.3), ...tilted(8, 40, 0.05)];

const cases: [string, Trace, Speed, string, Parameters<typeof run>[2]?][] = [
  ['normal riding on rough road', upright(20, 0.4), riding, 'none'],
  ['crash while riding: impact, tumble, lying still', crashTrace, stopsAt(impactMs + 500), 'crash'],
  ['crash with no GPS afterwards still alerts', crashTrace, gpsLostAt(impactMs + 500), 'crash'],
  ['crash on High sensitivity', crashTrace, stopsAt(impactMs + 500), 'crash', { sensitivity: 'high' }],
  ['pothole: spike then keeps riding upright', [...upright(3), ...spike(4.5), ...upright(6, 0.4)], riding, 'bump:moving_again'],
  ['gentle spike below threshold', [...upright(3), ...spike(2.5), ...upright(5)], riding, 'none'],
  ['shaking phone in hand at a standstill, then set down', [...upright(3, 0.05), ...shaking(3), ...lyingFlat(6)], stationary, 'bump:not_moving'],
  ['same crash trace but not moving (dropped phone at home)', crashTrace, stationary, 'bump:not_moving'],
  ['shaking phone while riding (fiddling at speed), then still', [...upright(3), ...shaking(3), ...lyingFlat(6)], riding, 'bump:handling'],
  ['phone out of pocket right after stopping (High)', pocketPull, stopsAt(12_000), 'bump:not_moving', { sensitivity: 'high' }],
  ['pothole, then phone settles tilted in a pocket (High)', potholeShift, riding, 'bump:moving_again', { sensitivity: 'high' }],
  ['phone unlocked just after a jolt', crashTrace, stopsAt(impactMs + 500), 'bump:handling', { interactAt: impactMs + 2000 }],
];

for (const [name, trace, speed, expected, opts] of cases) {
  const events = run(trace, speed, opts);
  // 'bump:<reason>' means: no crash, and at least one spike was rejected for that reason.
  const reasons = [...new Set(events.flatMap((e) => (e.type === 'bump' ? [`bump:${e.reason}`] : [])))];
  const got = events.some((e) => e.type === 'crash') ? 'crash' : reasons.length ? reasons.join(',') : 'none';
  const ok = expected.startsWith('bump:') ? got !== 'crash' && reasons.includes(expected) : got === expected;
  assert.ok(ok, `${name}: expected ${expected}, got ${got} ${JSON.stringify(events)}`);
  console.log(`✓ ${name} → ${got}`);
}
console.log('All detector checks passed.');
