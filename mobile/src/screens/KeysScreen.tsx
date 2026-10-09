// The user's own Deepgram and DeepInfra keys, for "Online, best quality". They are saved
// as they are typed or pasted, encrypted, and only on this phone.

import * as Clipboard from 'expo-clipboard';
import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Text, View } from 'react-native';
import type { TextInput } from 'react-native';

import { MAX_KEY_LENGTH } from '../app-settings.ts';
import type { AppSettings } from '../app-settings.ts';
import { Button, CompactButton } from '../components/Button.tsx';
import { TextField } from '../components/Field.tsx';
import { Icon } from '../components/Icon.tsx';
import { Screen, WizardHeader } from '../components/Screen.tsx';
import { themedStyles, type } from '../theme.ts';
import { useBackButton } from './parts.tsx';
import type { Update } from './parts.tsx';

type KeyName = 'deepgramKey' | 'deepinfraKey';

const MISSING: Readonly<Record<KeyName, string>> = {
  deepgramKey: 'Enter your Deepgram key.',
  deepinfraKey: 'Enter your DeepInfra key.',
};

interface KeysScreenProps {
  settings: AppSettings;
  onChange: Update;
  onBack(): void;
  onDone(): void;
  /** Part of the first-time setup: both keys are needed to go on. */
  wizard?: boolean;
  /** Opened because a conversation needs keys: says at once which one is missing. */
  check?: boolean;
}

export function KeysScreen({ settings, onChange, onBack, onDone, wizard = false, check = false }: KeysScreenProps) {
  const { styles, palette } = useStyles();
  const [errors, setErrors] = useState<Partial<Record<KeyName, string>>>(() =>
    check ? missingKeys(settings) : {},
  );
  const deepgramInput = useRef<TextInput>(null);
  const deepinfraInput = useRef<TextInput>(null);

  useBackButton(() => {
    onBack();
    return true;
  });

  const save = () => {
    if (wizard || check) {
      const missing = missingKeys(settings);
      setErrors(missing);
      if (missing.deepgramKey) {
        deepgramInput.current?.focus();
        return;
      }
      if (missing.deepinfraKey) {
        deepinfraInput.current?.focus();
        return;
      }
    }
    onDone();
  };

  const change = (name: KeyName, value: string) => {
    setErrors((current) => ({ ...current, [name]: undefined }));
    onChange({ [name]: value });
  };
  const pasteFailed = (name: KeyName, message: string) => setErrors((current) => ({ ...current, [name]: message }));

  return (
    <Screen>
      {wizard ? (
        <WizardHeader step={3} onBack={onBack} />
      ) : (
        <View style={styles.back}>
          <CompactButton label="Back" icon="chevron-left" onPress={onBack} />
        </View>
      )}
      <View style={styles.intro}>
        <Text style={styles.title} accessibilityRole="header">
          Online accounts
        </Text>
        <Text style={styles.text}>
          Online translation uses two services. Each gives you a key: a long code that lets Alo use your account.
        </Text>
      </View>
      <KeyField
        name="deepgramKey"
        label="Speech service key (Deepgram)"
        value={settings.deepgramKey}
        error={errors.deepgramKey}
        inputRef={deepgramInput}
        onChange={(value) => change('deepgramKey', value)}
        onPasteFailed={(message) => pasteFailed('deepgramKey', message)}
        onSubmit={() => deepinfraInput.current?.focus()}
      />
      <KeyField
        name="deepinfraKey"
        label="Translation service key (DeepInfra)"
        value={settings.deepinfraKey}
        error={errors.deepinfraKey}
        inputRef={deepinfraInput}
        onChange={(value) => change('deepinfraKey', value)}
        onPasteFailed={(message) => pasteFailed('deepinfraKey', message)}
      />
      <View style={styles.help}>
        <View style={styles.helpRow}>
          <Icon name="info" size={22} color={palette.accent} />
          <Text style={styles.helpText}>
            Create them at console.deepgram.com and deepinfra.com. Each bills you for what you use.
          </Text>
        </View>
        <View style={styles.helpRow}>
          <Icon name="lock" size={22} color={palette.accent} />
          <Text style={styles.helpText}>Stored encrypted, only on this phone, and sent only to those two services.</Text>
        </View>
      </View>
      <Button kind="primary" label="Save" icon="check" onPress={save} />
    </Screen>
  );
}

function missingKeys(settings: AppSettings): Partial<Record<KeyName, string>> {
  const missing: Partial<Record<KeyName, string>> = {};
  if (!settings.deepgramKey.trim()) missing.deepgramKey = MISSING.deepgramKey;
  if (!settings.deepinfraKey.trim()) missing.deepinfraKey = MISSING.deepinfraKey;
  return missing;
}

interface KeyFieldProps {
  name: KeyName;
  label: string;
  value: string;
  error: string | undefined;
  inputRef: RefObject<TextInput | null>;
  onChange(value: string): void;
  onPasteFailed(message: string): void;
  onSubmit?: (() => void) | undefined;
}

/** A key, hidden unless asked, with buttons to show it and to paste it. */
function KeyField({ name, label, value, error, inputRef, onChange, onPasteFailed, onSubmit }: KeyFieldProps) {
  const { styles } = useStyles();
  const [shown, setShown] = useState(false);
  const paste = () => {
    Clipboard.getStringAsync().then(
      (text) => {
        const key = text.trim().slice(0, MAX_KEY_LENGTH);
        if (key) onChange(key);
        else onPasteFailed('Nothing to paste. Copy the key first, then tap Paste.');
      },
      () => onPasteFailed('Couldn’t paste. Type the key instead.'),
    );
  };
  return (
    <TextField
      ref={inputRef}
      label={label}
      large
      icon="key-round"
      error={error}
      value={value}
      onChangeText={onChange}
      placeholder="Not entered yet"
      secureTextEntry={!shown}
      maxLength={MAX_KEY_LENGTH}
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="off"
      importantForAutofill="no"
      spellCheck={false}
      returnKeyType={onSubmit ? 'next' : 'done'}
      submitBehavior={onSubmit ? 'submit' : 'blurAndSubmit'}
      onSubmitEditing={onSubmit}
    >
      <View style={styles.keyButtons}>
        <CompactButton
          label={shown ? 'Hide' : 'Show'}
          icon={shown ? 'eye-off' : 'eye'}
          accessibilityLabel={`${shown ? 'Hide' : 'Show'} the ${name === 'deepgramKey' ? 'Deepgram' : 'DeepInfra'} key`}
          onPress={() => setShown((value) => !value)}
          style={styles.keyButton}
        />
        <CompactButton
          label="Paste"
          icon="clipboard-paste"
          accessibilityLabel={`Paste the ${name === 'deepgramKey' ? 'Deepgram' : 'DeepInfra'} key`}
          onPress={paste}
          style={styles.keyButton}
        />
      </View>
    </TextField>
  );
}

const useStyles = themedStyles((palette) => ({
  back: {
    flexDirection: 'row',
  },
  intro: {
    gap: 10,
  },
  title: {
    ...type.title,
    color: palette.text,
  },
  text: {
    ...type.body,
    color: palette.text,
  },
  keyButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  keyButton: {
    flex: 1,
  },
  help: {
    gap: 12,
    padding: 16,
    borderRadius: 16,
    backgroundColor: palette.surface2,
  },
  helpRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  helpText: {
    ...type.secondary,
    flex: 1,
    color: palette.text,
  },
}));
