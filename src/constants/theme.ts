/**
 * Rider's Black Box uses a single high-contrast dark theme styled like a
 * motorcycle instrument cluster: asphalt black, hi-vis orange, italic
 * condensed numerals. It has to be readable in direct sunlight, at night, with
 * gloves on, and by someone who is shaken up.
 */

export const Colors = {
  bg: '#09090B',
  surface: '#131316',
  surfaceRaised: '#1D1D22',
  border: '#2B2B32',
  text: '#F5F5F4',
  textDim: '#A1A1AA',
  textFaint: '#6B6B75',
  /** Hi-vis orange, like a safety vest or a tacho needle. */
  accent: '#FF6B00',
  accentDim: '#361905',
  /** Text on an accent background. */
  onAccent: '#140800',
  danger: '#FF3B30',
  dangerDim: '#3A0F0C',
  ok: '#39E07A',
  okDim: '#0F2C1A',
  info: '#3BC7FF',
} as const;

export const SeverityColors = {
  minor: '#39E07A',
  moderate: '#FFC400',
  severe: '#FF3B30',
} as const;

/**
 * Barlow Condensed, loaded in the root layout. Set `fontFamily` only: adding
 * `fontWeight` to a custom face makes Android fall back to a synthetic weight.
 */
export const Fonts = {
  /** Big italic numerals and titles: speed, countdown, screen titles. */
  display: 'BarlowCondensed_900Black_Italic',
  /** Buttons and emphasised headings. */
  displayBold: 'BarlowCondensed_800ExtraBold_Italic',
  heading: 'BarlowCondensed_700Bold',
  label: 'BarlowCondensed_600SemiBold',
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
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const;
