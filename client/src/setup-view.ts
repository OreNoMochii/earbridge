// The start screen: the mode, the languages, and how to talk and listen.

import { LANGUAGES, canAutoDetect, sameLanguage } from '../../shared/languages.ts';
import type { ErrorCode, Mode } from '../../shared/protocol.ts';
import { formatRoomCode, normalizeRoomCode } from '../../shared/room-code.ts';
import { listMicrophones } from './audio/mic.ts';
import { h } from './dom.ts';
import { languageLabel } from './language-names.ts';
import { MAX_NAME_LENGTH } from './settings.ts';
import type { Output, Settings, TalkMode, Voice } from './settings.ts';

export interface SetupError {
  message: string;
  code?: ErrorCode | undefined;
}

export interface SetupOptions {
  settings: Settings;
  /** A room to join: from an invite link, or the room the last session was in. */
  invitedRoom: string | undefined;
  /** Why the last session ended, if it did not end normally. */
  error: SetupError | undefined;
  /** Called on every change, e.g. to remember the settings. */
  onChange(settings: Settings): void;
  /**
   * Called synchronously within the tap on Start: browsers only let a page start audio
   * during a user gesture. `room` is the room to join (room mode), or undefined.
   */
  onStart(settings: Settings, room: string | undefined): void;
  /** The user chose to start a new room instead of joining `invitedRoom`. */
  onForgetInvite(): void;
}

export interface SetupView {
  readonly element: HTMLElement;
  destroy(): void;
}

const SORTED_LANGUAGES = [...LANGUAGES].sort((a, b) => a.name.localeCompare(b.name, 'en'));

