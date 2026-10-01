import { Text, View } from 'react-native';

import { RADIUS, themedStyles } from '../theme.ts';

interface HoldButtonProps {
  label: string;
  detail: string;
  /** Held down, as the conversation sees it. */
  pressed: boolean;
  onChange(pressed: boolean): void;
}

/**
 * On while a finger is on it, even if it slides off. With a screen reader, a double tap
 * turns it on and another turns it off.
 */
export function HoldButton({ label, detail, pressed, onChange }: HoldButtonProps) {
  const { styles } = useStyles();
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${detail}`}
      accessibilityHint="Hold while you talk"
      accessibilityState={{ selected: pressed }}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'activate') onChange(!pressed);
      }}
      onStartShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={() => onChange(true)}
      onResponderRelease={() => onChange(false)}
      onResponderTerminate={() => onChange(false)}
      style={[styles.hold, pressed && styles.holdPressed]}
    >
      <Text style={[styles.label, pressed && styles.textPressed]}>{label}</Text>
      <Text style={[styles.detail, pressed && styles.textPressed]} numberOfLines={1}>
        {detail}
      </Text>
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  hold: {
    flex: 1,
    minHeight: 88,
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderWidth: 2,
    borderColor: palette.accent,
    borderRadius: RADIUS,
    backgroundColor: palette.surface,
  },
  holdPressed: {
    backgroundColor: palette.accent,
    transform: [{ scale: 0.98 }],
  },
  label: {
    color: palette.text,
    fontSize: 19,
    fontWeight: '700',
  },
  detail: {
    color: palette.text,
    fontSize: 14,
    opacity: 0.8,
  },
  textPressed: {
    color: palette.accentContrast,
  },
}));
