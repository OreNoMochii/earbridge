// A big button to hold while talking.

import { Text, useWindowDimensions, View } from 'react-native';

import { RADIUS_LG, themedStyles, type } from '../theme.ts';
import { Icon } from './Icon.tsx';

interface HoldButtonProps {
  /** Whose button it is, e.g. "Me · English". */
  detail: string;
  /** Held down, as the conversation sees it. */
  pressed: boolean;
  onChange(pressed: boolean): void;
}

/**
 * On while a finger is on it, even if it slides off. With a screen reader, a double tap
 * turns it on and another turns it off.
 */
export function HoldButton({ detail, pressed, onChange }: HoldButtonProps) {
  const { styles, palette } = useStyles();
  const short = useWindowDimensions().height < 700;
  const color = pressed ? palette.live : palette.text;
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={detail}
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
      style={[styles.hold, short && styles.holdShort, pressed && styles.holdPressed]}
    >
      <Icon name="mic" size={short ? 32 : 40} color={pressed ? palette.live : palette.accent} />
      <Text style={[styles.label, { color }]}>{pressed ? 'Listening…' : 'Hold while you talk'}</Text>
      <Text style={styles.detail} numberOfLines={1}>
        {detail}
      </Text>
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  hold: {
    flex: 1,
    minHeight: 140,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 2,
    borderColor: palette.borderStrong,
    borderRadius: RADIUS_LG,
    backgroundColor: palette.surface,
  },
  holdShort: {
    minHeight: 112,
    gap: 4,
  },
  holdPressed: {
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderWidth: 3,
    borderColor: palette.live,
    backgroundColor: palette.liveSoft,
  },
  label: {
    ...type.button,
    textAlign: 'center',
  },
  detail: {
    ...type.secondary,
    color: palette.muted,
    textAlign: 'center',
  },
}));
