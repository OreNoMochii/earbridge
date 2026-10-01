// The start screen: the mode, the languages, how to talk and listen, and the server.
// A port of the web app's client/src/setup-view.ts.

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { canAutoDetect, languageName, sameLanguage } from '../../../shared/languages.ts';
import type { Mode } from '../../../shared/protocol.ts';
import { formatRoomCode, normalizeRoomCode } from '../../../shared/room-code.ts';
import { MAX_NAME_LENGTH } from '../../../client/src/settings.ts';
import type { Output, TalkMode, Voice } from '../../../client/src/settings.ts';
import type { AppSettings, MicChoice } from '../app-settings.ts';
import { Button } from '../components/Button.tsx';
import { LanguageList } from '../components/LanguageList.tsx';
import { Segmented } from '../components/Segmented.tsx';
import type { EndReason } from '../connection.ts';
import { languageLabel } from '../language-names.ts';
import { normalizeServerUrl, serverLabel } from '../server-url.ts';
import { RADIUS, themedStyles } from '../theme.ts';

const ICON = require('../../assets/icon.png') as number;

interface SetupScreenProps {
  settings: AppSettings;
  /** A room to join: from an invite link, or the room the last conversation was in. */
  invitedRoom: string | undefined;
  /** Why the last conversation ended, if it did not end normally. */
  error: EndReason | undefined;
  onChange(settings: AppSettings): void;
  /** `server` is the server's address; `room` the room to join (room mode), or undefined. */
  onStart(settings: AppSettings, server: string, room: string | undefined): void;
  /** The user chose to start a new room instead of joining `invitedRoom`. */
  onForgetInvite(): void;
}

type Picking = 'myLang' | 'theirLang';

