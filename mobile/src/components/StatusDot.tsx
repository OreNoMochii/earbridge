import { useEffect, useState } from 'react';
import { Animated } from 'react-native';

import type { StatusTone } from '../live-session.ts';
import { themedStyles } from '../theme.ts';

/** How fast the dot pulses, by tone; idle stays still. */
const PULSE_MS: Record<StatusTone, number | undefined> = { live: 2_000, busy: 1_000, speaking: 800, idle: undefined };

export function StatusDot({ tone }: { tone: StatusTone }) {
  const { styles, palette } = useStyles();
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    const period = PULSE_MS[tone];
    opacity.setValue(1);
    if (period === undefined) return;
    const half = period / 2;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: half, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: half, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [tone, opacity]);

  return <Animated.View style={[styles.dot, { backgroundColor: palette[tone], opacity }]} />;
}

const useStyles = themedStyles(() => ({
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
}));
