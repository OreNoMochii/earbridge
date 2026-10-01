import { Pressable, Text } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { themedStyles } from '../theme.ts';

export type ButtonKind = 'default' | 'primary' | 'danger' | 'ghost';

export interface ButtonProps {
  label: string;
  onPress(): void;
  kind?: ButtonKind;
  small?: boolean;
  disabled?: boolean;
  /** A toggle that is on, like Mute while muted. */
  active?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function Button({ label, onPress, kind = 'default', small, disabled, active, accessibilityLabel, style }: ButtonProps) {
  const { styles } = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled), selected: active }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.small,
        styles[kind],
        active && styles.active,
        disabled && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      <Text
        style={[styles.label, small && styles.smallLabel, styles[`${kind}Label` as const], active && styles.activeLabel]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const useStyles = themedStyles((palette) => ({
  button: {
    minHeight: 44,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: 12,
    backgroundColor: palette.surface,
  },
  small: {
    minHeight: 36,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  default: {},
  primary: {
    backgroundColor: palette.accent,
    borderColor: palette.accent,
  },
  danger: {
    borderColor: palette.dangerBorder,
  },
  ghost: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
  },
  active: {
    backgroundColor: palette.dangerSoft,
    borderColor: palette.danger,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.7,
  },
  label: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  smallLabel: {
    fontSize: 14,
  },
  defaultLabel: {},
  primaryLabel: {
    color: palette.accentContrast,
  },
  dangerLabel: {
    color: palette.danger,
  },
  ghostLabel: {
    color: palette.accent,
  },
  activeLabel: {
    color: palette.danger,
  },
}));
