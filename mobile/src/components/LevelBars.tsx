// The microphone level as five bars, like a voice: green when sent, purple while
// silenced (the phone is speaking), grey when off.

import { useEffect, useState } from 'react';
import { Animated, View } from 'react-native';

import type { MicMode } from '../audio/mic.ts';
import { themedStyles } from '../theme.ts';

const HEIGHT = 28;
/** Each bar's height at full level, as a share of the whole. */
const SHAPE = [0.55, 0.8, 1, 0.75, 0.5];
/** Bars never get shorter than this, so the meter is visible when quiet. */
const MIN = 6;

interface LevelBarsProps {
  /** Calls back with the level (0..1); returns a function that stops. */
  subscribe(listener: (level: number) => void): () => void;
  mode: MicMode;
}

export function LevelBars({ subscribe, mode }: LevelBarsProps) {
  const { styles, palette } = useStyles();
  const [level] = useState(() => new Animated.Value(0));
  useEffect(() => {
    let shown = 0;
    return subscribe((next) => {
      // Rise at once, fall slowly: easier to read than the raw level.
      shown = Math.max(next, shown * 0.85);
      level.setValue(shown);
    });
  }, [subscribe, level]);

  const color = mode === 'live' ? palette.live : mode === 'silent' ? palette.speaking : palette.idle;
  return (
    <View style={styles.bars} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {SHAPE.map((shape, index) => {
        const full = shape * HEIGHT;
        const scaleY = level.interpolate({ inputRange: [0, 1], outputRange: [MIN / full, 1], extrapolate: 'clamp' });
        return (
          <Animated.View
            key={index}
            style={[styles.bar, { height: full, backgroundColor: color, opacity: mode === 'off' ? 0.6 : 1, transform: [{ scaleY }] }]}
          />
        );
      })}
    </View>
  );
}

const useStyles = themedStyles(() => ({
  bars: {
    height: HEIGHT,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
  },
  bar: {
    width: 6,
    borderRadius: 3,
    transformOrigin: 'bottom',
  },
}));
