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

function run(trace: Trace, sensitivity: keyof typeof SENSITIVITY_PRESETS = 'medium') {
  const d = new CrashDetector(SENSITIVITY_PRESETS[sensitivity]);
  const events: DetectorEvent[] = [];
  trace.forEach((s, i) => {
    const e = d.pushAccel({ t: i * DT, ...s });
    if (e) events.push(e);
  });
  return events;
}

const cases: [string, Trace, DetectorEvent['type'] | 'none'][] = [
  ['normal riding on rough road', upright(20, 0.4), 'none'],
  ['crash: impact, tumble, lying still on its side', [...upright(3), ...spike(6), ...tumble(0.8), ...lyingFlat(5)], 'crash'],
  ['pothole: spike then keeps riding upright', [...upright(3), ...spike(4), ...upright(6, 0.4)], 'bump'],
  ['phone dropped at a stop, picked up again', [...upright(3, 0.02), ...spike(4), ...lyingFlat(1.5), ...upright(4, 0.5)], 'bump'],
  ['gentle spike below threshold', [...upright(3), ...spike(2.5), ...upright(5)], 'none'],
];

for (const [name, trace, expected] of cases) {
  const events = run(trace);
  const got = events.find((e) => e.type === 'crash')?.type ?? events[0]?.type ?? 'none';
  assert.equal(got, expected, `${name}: expected ${expected}, got ${got} ${JSON.stringify(events)}`);
  console.log(`✓ ${name} → ${got}${events[0] ? ' ' + JSON.stringify(events[0]) : ''}`);
}
console.log('All detector checks passed.');
