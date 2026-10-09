// The voice prints kept on this phone for "Only our two voices": mine, and those of people
// I talk with, saved with their OK so they need not be recorded again in each talk. Each
// is drawn, and can be deleted; mine can be recorded again.

import { useState } from 'react';
import { Text, View } from 'react-native';

import { wantsEarphoneMic } from '../app-settings.ts';
import type { AppSettings } from '../app-settings.ts';
import { Note, SectionTitle } from '../components/Basics.tsx';
import { Button, CompactButton } from '../components/Button.tsx';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { PersonDialog } from '../components/PersonDialog.tsx';
import { Screen } from '../components/Screen.tsx';
import { VoicePrint } from '../components/VoicePrint.tsx';
import { VoiceRecorder } from '../components/VoiceRecorder.tsx';
import {
  deleteMyVoice,
  deletePerson,
  listPeople,
  readMyVoice,
  readPersonVoice,
  saveMyVoice,
  savePerson,
} from '../engines/voices.ts';
import type { KeptVoice, SavedPerson } from '../engines/voices.ts';
import { RADIUS, themedStyles, type } from '../theme.ts';
import { useBackButton } from './parts.tsx';
import type { Update } from './parts.tsx';

interface Person extends SavedPerson {
  /** Undefined when it can no longer be used, e.g. made by an older speaker model. */
  voice: KeptVoice | undefined;
}

interface VoicesScreenProps {
  settings: AppSettings;
  onChange: Update;
  onBack(): void;
}

