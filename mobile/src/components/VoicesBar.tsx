// One phone, while only the two people's voices are translated: whether both voices are
// known, a way to record the other person's for this conversation, and how that goes, or
// to choose them among people whose voices were saved, and to save theirs, with their OK.

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { RecordingProblem } from '../../../shared/protocol.ts';
import type { SavedPerson } from '../engines/voices.ts';
import type { LiveSession, VoicesView } from '../live-session.ts';
import { themedStyles, type } from '../theme.ts';
import { CompactButton } from './Button.tsx';
import { Icon } from './Icon.tsx';
import { PersonDialog } from './PersonDialog.tsx';

/** What to do while the recording goes wrong. */
const HINTS: Record<RecordingProblem, string> = {
  mine: 'That sounded like you. Let them talk.',
  quiet: 'Can’t hear them well. Hold the phone closer to them.',
};

/** Why a recording did not work. */
const FAILURES: Record<RecordingProblem, string> = {
  mine: 'It heard mostly your voice. Let them talk, you stay quiet.',
  quiet: 'Too little of their voice was heard. Hold the phone closer to them.',
};

interface VoicesBarProps {
  session: LiveSession;
  voices: VoicesView;
}

export function VoicesBar({ session, voices }: VoicesBarProps) {
  const [saving, setSaving] = useState(false);
  return (
    <>
      <VoicesCard session={session} voices={voices} onSave={() => setSaving(true)} />
      {saving && (
        <PersonDialog
          title="Save their voice"
          go={{ label: 'Save', icon: 'check' }}
          taken={voices.people.map((person) => person.name)}
          onGo={async (name) => {
            const saved = await session.savePartner(name);
            if (saved) setSaving(false);
            return saved;
          }}
          onCancel={() => setSaving(false)}
        />
      )}
    </>
  );
}

