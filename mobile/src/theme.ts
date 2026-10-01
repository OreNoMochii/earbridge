// Colors and shared styles, following the phone's light or dark appearance. The same
// palette as the web app.

import { StyleSheet, useColorScheme } from 'react-native';

const light = {
  bg: '#f1f5f9',
  surface: '#ffffff',
  surface2: '#e2e8f0',
  raised: '#ffffff',
  text: '#0f172a',
  muted: '#475569',
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',
  inputBg: '#ffffff',
  accent: '#0f766e',
  accentStrong: '#115e59',
  accentContrast: '#ffffff',
  accentSoft: '#ccfbf1',
  mineBg: '#e6f6f4',
  danger: '#b91c1c',
  dangerSoft: '#fee2e2',
  dangerBorder: '#fca5a5',
  live: '#16a34a',
  busy: '#d97706',
  idle: '#94a3b8',
  speaking: '#7c3aed',
  toastBg: '#0f172a',
  toastText: '#f8fafc',
};

export type Palette = typeof light;

const dark: Palette = {
  bg: '#0b1220',
  surface: '#111a2e',
  surface2: '#1b2640',
  raised: '#2c3b5a',
  text: '#e2e8f0',
  muted: '#94a3b8',
  border: '#1e293b',
  borderStrong: '#334155',
  inputBg: '#0b1220',
  accent: '#2dd4bf',
  accentStrong: '#5eead4',
  accentContrast: '#042f2e',
  accentSoft: '#123f3c',
  mineBg: '#10302f',
  danger: '#f87171',
  dangerSoft: '#3b1219',
  dangerBorder: '#7f1d1d',
  live: '#4ade80',
  busy: '#fbbf24',
  idle: '#64748b',
  speaking: '#a78bfa',
  toastBg: '#e2e8f0',
  toastText: '#0f172a',
};

export const RADIUS = 16;

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
