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
const spike = (g: number, n = 4): Trace => Array.from({ length: n }, () => ({ x: g * 0.6, y: g * 0.8, z: 0 }));
const tumble = (secs: number): Trace =>
  Array.from({ length: secs * HZ }, (_, i) => ({ x: Math.sin(i / 3) * 2, y: Math.cos(i / 4) * 2, z: noise(1.5) }));
/** Vigorous shaking in the hand: repeated ~3–5 g swings at ~4 Hz. */
const shaking = (secs: number, peak = 5): Trace =>
  Array.from({ length: secs * HZ }, (_, i) => {
    const a = Math.sin((i / HZ) * 2 * Math.PI * 4) * peak;
    return { x: a * 0.7, y: 1 + a * 0.7, z: noise(0.3) };
  });

type Motion = 'riding' | 'stationary';

function run(trace: Trace, motion: Motion, sensitivity: keyof typeof SENSITIVITY_PRESETS = 'medium') {
  const d = new CrashDetector(SENSITIVITY_PRESETS[sensitivity]);
  const events: DetectorEvent[] = [];
  trace.forEach((s, i) => {
    const t = i * DT;
    // GPS delivers a speed reading every 2 s.
    if (i % (2 * HZ) === 0) d.pushSpeed(t, motion === 'riding' ? 12 : 0);
    const e = d.pushAccel({ t, ...s });
    if (e) events.push(e);
  });
  return events;
}

const cases: [string, Trace, Motion, string][] = [
  ['normal riding on rough road', upright(20, 0.4), 'riding', 'none'],
  ['crash while riding: impact, tumble, lying still', [...upright(3), ...spike(6), ...tumble(0.8), ...lyingFlat(5)], 'riding', 'crash'],
  ['pothole: spike then keeps riding upright', [...upright(3), ...spike(4.5), ...upright(6, 0.4)], 'riding', 'bump:moving_again'],
  ['gentle spike below threshold', [...upright(3), ...spike(2.5), ...upright(5)], 'riding', 'none'],
  ['shaking phone in hand at a standstill, then set down', [...upright(3, 0.05), ...shaking(3), ...lyingFlat(6)], 'stationary', 'bump:not_moving'],
  ['same crash trace but not moving (dropped phone at home)', [...upright(3), ...spike(6), ...tumble(0.8), ...lyingFlat(5)], 'stationary', 'bump:not_moving'],
  ['shaking phone while riding (fiddling at speed), then still', [...upright(3), ...shaking(3), ...lyingFlat(6)], 'riding', 'bump:handling'],
];

for (const [name, trace, motion, expected] of cases) {
  const events = run(trace, motion);
  // 'bump:<reason>' means: no crash, and at least one spike was rejected for that reason.
  const reasons = [...new Set(events.flatMap((e) => (e.type === 'bump' ? [`bump:${e.reason}`] : [])))];
  const got = events.some((e) => e.type === 'crash') ? 'crash' : reasons.length ? reasons.join(',') : 'none';
  const ok = expected.startsWith('bump:') ? got !== 'crash' && reasons.includes(expected) : got === expected;
  assert.ok(ok, `${name}: expected ${expected}, got ${got} ${JSON.stringify(events)}`);
  console.log(`✓ ${name} → ${got}`);
}
console.log('All detector checks passed.');
