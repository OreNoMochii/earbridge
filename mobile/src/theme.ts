// Colours, type and shapes, following the phone's light or dark appearance. Large, very
// legible type and big targets: the app is made to be easy for older people.

import { StyleSheet, useColorScheme } from 'react-native';
import type { TextStyle } from 'react-native';

const light = {
  bg: '#F7F4EE',
  surface: '#FFFFFF',
  surface2: '#EFEAE1',
  text: '#14181F',
  muted: '#444C59',
  border: '#D9D2C5',
  borderStrong: '#8A8275',
  accent: '#0B5F58',
  onAccent: '#FFFFFF',
  accentSoft: '#D5EFEA',
  mine: '#E3F2EF',
  danger: '#B3261E',
  onDanger: '#FFFFFF',
  dangerSoft: '#FBE3E1',
  live: '#1E6B30',
  liveSoft: '#DDF3E2',
  busy: '#7A4F00',
  busySoft: '#FFF0CC',
  speaking: '#5B3CC4',
  speakingSoft: '#ECE6FF',
  idle: '#4A525E',
  idleSoft: '#E9E6E0',
  toastBg: '#14181F',
  toastText: '#FFFFFF',
  scrim: '#14181F99',
};

export type Palette = typeof light;

const dark: Palette = {
  bg: '#0F1419',
  surface: '#182029',
  surface2: '#222C37',
  text: '#F3F1EC',
  muted: '#C2C8D0',
  border: '#2E3A47',
  borderStrong: '#6B7785',
  accent: '#4FD1C1',
  onAccent: '#062A26',
  accentSoft: '#123A36',
  mine: '#133531',
  danger: '#FF8A80',
  onDanger: '#2A0A08',
  dangerSoft: '#3D1716',
  live: '#6EE787',
  liveSoft: '#10301A',
  busy: '#FFC94D',
  busySoft: '#3A2C08',
  speaking: '#B9A6FF',
  speakingSoft: '#261D45',
  idle: '#AEB6C0',
  idleSoft: '#222C37',
  toastBg: '#F3F1EC',
  toastText: '#14181F',
  scrim: '#000000B3',
};

/** Atkinson Hyperlegible, made for low vision; other scripts fall back to the phone's fonts. */
export const FONT = 'Atkinson Hyperlegible';
export const RADIUS = 18;
export const RADIUS_LG = 24;

function text(size: number, weight: '400' | '700' = '400', lineHeight = 1.35): TextStyle {
  return { fontFamily: FONT, fontSize: size, lineHeight: Math.round(size * lineHeight), fontWeight: weight };
}

/** Text styles by role, without colours. Nothing is smaller than 15. */
export const type = {
  title: text(30, '700'),
  heading: text(24, '700'),
  section: text(22, '700'),
  button: text(21, '700'),
  large: text(21),
  largeBold: text(21, '700'),
  body: text(19),
  bodyBold: text(19, '700'),
  compact: text(18, '700'),
  secondary: text(17),
  secondaryBold: text(17, '700'),
  small: text(15),
  smallBold: text(15, '700'),
  partner: text(34, '700', 1.4),
} satisfies Record<string, TextStyle>;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

/**
 * Makes a hook that returns the styles for the current appearance; both sets are
 * created once, up front.
 */
export function themedStyles<T extends StyleSheet.NamedStyles<T>>(
  create: (palette: Palette) => T,
): () => { styles: T; palette: Palette } {
  const sheets = { light: StyleSheet.create(create(light)), dark: StyleSheet.create(create(dark)) };
  return () => {
    const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
    return { styles: sheets[scheme], palette: scheme === 'dark' ? dark : light };
  };
}
