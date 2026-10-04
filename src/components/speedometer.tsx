/**
 * Analogue-style speedometer, like a motorcycle's instrument cluster: a 270°
 * dial with ticks, a hi-vis arc up to the current speed, a marker at the ride's
 * top speed and a big italic digital readout in the middle.
 */
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { Colors, Fonts } from '@/constants/theme';

const START_DEG = 135;
const SWEEP_DEG = 270;
/** Dial ranges in km/h; the smallest one that fits the ride's top speed is used. */
const SCALES = [120, 180, 240, 300];

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arc(cx: number, cy: number, r: number, fromDeg: number, toDeg: number) {
  const a = polar(cx, cy, r, fromDeg);
  const b = polar(cx, cy, r, toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`;
}

export function Speedometer({
  kmh,
  maxKmh,
  size = 300,
  color = Colors.accent,
}: {
  kmh: number;
  maxKmh: number;
  size?: number;
  /** Arc colour: orange while armed, dimmer while detection isn't running. */
  color?: string;
}) {
  const scale = SCALES.find((s) => Math.max(kmh, maxKmh) <= s * 0.95) ?? SCALES[SCALES.length - 1];
  const c = size / 2;
  const r = c - 18;
  const toDeg = (v: number) => START_DEG + (Math.min(Math.max(v, 0), scale) / scale) * SWEEP_DEG;
  const redFrom = scale * (5 / 6);
  const speed = Math.round(kmh);

  const ticks = [];
  for (let v = 0; v <= scale; v += 10) {
    const major = v % (scale <= 180 ? 20 : 40) === 0;
    const deg = toDeg(v);
    const outer = polar(c, c, r - 10, deg);
    const inner = polar(c, c, r - (major ? 26 : 18), deg);
    ticks.push(
      <Line
        key={v}
        x1={outer.x}
        y1={outer.y}
        x2={inner.x}
        y2={inner.y}
        stroke={v >= redFrom ? Colors.danger : major ? Colors.text : Colors.textFaint}
        strokeWidth={major ? 3 : 1.5}
        strokeLinecap="round"
      />,
    );
    if (major) {
      const p = polar(c, c, r - 44, deg);
      ticks.push(
        <SvgText
          key={`l${v}`}
          x={p.x}
          y={p.y + 6}
          fill={v >= redFrom ? Colors.danger : Colors.textDim}
          fontSize={17}
          fontFamily={Fonts.heading}
          textAnchor="middle">
          {v}
        </SvgText>,
      );
    }
  }

  const maxMark = maxKmh > 0 ? { a: polar(c, c, r + 8, toDeg(maxKmh)), b: polar(c, c, r - 10, toDeg(maxKmh)) } : null;

  return (
    <View
      style={{ width: size, height: size, alignSelf: 'center' }}
      accessible
      accessibilityLabel={`Speed ${speed} kilometres per hour. Top speed ${Math.round(maxKmh)}.`}>
      <Svg width={size} height={size}>
        {/* Bezel */}
        <Circle cx={c} cy={c} r={r + 12} fill={Colors.surface} stroke={Colors.border} strokeWidth={2} />
        <Path d={arc(c, c, r, START_DEG, START_DEG + SWEEP_DEG)} stroke={Colors.surfaceRaised} strokeWidth={10} fill="none" strokeLinecap="round" />
        <Path d={arc(c, c, r, toDeg(redFrom), START_DEG + SWEEP_DEG)} stroke={Colors.dangerDim} strokeWidth={10} fill="none" strokeLinecap="round" />
        {speed > 0 && (
          <Path d={arc(c, c, r, START_DEG, toDeg(kmh))} stroke={color} strokeWidth={10} fill="none" strokeLinecap="round" />
        )}
        <G>{ticks}</G>
        {maxMark && (
          <Line x1={maxMark.a.x} y1={maxMark.a.y} x2={maxMark.b.x} y2={maxMark.b.y} stroke={Colors.text} strokeWidth={3} strokeLinecap="round" />
        )}
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
        <Text style={[styles.speed, { fontSize: size * 0.34, lineHeight: size * 0.36 }]}>{speed}</Text>
        <Text style={styles.unit}>km/h</Text>
      </View>
      {/* Top speed sits in the open bottom of the dial, like a trip readout. */}
      <View style={[styles.top, { top: size * 0.8 }]} pointerEvents="none">
        <Text style={styles.topLabel}>Top</Text>
        <Text style={styles.topValue}>{Math.round(maxKmh)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', paddingTop: 8 },
  speed: { color: Colors.text, fontFamily: Fonts.display, fontVariant: ['tabular-nums'] },
  unit: { color: Colors.textDim, fontFamily: Fonts.label, fontSize: 16, letterSpacing: 2, textTransform: 'uppercase' },
  top: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', alignItems: 'baseline', gap: 6 },
  topLabel: { color: Colors.textFaint, fontFamily: Fonts.label, fontSize: 14, letterSpacing: 2, textTransform: 'uppercase' },
  topValue: { color: Colors.text, fontFamily: Fonts.displayBold, fontSize: 24, fontVariant: ['tabular-nums'] },
});
