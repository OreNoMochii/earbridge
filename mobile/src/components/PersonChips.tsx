// A group: who is in it, and in which language.

import { Text, View } from 'react-native';

import { languageName } from '../../../shared/languages.ts';
import { nativeLanguageName, plainLanguageName } from '../language-names.ts';
import type { ParticipantView } from '../live-session.ts';
import { themedStyles, type } from '../theme.ts';

export function PersonChips({ participants }: { participants: readonly ParticipantView[] }) {
  const { styles } = useStyles();
  if (participants.length === 0) return null;
  return (
    <View style={styles.people}>
      <Text style={styles.title} accessibilityRole="header">
        In this group
      </Text>
      <View style={styles.chips}>
        {participants.map((person, index) => {
          const name = person.me ? 'You' : person.name;
          return (
            <View
              key={`${index}:${person.name}`}
              style={styles.chip}
              accessible
              accessibilityLabel={`${name}, ${languageName(person.lang)}`}
            >
              <View style={styles.avatar}>
                <Text style={styles.initial}>{(person.name.trim()[0] ?? '?').toUpperCase()}</Text>
              </View>
              <Text style={styles.name} numberOfLines={1}>
                {name}
              </Text>
              <Text style={styles.lang} numberOfLines={1}>
                {nativeLanguageName(person.lang) ?? plainLanguageName(person.lang)}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  people: {
    gap: 8,
  },
  title: {
    ...type.secondaryBold,
    color: palette.muted,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 4,
    paddingRight: 12,
    paddingBottom: 4,
    paddingLeft: 4,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: 999,
    backgroundColor: palette.surface,
  },
  avatar: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: palette.accentSoft,
  },
  initial: {
    ...type.secondaryBold,
    color: palette.accent,
  },
  name: {
    ...type.secondaryBold,
    flexShrink: 1,
    color: palette.text,
  },
  lang: {
    ...type.small,
    color: palette.muted,
  },
}));
