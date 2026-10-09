// Small pieces used on many screens: the logo, the conversation status, section titles,
// dividers, notes with an icon, and the banner that says why a conversation stopped.

import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { StatusTone } from '../live-session.ts';
import { themedStyles, type } from '../theme.ts';
import { CompactButton } from './Button.tsx';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';

/** "Alo" in a speech bubble. */
export function Logo({ large = false }: { large?: boolean }) {
  const { styles, palette } = useStyles();
  return (
    <View style={styles.logo} accessible accessibilityRole="header" accessibilityLabel="Alo">
      <Icon name="audio-lines" size={large ? 30 : 24} color={palette.onAccent} />
      <Text style={[styles.logoText, large && styles.logoTextLarge]}>Alo</Text>
    </View>
  );
}

/** What the conversation is doing, in its colour. */
export function StatusPill({ text, tone }: { text: string; tone: StatusTone }) {
  const { styles, palette } = useStyles();
  const color = palette[tone];
  return (
    <View style={[styles.pill, { backgroundColor: palette[`${tone}Soft` as const] }]} accessibilityLiveRegion="polite">
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color }]} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
}

/** A section's title, muted when nothing in it can be used. */
export function SectionTitle({ children, hint, muted = false }: { children: string; hint?: string | undefined; muted?: boolean }) {
  const { styles } = useStyles();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, muted && styles.mutedTitle]} accessibilityRole="header">
        {children}
      </Text>
      {hint !== undefined && <Text style={styles.muted}>{hint}</Text>}
    </View>
  );
}

export function Divider() {
  const { styles } = useStyles();
  return <View style={styles.divider} />;
}

/** A line of text with an icon before it, e.g. for privacy. Muted notes have a smaller icon. */
export function Note({ icon, children, tone = 'plain' }: { icon: IconName; children: ReactNode; tone?: 'plain' | 'muted' }) {
  const { styles, palette } = useStyles();
  const muted = tone === 'muted';
  return (
    <View style={[styles.note, muted && styles.noteMuted]}>
      <Icon name={icon} size={muted ? 22 : 24} color={muted ? palette.muted : palette.accent} />
      <Text style={[styles.noteText, tone === 'muted' && styles.muted]}>{children}</Text>
    </View>
  );
}

export interface BannerAction {
  label: string;
  icon: IconName;
  onPress(): void;
}

/** A problem, with what to do about it. */
export function Banner({ icon, title, message, action }: { icon: IconName; title: string; message: string; action?: BannerAction | undefined }) {
  const { styles, palette } = useStyles();
  return (
    <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <View style={styles.bannerHead}>
        <Icon name={icon} size={26} color={palette.danger} />
        <View style={styles.bannerText}>
          <Text style={styles.bannerTitle}>{title}</Text>
          <Text style={styles.bannerMessage}>{message}</Text>
        </View>
      </View>
      {action && <CompactButton label={action.label} icon={action.icon} onPress={action.onPress} style={styles.bannerAction} />}
    </View>
  );
}

/** Text in the "a field is wrong" style, with its icon. */
export function ErrorText({ children }: { children: string }) {
  const { styles, palette } = useStyles();
  return (
    <View style={styles.error} accessibilityLiveRegion="polite">
      <Icon name="circle-alert" size={22} color={palette.danger} />
      <Text style={styles.errorText}>{children}</Text>
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  logo: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 8,
    paddingRight: 16,
    paddingBottom: 8,
    paddingLeft: 14,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 6,
    backgroundColor: palette.accent,
  },
  logoText: {
    ...type.title,
    fontSize: 26,
    lineHeight: 35,
    color: palette.onAccent,
  },
  logoTextLarge: {
    fontSize: 34,
    lineHeight: 46,
  },
  pill: {
    alignSelf: 'flex-start',
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 8,
    paddingRight: 16,
    paddingBottom: 8,
    paddingLeft: 12,
    borderRadius: 999,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  pillText: {
    ...type.secondaryBold,
    flexShrink: 1,
  },
  section: {
    gap: 12,
  },
  sectionTitle: {
    ...type.section,
    color: palette.text,
  },
  mutedTitle: {
    color: palette.muted,
  },
  muted: {
    ...type.secondary,
    color: palette.muted,
  },
  divider: {
    height: 2,
    backgroundColor: palette.border,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  noteMuted: {
    gap: 10,
  },
  noteText: {
    ...type.secondary,
    flex: 1,
    color: palette.text,
  },
  banner: {
    gap: 14,
    padding: 14,
    borderWidth: 2,
    borderColor: palette.danger,
    borderRadius: 16,
    backgroundColor: palette.dangerSoft,
  },
  bannerHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  bannerText: {
    flex: 1,
    gap: 4,
  },
  bannerAction: {
    alignSelf: 'flex-start',
  },
  bannerTitle: {
    ...type.bodyBold,
    color: palette.danger,
  },
  bannerMessage: {
    ...type.secondary,
    color: palette.text,
  },
  error: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  errorText: {
    ...type.secondaryBold,
    flex: 1,
    color: palette.danger,
  },
}));
