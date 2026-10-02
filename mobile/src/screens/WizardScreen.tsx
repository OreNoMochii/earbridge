// The first-time setup, one question per step: my language, theirs, who translates (and
// the keys or the computer it needs), and where translations are heard.

import { getLocales } from 'expo-localization';
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { TextInput } from 'react-native';

import { matchLanguage } from '../../../client/src/settings.ts';
import type { AppSettings } from '../app-settings.ts';
import { Logo } from '../components/Basics.tsx';
import { Button } from '../components/Button.tsx';
import { LanguageList, LanguageRow, LanguageRows, LanguageSearch } from '../components/LanguageList.tsx';
import { Screen, WizardHeader } from '../components/Screen.tsx';
import { localSupport } from '../engines/local.ts';
import { normalizeServerUrl } from '../server-url.ts';
import { themedStyles, type } from '../theme.ts';
import { KeysScreen } from './KeysScreen.tsx';
import { EngineCards, myLangPatch, OutputCards, SERVER_MISSING, ServerFields, theirLangPatch, useBackButton } from './parts.tsx';
import type { Update } from './parts.tsx';

interface WizardScreenProps {
  settings: AppSettings;
  onChange: Update;
}

export function WizardScreen({ settings, onChange }: WizardScreenProps) {
  const { styles } = useStyles();
  const [step, setStep] = useState(1);
  const [keys, setKeys] = useState(false);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [serverError, setServerError] = useState<string>();
  const serverInput = useRef<TextInput>(null);
  const tokenInput = useRef<TextInput>(null);

  // Each step's Screen has a key of its own, so the next one starts at the top.
  const go = (next: number) => {
    setStep(next);
    setQuery('');
  };

  useBackButton(() => {
    if (step === 1) return false;
    go(step - 1);
    return true;
  });

  if (keys) {
    return (
      <KeysScreen
        settings={settings}
        onChange={onChange}
        wizard
        onBack={() => setKeys(false)}
        onDone={() => {
          setKeys(false);
          go(4);
        }}
      />
    );
  }

  if (step === 1) {
    const phoneLang = getLocales()
      .map((locale) => matchLanguage(locale.languageTag))
      .find((code) => code !== undefined);
    return (
      <>
        <Screen key={1} fixed>
          <View style={styles.part}>
            <WizardHeader step={1} />
            <View style={styles.welcome}>
              <Logo large />
              <Text style={styles.hello} accessible={false}>
                Hello · Hola · Bonjour · Ciao · こんにちは · Привет
              </Text>
              <Text style={styles.title} accessibilityRole="header">
                Welcome to Alo
              </Text>
              <Text style={styles.text}>
                Alo translates what you and another person say, so you can each talk in your own language.
              </Text>
            </View>
            <Text style={styles.question} accessibilityRole="header">
              Which language do you speak?
            </Text>
            <LanguageRow
              code={settings.myLang}
              selected
              onPress={() => setPicking(true)}
              detail={settings.myLang === phoneLang ? 'From your phone’s settings' : undefined}
            />
            <Button label="Choose another language" icon="list" onPress={() => setPicking(true)} />
          </View>
          <Button kind="primary" label="Next" next onPress={() => go(2)} />
        </Screen>
        {picking && (
          <LanguageList
            title="Which language do you speak?"
            value={settings.myLang}
            onSelect={(code) => {
              onChange(myLangPatch(settings, code));
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
          />
        )}
      </>
    );
  }

  if (step === 2) {
    return (
      <Screen key={2} footer={<Button kind="primary" label="Next" next onPress={() => go(3)} />}>
        <WizardHeader step={2} onBack={() => go(1)} />
        <Text style={styles.title} accessibilityRole="header">
          Which language will the other person speak?
        </Text>
        <LanguageSearch value={query} onChange={setQuery} placeholder="Type a language, like Japanese" />
        <LanguageRows
          query={query}
          value={settings.theirLang}
          exclude={settings.myLang}
          onSelect={(code) => onChange(theirLangPatch(settings, code))}
        />
      </Screen>
    );
  }

  if (step === 3) {
    const next = () => {
      if (settings.engine === 'keys') {
        setKeys(true);
        return;
      }
      if (settings.engine === 'server' && !normalizeServerUrl(settings.server)) {
        setServerError(SERVER_MISSING);
        serverInput.current?.focus();
        return;
      }
      if (settings.engine === 'local' && !localSupport().available) return;
      go(4);
    };
    return (
      <Screen key={3} footer={<Button kind="primary" label="Next" next onPress={next} />}>
        <WizardHeader step={3} onBack={() => go(2)} />
        <Text style={styles.title} accessibilityRole="header">
          How should Alo translate?
        </Text>
        <EngineCards
          settings={settings}
          onChange={(patch) => {
            setServerError(undefined);
            onChange(patch);
          }}
        />
        {settings.engine === 'server' && (
          <View style={styles.fields}>
            <ServerFields
              settings={settings}
              onChange={onChange}
              addressLabel="The computer’s address"
              error={serverError}
              onEdit={() => setServerError(undefined)}
              serverRef={serverInput}
              tokenRef={tokenInput}
              onAddressDone={() => tokenInput.current?.focus()}
            />
          </View>
        )}
      </Screen>
    );
  }

  return (
    <Screen key={4} fixed>
      <View style={styles.part}>
        <WizardHeader step={4} onBack={() => go(3)} />
        <Text style={styles.title} accessibilityRole="header">
          Where do you want to hear translations?
        </Text>
        <OutputCards settings={settings} onChange={onChange} />
        <Text style={styles.later}>You can change all of this later in Settings.</Text>
      </View>
      <Button kind="primary" label="Finish" icon="check" onPress={() => onChange({ setupDone: true })} />
    </Screen>
  );
}

const useStyles = themedStyles((palette) => ({
  part: {
    gap: 24,
  },
  welcome: {
    alignItems: 'flex-start',
    gap: 14,
  },
  hello: {
    ...type.compact,
    fontWeight: '400',
    color: palette.muted,
  },
  title: {
    ...type.title,
    color: palette.text,
  },
  text: {
    ...type.body,
    color: palette.text,
  },
  question: {
    ...type.section,
    color: palette.text,
  },
  fields: {
    gap: 20,
  },
  later: {
    ...type.secondary,
    color: palette.muted,
    textAlign: 'center',
  },
}));
