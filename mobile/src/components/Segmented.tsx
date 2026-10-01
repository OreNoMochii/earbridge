// A choice of one among a few: the mode tabs, the setup choices, and who is talking.

import { Pressable, Text, View } from 'react-native';

import { RADIUS, themedStyles } from '../theme.ts';

export interface Option<T extends string> {
  value: T;
  label: string;
  detail?: string;
}

interface SegmentedProps<T extends string> {
  options: readonly Option<T>[];
  value: T | undefined;
  onChange(value: T): void;
  /** tabs: big, for the mode. choices: bordered boxes. bar: one joined row of buttons. */
  look: 'tabs' | 'choices' | 'bar';
  accessibilityLabel: string;
}

export function Segmented<T extends string>({ options, value, onChange, look, accessibilityLabel }: SegmentedProps<T>) {
  const { styles } = useStyles();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={styles[look]}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles[`${look}Option` as const],
              look === 'bar' && index > 0 && styles.barDivider,
              selected && styles[`${look}Selected` as const],
              pressed && !selected && styles.pressed,
            ]}
          >
            {look === 'choices' && (
              <View style={[styles.radio, selected && styles.radioSelected]}>{selected && <View style={styles.radioDot} />}</View>
            )}
            <View style={look === 'choices' ? styles.choiceText : undefined}>
              <Text
                style={[styles[`${look}Label` as const], selected && styles[`${look}LabelSelected` as const]]}
                numberOfLines={look === 'bar' ? 1 : undefined}
              >
                {option.label}
              </Text>
              {option.detail !== undefined && <Text style={styles.detail}>{option.detail}</Text>}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  pressed: {
    opacity: 0.7,
  },
  detail: {
    marginTop: 2,
    color: palette.muted,
    fontSize: 13,
    textAlign: 'center',
  },

  tabs: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: RADIUS,
    backgroundColor: palette.surface2,
  },
  tabsOption: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 13,
    alignItems: 'center',
  },
  tabsSelected: {
    backgroundColor: palette.raised,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  tabsLabel: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  tabsLabelSelected: {},

  choices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  choicesOption: {
    flexGrow: 1,
    flexBasis: 120,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minHeight: 46,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: 12,
  },
  choicesSelected: {
    borderColor: palette.accent,
    backgroundColor: palette.accentSoft,
  },
  choicesLabel: {
    color: palette.text,
    fontSize: 15,
  },
  choicesLabelSelected: {
    fontWeight: '600',
  },
  choiceText: {
    flexShrink: 1,
  },
  radio: {
    width: 18,
    height: 18,
    borderWidth: 2,
    borderColor: palette.borderStrong,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: {
    borderColor: palette.accent,
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: palette.accent,
  },

  bar: {
    flex: 1,
    flexDirection: 'row',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: 12,
  },
  barOption: {
    flex: 1,
    minHeight: 48,
    paddingVertical: 6,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
  },
  barDivider: {
    borderLeftWidth: 1,
    borderLeftColor: palette.borderStrong,
  },
  barSelected: {
    backgroundColor: palette.accent,
  },
  barLabel: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '600',
  },
  barLabelSelected: {
    color: palette.accentContrast,
  },
}));
