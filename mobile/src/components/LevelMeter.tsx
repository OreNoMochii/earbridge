import { useEffect, useState } from 'react';
import { Animated, View } from 'react-native';

import type { MicMode } from '../audio/mic.ts';
import { themedStyles } from '../theme.ts';

interface LevelMeterProps {
  /** Calls back with the level (0..1); returns a function that stops. */
  subscribe(listener: (level: number) => void): () => void;
  mode: MicMode;
}

/** The microphone level: green when sent, purple while silenced, grey when off. */
export function LevelMeter({ subscribe, mode }: LevelMeterProps) {
  const { styles, palette } = useStyles();
  const [scale] = useState(() => new Animated.Value(0));

  useEffect(() => {
    let shown = 0;
    return subscribe((level) => {
      // Rise at once, fall slowly: easier to read than the raw level.
      shown = Math.max(level, shown * 0.85);
      scale.setValue(shown);
    });
  }, [subscribe, scale]);

  const color = mode === 'live' ? palette.live : mode === 'silent' ? palette.speaking : palette.idle;
  return (
    <View style={styles.meter} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View
        style={[
          styles.fill,
          { backgroundColor: color, opacity: mode === 'off' ? 0.6 : 1, transform: [{ scaleX: scale }] },
        ]}
      />
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  meter: {
    width: 80,
    height: 6,
    overflow: 'hidden',
    borderRadius: 3,
    backgroundColor: palette.surface2,
  },
  fill: {
    width: '100%',
    height: '100%',
    transformOrigin: 'left',
  },
}));
