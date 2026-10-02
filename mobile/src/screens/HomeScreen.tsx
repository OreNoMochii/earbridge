// Home: the two languages, the two ways to start, and how Alo is set up.

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { languageName } from '../../../shared/languages.ts';
import type { AppSettings } from '../app-settings.ts';
import { Banner, Logo, Note } from '../components/Basics.tsx';
import { CompactButton, HeroButton } from '../components/Button.tsx';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { LanguageList } from '../components/LanguageList.tsx';
import { Screen } from '../components/Screen.tsx';
import type { EndReason } from '../connection.ts';
import { nativeLabel } from '../language-names.ts';
import { RADIUS, RADIUS_LG, themedStyles, type } from '../theme.ts';
import { EndBanner, myLangPatch, theirLangPatch, whoIsTalking } from './parts.tsx';
import type { Update } from './parts.tsx';

interface HomeScreenProps {
  settings: AppSettings;
  onChange: Update;
  /** Why the last conversation stopped. */
  error: EndReason | undefined;
  /** Why a conversation can't start, e.g. this phone can't translate on its own. */
  problem: string | undefined;
  onStart(): void;
  onGroup(): void;
  onSettings(): void;
  onKeys(): void;
}

type Picking = 'myLang' | 'theirLang';

export function HomeScreen({ settings, onChange, error, problem, onStart, onGroup, onSettings, onKeys }: HomeScreenProps) {
  const { styles, palette } = useStyles();
  const [picking, setPicking] = useState<Picking>();

  const setup: { icon: IconName; text: string }[] = [
    settings.engine === 'local'
      ? { icon: 'smartphone', text: 'Translates on this phone' }
      : settings.engine === 'keys'
        ? { icon: 'cloud', text: 'Translates online, with your accounts' }
        : { icon: 'monitor', text: 'Translates through a computer' },
    settings.talkMode === 'hold'
      ? { icon: 'hand', text: 'Press and hold to talk' }
      : { icon: 'mic', text: 'Talk freely: the microphone stays on' },
    settings.output === 'speaker'
      ? { icon: 'volume-2', text: 'Translations out loud on the phone' }
      : { icon: 'headphones', text: 'Translations in your earphones' },
  ];

  return (
    <>
      <Screen gap={20}>
        <View style={styles.top}>
          <Logo />
          <CompactButton label="Settings" icon="settings" onPress={onSettings} />
        </View>
        {problem !== undefined && (
          <Banner
            icon="smartphone"
            title="On this phone isn’t available"
            message={problem}
            action={{ label: 'Choose another way', icon: 'settings', onPress: onSettings }}
          />
        )}
        {error !== undefined && <EndBanner reason={error} onRetry={onStart} onKeys={onKeys} onAccessCode={onSettings} />}

        <View style={styles.languages}>
          <LanguageButton label="You speak" code={settings.myLang} onPress={() => setPicking('myLang')} />
          <View style={styles.swapRow}>
            <View style={styles.line} />
            <CompactButton
              label="Swap"
              icon="arrow-up-down"
              accessibilityLabel="Swap the two languages"
              onPress={() => onChange({ myLang: settings.theirLang, theirLang: settings.myLang })}
            />
            <View style={styles.line} />
          </View>
          <LanguageButton label="They speak" code={settings.theirLang} onPress={() => setPicking('theirLang')} />
        </View>

        <HeroButton title="Start talking" subtitle="One phone, the two of you" icon="mic" onPress={onStart} />
        <HeroButton kind="other" title="Group conversation" subtitle="Everyone on their own phone" icon="users" onPress={onGroup} />

        <View style={styles.summary}>
          <View style={styles.summaryHead}>
            <Text style={styles.summaryTitle} accessibilityRole="header">
              How Alo is set up
            </Text>
            <CompactButton label="Change" icon="pencil" accessibilityLabel="Change the settings" onPress={onSettings} />
          </View>
          {setup.map((row) => (
            <View key={row.icon} style={styles.summaryRow}>
              <Icon name={row.icon} size={24} color={palette.accent} />
              <Text style={styles.summaryText}>{row.text}</Text>
            </View>
          ))}
        </View>
        <Note icon="info" tone="muted">
          {whoIsTalking(settings)}
        </Note>
      </Screen>
      {picking && (
        <LanguageList
          title={picking === 'myLang' ? 'Which language do you speak?' : 'Which language does the other person speak?'}
          value={settings[picking]}
          onSelect={(code) => {
            onChange(picking === 'myLang' ? myLangPatch(settings, code) : theirLangPatch(settings, code));
            setPicking(undefined);
          }}
          onClose={() => setPicking(undefined)}
        />
      )}
    </>
  );
}

function LanguageButton({ label, code, onPress }: { label: string; code: string; onPress(): void }) {
  const { styles, palette } = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${languageName(code)}`}
      accessibilityHint="Opens the list of languages"
      onPress={onPress}
      style={({ pressed }) => [styles.language, pressed && styles.pressed]}
    >
      <View style={styles.languageTexts}>
        <Text style={styles.languageLabel}>{label}</Text>
        <Text style={styles.languageValue}>{nativeLabel(code)}</Text>
      </View>
      <Icon name="chevron-right" size={28} color={palette.muted} />
    </Pressable>
  );
}

const useStyles = themedStyles((palette) => ({
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  languages: {
    padding: 8,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: RADIUS_LG,
    backgroundColor: palette.surface,
  },
  language: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 16,
  },
  pressed: {
    backgroundColor: palette.surface2,
  },
  languageTexts: {
    flex: 1,
    gap: 2,
  },
  languageLabel: {
    ...type.secondary,
    color: palette.muted,
  },
  languageValue: {
    ...type.heading,
    color: palette.text,
  },
  swapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
  },
  line: {
    flex: 1,
    height: 2,
    backgroundColor: palette.border,
  },
  summary: {
    gap: 10,
    paddingTop: 12,
    paddingRight: 12,
    paddingBottom: 16,
    paddingLeft: 16,
    borderRadius: RADIUS,
    backgroundColor: palette.surface2,
  },
  summaryHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  summaryTitle: {
    ...type.bodyBold,
    flexShrink: 1,
    color: palette.text,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  summaryText: {
    ...type.secondary,
    flex: 1,
    color: palette.text,
  },
}));
