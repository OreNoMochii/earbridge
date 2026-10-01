import { Text, View } from 'react-native';

import { languageName } from '../../../shared/languages.ts';
import { shortLanguageLabel } from '../language-names.ts';
import type { ParticipantView } from '../live-session.ts';
import { themedStyles } from '../theme.ts';

/** Room mode: who is in the room, and in which language. */
export function Participants({ participants }: { participants: readonly ParticipantView[] }) {
  const { styles } = useStyles();
  if (participants.length === 0) return null;
  return (
    <View style={styles.list} accessibilityLabel="People in the room">
      {participants.map((participant, index) => (
        <View
          key={`${index}:${participant.name}`}
          style={[styles.chip, participant.me && styles.me]}
          accessible
          accessibilityLabel={`${participant.me ? 'You' : participant.name}, ${languageName(participant.lang)}`}
        >
          <Text style={styles.name} numberOfLines={1}>
            {participant.me ? 'You' : participant.name}
          </Text>
          <Text style={styles.lang}>{shortLanguageLabel(participant.lang)}</Text>
        </View>
      ))}
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingTop: 10,
    paddingHorizontal: 16,
  },
  chip: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: 999,
    backgroundColor: palette.surface,
  },
  me: {
    borderColor: palette.accent,
  },
  name: {
    flexShrink: 1,
    color: palette.text,
    fontSize: 14,
  },
  lang: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
}));