export function renderSetup(options: SetupOptions): SetupView {
  let settings: Settings = { ...options.settings };
  let invitedRoom = options.invitedRoom;
  let destroyed = false;

  const update = (patch: Partial<Settings>): void => {
    settings = { ...settings, ...patch };
    options.onChange(settings);
    refresh();
  };

  // Choosing a language already taken by the other side swaps the two, so the pair
  // always stays valid (the mode can change later).
  const setMyLang = (code: string): void =>
    update({ myLang: code, theirLang: sameLanguage(code, settings.theirLang) ? settings.myLang : settings.theirLang });
  const setTheirLang = (code: string): void =>
    update({ theirLang: code, myLang: sameLanguage(code, settings.myLang) ? settings.theirLang : settings.myLang });

  // Mode
  const modeTabs = h(
    'fieldset',
    { class: 'tabs' },
    h('legend', { class: 'visually-hidden' }, 'Mode'),
    choice<Mode>('mode', 'solo', settings.mode, 'One phone', 'Two people, one phone', (mode) => update({ mode }), 'tab'),
    choice<Mode>('mode', 'room', settings.mode, 'Room', 'Everyone uses their own phone', (mode) => update({ mode }), 'tab'),
  );

  // One phone
  const myLangSolo = languageSelect('my-lang-solo', settings.myLang, setMyLang);
  const theirLangSelect = languageSelect('their-lang', settings.theirLang, setTheirLang);
  const soloHint = h('p', { class: 'hint' });
  const soloCard = h(
    'section',
    { class: 'card', 'aria-label': 'Languages' },
    field('my-lang-solo', 'I speak', myLangSolo),
    h(
      'button',
      {
        type: 'button',
        class: 'swap',
        'aria-label': 'Swap languages',
        title: 'Swap languages',
        onclick: () => update({ myLang: settings.theirLang, theirLang: settings.myLang }),
      },
      '⇅',
    ),
    field('their-lang', 'The other person speaks', theirLangSelect),
    soloHint,
  );

  // Room
  const nameError = fieldError('name-error');
  const nameInput = h('input', {
    id: 'name',
    type: 'text',
    value: settings.name,
    maxlength: MAX_NAME_LENGTH,
    autocomplete: 'nickname',
    enterkeyhint: 'go',
    placeholder: 'Shown to the others',
    'aria-describedby': 'name-error',
    oninput: () => {
      clearError(nameInput, nameError);
      update({ name: nameInput.value });
    },
  });
  const myLangRoom = languageSelect('my-lang-room', settings.myLang, setMyLang);
  const codeError = fieldError('room-code-error');
  const codeInput = h('input', {
    id: 'room-code',
    type: 'text',
    maxlength: 9,
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    placeholder: 'Leave empty to start a new room',
    'aria-describedby': 'room-code-error',
    oninput: () => {
      clearError(codeInput, codeError);
      refresh();
    },
  });
  const codeField = field('room-code', 'Room code', codeInput, codeError);
  const inviteText = h('strong');
  const inviteBanner = h(
    'div',
    { class: 'invite-banner' },
    h('p', {}, 'You’re joining room ', inviteText, '.'),
    h(
      'button',
      {
        type: 'button',
        class: 'button small ghost',
        onclick: () => {
          invitedRoom = undefined;
          options.onForgetInvite();
          refresh();
          codeInput.focus();
        },
      },
      'Start a new room instead',
    ),
  );
  const roomCard = h(
    'section',
    { class: 'card', 'aria-label': 'Room' },
    inviteBanner,
    field('name', 'Your name', nameInput, nameError),
    field('my-lang-room', 'I speak', myLangRoom),
    codeField,
  );

  // Talking and listening
  const talkHint = h('p', { class: 'hint' });
  const talkChoices = h(
    'fieldset',
    { class: 'card choices' },
    h('legend', {}, 'Talking'),
    h(
      'div',
      { class: 'choice-row' },
      choice<TalkMode>('talk', 'handsfree', settings.talkMode, 'Hands-free', undefined, (talkMode) => update({ talkMode })),
      choice<TalkMode>('talk', 'hold', settings.talkMode, 'Hold to talk', undefined, (talkMode) => update({ talkMode })),
    ),
    talkHint,
  );
  const outputHint = h('p', { class: 'hint' });
  const outputChoices = h(
    'fieldset',
    { class: 'card choices' },
    h('legend', {}, 'Translations play'),
    h(
      'div',
      { class: 'choice-row' },
      choice<Output>('output', 'earphones', settings.output, 'In my earphones', undefined, (output) => update({ output })),
      choice<Output>('output', 'speaker', settings.output, 'On the phone speaker', undefined, (output) =>
        update({ output }),
      ),
    ),
    outputHint,
  );

  // Advanced
  const micSelect = h(
    'select',
    { id: 'mic', onchange: () => update({ micId: micSelect.value }) },
    h('option', { value: '' }, 'Default'),
  );
  const voiceSelect = h(
    'select',
    { id: 'voice', onchange: () => update({ voice: voiceSelect.value as Voice }) },
    h('option', { value: 'natural' }, 'Natural voice'),
    h('option', { value: 'phone' }, 'The phone’s own voice'),
  );
  voiceSelect.value = settings.voice;
  const tokenInput = h('input', {
    id: 'token',
    type: 'password',
    value: settings.token,
    autocomplete: 'off',
    enterkeyhint: 'go',
    oninput: () => update({ token: tokenInput.value }),
  });
  const unauthorized = options.error?.code === 'unauthorized';
  const advanced = h(
    'details',
    { class: 'card advanced', open: unauthorized },
    h('summary', {}, 'Advanced'),
    field('mic', 'Microphone', micSelect),
    h(
      'p',
      { class: 'hint' },
      'With one phone, the phone’s own microphone usually works best: it hears you both, and Bluetooth earphones keep their full sound quality. In a room, use the earphones’ microphone.',
    ),
    field('voice', 'Voice', voiceSelect),
    h(
      'p',
      { class: 'hint' },
      'The natural voice sounds more human and takes a moment longer. Languages it doesn’t speak are read by the phone’s own voice.',
    ),
    field('token', 'Access code', tokenInput),
    h('p', { class: 'hint' }, 'Only if the person running this server gave you one.'),
  );

  const startButton = h('button', { type: 'submit', class: 'button primary start' }, 'Start');

  const start = (): void => {
    if (settings.mode === 'solo') {
      options.onStart(settings, undefined);
      return;
    }
    const name = nameInput.value.trim();
    if (!name) {
      showError(nameInput, nameError, 'Enter your name, so the others know who is talking.');
      return;
    }
    let room = invitedRoom;
    if (!room && codeInput.value.trim()) {
      room = normalizeRoomCode(codeInput.value);
      if (!room) {
        showError(codeInput, codeError, 'Room codes have 6 letters and numbers, like ABC 234.');
        return;
      }
    }
    options.onStart({ ...settings, name }, room);
  };

  const element = h(
    'div',
    { class: 'setup' },
    h(
      'header',
      { class: 'brand' },
      h('img', { class: 'brand-icon', src: `${import.meta.env.BASE_URL}icon.svg`, alt: '', width: 48, height: 48 }),
      h('div', {}, h('h1', {}, 'EarBridge'), h('p', {}, 'Live translation for any earphones')),
    ),
    options.error && h('p', { class: 'error-box', role: 'alert' }, options.error.message),
    h(
      'form',
      {
        class: 'setup-form',
        novalidate: true,
        onsubmit: (event: SubmitEvent) => {
          event.preventDefault();
          start();
        },
      },
      modeTabs,
      soloCard,
      roomCard,
      talkChoices,
      outputChoices,
      advanced,
      startButton,
    ),
    h(
      'p',
      { class: 'privacy' },
      'Your voice goes through this app’s server to Deepgram for speech recognition. The text goes to DeepInfra for translation and natural voices (a server can be set up to translate with Anthropic’s Claude instead). This app stores nothing.',
    ),
  );

  function refresh(): void {
    const solo = settings.mode === 'solo';
    soloCard.hidden = !solo;
    roomCard.hidden = solo;
    myLangSolo.value = settings.myLang;
    myLangRoom.value = settings.myLang;
    theirLangSelect.value = settings.theirLang;

    if (settings.talkMode === 'hold') {
      soloHint.textContent = 'Hold your button while you speak, and theirs while they speak.';
    } else if (canAutoDetect(settings.myLang, settings.theirLang)) {
      soloHint.textContent = 'Who is speaking is detected automatically.';
    } else {
      soloHint.textContent =
        'Tap Me or Them to show who is speaking: automatic detection isn’t available for this language pair.';
    }
    talkHint.textContent =
      settings.talkMode === 'hold'
        ? 'The microphone is on only while you hold the button. Best in noisy places.'
        : 'The microphone stays on. Best in quiet places.';
    if (solo) {
      outputHint.textContent =
        settings.output === 'speaker'
          ? 'Both translations are read aloud by the phone, so the other person hears theirs too. The microphone pauses while it speaks.'
          : 'You hear their words in your earphones; they read yours on the screen.';
    } else {
      outputHint.textContent =
        settings.output === 'speaker'
          ? 'The phone reads translations aloud and pauses the microphone meanwhile. Only if the others are not in the same room.'
          : 'You hear the others in your language.';
    }

    inviteBanner.hidden = !invitedRoom;
    inviteText.textContent = invitedRoom ? formatRoomCode(invitedRoom) : '';
    codeField.hidden = Boolean(invitedRoom);
    startButton.textContent = solo ? 'Start' : invitedRoom || codeInput.value.trim() ? 'Join room' : 'Start a room';
  }

  // Microphone names are only known once the microphone was allowed, and the list
  // changes as earphones connect.
  const loadMicrophones = async (): Promise<void> => {
    const microphones = await listMicrophones();
    if (destroyed) return;
    micSelect.replaceChildren(
      h('option', { value: '' }, 'Default'),
      ...microphones.map((microphone) => h('option', { value: microphone.deviceId }, microphone.label)),
    );
    micSelect.value = microphones.some((microphone) => microphone.deviceId === settings.micId) ? settings.micId : '';
  };
  const onDeviceChange = (): void => void loadMicrophones();
  navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange);
  void loadMicrophones();

  refresh();
  if (unauthorized) requestAnimationFrame(() => tokenInput.focus());

  return {
    element,
    destroy() {
      destroyed = true;
      navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange);
    },
  };
}

