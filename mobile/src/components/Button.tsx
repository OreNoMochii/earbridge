// The buttons. Big ones for the main action on a screen; compact ones for actions next to
// something else; hero ones for starting a conversation from Home. Every one has a
// visible label: icons only help recognize it.

import { Pressable, Text, View } from 'react-native';
import type { AccessibilityState, StyleProp, ViewStyle } from 'react-native';

import { RADIUS, RADIUS_LG, themedStyles, type } from '../theme.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';

interface Common {
  label: string;
  icon?: IconName | undefined;
  disabled?: boolean;
  onPress(): void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
  style?: StyleProp<ViewStyle>;
}

interface ButtonProps extends Common {
  kind?: 'primary' | 'secondary' | 'danger';
  /** An arrow after the label, for going on to the next step. */
  next?: boolean;
}

export function Button({ kind = 'secondary', label, icon, next, disabled, onPress, style, ...a11y }: ButtonProps) {
  const { styles, palette } = useStyles();
  const color = kind === 'primary' ? palette.onAccent : kind === 'danger' ? palette.onDanger : palette.text;
  return (
    <Pressable
      accessibilityRole="button"
      {...a11y}
      accessibilityState={{ disabled: !!disabled, ...a11y.accessibilityState }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, styles[kind], pressed && styles.pressed, disabled && styles.disabled, style]}
    >
      {icon && <Icon name={icon} size={26} color={color} />}
      <Text style={[styles.label, { color }]}>{label}</Text>
      {next && <Icon name="arrow-right" size={26} color={color} />}
    </Pressable>
  );
}

interface CompactButtonProps extends Common {
  /** plain; danger: End and Leave; active: a panel it opened is showing; delete: removes something. */
  kind?: 'plain' | 'danger' | 'active' | 'delete';
}

export function CompactButton({ kind = 'plain', label, icon, disabled, onPress, style, ...a11y }: CompactButtonProps) {
  const { styles, palette } = useStyles();
  const color =
    kind === 'danger' ? palette.onDanger : kind === 'active' ? palette.accent : kind === 'delete' ? palette.danger : palette.text;
  return (
    <Pressable
      accessibilityRole="button"
      {...a11y}
      accessibilityState={{ disabled: !!disabled, ...a11y.accessibilityState }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.compact,
        kind === 'danger' && styles.compactDanger,
        kind === 'active' && styles.compactActive,
        kind === 'delete' && styles.compactDelete,
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      {icon && <Icon name={icon} size={22} color={color} />}
      <Text style={[kind === 'danger' ? styles.compactDangerLabel : styles.compactLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

interface HeroButtonProps {
  title: string;
  subtitle: string;
  icon: IconName;
  /** main: Start talking; other: the group conversation. */
  kind?: 'main' | 'other';
  onPress(): void;
}

/** A large card-like button, for the two ways to start from Home. */
export function HeroButton({ title, subtitle, icon, kind = 'main', onPress }: HeroButtonProps) {
  const { styles, palette } = useStyles();
  const main = kind === 'main';
  const color = main ? palette.onAccent : palette.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      onPress={onPress}
      style={({ pressed }) => [styles.hero, main ? styles.heroMain : styles.heroOther, pressed && styles.pressed]}
    >
      <View style={[styles.heroIcon, !main && styles.heroIconOther]}>
        <Icon name={icon} size={main ? 32 : 28} color={palette.accent} />
      </View>
      <View style={styles.heroText}>
        <Text style={[main ? styles.heroTitle : styles.heroTitleOther, { color }]}>{title}</Text>
        <Text style={[styles.heroSubtitle, { color: main ? palette.onAccent : palette.muted }]}>{subtitle}</Text>
      </View>
      <Icon name="chevron-right" size={28} color={color} />
    </Pressable>
  );
}

const useStyles = themedStyles((palette) => ({
  button: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: RADIUS,
  },
  primary: {
    backgroundColor: palette.accent,
  },
  secondary: {
    borderWidth: 2,
    borderColor: palette.borderStrong,
    backgroundColor: palette.surface,
  },
  danger: {
    backgroundColor: palette.danger,
  },
  label: {
    ...type.button,
    flexShrink: 1,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.75,
  },
  disabled: {
    opacity: 0.5,
  },
  compact: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderWidth: 2,
    borderColor: palette.borderStrong,
    borderRadius: 16,
    backgroundColor: palette.surface,
  },
  compactDanger: {
    paddingHorizontal: 22,
    borderColor: palette.danger,
    backgroundColor: palette.danger,
  },
  compactActive: {
    borderColor: palette.accent,
    backgroundColor: palette.accentSoft,
  },
  compactDelete: {
    borderColor: palette.danger,
  },
  compactLabel: {
    ...type.compact,
    flexShrink: 1,
    textAlign: 'center',
  },
  compactDangerLabel: {
    ...type.button,
    flexShrink: 1,
  },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    padding: 20,
    borderRadius: RADIUS_LG,
  },
  heroMain: {
    backgroundColor: palette.accent,
  },
  heroOther: {
    borderWidth: 2,
    borderColor: palette.borderStrong,
    backgroundColor: palette.surface,
  },
  heroIcon: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 32,
    backgroundColor: palette.accentSoft,
  },
  heroIconOther: {
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  heroText: {
    flex: 1,
    gap: 2,
  },
  heroTitle: {
    ...type.title,
    fontSize: 26,
    lineHeight: 33,
  },
  heroTitleOther: {
    ...type.section,
  },
  heroSubtitle: {
    ...type.secondary,
  },
}));