function VoicesCard({ session, voices, onSave }: VoicesBarProps & { onSave(): void }) {
  const { styles, palette } = useStyles();
  const [open, setOpen] = useState(false);
  const { partner, recording, failed, name, people } = voices;
  const recorded = partner === 'recorded';
  const record = () => {
    setOpen(false);
    session.recordPartner();
  };
  const choose = (person: SavedPerson) => {
    setOpen(false);
    session.usePartner(person);
  };

  if (recording) {
    const { seconds, of, hint } = recording;
    return (
      <View style={styles.card}>
        <View style={styles.head}>
          <Icon name="mic" size={24} color={palette.live} />
          <Text style={styles.title}>Recording their voice</Text>
          {of > 0 && (
            <Text style={styles.count} accessibilityLabel={`${seconds} of ${of} seconds`}>
              {seconds} / {of} s
            </Text>
          )}
        </View>
        {of > 0 && (
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.min(100, (seconds / of) * 100)}%` }]} />
          </View>
        )}
        <View style={styles.foot}>
          <Text style={[hint ? styles.hint : styles.text, styles.grow]} accessibilityLiveRegion="polite">
            {hint ? HINTS[hint] : 'Let them talk. You stay quiet.'}
          </Text>
          <CompactButton label="Cancel" icon="x" accessibilityLabel="Stop recording their voice" onPress={() => session.stopRecording()} />
        </View>
      </View>
    );
  }

  if (failed) {
    return (
      <View style={styles.card} accessibilityRole="alert">
        <View style={styles.head}>
          <Icon name="circle-alert" size={24} color={palette.danger} />
          <Text style={styles.title}>Couldn’t record their voice</Text>
        </View>
        <Text style={styles.text}>{FAILURES[failed]}</Text>
        <View style={styles.buttons}>
          <CompactButton label="Try again" icon="mic" onPress={record} style={styles.button} />
          <CompactButton label="Close" onPress={() => session.dismissVoices()} style={styles.button} />
        </View>
      </View>
    );
  }

  if (voices.offerSave && recorded) {
    return (
      <View style={styles.card}>
        <View style={styles.head}>
          <Icon name="circle-check" size={24} color={palette.live} />
          <Text style={styles.title}>Their voice is recorded</Text>
        </View>
        <Text style={styles.text}>Save it for your next talks? Only with their OK.</Text>
        <View style={styles.buttons}>
          <CompactButton label="Save" icon="check" accessibilityLabel="Save their voice" onPress={onSave} style={styles.button} />
          <CompactButton label="No" icon="x" accessibilityLabel="Don’t save their voice" onPress={() => session.dismissSave()} style={styles.button} />
        </View>
      </View>
    );
  }

  if (partner === 'unknown' && (open || !voices.dismissed)) {
    const dismiss = () => {
      setOpen(false);
      session.dismissVoices();
    };
    if (people.length > 0) {
      return (
        <View style={styles.card}>
          <View style={styles.head}>
            <Icon name="users" size={24} color={palette.accent} />
            <Text style={styles.title}>Who are you talking with?</Text>
          </View>
          <People people={people} onChoose={choose} />
          <View style={styles.buttons}>
            <CompactButton
              label="Someone new"
              icon="mic"
              accessibilityLabel="Someone new: record their voice"
              onPress={record}
              style={styles.button}
            />
            <CompactButton label="Not now" onPress={dismiss} style={styles.button} />
          </View>
        </View>
      );
    }
    return (
      <View style={styles.card}>
        <View style={styles.head}>
          <Icon name="mic" size={24} color={palette.accent} />
          <Text style={styles.title}>Record their voice</Text>
        </View>
        <Text style={styles.text}>Only recorded voices are translated. Ask them to say a few words.</Text>
        <View style={styles.buttons}>
          <CompactButton label="Record" icon="mic" accessibilityLabel="Record their voice" onPress={record} style={styles.button} />
          <CompactButton label="Not now" onPress={dismiss} style={styles.button} />
        </View>
        <View style={styles.privacy}>
          <Icon name="lock" size={18} color={palette.muted} />
          <Text style={styles.small}>Only for this talk, on this phone.</Text>
        </View>
      </View>
    );
  }

  if (open && recorded) {
    const others = people.filter((person) => person.name !== name);
    return (
      <View style={styles.card}>
        <View style={styles.head}>
          <Icon name="circle-check" size={24} color={palette.live} />
          <Text style={styles.title}>{name ? `Talking with ${name}` : 'Their voice is recorded'}</Text>
        </View>
        <Text style={styles.text}>{name ? 'Their saved voice is used.' : 'Only for this talk, unless you save it.'}</Text>
        {others.length > 0 && (
          <View style={styles.others}>
            <Text style={styles.label}>Someone else?</Text>
            <People people={others} onChoose={choose} />
          </View>
        )}
        <View style={styles.buttons}>
          <CompactButton label="Record" icon="mic" accessibilityLabel="Record their voice again" onPress={record} style={styles.button} />
          {!name && (
            <CompactButton label="Save" icon="check" accessibilityLabel="Save their voice" onPress={onSave} style={styles.button} />
          )}
          <CompactButton label="Close" onPress={() => setOpen(false)} style={styles.button} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <Text style={styles.label}>Voices</Text>
      <View style={[styles.chip, styles.known]} accessible accessibilityLabel="Your voice is known">
        <Icon name="check" size={18} color={palette.live} />
        <Text style={[styles.chipText, { color: palette.live }]}>You</Text>
      </View>
      {!recorded ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={people.length > 0 ? 'Choose who you are talking with' : 'Record their voice'}
          onPress={people.length > 0 ? () => setOpen(true) : record}
          hitSlop={6}
          style={({ pressed }) => [styles.chip, styles.action, pressed && styles.pressed]}
        >
          <Icon name={people.length > 0 ? 'users' : 'mic'} size={18} color={palette.accent} />
          <Text style={[styles.chipText, { color: palette.accent }]}>{people.length > 0 ? 'Choose them' : 'Record them'}</Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={name ? `Talking with ${name}` : 'Their voice is recorded'}
          accessibilityHint="Shows more, and lets you record it again"
          onPress={() => setOpen(true)}
          hitSlop={6}
          style={({ pressed }) => [styles.chip, styles.known, pressed && styles.pressed]}
        >
          <Icon name="check" size={18} color={palette.live} />
          <Text style={[styles.chipText, { color: palette.live }]} numberOfLines={1}>
            {name ?? 'Them'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/** People whose voices are saved, to choose who they are talking with. */
function People({ people, onChoose }: { people: readonly SavedPerson[]; onChoose(person: SavedPerson): void }) {
  const { styles, palette } = useStyles();
  return (
    <View style={styles.row}>
      {people.map((person) => (
        <Pressable
          key={person.id}
          accessibilityRole="button"
          accessibilityHint="Uses their saved voice"
          onPress={() => onChoose(person)}
          hitSlop={6}
          style={({ pressed }) => [styles.chip, styles.action, pressed && styles.pressed]}
        >
          <Text style={[styles.chipText, { color: palette.accent }]} numberOfLines={1}>
            {person.name}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  card: {
    gap: 10,
    padding: 14,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: 16,
    backgroundColor: palette.surface,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    ...type.bodyBold,
    flex: 1,
    color: palette.text,
  },
  count: {
    ...type.secondaryBold,
    color: palette.muted,
  },
  track: {
    height: 12,
    overflow: 'hidden',
    borderRadius: 6,
    backgroundColor: palette.surface2,
  },
  fill: {
    height: 12,
    borderRadius: 6,
    backgroundColor: palette.live,
  },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  text: {
    ...type.secondary,
    color: palette.text,
  },
  hint: {
    ...type.secondaryBold,
    color: palette.danger,
  },
  grow: {
    flex: 1,
  },
  buttons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  button: {
    flexGrow: 1,
    flexBasis: '40%',
  },
  others: {
    gap: 8,
  },
  privacy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  small: {
    ...type.small,
    flex: 1,
    color: palette.muted,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    ...type.smallBold,
    color: palette.muted,
  },
  chip: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  known: {
    backgroundColor: palette.liveSoft,
  },
  action: {
    borderWidth: 2,
    borderColor: palette.accent,
    backgroundColor: palette.accentSoft,
  },
  chipText: {
    ...type.smallBold,
  },
  pressed: {
    opacity: 0.75,
  },
}));
