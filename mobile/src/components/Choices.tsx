// Ways to choose: cards for a few big choices, each explained; switches; segments for
// short options side by side; and radio rows. Selected things get a thicker accent border,
// so the choice shows without relying on colour alone.

import { Pressable, Text, View } from 'react-native';

import { RADIUS, themedStyles, type } from '../theme.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';

interface ChoiceCardProps {
  icon: IconName;
  title: string;
  description: string;
  selected: boolean;
  onPress(): void;
  /** e.g. "Recommended", in a pill above the title. */
  badge?: string | undefined;
  /** Why it can't be chosen, in red. */
  reason?: string | undefined;
  /** Something worth knowing about it. */
  note?: string | undefined;
  disabled?: boolean;
}

export function ChoiceCard({ icon, title, description, selected, onPress, badge, reason, note, disabled = false }: ChoiceCardProps) {
  const { styles, palette } = useStyles();
  const extra = reason ?? note;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      accessibilityLabel={[title, badge, description, extra].filter((part) => part !== undefined).join('. ')}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        selected && styles.cardSelected,
        disabled && styles.cardDisabled,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.iconCircle, selected && styles.iconCircleSelected, disabled && styles.iconCircleDisabled]}>
        <Icon name={icon} size={28} color={disabled ? palette.idle : palette.accent} />
      </View>
      <View style={styles.texts}>
        {badge !== undefined && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        )}
        <Text style={[styles.cardTitle, disabled && styles.mutedTitle]}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
        {reason !== undefined ? (
          <Text style={styles.reason}>{reason}</Text>
        ) : (
          note !== undefined && <Text style={styles.description}>{note}</Text>
        )}
      </View>
      <Radio selected={selected} />
    </Pressable>
  );
}

function Radio({ selected }: { selected: boolean }) {
  const { styles } = useStyles();
  return <View style={[styles.radio, selected && styles.radioSelected]}>{selected && <View style={styles.radioDot} />}</View>;
}

interface SwitchRowProps {
  title: string;
  description: string;
  value: boolean;
  onChange(value: boolean): void;
  /** Shown as off, and can't be changed. */
  disabled?: boolean;
}

