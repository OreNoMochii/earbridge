// A group conversation: everyone on their own phone, through a computer running Alo.
// Start a new group, join one by its code, or join the one an invite opened.

import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Platform, Text, TextInput, View } from 'react-native';

import { formatRoomCode, normalizeRoomCode, ROOM_CODE_LENGTH } from '../../../shared/room-code.ts';
import { MAX_NAME_LENGTH } from '../../../client/src/settings.ts';
import type { AppSettings } from '../app-settings.ts';
import { Button, CompactButton } from '../components/Button.tsx';
import { ErrorText, SectionTitle } from '../components/Basics.tsx';
import { SelectField, TextField } from '../components/Field.tsx';
import { Icon } from '../components/Icon.tsx';
import { LanguageList } from '../components/LanguageList.tsx';
import { Screen, useKeepInView } from '../components/Screen.tsx';
import type { EndReason } from '../connection.ts';
import { nativeLabel } from '../language-names.ts';
import { normalizeServerUrl, serverLabel } from '../server-url.ts';
import { themedStyles, type } from '../theme.ts';
import { EndBanner, myLangPatch, SERVER_MISSING, ServerFields, useBackButton } from './parts.tsx';
import type { Update } from './parts.tsx';

const NAME_MISSING = 'Enter your name, so the others know who is talking.';
const CODE_WRONG = 'Group codes have 6 letters and numbers, like ABC 234.';

interface GroupScreenProps {
  settings: AppSettings;
  onChange: Update;
  /** The group an invite opened, or the one to go back into after a problem. */
  invitedRoom: string | undefined;
  /** Why the last conversation stopped. */
  error: EndReason | undefined;
  onForgetInvite(): void;
  onStart(settings: AppSettings, server: string, room: string | undefined): void;
  onBack(): void;
}

