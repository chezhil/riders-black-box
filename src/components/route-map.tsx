/**
 * A ride's GPS route drawn over a real street map.
 *
 * Uses Esri's World Dark Gray Canvas raster tiles (no API key, matches the
 * app's dark theme): picks the zoom that fits the whole route, lays out the tiles
 * that cover the view, and draws the route in the same Web Mercator projection
 * with SVG on top. Tiles are disk-cached by expo-image; if they can't load
 * (offline), the route still draws on the dark background.
 */
import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { Colors, Radius } from '@/constants/theme';
import type { LatLng } from '@/lib/types';

import { T } from './ui';

const TILE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 16;
/** Zoom used when there's a single point (or the rider hasn't moved yet). */
const SINGLE_POINT_ZOOM = 15;
const PADDING = 28;
const tileUrl = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`;

/** Web Mercator: lat/lng to world pixel coordinates at zoom `z`. */
function project(p: LatLng, z: number) {
  const world = TILE * 2 ** z;
  const lat = Math.max(-85.0511, Math.min(85.0511, p.lat));
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((p.lng + 180) / 360) * world,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world,
  };
}

function fitZoom(points: LatLng[], width: number, height: number) {
  if (points.length < 2) return SINGLE_POINT_ZOOM;
  for (let z = MAX_ZOOM; z > MIN_ZOOM; z--) {
    const px = points.map((p) => project(p, z));
    const w = Math.max(...px.map((p) => p.x)) - Math.min(...px.map((p) => p.x));
    const h = Math.max(...px.map((p) => p.y)) - Math.min(...px.map((p) => p.y));
    if (w <= width - PADDING * 2 && h <= height - PADDING * 2) return z;
  }
  return MIN_ZOOM;
}

export function RouteMap({
  points,
  markers = [],
  height = 240,
}: {
  points: LatLng[];
  markers?: (LatLng & { color: string })[];
  height?: number;
}) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));

  if (points.length === 0) {
    return (
      <View style={[styles.box, styles.empty, { height }]}>
        <T.Dim>Waiting for GPS…</T.Dim>
      </View>
    );
  }

  return (
    <View style={[styles.box, { height }]} onLayout={onLayout}>
      {width > 0 && <MapContent points={points} markers={markers} width={width} height={height} />}
      <Text style={styles.attribution}>Tiles © Esri · © OpenStreetMap contributors</Text>
    </View>
  );
}

function MapContent({
  points,
  markers,
  width,
  height,
}: {
  points: LatLng[];
  markers: (LatLng & { color: string })[];
  width: number;
  height: number;
}) {
  const z = fitZoom([...points, ...markers], width, height);
  const px = points.map((p) => project(p, z));
  const minX = Math.min(...px.map((p) => p.x));
  const maxX = Math.max(...px.map((p) => p.x));
  const minY = Math.min(...px.map((p) => p.y));
  const maxY = Math.max(...px.map((p) => p.y));
  // Top-left corner of the view, in world pixels, centring the route.
  const left = (minX + maxX) / 2 - width / 2;
  const top = (minY + maxY) / 2 - height / 2;
  const toView = (p: LatLng) => {
    const w = project(p, z);
    return { x: w.x - left, y: w.y - top };
  };

  const tilesPerSide = 2 ** z;
  const tiles: { key: string; url: string; x: number; y: number }[] = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height) / TILE); ty++) {
    if (ty < 0 || ty >= tilesPerSide) continue;
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width) / TILE); tx++) {
      const wrappedX = ((tx % tilesPerSide) + tilesPerSide) % tilesPerSide;
      tiles.push({ key: `${z}/${tx}/${ty}`, url: tileUrl(z, wrappedX, ty), x: tx * TILE - left, y: ty * TILE - top });
    }
  }

  const route = points.map(toView);
  const polyline = route.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const start = route[0];
  const end = route[route.length - 1];

  return (
    <>
      {tiles.map((t) => (
        <Image
          key={t.key}
          source={t.url}
          style={{ position: 'absolute', left: t.x, top: t.y, width: TILE, height: TILE }}
          cachePolicy="disk"
          transition={150}
        />
      ))}
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        {route.length > 1 && (
          <>
            {/* Dark casing so the route reads against busy streets. */}
            <Polyline
              points={polyline}
              fill="none"
              stroke="#000000"
              strokeOpacity={0.55}
              strokeWidth={8}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <Polyline
              points={polyline}
              fill="none"
              stroke={Colors.accent}
              strokeWidth={4.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <Circle cx={start.x} cy={start.y} r={6} fill={Colors.ok} stroke="#000" strokeWidth={2} />
          </>
        )}
        {markers.map((m, i) => {
          const p = toView(m);
          return <Circle key={i} cx={p.x} cy={p.y} r={6} fill={m.color} stroke="#000" strokeWidth={2} />;
        })}
        {/* Current / final position */}
        <Circle cx={end.x} cy={end.y} r={11} fill={Colors.accent} fillOpacity={0.25} />
        <Circle cx={end.x} cy={end.y} r={6.5} fill={Colors.text} stroke={Colors.accent} strokeWidth={3} />
      </Svg>
    </>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: '#0E0E10',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  empty: { alignItems: 'center', justifyContent: 'center' },
  attribution: {
    position: 'absolute',
    right: 6,
    bottom: 4,
    fontSize: 9,
    color: 'rgba(255,255,255,0.55)',
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 4,
    borderRadius: 3,
  },
});