export function SetupScreen({ settings, invitedRoom, error, onChange, onStart, onForgetInvite }: SetupScreenProps) {
  const { styles, palette } = useStyles();
  const insets = useSafeAreaInsets();
  const [roomCode, setRoomCode] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [codeError, setCodeError] = useState<string>();
  const [serverError, setServerError] = useState<string>();
  const [advancedOpen, setAdvancedOpen] = useState(
    () => !settings.server.trim() || error?.code === 'unauthorized' || error?.code === 'unreachable',
  );
  const [picking, setPicking] = useState<Picking>();
  const nameInput = useRef<TextInput>(null);
  const codeInput = useRef<TextInput>(null);
  const serverInput = useRef<TextInput>(null);

  const solo = settings.mode === 'solo';
  const update = (patch: Partial<AppSettings>) => onChange({ ...settings, ...patch });
  // Choosing a language already taken by the other side swaps the two, so the pair
  // always stays valid (the mode can change later).
  const setMyLang = (code: string) =>
    update({ myLang: code, theirLang: sameLanguage(code, settings.theirLang) ? settings.myLang : settings.theirLang });
  const setTheirLang = (code: string) =>
    update({ theirLang: code, myLang: sameLanguage(code, settings.myLang) ? settings.theirLang : settings.myLang });

  const start = () => {
    let room: string | undefined;
    const name = settings.name.trim();
    if (!solo) {
      if (!name) {
        setNameError('Enter your name, so the others know who is talking.');
        nameInput.current?.focus();
        return;
      }
      room = invitedRoom;
      if (!room && roomCode.trim()) {
        room = normalizeRoomCode(roomCode);
        if (!room) {
          setCodeError('Room codes have 6 letters and numbers, like ABC 234.');
          codeInput.current?.focus();
          return;
        }
      }
    }
    const server = normalizeServerUrl(settings.server);
    if (!server) {
      setServerError('Enter the address of your EarBridge server, like 192.168.1.20:8787.');
      setAdvancedOpen(true);
      // After the section has opened.
      setTimeout(() => serverInput.current?.focus(), 50);
      return;
    }
    onStart(solo ? settings : { ...settings, name }, server, room);
  };

  let soloHint: string;
  if (settings.talkMode === 'hold') soloHint = 'Hold your button while you speak, and theirs while they speak.';
  else if (canAutoDetect(settings.myLang, settings.theirLang)) soloHint = 'Who is speaking is detected automatically.';
  else soloHint = 'Tap Me or Them to show who is speaking: automatic detection isn’t available for this language pair.';

  const talkHint =
    settings.talkMode === 'hold'
      ? 'The microphone is on only while you hold the button. Best in noisy places.'
      : 'The microphone stays on. Best in quiet places.';

  let outputHint: string;
  if (solo) {
    outputHint =
      settings.output === 'speaker'
        ? 'Both translations are read aloud by the phone, so the other person hears theirs too. The microphone pauses while it speaks.'
        : 'You hear their words in your earphones; they read yours on the screen.';
  } else {
    outputHint =
      settings.output === 'speaker'
        ? 'The phone reads translations aloud and pauses the microphone meanwhile. Only if the others are not in the same room.'
        : 'You hear the others in your language.';
  }

  const invitedServer = normalizeServerUrl(settings.server);
  const startLabel = solo ? 'Start' : invitedRoom || roomCode.trim() ? 'Join room' : 'Start a room';

  return (
    <View style={styles.screen}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.content,
            {
              paddingTop: insets.top + 16,
              paddingBottom: insets.bottom + 24,
              paddingLeft: insets.left + 16,
              paddingRight: insets.right + 16,
            },
          ]}
        >
          <View style={styles.column}>
            <View style={styles.brand}>
              <Image source={ICON} style={styles.brandIcon} accessibilityIgnoresInvertColors />
              <View>
                <Text style={styles.brandName} accessibilityRole="header">
                  EarBridge
                </Text>
                <Text style={styles.brandTagline}>Live translation for any earphones</Text>
              </View>
            </View>

            {error && (
              <View style={styles.errorBox} accessibilityRole="alert" accessibilityLiveRegion="assertive">
                <Text style={styles.errorText}>{error.message}</Text>
              </View>
            )}

            <Segmented<Mode>
              look="tabs"
              accessibilityLabel="Mode"
              options={[
                { value: 'solo', label: 'One phone', detail: 'Two people, one phone' },
                { value: 'room', label: 'Room', detail: 'Everyone uses their own phone' },
              ]}
              value={settings.mode}
              onChange={(mode) => update({ mode })}
            />

            {solo ? (
              <Card label="Languages">
                <LanguageField label="I speak" value={settings.myLang} onPress={() => setPicking('myLang')} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Swap languages"
                  onPress={() => update({ myLang: settings.theirLang, theirLang: settings.myLang })}
                  style={({ pressed }) => [styles.swap, pressed && styles.pressed]}
                  hitSlop={8}
                >
                  <Text style={styles.swapText}>⇅</Text>
                </Pressable>
                <LanguageField
                  label="The other person speaks"
                  value={settings.theirLang}
                  onPress={() => setPicking('theirLang')}
                />
                <Text style={styles.hint}>{soloHint}</Text>
              </Card>
            ) : (
              <Card label="Room">
                {invitedRoom && (
                  <View style={styles.invite}>
                    <Text style={styles.inviteText}>
                      You’re joining room <Text style={styles.strong}>{formatRoomCode(invitedRoom)}</Text>
                      {invitedServer ? ` on ${serverLabel(invitedServer)}` : ''}.
                    </Text>
                    <Button
                      small
                      kind="ghost"
                      label="Start a new room instead"
                      onPress={onForgetInvite}
                      style={styles.inviteButton}
                    />
                  </View>
                )}
                <Field label="Your name" error={nameError}>
                  <TextInput
                    ref={nameInput}
                    value={settings.name}
                    onChangeText={(name) => {
                      setNameError(undefined);
                      update({ name });
                    }}
                    maxLength={MAX_NAME_LENGTH}
                    placeholder="Shown to the others"
                    placeholderTextColor={palette.muted}
                    autoComplete="nickname"
                    autoCapitalize="words"
                    returnKeyType="done"
                    accessibilityLabel="Your name"
                    style={[styles.input, nameError !== undefined && styles.inputInvalid]}
                  />
                </Field>
                <LanguageField label="I speak" value={settings.myLang} onPress={() => setPicking('myLang')} />
                {!invitedRoom && (
                  <Field label="Room code" error={codeError}>
                    <TextInput
                      ref={codeInput}
                      value={roomCode}
                      onChangeText={(text) => {
                        setCodeError(undefined);
                        setRoomCode(text);
                      }}
                      maxLength={9}
                      placeholder="Leave empty to start a new room"
                      placeholderTextColor={palette.muted}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      autoComplete="off"
                      spellCheck={false}
                      returnKeyType="go"
                      onSubmitEditing={start}
                      accessibilityLabel="Room code"
                      style={[styles.input, codeError !== undefined && styles.inputInvalid]}
                    />
                  </Field>
                )}
              </Card>
            )}

            <Card label="Talking" title="Talking">
              <Segmented<TalkMode>
                look="choices"
                accessibilityLabel="Talking"
                options={[
                  { value: 'handsfree', label: 'Hands-free' },
                  { value: 'hold', label: 'Hold to talk' },
                ]}
                value={settings.talkMode}
                onChange={(talkMode) => update({ talkMode })}
              />
              <Text style={styles.hint}>{talkHint}</Text>
            </Card>

            <Card label="Translations play" title="Translations play">
              <Segmented<Output>
                look="choices"
                accessibilityLabel="Translations play"
                options={[
                  { value: 'earphones', label: 'In my earphones' },
                  { value: 'speaker', label: 'On the phone speaker' },
                ]}
                value={settings.output}
                onChange={(output) => update({ output })}
              />
              <Text style={styles.hint}>{outputHint}</Text>
            </Card>

            <View style={styles.card}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: advancedOpen }}
                onPress={() => setAdvancedOpen((open) => !open)}
                style={({ pressed }) => [styles.advancedHeader, pressed && styles.pressed]}
              >
                <Text style={styles.cardTitle}>Advanced</Text>
                <Text style={styles.chevron}>{advancedOpen ? '▴' : '▾'}</Text>
              </Pressable>
              {advancedOpen && (
                <>
                  <Field label="Server" error={serverError}>
                    <TextInput
                      ref={serverInput}
                      value={settings.server}
                      onChangeText={(server) => {
                        setServerError(undefined);
                        update({ server });
                      }}
                      maxLength={500}
                      placeholder="192.168.1.20:8787"
                      placeholderTextColor={palette.muted}
                      keyboardType="url"
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      spellCheck={false}
                      returnKeyType="done"
                      accessibilityLabel="Server"
                      style={[styles.input, serverError !== undefined && styles.inputInvalid]}
                    />
                  </Field>
                  <Text style={styles.hint}>
                    The computer running EarBridge prints its address when it starts. Same Wi-Fi as this phone, or
                    an https address.
                  </Text>

                  <Text style={styles.label}>Microphone</Text>
                  <Segmented<MicChoice>
                    look="choices"
                    accessibilityLabel="Microphone"
                    options={[
                      { value: 'auto', label: 'Automatic' },
                      { value: 'phone', label: 'Phone' },
                      { value: 'earphones', label: 'Earphones' },
                    ]}
                    value={settings.mic}
                    onChange={(mic) => update({ mic })}
                  />
                  <Text style={styles.hint}>
                    With one phone, the phone’s own microphone usually works best: it hears you both, and Bluetooth
                    earphones keep their full sound quality. In a room, use the earphones’ microphone.
                  </Text>

                  <Text style={styles.label}>Voice</Text>
                  <Segmented<Voice>
                    look="choices"
                    accessibilityLabel="Voice"
                    options={[
                      { value: 'natural', label: 'Natural voice' },
                      { value: 'phone', label: 'The phone’s own voice' },
                    ]}
                    value={settings.voice}
                    onChange={(voice) => update({ voice })}
                  />
                  <Text style={styles.hint}>
                    The natural voice sounds more human and takes a moment longer. Languages it doesn’t speak are read
                    by the phone’s own voice.
                  </Text>

                  <Field label="Access code">
                    <TextInput
                      value={settings.token}
                      onChangeText={(token) => update({ token })}
                      secureTextEntry
                      autoFocus={error?.code === 'unauthorized'}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      returnKeyType="done"
                      accessibilityLabel="Access code"
                      style={styles.input}
                    />
                  </Field>
                  <Text style={styles.hint}>Only if the person running this server gave you one.</Text>
                </>
              )}
            </View>

            <Button kind="primary" label={startLabel} onPress={start} style={styles.start} />

            <Text style={styles.privacy}>
              Your voice goes through your EarBridge server to Deepgram for speech recognition. The text goes to
              DeepInfra for translation and natural voices (a server can be set up to translate with Anthropic’s
              Claude instead). This app keeps no recordings or transcripts.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {picking && (
        <LanguageList
          title={picking === 'myLang' ? 'I speak' : 'The other person speaks'}
          value={settings[picking]}
          onSelect={(code) => {
            if (picking === 'myLang') setMyLang(code);
            else setTheirLang(code);
            setPicking(undefined);
          }}
          onClose={() => setPicking(undefined)}
        />
      )}
    </View>
  );
}

