// What several screens share: the Android back button, choosing languages, who translates
// and where translations are heard, the computer's address, and why a conversation stopped.

import { useEffect, useEffectEvent } from 'react';
import type { ReactNode, Ref } from 'react';
import { BackHandler, Linking, View } from 'react-native';
import type { TextInput } from 'react-native';

import { canAutoDetect, sameLanguage } from '../../../shared/languages.ts';
import type { AppSettings } from '../app-settings.ts';
import { Banner } from '../components/Basics.tsx';
import type { BannerAction } from '../components/Basics.tsx';
import { ChoiceCard } from '../components/Choices.tsx';
import { TextField } from '../components/Field.tsx';
import type { EndReason } from '../connection.ts';
import { localSupport } from '../engines/local.ts';

/** Changes some settings, keeping the others. */
export type Update = (patch: Partial<AppSettings>) => void;

export const SERVER_MISSING = 'Enter the address of the computer running Alo, like 192.168.1.20:8787.';

/**
 * The Android back button while the screen shows; the handler returns true when it handled
 * it. Lists and dialogs opened over the screen register later, so they get it first.
 */
export function useBackButton(handler: () => boolean): void {
  const onBack = useEffectEvent(handler);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => onBack());
    return () => subscription.remove();
  }, []);
}

// Choosing a language the other side already has swaps the two, so the pair stays valid.

export function myLangPatch(settings: AppSettings, code: string): Partial<AppSettings> {
  return { myLang: code, theirLang: sameLanguage(code, settings.theirLang) ? settings.myLang : settings.theirLang };
}

export function theirLangPatch(settings: AppSettings, code: string): Partial<AppSettings> {
  return { theirLang: code, myLang: sameLanguage(code, settings.myLang) ? settings.theirLang : settings.myLang };
}

/** How Alo knows who is talking, with one phone. */
export function whoIsTalking(settings: AppSettings): string {
  if (settings.talkMode === 'hold') return 'Hold a button to talk. Let go when you’re done.';
  if (settings.engine !== 'local' && canAutoDetect(settings.myLang, settings.theirLang)) {
    return 'Who is talking is noticed automatically.';
  }
  return 'Tap Me or Them to show who is talking.';
}

interface CardsProps {
  settings: AppSettings;
  onChange: Update;
  /** The first-time setup: the cards are a bit further apart, and say a bit more. */
  wizard?: boolean;
}

/**
 * On this phone, online with the user's own accounts, or through a computer. What the
 * chosen one needs, like the keys, shows right under it.
 */
export function EngineCards({ settings, onChange, wizard = false, details }: CardsProps & { details?: ReactNode }) {
  const local = localSupport();
  const taiwan = settings.myLang === 'zh-TW' || settings.theirLang === 'zh-TW';
  return (
    <View style={{ gap: wizard ? 14 : 12 }} accessibilityRole="radiogroup">
      <ChoiceCard
        icon="smartphone"
        title="On this phone"
        badge={local.available ? 'Recommended' : undefined}
        description="Free and private. Works offline after a download."
        note={taiwan ? 'For Chinese (Taiwan): translated into simplified characters.' : undefined}
        reason={local.available ? undefined : local.reason}
        disabled={!local.available}
        selected={settings.engine === 'local'}
        onPress={() => onChange({ engine: 'local' })}
      />
      {settings.engine === 'local' && details}
      <ChoiceCard
        icon="cloud"
        title="Online, best quality"
        description="Your own Deepgram and DeepInfra accounts, paid per use."
        selected={settings.engine === 'keys'}
        onPress={() => onChange({ engine: 'keys' })}
      />
      {settings.engine === 'keys' && details}
      <ChoiceCard
        icon="monitor"
        title="Through a computer"
        description="A computer at home or work runs Alo."
        selected={settings.engine === 'server'}
        onPress={() => onChange({ engine: 'server' })}
      />
      {settings.engine === 'server' && details}
    </View>
  );
}

