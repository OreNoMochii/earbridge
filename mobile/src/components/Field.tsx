// Text fields with their label above, and what is wrong or worth knowing below.

import { useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';

import { themedStyles, type } from '../theme.ts';
import { ErrorText } from './Basics.tsx';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { useKeepInView } from './Screen.tsx';

interface TextFieldProps extends Omit<TextInputProps, 'style' | 'ref'> {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  icon?: IconName | undefined;
  /** A slightly larger label, a bit further from the box, for fields that stand alone on a screen. */
  large?: boolean;
  ref?: Ref<TextInput>;
  /** Under the field, e.g. buttons that act on it. */
  children?: ReactNode;
}

export function TextField({ label, hint, error, icon, large, ref, children, onFocus, onBlur, ...input }: TextFieldProps) {
  const { styles, palette } = useStyles();
  const [focused, setFocused] = useState(false);
  const field = useRef<View>(null);
  const keepInView = useKeepInView();
  return (
    <View ref={field} style={[styles.field, large && styles.fieldLarge]}>
      <Text style={[styles.label, large && styles.labelLarge]}>{label}</Text>
      <View style={[styles.box, focused && styles.boxFocused, error !== undefined && styles.boxError]}>
        {icon && <Icon name={icon} size={24} color={palette.muted} />}
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          accessibilityHint={error ?? hint}
          placeholderTextColor={palette.muted}
          {...input}
          onFocus={(event) => {
            setFocused(true);
            keepInView(field, true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            keepInView(field, false);
            onBlur?.(event);
          }}
          style={styles.input}
        />
      </View>
      {error !== undefined && <ErrorText>{error}</ErrorText>}
      {hint !== undefined && <Text style={styles.hint}>{hint}</Text>}
      {children}
    </View>
  );
}

/** Looks like a field, and opens a list to choose from. */
export function SelectField({ label, value, onPress }: { label: string; value: string; onPress(): void }) {
  const { styles, palette } = useStyles();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        accessibilityHint="Opens the list of languages"
        onPress={onPress}
        style={({ pressed }) => [styles.box, pressed && styles.pressed]}
      >
        <Text style={styles.value}>{value}</Text>
        <Icon name="chevron-down" size={24} color={palette.muted} />
      </Pressable>
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  field: {
    gap: 8,
  },
  fieldLarge: {
    gap: 10,
  },
  label: {
    ...type.compact,
    color: palette.text,
  },
  labelLarge: {
    ...type.bodyBold,
  },
  box: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    borderWidth: 2,
    borderColor: palette.borderStrong,
    borderRadius: 14,
    backgroundColor: palette.surface,
  },
  boxFocused: {
    paddingHorizontal: 13,
    borderWidth: 3,
    borderColor: palette.accent,
  },
  boxError: {
    paddingHorizontal: 13,
    borderWidth: 3,
    borderColor: palette.danger,
  },
  input: {
    ...type.body,
    flex: 1,
    minHeight: 56,
    paddingVertical: 10,
    color: palette.text,
  },
  value: {
    ...type.body,
    flex: 1,
    paddingVertical: 14,
    color: palette.text,
  },
  hint: {
    ...type.secondary,
    color: palette.muted,
  },
  pressed: {
    backgroundColor: palette.surface2,
  },
}));
