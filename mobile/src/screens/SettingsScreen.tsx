// Everything that can be changed: who translates, how to talk, where translations are
// heard, help for noisy places, and the microphone and voice under "More options".

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { wantsEarphoneMic } from '../app-settings.ts';
import type { AppSettings, MicChoice } from '../app-settings.ts';
import { Divider, Note, SectionTitle } from '../components/Basics.tsx';
import { Button, CompactButton } from '../components/Button.tsx';
import { ChoiceCard, RadioRow, Segments, SwitchRow } from '../components/Choices.tsx';
import { Icon } from '../components/Icon.tsx';
import { Screen } from '../components/Screen.tsx';
import { VoiceRecorder } from '../components/VoiceRecorder.tsx';
import { canCheckVoices, deleteMyVoice, loadMyVoice } from '../engines/voices.ts';
import { normalizeServerUrl } from '../server-url.ts';
import { RADIUS, themedStyles, type } from '../theme.ts';
import { EngineCards, OutputCards, SERVER_MISSING, ServerFields, useBackButton } from './parts.tsx';
import type { Update } from './parts.tsx';

const PRIVACY: Readonly<Record<AppSettings['engine'], string>> = {
  local: 'What you say stays on this phone. Alo keeps no recordings or transcripts.',
  keys: 'Your voice goes to Deepgram and the text to DeepInfra, with your keys. Alo keeps no recordings or transcripts.',
  server: 'What you say goes to the computer running Alo. Alo keeps no recordings or transcripts.',
};

const MICROPHONES = [
  { value: 'auto', top: 'Automatic' },
  { value: 'phone', top: 'Phone' },
  { value: 'earphones', top: 'Earphones' },
] as const satisfies readonly { value: MicChoice; top: string }[];

interface SettingsScreenProps {
  settings: AppSettings;
  onChange: Update;
  onDone(): void;
  onKeys(): void;
  /** Opened because a conversation needs the computer's address: says so at once. */
  check?: boolean;
}

