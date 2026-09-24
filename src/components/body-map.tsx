/**
 * Tappable front/back body silhouette. The zones themselves form the figure,
 * so every visible part of the body is a tap target.
 */
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Ellipse, G, Rect } from 'react-native-svg';

import { Colors, SeverityColors } from '@/constants/theme';
import type { BodyPart, Severity } from '@/lib/types';

export type BodyView = 'front' | 'back';

type Shape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

type Zone = { part: BodyPart; shape: Shape };

// Coordinates for the figure's screen-left and screen-right limbs.
// Front view: the rider's right side is on screen-left (like looking at them).
// Back view: the rider's left side is on screen-left.
const LIMBS_SCREEN_LEFT: Record<'arm' | 'hand' | 'leg' | 'foot', Shape> = {
  arm: { kind: 'rect', x: 30, y: 84, w: 26, h: 116, r: 13 },
  hand: { kind: 'ellipse', cx: 43, cy: 216, rx: 13, ry: 16 },
  leg: { kind: 'rect', x: 66, y: 244, w: 32, h: 138, r: 15 },
  foot: { kind: 'ellipse', cx: 80, cy: 396, rx: 19, ry: 11 },
};

function mirror(s: Shape): Shape {
  return s.kind === 'rect' ? { ...s, x: 200 - s.x - s.w } : { ...s, cx: 200 - s.cx };
}

function zonesFor(view: BodyView): Zone[] {
  const leftSide = view === 'front' ? 'right' : 'left';
  const rightSide = view === 'front' ? 'left' : 'right';
  const limbs = (['arm', 'hand', 'leg', 'foot'] as const).flatMap((limb) => [
    { part: `${leftSide}_${limb}` as BodyPart, shape: LIMBS_SCREEN_LEFT[limb] },
    { part: `${rightSide}_${limb}` as BodyPart, shape: mirror(LIMBS_SCREEN_LEFT[limb]) },
  ]);
  return [
    { part: 'head', shape: { kind: 'ellipse', cx: 100, cy: 38, rx: 25, ry: 29 } },
    { part: 'neck', shape: { kind: 'rect', x: 89, y: 66, w: 22, h: 14, r: 5 } },
    {
      part: view === 'front' ? 'chest' : 'upper_back',
      shape: { kind: 'rect', x: 60, y: 80, w: 80, h: 72, r: 18 },
    },
    {
      part: view === 'front' ? 'abdomen' : 'lower_back',
      shape: { kind: 'rect', x: 64, y: 154, w: 72, h: 50, r: 10 },
    },
    { part: 'pelvis', shape: { kind: 'rect', x: 62, y: 206, w: 76, h: 36, r: 12 } },
    ...limbs,
  ];
}

export function BodyMap({
  view,
  selected,
  onToggle,
}: {
  view: BodyView;
  /** Selected parts, with a severity once rated. */
  selected: Partial<Record<BodyPart, Severity | null>>;
  onToggle: (part: BodyPart) => void;
}) {
  return (
    <View style={styles.wrap}>
      <Text style={[styles.side, { left: 4 }]}>{view === 'front' ? 'R' : 'L'}</Text>
      <Text style={[styles.side, { right: 4 }]}>{view === 'front' ? 'L' : 'R'}</Text>
      <Svg viewBox="0 0 200 420" width="100%" height="100%">
        <G>
          {zonesFor(view).map(({ part, shape }) => {
            const isSelected = part in selected;
            const severity = selected[part];
            const fill = isSelected
              ? severity
                ? SeverityColors[severity]
                : Colors.accent
              : Colors.surfaceRaised;
            const common = {
              fill,
              fillOpacity: isSelected ? 0.9 : 1,
              stroke: isSelected ? '#FFFFFF' : Colors.border,
              strokeWidth: isSelected ? 2 : 1.5,
              onPress: () => onToggle(part),
            };
            return shape.kind === 'rect' ? (
              <Rect
                key={part}
                x={shape.x}
                y={shape.y}
                width={shape.w}
                height={shape.h}
                rx={shape.r}
                {...common}
              />
            ) : (
              <Ellipse key={part} cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} {...common} />
            );
          })}
        </G>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 400, aspectRatio: 200 / 420, alignSelf: 'center' },
  side: {
    position: 'absolute',
    top: 8,
    color: Colors.textFaint,
    fontWeight: '800',
    fontSize: 14,
  },
});