function Card({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  const { styles } = useStyles();
  return (
    <View style={styles.card} accessibilityLabel={title ? undefined : label}>
      {title !== undefined && (
        <Text style={styles.cardTitle} accessibilityRole="header">
          {title}
        </Text>
      )}
      {children}
    </View>
  );
}

function Field({ label, error, children }: { label: string; error?: string | undefined; children: ReactNode }) {
  const { styles } = useStyles();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {error !== undefined && (
        <Text style={styles.fieldError} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
    </View>
  );
}

/** Looks like a text field; opens the list of languages. */
function LanguageField({ label, value, onPress }: { label: string; value: string; onPress(): void }) {
  const { styles } = useStyles();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${languageName(value)}`}
        accessibilityHint="Opens the list of languages"
        onPress={onPress}
        style={({ pressed }) => [styles.input, styles.select, pressed && styles.pressed]}
      >
        <Text style={styles.selectText} numberOfLines={1}>
          {languageLabel(value)}
        </Text>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  screen: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  content: {
    flexGrow: 1,
    alignItems: 'center',
  },
  column: {
    width: '100%',
    maxWidth: 544,
    gap: 14,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 4,
  },
  brandIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
  },
  brandName: {
    color: palette.text,
    fontSize: 26,
    fontWeight: '800',
  },
  brandTagline: {
    color: palette.muted,
    fontSize: 15,
  },
  errorBox: {
    padding: 14,
    borderWidth: 1,
    borderColor: palette.danger,
    borderRadius: 12,
    backgroundColor: palette.dangerSoft,
  },
  errorText: {
    color: palette.danger,
    fontSize: 15,
    lineHeight: 21,
  },
  card: {
    gap: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: RADIUS,
    backgroundColor: palette.surface,
  },
  cardTitle: {
    color: palette.text,
    fontSize: 16,
    fontWeight: '700',
  },
  field: {
    gap: 6,
  },
  label: {
    color: palette.text,
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    minHeight: 48,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: 12,
    backgroundColor: palette.inputBg,
    color: palette.text,
    fontSize: 16,
  },
  inputInvalid: {
    borderColor: palette.danger,
  },
  select: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  selectText: {
    flexShrink: 1,
    color: palette.text,
    fontSize: 16,
  },
  chevron: {
    color: palette.muted,
    fontSize: 16,
  },
  fieldError: {
    color: palette.danger,
    fontSize: 14,
  },
  hint: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  swap: {
    alignSelf: 'center',
    width: 40,
    height: 40,
    marginVertical: -4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.borderStrong,
    borderRadius: 20,
    backgroundColor: palette.surface,
  },
  swapText: {
    color: palette.accent,
    fontSize: 20,
    fontWeight: '700',
  },
  invite: {
    gap: 4,
    padding: 12,
    borderRadius: 12,
    backgroundColor: palette.accentSoft,
  },
  inviteText: {
    color: palette.text,
    fontSize: 15,
    lineHeight: 21,
  },
  inviteButton: {
    alignSelf: 'flex-start',
    marginLeft: -12,
  },
  strong: {
    fontWeight: '700',
  },
  advancedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 32,
  },
  pressed: {
    opacity: 0.7,
  },
  start: {
    minHeight: 52,
  },
  privacy: {
    color: palette.muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
}));
