/**
 * Rider's Black Box uses a single high-contrast dark theme: it has to be
 * readable in direct sunlight, at night, and by someone who is shaken up.
 */

export const Colors = {
  bg: '#0B0D10',
  surface: '#15181D',
  surfaceRaised: '#1E232A',
  border: '#2A3038',
  text: '#F2F4F7',
  textDim: '#9AA3AF',
  textFaint: '#6B7480',
  accent: '#FF7A1A',
  accentDim: '#3A2414',
  danger: '#EF4444',
  dangerDim: '#3B1517',
  ok: '#22C55E',
  okDim: '#12301D',
  info: '#38BDF8',
} as const;

export const SeverityColors = {
  minor: '#22C55E',
  moderate: '#FACC15',
  severe: '#EF4444',
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;