/** A setting that is on or off, with the word "On" or "Off" next to the switch. */
export function SwitchRow({ title, description, value, onChange, disabled = false }: SwitchRowProps) {
  const { styles } = useStyles();
  const on = value && !disabled;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityHint={description}
      accessibilityState={{ checked: on, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={({ pressed }) => [styles.switchRow, pressed && styles.pressed]}
    >
      <View style={styles.switchTexts}>
        <Text style={[styles.switchTitle, disabled && styles.mutedTitle]}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
      <View style={styles.switch}>
        <Text style={[styles.switchState, on && styles.switchStateOn]}>{on ? 'On' : 'Off'}</Text>
        <View style={[styles.track, on ? styles.trackOn : styles.trackOff]}>
          <View style={[styles.knob, on ? styles.knobOn : styles.knobOff]} />
        </View>
      </View>
    </Pressable>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  top: string;
  /** A second line, e.g. the language. */
  bottom?: string | undefined;
}

interface SegmentsProps<T extends string> {
  /** Shown above the options, and read out with them. */
  label: string;
  /** question: small and muted, e.g. "Who is talking?"; field: like a field's label. */
  look?: 'question' | 'field';
  options: readonly SegmentOption<T>[];
  value: T | undefined;
  onChange(value: T): void;
}

/** A few short options side by side; one of them is chosen. */
export function Segments<T extends string>({ label, look = 'field', options, value, onChange }: SegmentsProps<T>) {
  const { styles } = useStyles();
  return (
    <View style={styles.segmentsBlock}>
      <Text style={look === 'question' ? styles.question : styles.fieldLabel}>{label}</Text>
      <View style={styles.segments} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={option.bottom === undefined ? option.top : `${option.top}, ${option.bottom}`}
              accessibilityState={{ checked: selected }}
              onPress={() => onChange(option.value)}
              style={({ pressed }) => [styles.segment, selected && styles.segmentSelected, pressed && styles.pressed]}
            >
              <Text style={[styles.segmentTop, selected && styles.segmentTopSelected]} numberOfLines={1}>
                {option.top}
              </Text>
              {option.bottom !== undefined && (
                <Text style={styles.segmentBottom} numberOfLines={1}>
                  {option.bottom}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** One of a list of options, as a full-width row. */
export function RadioRow({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  const { styles } = useStyles();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.radioRow, selected && styles.radioRowSelected, pressed && styles.pressed]}
    >
      <Radio selected={selected} />
      <Text style={styles.radioLabel}>{label}</Text>
    </Pressable>
  );
}

const useStyles = themedStyles((palette) => ({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
    padding: 20,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: RADIUS,
    backgroundColor: palette.surface,
  },
  cardSelected: {
    padding: 19,
    borderWidth: 3,
    borderColor: palette.accent,
    backgroundColor: palette.accentSoft,
  },
  cardDisabled: {
    borderColor: palette.border,
    backgroundColor: palette.surface2,
  },
  pressed: {
    opacity: 0.75,
  },
  iconCircle: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 28,
    backgroundColor: palette.accentSoft,
  },
  iconCircleSelected: {
    backgroundColor: palette.surface,
  },
  iconCircleDisabled: {
    backgroundColor: palette.idleSoft,
  },
  texts: {
    flex: 1,
    gap: 6,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: palette.accent,
  },
  badgeText: {
    ...type.smallBold,
    color: palette.onAccent,
  },
  cardTitle: {
    ...type.largeBold,
    color: palette.text,
  },
  mutedTitle: {
    color: palette.muted,
  },
  description: {
    ...type.secondary,
    color: palette.muted,
  },
  reason: {
    ...type.secondaryBold,
    color: palette.danger,
  },
  radio: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: palette.borderStrong,
    borderRadius: 15,
    backgroundColor: palette.surface,
  },
  radioSelected: {
    borderColor: palette.accent,
  },
  radioDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: palette.accent,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 14,
  },
  switchTexts: {
    flex: 1,
    gap: 4,
  },
  switchTitle: {
    ...type.bodyBold,
    color: palette.text,
  },
  switch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  switchState: {
    ...type.secondaryBold,
    color: palette.muted,
  },
  switchStateOn: {
    color: palette.accent,
  },
  track: {
    width: 60,
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 17,
  },
  trackOn: {
    justifyContent: 'flex-end',
    padding: 4,
    backgroundColor: palette.accent,
  },
  trackOff: {
    justifyContent: 'flex-start',
    padding: 2,
    borderWidth: 2,
    borderColor: palette.borderStrong,
    backgroundColor: palette.surface2,
  },
  knob: {
    width: 26,
    height: 26,
    borderRadius: 13,
  },
  knobOn: {
    backgroundColor: palette.onAccent,
  },
  knobOff: {
    backgroundColor: palette.borderStrong,
  },
  segmentsBlock: {
    gap: 8,
  },
  question: {
    ...type.secondaryBold,
    color: palette.muted,
  },
  fieldLabel: {
    ...type.bodyBold,
    color: palette.text,
  },
  segments: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: RADIUS,
    backgroundColor: palette.surface2,
  },
  segment: {
    flex: 1,
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: 'transparent',
    borderRadius: 14,
  },
  segmentSelected: {
    borderColor: palette.accent,
    backgroundColor: palette.surface,
  },
  segmentTop: {
    ...type.secondaryBold,
    color: palette.text,
    textAlign: 'center',
  },
  segmentTopSelected: {
    color: palette.accent,
  },
  segmentBottom: {
    ...type.small,
    color: palette.muted,
    textAlign: 'center',
  },
  radioRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: 16,
    backgroundColor: palette.surface,
  },
  radioRowSelected: {
    paddingHorizontal: 15,
    borderWidth: 3,
    borderColor: palette.accent,
    backgroundColor: palette.accentSoft,
  },
  radioLabel: {
    ...type.bodyBold,
    flex: 1,
    color: palette.text,
  },
}));
