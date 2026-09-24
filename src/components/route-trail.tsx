/**
 * Draws a ride's GPS trail as an SVG polyline (equirectangular projection).
 * No map tiles or API key needed, and it works offline.
 */
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { Colors, Radius } from '@/constants/theme';
import type { LatLng } from '@/lib/types';

import { T } from './ui';

export function RouteTrail({
  points,
  markers = [],
  height = 220,
}: {
  points: LatLng[];
  markers?: (LatLng & { color: string })[];
  height?: number;
}) {
  if (points.length < 2) {
    return (
      <View style={[styles.box, styles.empty, { height }]}>
        <T.Dim>{points.length === 0 ? 'Waiting for GPS…' : 'Route will appear as you move'}</T.Dim>
      </View>
    );
  }

  const W = 300;
  const H = 200;
  const pad = 14;
  const lat0 = points[0].lat;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const xs = points.map((p) => p.lng * kx);
  const ys = points.map((p) => p.lat);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, (maxY - minY) * (W / H), 1e-5);
  const scale = (W - pad * 2) / span;
  const offX = (W - (maxX - minX) * scale) / 2;
  const offY = (H - (maxY - minY) * scale) / 2;
  const project = (p: LatLng) => ({
    x: offX + (p.lng * kx - minX) * scale,
    y: H - (offY + (p.lat - minY) * scale),
  });

  const projected = points.map(project);
  const start = projected[0];
  const end = projected[projected.length - 1];

  return (
    <View style={[styles.box, { height }]}>
      <Svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
        <Polyline
          points={projected.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke={Colors.accent}
          strokeWidth={3}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <Circle cx={start.x} cy={start.y} r={5} fill={Colors.ok} />
        <Circle cx={end.x} cy={end.y} r={6} fill={Colors.text} stroke={Colors.accent} strokeWidth={2} />
        {markers.map((m, i) => {
          const p = project(m);
          return <Circle key={i} cx={p.x} cy={p.y} r={6} fill={m.color} stroke="#000" strokeWidth={1} />;
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  empty: { alignItems: 'center', justifyContent: 'center' },
});