/** In the earphones, or out loud on the phone. */
export function OutputCards({ settings, onChange, wizard = false }: CardsProps) {
  return (
    <View style={{ gap: wizard ? 14 : 12 }} accessibilityRole="radiogroup">
      <ChoiceCard
        icon="headphones"
        title="In my earphones"
        description="You hear them. They read your words on the screen."
        selected={settings.output === 'earphones'}
        onPress={() => onChange({ output: 'earphones' })}
      />
      <ChoiceCard
        icon="volume-2"
        title="Out loud on the phone"
        description="The phone speaks both translations aloud."
        selected={settings.output === 'speaker'}
        onPress={() => onChange({ output: 'speaker' })}
      />
    </View>
  );
}

interface ServerFieldsProps {
  settings: AppSettings;
  onChange: Update;
  addressLabel: string;
  /** What is wrong with the address. */
  error?: string | undefined;
  /** Something was typed, e.g. to hide the error. */
  onEdit?: (() => void) | undefined;
  serverRef?: Ref<TextInput> | undefined;
  tokenRef?: Ref<TextInput> | undefined;
  /** Moves on to the access code. */
  onAddressDone?: (() => void) | undefined;
}

/** The computer running Alo: its address, and the access code if it has one. */
export function ServerFields({ settings, onChange, addressLabel, error, onEdit, serverRef, tokenRef, onAddressDone }: ServerFieldsProps) {
  return (
    <>
      <TextField
        ref={serverRef}
        label={addressLabel}
        error={error}
        value={settings.server}
        onChangeText={(server) => {
          onEdit?.();
          onChange({ server });
        }}
        placeholder="192.168.1.20:8787"
        maxLength={500}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        returnKeyType={onAddressDone ? 'next' : 'done'}
        submitBehavior={onAddressDone ? 'submit' : 'blurAndSubmit'}
        onSubmitEditing={onAddressDone}
      />
      <TextField
        ref={tokenRef}
        label="Access code"
        hint="Only if you were given one."
        value={settings.token}
        onChangeText={(token) => {
          onEdit?.();
          onChange({ token });
        }}
        maxLength={200}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        spellCheck={false}
        returnKeyType="done"
      />
    </>
  );
}

interface EndBannerProps {
  reason: EndReason;
  onRetry(): void;
  /** Where the user's own keys can be changed; without it, only trying again is offered. */
  onKeys?: (() => void) | undefined;
  /** Shows the access code field. */
  onAccessCode(): void;
}

/** Why the last conversation stopped, and what to do about it. */
export function EndBanner({ reason, onRetry, onKeys, onAccessCode }: EndBannerProps) {
  const retry: BannerAction = { label: 'Try again', icon: 'rotate-cw', onPress: onRetry };
  const { message } = reason;
  switch (reason.code) {
    case 'unreachable':
      return <Banner icon="wifi-off" title="Couldn’t reach the computer" message={message} action={retry} />;
    case 'microphone':
      return (
        <Banner
          icon="mic-off"
          title="Microphone not allowed"
          message={message}
          action={{ label: 'Open phone settings', icon: 'settings', onPress: () => void Linking.openSettings().catch(() => {}) }}
        />
      );
    case 'keys':
      return (
        <Banner
          icon="key-round"
          title="Online translation stopped"
          message={message}
          action={onKeys ? { label: 'Change keys', icon: 'key-round', onPress: onKeys } : retry}
        />
      );
    case 'download':
      return <Banner icon="download" title="Download failed" message={message} action={retry} />;
    case 'unauthorized':
      return (
        <Banner
          icon="lock"
          title="Access code needed"
          message={message}
          action={{ label: 'Enter the access code', icon: 'key-round', onPress: onAccessCode }}
        />
      );
    case 'room_not_found':
      return <Banner icon="users" title="Group not found" message="Check the code, or start a new group." />;
    default:
      return <Banner icon="triangle-alert" title="The conversation stopped" message={message} action={retry} />;
  }
}