export function SettingsScreen({ settings, onChange, onDone, onKeys, check = false }: SettingsScreenProps) {
  const { styles, palette } = useStyles();
  const [serverError, setServerError] = useState(() =>
    check && !normalizeServerUrl(settings.server) ? SERVER_MISSING : undefined,
  );
  const [myVoice, setMyVoice] = useState(() => loadMyVoice() !== undefined);
  const [recording, setRecording] = useState(false);
  const [more, setMore] = useState(false);

  useBackButton(() => {
    onDone();
    return true;
  });

  const { engine } = settings;
  // The phone's own speech recognition says nothing about loudness or voices.
  const filters = engine !== 'local';
  const voices = engine === 'keys' && canCheckVoices();
  const keysSaved = settings.deepgramKey.trim() !== '' && settings.deepinfraKey.trim() !== '';

  const setOnlyOurVoices = (on: boolean) => {
    if (!on) onChange({ onlyOurVoices: false });
    else if (myVoice) onChange({ onlyOurVoices: true });
    else setRecording(true);
  };
  const deleteVoice = () => {
    setMyVoice(false);
    onChange({ onlyOurVoices: false });
    deleteMyVoice().catch(() => {});
  };

  return (
    <>
      <Screen gap={28}>
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Settings
          </Text>
          <CompactButton label="Done" icon="check" onPress={onDone} />
        </View>

        <View style={styles.section}>
          <SectionTitle>How Alo translates</SectionTitle>
          <EngineCards settings={settings} onChange={onChange} />
          {engine === 'keys' && (
            <View style={styles.box}>
              <View style={styles.boxHead}>
                <Icon name={keysSaved ? 'circle-check' : 'circle-alert'} size={26} color={keysSaved ? palette.live : palette.busy} />
                <Text style={styles.boxTitle}>{keysSaved ? 'Account keys: saved' : 'Account keys: not entered yet'}</Text>
              </View>
              <Button label={keysSaved ? 'Change keys' : 'Enter keys'} icon="key-round" onPress={onKeys} />
            </View>
          )}
          {engine === 'server' && (
            <ServerFields
              settings={settings}
              onChange={onChange}
              addressLabel="The computer’s address"
              error={serverError}
              onEdit={() => setServerError(undefined)}
            />
          )}
        </View>
        <Divider />

        <View style={styles.section}>
          <SectionTitle>Talking</SectionTitle>
          <View style={styles.cards} accessibilityRole="radiogroup">
            <ChoiceCard
              icon="mic"
              title="Talk freely"
              description="The microphone stays on. Best in quiet places."
              selected={settings.talkMode === 'handsfree'}
              onPress={() => onChange({ talkMode: 'handsfree' })}
            />
            <ChoiceCard
              icon="hand"
              title="Press and hold to talk"
              description="Best in noisy places."
              selected={settings.talkMode === 'hold'}
              onPress={() => onChange({ talkMode: 'hold' })}
            />
          </View>
        </View>
        <Divider />

        <View style={styles.section}>
          <SectionTitle>Hearing translations</SectionTitle>
          <OutputCards settings={settings} onChange={onChange} />
        </View>
        <Divider />

        <View style={styles.section}>
          <SectionTitle hint="For conversations on one phone.">Noisy places</SectionTitle>
          <SwitchRow
            title="Ignore far-away voices"
            description="Skips speech much quieter than you two, like other tables, a TV or a radio."
            value={settings.nearbyOnly}
            disabled={!filters}
            onChange={(nearbyOnly) => onChange({ nearbyOnly })}
          />
          <SwitchRow
            title="Only our two voices"
            description="Translates only you and the person you talk with. Needs Online, best quality."
            value={voices && myVoice && settings.onlyOurVoices}
            disabled={!voices}
            onChange={setOnlyOurVoices}
          />
          {voices && myVoice && (
            <View style={styles.voiceBox}>
              <View style={styles.boxHead}>
                <Icon name="circle-check" size={26} color={palette.live} />
                <Text style={[styles.boxTitle, { color: palette.live }]}>Your voice is saved on this phone</Text>
              </View>
              <View style={styles.voiceButtons}>
                <CompactButton label="Record again" icon="mic" onPress={() => setRecording(true)} style={styles.voiceButton} />
                <CompactButton
                  kind="delete"
                  label="Delete"
                  icon="trash-2"
                  accessibilityLabel="Delete your saved voice"
                  onPress={deleteVoice}
                  style={styles.voiceButton}
                />
              </View>
            </View>
          )}
          {filters ? (
            <Note icon="info" tone="muted">
              Anything skipped by mistake can still be translated: tap Translate on it.
            </Note>
          ) : (
            <View style={styles.why}>
              <Icon name="info" size={22} color={palette.idle} />
              <Text style={styles.whyText}>
                Not available with On this phone. Press and hold to talk works best in noisy places.
              </Text>
            </View>
          )}
        </View>
        <Divider />

        <View style={styles.section}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: more }}
            onPress={() => setMore((open) => !open)}
            style={({ pressed }) => [styles.more, pressed && styles.pressed]}
          >
            <Text style={styles.moreTitle}>More options</Text>
            <Text style={styles.moreState}>{more ? 'Hide' : 'Show'}</Text>
            <Icon name={more ? 'chevron-up' : 'chevron-down'} size={26} color={palette.text} />
          </Pressable>
          {more && (
            <View style={styles.moreContent}>
              <View style={styles.field}>
                <Segments<MicChoice>
                  label="Microphone"
                  options={MICROPHONES}
                  value={settings.mic}
                  onChange={(mic) => onChange({ mic })}
                />
                <Text style={styles.hint}>With one phone, the phone’s own microphone usually works best.</Text>
              </View>
              {engine !== 'local' && (
                <View style={styles.field} accessibilityRole="radiogroup" accessibilityLabel="Voice">
                  <Text style={styles.label}>Voice</Text>
                  <RadioRow
                    label="Natural voice"
                    selected={settings.voice === 'natural'}
                    onPress={() => onChange({ voice: 'natural' })}
                  />
                  <RadioRow
                    label="The phone’s own voice"
                    selected={settings.voice === 'phone'}
                    onPress={() => onChange({ voice: 'phone' })}
                  />
                </View>
              )}
            </View>
          )}
        </View>

        <View style={styles.privacy}>
          <Icon name="lock" size={24} color={palette.accent} />
          <Text style={styles.privacyText}>{PRIVACY[engine]}</Text>
        </View>
        <Button kind="primary" label="Done" icon="check" onPress={onDone} />
      </Screen>
      {recording && (
        <VoiceRecorder
          earphoneMic={wantsEarphoneMic({ ...settings, mode: 'solo' })}
          onDone={() => {
            setRecording(false);
            setMyVoice(true);
            onChange({ onlyOurVoices: true });
          }}
          onClose={() => setRecording(false)}
        />
      )}
    </>
  );
}

const useStyles = themedStyles((palette) => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: {
    ...type.title,
    flexShrink: 1,
    color: palette.text,
  },
  section: {
    gap: 16,
  },
  cards: {
    gap: 14,
  },
  box: {
    gap: 12,
    padding: 16,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: 16,
    backgroundColor: palette.surface,
  },
  boxHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  boxTitle: {
    ...type.bodyBold,
    flex: 1,
    color: palette.text,
  },
  voiceBox: {
    gap: 14,
    padding: 16,
    borderRadius: 16,
    backgroundColor: palette.liveSoft,
  },
  voiceButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  voiceButton: {
    flex: 1,
  },
  why: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 14,
    borderRadius: 14,
    backgroundColor: palette.idleSoft,
  },
  whyText: {
    ...type.secondary,
    flex: 1,
    color: palette.text,
  },
  more: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingRight: 16,
    paddingLeft: 20,
    borderWidth: 2,
    borderColor: palette.borderStrong,
    borderRadius: RADIUS,
    backgroundColor: palette.surface,
  },
  pressed: {
    opacity: 0.75,
  },
  moreTitle: {
    ...type.button,
    flex: 1,
    color: palette.text,
  },
  moreState: {
    ...type.secondaryBold,
    color: palette.muted,
  },
  moreContent: {
    gap: 24,
  },
  field: {
    gap: 10,
  },
  label: {
    ...type.bodyBold,
    color: palette.text,
  },
  hint: {
    ...type.secondary,
    color: palette.muted,
  },
  privacy: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  privacyText: {
    ...type.secondary,
    flex: 1,
    color: palette.text,
  },
}));