export function GroupScreen({ settings, onChange, invitedRoom, error, onForgetInvite, onStart, onBack }: GroupScreenProps) {
  const { styles, palette } = useStyles();
  const [code, setCode] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [codeError, setCodeError] = useState<string>();
  const [serverError, setServerError] = useState<string>();
  const [picking, setPicking] = useState(false);
  const nameInput = useRef<TextInput>(null);
  const codeInput = useRef<TextInput>(null);
  const joinPart = useRef<View>(null);
  const serverInput = useRef<TextInput>(null);
  const tokenInput = useRef<TextInput>(null);

  useBackButton(() => {
    onBack();
    return true;
  });

  /** Starts a new group when `room` is undefined. */
  const go = (room: string | undefined) => {
    const name = settings.name.trim();
    if (!name) {
      setNameError(NAME_MISSING);
      nameInput.current?.focus();
      return;
    }
    const server = normalizeServerUrl(settings.server);
    if (!server) {
      setServerError(SERVER_MISSING);
      serverInput.current?.focus();
      return;
    }
    onStart({ ...settings, mode: 'room', name }, server, room);
  };

  const join = () => {
    const room = normalizeRoomCode(code);
    if (!room) {
      setCodeError(CODE_WRONG);
      codeInput.current?.focus();
      return;
    }
    go(room);
  };

  const invitedServer = normalizeServerUrl(settings.server);

  return (
    <>
      <Screen>
        <View style={styles.back}>
          <CompactButton label="Back" icon="chevron-left" onPress={onBack} />
        </View>
        <View style={styles.intro}>
          <Text style={styles.title} accessibilityRole="header">
            Group conversation
          </Text>
          <Text style={styles.text}>
            Everyone uses their own phone and earphones, and hears the others in their own language.
          </Text>
        </View>
        {error !== undefined && (
          <EndBanner reason={error} onRetry={() => go(invitedRoom)} onAccessCode={() => tokenInput.current?.focus()} />
        )}
        {invitedRoom !== undefined && (
          <View style={styles.invited}>
            <View style={styles.invitedHead}>
              <Icon name="link" size={24} color={palette.accent} />
              <Text style={styles.invitedText}>
                You’re joining group {formatRoomCode(invitedRoom)}
                {invitedServer ? ` on ${serverLabel(invitedServer)}` : ''}
              </Text>
            </View>
            <CompactButton
              label="Start a new group instead"
              icon="users"
              onPress={onForgetInvite}
              style={styles.invitedAction}
            />
          </View>
        )}

        <View style={styles.aboutYou}>
          <TextField
            ref={nameInput}
            label="Your name, shown to the others"
            error={nameError}
            value={settings.name}
            onChangeText={(name) => {
              setNameError(undefined);
              onChange({ name });
            }}
            maxLength={MAX_NAME_LENGTH}
            autoCapitalize="words"
            autoComplete="nickname"
            returnKeyType="done"
          />
          <SelectField label="You speak" value={nativeLabel(settings.myLang)} onPress={() => setPicking(true)} />
        </View>
        {invitedRoom !== undefined ? (
          <Button kind="primary" label="Join group" icon="log-in" onPress={() => go(invitedRoom)} />
        ) : (
          <>
            <Button kind="primary" label="Start a new group" icon="users" onPress={() => go(undefined)} />
            <View style={styles.or} accessible={false}>
              <View style={styles.line} />
              <Text style={styles.orText}>or</Text>
              <View style={styles.line} />
            </View>
            <View ref={joinPart} style={styles.section}>
              <SectionTitle hint="Type the code you were given.">Join a group</SectionTitle>
              <CodeBoxes
                inputRef={codeInput}
                area={joinPart}
                value={code}
                error={codeError !== undefined}
                onChange={(value) => {
                  setCodeError(undefined);
                  setCode(value);
                }}
                onSubmit={join}
              />
              {codeError !== undefined && <ErrorText>{codeError}</ErrorText>}
              <Button label="Join" icon="log-in" onPress={join} />
            </View>
          </>
        )}

        <View style={styles.section}>
          <SectionTitle hint="Groups always need one. Ask the person who set it up.">The computer running Alo</SectionTitle>
          <ServerFields
            settings={settings}
            onChange={onChange}
            addressLabel="Address"
            error={serverError}
            onEdit={() => setServerError(undefined)}
            serverRef={serverInput}
            tokenRef={tokenInput}
            onAddressDone={() => tokenInput.current?.focus()}
          />
        </View>
      </Screen>
      {picking && (
        <LanguageList
          title="Which language do you speak?"
          value={settings.myLang}
          onSelect={(lang) => {
            onChange(myLangPatch(settings, lang));
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}

interface CodeBoxesProps {
  inputRef: RefObject<TextInput | null>;
  /** Kept above the keyboard while typing, e.g. with the Join button. */
  area: RefObject<View | null>;
  value: string;
  error: boolean;
  onChange(value: string): void;
  onSubmit(): void;
}

/** A box per letter of the group code, over one hidden field that takes the typing. */
function CodeBoxes({ inputRef, area, value, error, onChange, onSubmit }: CodeBoxesProps) {
  const { styles } = useStyles();
  const [focused, setFocused] = useState(false);
  const keepInView = useKeepInView();
  const chars = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
  return (
    <View style={styles.codeRow}>
      {Array.from({ length: ROOM_CODE_LENGTH }, (_, index) => (
        <View
          key={index}
          style={[
            styles.codeBox,
            index === 3 && styles.codeGap,
            focused && index === Math.min(chars.length, ROOM_CODE_LENGTH - 1) && styles.codeBoxActive,
            error && styles.codeBoxError,
          ]}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        >
          <Text style={styles.codeChar}>{chars[index] ?? ''}</Text>
        </View>
      ))}
      <TextInput
        ref={inputRef}
        value={chars}
        onChangeText={(text) => onChange(text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH))}
        onFocus={() => {
          setFocused(true);
          keepInView(area, true);
        }}
        onBlur={() => {
          setFocused(false);
          keepInView(area, false);
        }}
        onSubmitEditing={onSubmit}
        maxLength={9}
        autoCapitalize="characters"
        // Android's has the numbers on top and no suggestions.
        keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        caretHidden
        returnKeyType="go"
        submitBehavior="blurAndSubmit"
        accessibilityLabel="Group code"
        accessibilityHint="Six letters and numbers"
        style={styles.codeInput}
      />
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  back: {
    flexDirection: 'row',
  },
  intro: {
    gap: 8,
  },
  title: {
    ...type.title,
    color: palette.text,
  },
  text: {
    ...type.body,
    color: palette.text,
  },
  invited: {
    gap: 14,
    padding: 14,
    borderWidth: 2,
    borderColor: palette.accent,
    borderRadius: 16,
    backgroundColor: palette.accentSoft,
  },
  invitedHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  invitedText: {
    ...type.bodyBold,
    flex: 1,
    color: palette.text,
  },
  invitedAction: {
    alignSelf: 'flex-start',
  },
  aboutYou: {
    gap: 16,
  },
  or: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  line: {
    flex: 1,
    height: 2,
    backgroundColor: palette.border,
  },
  orText: {
    ...type.secondaryBold,
    color: palette.muted,
  },
  section: {
    gap: 12,
  },
  codeRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  codeBox: {
    flex: 1,
    maxWidth: 52,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: palette.borderStrong,
    borderRadius: 12,
    backgroundColor: palette.surface,
  },
  codeGap: {
    marginLeft: 16,
  },
  codeBoxActive: {
    borderWidth: 3,
    borderColor: palette.accent,
  },
  codeBoxError: {
    borderColor: palette.danger,
  },
  codeChar: {
    fontSize: 28,
    fontWeight: '700',
    color: palette.text,
  },
  codeInput: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    // Not 0: Android leaves fully transparent views out for screen readers.
    opacity: 0.01,
    color: 'transparent',
  },
}));