function languageSelect(id: string, value: string, onSelect: (code: string) => void): HTMLSelectElement {
  const select = h(
    'select',
    { id, onchange: () => onSelect(select.value) },
    ...SORTED_LANGUAGES.map((language) => h('option', { value: language.code }, languageLabel(language.code))),
  );
  select.value = value;
  return select;
}

function field(id: string, label: string, ...controls: HTMLElement[]): HTMLElement {
  return h('div', { class: 'field' }, h('label', { for: id }, label), ...controls);
}

function choice<T extends string>(
  name: string,
  value: T,
  current: T,
  label: string,
  detail: string | undefined,
  onSelect: (value: T) => void,
  className = 'choice',
): HTMLLabelElement {
  return h(
    'label',
    { class: className },
    h('input', { type: 'radio', name, value, checked: value === current, onchange: () => onSelect(value) }),
    h(
      'span',
      { class: `${className}-text` },
      h('span', { class: `${className}-label` }, label),
      detail && h('span', { class: `${className}-detail` }, detail),
    ),
  );
}

function fieldError(id: string): HTMLElement {
  return h('p', { class: 'field-error', id, hidden: true });
}

function showError(input: HTMLInputElement, error: HTMLElement, message: string): void {
  error.textContent = message;
  error.hidden = false;
  input.setAttribute('aria-invalid', 'true');
  input.focus();
}

function clearError(input: HTMLInputElement, error: HTMLElement): void {
  error.hidden = true;
  input.removeAttribute('aria-invalid');
}
