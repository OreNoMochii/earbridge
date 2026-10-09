// A button to hold while talking.

import { Text, View } from 'react-native';

import { RADIUS, themedStyles, type } from '../theme.ts';
import { Icon } from './Icon.tsx';

interface HoldButtonProps {
  /** Whose button it is, e.g. "Me". */
  who: string;
  /** The language they speak, in its own words, e.g. "Español". */
  language: string;
  /** Held down, as the conversation sees it. */
  pressed: boolean;
  onChange(pressed: boolean): void;
}

/**
 * On while a finger is on it, even if it slides off. With a screen reader, a double tap
 * turns it on and another turns it off.
 */
export function HoldButton({ who, language, pressed, onChange }: HoldButtonProps) {
  const { styles, palette } = useStyles();
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${who}, ${language}`}
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
      <Icon name="mic" size={24} color={pressed ? palette.live : palette.accent} />
      <View style={styles.texts}>
        <Text style={[styles.who, pressed && styles.listening]} numberOfLines={1}>
          {who}
        </Text>
        <Text style={[styles.language, pressed && styles.listening]} numberOfLines={1}>
          {pressed ? 'Listening…' : language}
        </Text>
      </View>
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  hold: {
    flex: 1,
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 2,
    borderColor: palette.borderStrong,
    borderRadius: RADIUS,
    backgroundColor: palette.surface,
  },
  holdPressed: {
    paddingVertical: 5,
    paddingHorizontal: 9,
    borderWidth: 3,
    borderColor: palette.live,
    backgroundColor: palette.liveSoft,
  },
  texts: {
    flexShrink: 1,
  },
  who: {
    ...type.compact,
    color: palette.text,
  },
  language: {
    ...type.small,
    color: palette.muted,
  },
  listening: {
    color: palette.live,
  },
}));