export function VoicesScreen({ settings, onChange, onBack }: VoicesScreenProps) {
  const { styles } = useStyles();
  const [mine, setMine] = useState(readMyVoice);
  const [people, setPeople] = useState(readPeople);
  /** Whose voice is being recorded: mine, or someone's, told from mine. */
  const [recording, setRecording] = useState<'me' | { name: string; mine: Float32Array }>();
  const [naming, setNaming] = useState(false);
  const [deleting, setDeleting] = useState<'me' | Person>();

  useBackButton(() => {
    onBack();
    return true;
  });

  const reload = () => {
    setMine(readMyVoice());
    setPeople(readPeople());
  };

  const deleteVoice = (whose: 'me' | Person) => {
    setDeleting(undefined);
    if (whose === 'me') {
      setMine(undefined);
      onChange({ onlyOurVoices: false });
      deleteMyVoice().catch(() => {}).finally(reload);
    } else {
      setPeople((current) => current.filter((person) => person.id !== whose.id));
      deletePerson(whose.id).catch(() => {}).finally(reload);
    }
  };

  return (
    <>
      <Screen gap={28}>
        <View style={styles.back}>
          <CompactButton label="Back" icon="chevron-left" onPress={onBack} />
        </View>
        <View style={styles.intro}>
          <Text style={styles.title} accessibilityRole="header">
            Voices
          </Text>
          <Note icon="lock">Only voice prints are kept, on this phone. Recordings aren’t kept.</Note>
        </View>

        <View style={styles.section}>
          <SectionTitle>Your voice</SectionTitle>
          <View style={styles.card}>
            <View style={styles.row}>
              {mine ? (
                <VoicePrint print={mine.print} label="Your voice print" size={112} />
              ) : (
                <Blank size={112} />
              )}
              <View style={styles.about}>
                <Text style={styles.name}>{mine ? savedOn(mine.saved) : 'Not recorded yet'}</Text>
                {mine ? (
                  <CompactButton
                    kind="delete"
                    label="Delete"
                    icon="trash-2"
                    accessibilityLabel="Delete your voice"
                    onPress={() => setDeleting('me')}
                  />
                ) : (
                  <Text style={styles.detail}>Needed to tell you apart from other voices.</Text>
                )}
              </View>
            </View>
            {mine ? (
              <Button label="Record again" icon="mic" accessibilityLabel="Record your voice again" onPress={() => setRecording('me')} />
            ) : (
              <Button
                kind="primary"
                label="Record your voice"
                icon="mic"
                accessibilityLabel="Record your voice"
                onPress={() => setRecording('me')}
              />
            )}
          </View>
        </View>

        <View style={styles.section}>
          <SectionTitle hint="Pick one when a talk starts, instead of recording them again.">People you talk with</SectionTitle>
          {people.length === 0 && <Text style={styles.empty}>Nobody saved yet.</Text>}
          {people.map((person) => (
            <View key={person.id} style={styles.card}>
              <View style={styles.row}>
                {person.voice ? (
                  <VoicePrint print={person.voice.print} label={`${person.name}’s voice print`} size={88} />
                ) : (
                  <Blank size={88} />
                )}
                <View style={styles.about}>
                  <Text style={styles.name}>{person.name}</Text>
                  <Text style={styles.detail}>{person.voice ? savedOn(person.saved) : 'Can’t be used anymore'}</Text>
                  <CompactButton
                    kind="delete"
                    label="Delete"
                    icon="trash-2"
                    accessibilityLabel={`Delete ${person.name}’s voice`}
                    onPress={() => setDeleting(person)}
                  />
                </View>
              </View>
            </View>
          ))}
          <Button label="Record someone" icon="user-plus" disabled={!mine} onPress={() => setNaming(true)} />
          {!mine && <Text style={styles.detail}>Record your voice first.</Text>}
          <Note icon="info" tone="muted">
            Save someone’s voice only with their OK. Delete it whenever they ask.
          </Note>
        </View>
      </Screen>

      {naming && (
        <PersonDialog
          title="Record someone"
          go={{ label: 'Record', icon: 'mic' }}
          taken={people.map((person) => person.name)}
          onGo={(name) => {
            if (!mine) return false;
            setNaming(false);
            setRecording({ name, mine: mine.print });
            return true;
          }}
          onCancel={() => setNaming(false)}
        />
      )}
      <ConfirmDialog
        visible={deleting !== undefined}
        title={deleting === 'me' ? 'Delete your voice?' : `Delete ${deleting?.name ?? ''}’s voice?`}
        message={
          deleting === 'me'
            ? '“Only our two voices” turns off until you record it again.'
            : 'Their voice print is removed from this phone.'
        }
        keep={{ label: 'Keep it', icon: 'check' }}
        go={{ label: 'Delete', icon: 'trash-2' }}
        onKeep={() => setDeleting(undefined)}
        onGo={() => {
          if (deleting) deleteVoice(deleting);
        }}
      />
      {recording && (
        <VoiceRecorder
          them={recording === 'me' ? undefined : recording}
          earphoneMic={wantsEarphoneMic({ ...settings, mode: 'solo' })}
          save={recording === 'me' ? saveMyVoice : (print) => savePerson(recording.name, print)}
          onDone={() => {
            if (recording === 'me') onChange({ onlyOurVoices: true });
            setRecording(undefined);
            reload();
          }}
          onClose={() => setRecording(undefined)}
        />
      )}
    </>
  );
}

/** Where a voice print would be drawn, when there is none to draw. */
function Blank({ size }: { size: number }) {
  const { styles, palette } = useStyles();
  return (
    <View style={[styles.blank, { width: size, height: size, borderRadius: size / 2 }]}>
      <Icon name="mic-off" size={size / 3} color={palette.muted} />
    </View>
  );
}

function readPeople(): Person[] {
  return listPeople().map((person) => ({ ...person, voice: readPersonVoice(person.id) }));
}

function savedOn(saved: number | undefined): string {
  if (saved === undefined) return 'Saved on this phone';
  return `Saved ${new Date(saved).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

const useStyles = themedStyles((palette) => ({
  back: {
    flexDirection: 'row',
  },
  intro: {
    gap: 14,
  },
  title: {
    ...type.title,
    color: palette.text,
  },
  section: {
    gap: 12,
  },
  card: {
    gap: 14,
    padding: 16,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: RADIUS,
    backgroundColor: palette.surface,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  about: {
    flex: 1,
    gap: 6,
    alignItems: 'flex-start',
  },
  name: {
    ...type.bodyBold,
    color: palette.text,
  },
  detail: {
    ...type.secondary,
    color: palette.muted,
  },
  blank: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: palette.border,
  },
  empty: {
    ...type.body,
    color: palette.muted,
  },
}));
