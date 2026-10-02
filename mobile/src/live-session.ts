// One conversation, from the Start tap until it ends: wires the microphone, the engine
// (a computer running the server, or the phone itself), the transcript and the spoken translations
// together, and holds what the conversation screen shows. A port of the web app's
// client/src/live-session.ts.

import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import type { NativeEventSubscription } from 'react-native';

import { voiceLanguages } from '../../client/src/settings.ts';
import { OrderedSpeechQueue } from '../../client/src/speech-queue.ts';
import type { SpeechItem } from '../../client/src/speech-queue.ts';
import { canAutoDetect, sameLanguage } from '../../shared/languages.ts';
import { SKIPPED_KEPT, SOLO_ME } from '../../shared/protocol.ts';
import type { ClientMessage, Participant, ServerMessage, SkipReason, SpeakerSelection } from '../../shared/protocol.ts';
import { formatRoomCode } from '../../shared/room-code.ts';
import EarbridgeAudio from '../modules/earbridge-audio/src/EarbridgeAudioModule.ts';
import type { CaptureInput } from '../modules/earbridge-audio/src/EarbridgeAudioModule.ts';
import { wantsEarphoneMic } from './app-settings.ts';
import type { AppSettings } from './app-settings.ts';
import { earphonesConnected, watchEarphones } from './audio/earphones.ts';
import { MicrophoneError, openMicrophone } from './audio/mic.ts';
import type { MicMode, Microphone } from './audio/mic.ts';
import { PhoneVoice } from './audio/phone-voice.ts';
import { VoicePlayer } from './audio/voice-player.ts';
import { Connection } from './connection.ts';
import type { ConnectionState, EndReason } from './connection.ts';
import type { Backend, BackendEvents } from './engines/backend.ts';
import { InAppBackend } from './engines/in-app-backend.ts';
import type { InAppOptions } from './engines/in-app-backend.ts';
import { prepareKeys } from './engines/keys.ts';
import { prepareLocal } from './engines/local.ts';
import { plainLanguageName } from './language-names.ts';
import { serverLabel, socketUrl } from './server-url.ts';

/** After the phone speaker stops, its echo in the room takes a moment to die down. */
const SPEAKER_TAIL_MS = 300;
/** People let go of the button while finishing their last word. */
const HOLD_TAIL_MS = 250;
/** Bluetooth earphones can drop out for a moment and come straight back. */
const EARPHONES_GONE_MS = 1_000;
const TOAST_MS = 5_000;
const MAX_TOASTS = 3;
const MAX_ENTRIES = 200;
const KEEP_AWAKE_TAG = 'earbridge-conversation';

export type StatusTone = 'live' | 'busy' | 'idle' | 'speaking';
/** Which hold-to-talk button: one per person in one-phone mode, a single one in a room. */
export type HoldTarget = 'me' | 'them' | 'room';

/**
 * pending:     on its way.
 * streaming:   arriving.
 * done:        complete.
 * empty:       there was nothing to translate.
 * failed:      `text` says why.
 * interrupted: cut off by a lost connection.
 */
export type TranslationState = 'pending' | 'streaming' | 'done' | 'empty' | 'failed' | 'interrupted';

export interface FeedEntry {
  id: string;
  speaker: string;
  lang: string;
  text: string;
  /** Said by the person holding this phone. */
  mine: boolean;
  /** The translation this phone receives, if any. */
  translation: { lang: string; text: string; state: TranslationState } | undefined;
  /** One phone: not translated, as it seemed to come from someone else. */
  skipped: { reason: SkipReason; state: SkippedState } | undefined;
}

/**
 * skipped:   it can still be translated after all.
 * accepting: asked to be translated after all.
 * gone:      too old to be translated now.
 */
export type SkippedState = 'skipped' | 'accepting' | 'gone';

/** What someone is saying right now, before it is final. */
export interface Interim {
  key: string;
  speaker: string;
  lang: string;
  text: string;
  mine: boolean;
}

export interface Toast {
  id: number;
  message: string;
}

export interface ParticipantView {
  name: string;
  lang: string;
  me: boolean;
}

/** One-phone mode: the latest translation for the other person, shown large. */
export interface PartnerView {
  text: string;
  state: 'waiting' | 'streaming' | 'done' | 'failed';
}

export interface LiveState {
  status: { text: string; tone: StatusTone };
  micMode: MicMode;
  micLabel: string;
  muted: boolean;
  /** One-phone mode: who the recognizer expects. */
  speaker: SpeakerSelection | undefined;
  /** One-phone mode: whether "Auto" can be offered. */
  autoDetect: boolean;
  holding: HoldTarget | undefined;
  entries: readonly FeedEntry[];
  interims: readonly Interim[];
  toasts: readonly Toast[];
  partner: PartnerView;
  roomCode: string | undefined;
  inviteOpen: boolean;
  participants: readonly ParticipantView[];
}

type ReadyMessage = Extract<ServerMessage, { type: 'ready' }>;
type InterimMessage = Extract<ServerMessage, { type: 'interim' }>;
type UtteranceMessage = Extract<ServerMessage, { type: 'utterance' }>;
type SkippedMessage = Extract<ServerMessage, { type: 'skipped' }>;
type TranslationMessage = Extract<ServerMessage, { type: 'translation' }>;
type SpeechMessage = Extract<ServerMessage, { type: 'speech' }>;

export interface LiveSessionOptions {
  settings: AppSettings;
  /**
   * The server, e.g. http://192.168.1.20:8787, or undefined when the phone does the work
   * itself (one phone, with the engine in settings).
   */
  server: string | undefined;
  /** Room mode: the room to join, or undefined to start a new one. */
  room: string | undefined;
  /**
   * The session is over: `reason` is undefined when the user ended it. `room` is the
   * room it was in, if any, so it can be offered again after an error.
   */
  onEnded(reason: EndReason | undefined, room: string | undefined): void;
}

let nextToastId = 1;

export class LiveSession {
  private readonly options: LiveSessionOptions;
  private readonly settings: AppSettings;
  private readonly queue: OrderedSpeechQueue;
  private readonly voice = new VoicePlayer();
  private readonly speech = new PhoneVoice();
  private state: LiveState;
  private readonly listeners = new Set<() => void>();
  private readonly levelListeners = new Set<(level: number) => void>();
  private mic: Microphone | undefined;
  private backend: Backend | undefined;
  private connectionState: ConnectionState = 'connecting';
  /** What the engine is getting ready, e.g. a language download. */
  private progress: string | undefined;
  private recognizer: 'starting' | 'live' | 'reconnecting' = 'starting';
  private ended = false;
  private readonly cleanups: (() => void)[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  /** Whether earphones are connected; without them, translations play on the speaker. */
  private earphones = false;
  private earphonesGoneTimer: ReturnType<typeof setTimeout> | undefined;

  // Room mode. Every reconnection gets a new id, and the server may briefly still list
  // an old one, so all of them count as "me".
  private readonly myIds = new Set<string>();
  private others: Participant[] = [];
  private announceChanges = false;

  // What decides whether the microphone is sent (see updateMic).
  private holdTail = false;
  private speaking = false;
  private speakerTail = false;
  private holdTailTimer: ReturnType<typeof setTimeout> | undefined;
  private speakerTailTimer: ReturnType<typeof setTimeout> | undefined;

  /** One phone: the latest skipped utterances, oldest first, which can still be translated. */
  private skips: string[] = [];

  /** Utterances whose translation will be spoken on this phone. */
  private readonly toSpeak = new Set<string>();
  /** One-phone mode: my utterances, whose translations are shown to the other person. */
  private readonly forPartner = new Set<string>();
  /** Languages the server reads aloud with a natural voice. */
  private voiced: ReadonlySet<string> = new Set();
  /** Finished translations waiting for their natural voice, by utterance id. */
  private readonly awaitingVoice = new Map<string, SpeechItem>();
  private readonly voiceWarnings = new Set<string>();

  constructor(options: LiveSessionOptions) {
    this.options = options;
    this.settings = options.settings;
    const { settings } = options;
    this.state = {
      status: { text: 'Starting the microphone…', tone: 'busy' },
      micMode: 'off',
      micLabel: 'Microphone',
      muted: false,
      speaker: undefined,
      autoDetect:
        settings.mode === 'solo' &&
        (options.server !== undefined || settings.engine !== 'local') &&
        canAutoDetect(settings.myLang, settings.theirLang),
      holding: undefined,
      entries: [],
      interims: [],
      toasts: [],
      partner: { text: '', state: 'waiting' },
      roomCode: undefined,
      inviteOpen: false,
      participants: [],
    };
    this.queue = new OrderedSpeechQueue({
      speak: (item) => this.speak(item),
      onSpeakingChange: (speaking) => this.setSpeaking(speaking),
    });
  }

  // ---------------------------------------------------------------- for the screen

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): LiveState => this.state;

  /** The microphone's level from 0 to 1, ten times a second. */
  subscribeLevel(listener: (level: number) => void): () => void {
    this.levelListeners.add(listener);
    return () => {
      this.levelListeners.delete(listener);
    };
  }

  get mode(): AppSettings['mode'] {
    return this.settings.mode;
  }

  get talkMode(): AppSettings['talkMode'] {
    return this.settings.talkMode;
  }

  get myLang(): string {
    return this.settings.myLang;
  }

  get theirLang(): string {
    return this.settings.theirLang;
  }

  get server(): string | undefined {
    return this.options.server;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      this.end({ message: `Something went wrong: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async run(): Promise<void> {
    const { settings } = this;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    this.speech.onWarning = (message) => this.toast(message);
    // An app in the background gets no touch events; never leave the microphone open.
    const appState: NativeEventSubscription = AppState.addEventListener('change', (next) => {
      if (next === 'background' && this.state.holding) this.setHolding(this.state.holding, false);
    });
    this.cleanups.push(() => appState.remove());
    this.updateStatus();

    this.earphones = await earphonesConnected();
    if (this.ended) return;
    this.cleanups.push(watchEarphones((connected) => this.onEarphonesChange(connected)));

    let mic: Microphone;
    try {
      mic = await openMicrophone({
        earphoneMic: wantsEarphoneMic(settings),
        onAudio: (pcm) => this.backend?.sendAudio(pcm),
        onLevel: (level) => {
          for (const listener of this.levelListeners) listener(level);
        },
        onEnded: (message) => this.end({ message: `${message} Start again to continue.` }),
      });
    } catch (error) {
      this.end(
        error instanceof MicrophoneError
          ? { message: error.message, code: error.notAllowed ? 'microphone' : undefined }
          : { message: `Could not start the microphone: ${String(error)}` },
      );
      return;
    }
    if (this.ended) {
      mic.stop();
      return;
    }
    this.mic = mic;
    this.update({ micLabel: micLabel(mic.input) });
    if (wantsEarphoneMic(settings) && this.earphones && mic.input.input === 'phone') {
      this.toast('The earphones’ microphone isn’t available, so the phone’s microphone listens.');
    }
    if (settings.output === 'earphones' && !this.earphones) {
      this.toast('No earphones are connected, so translations play on the phone speaker. The microphone pauses while it speaks.');
    }
    this.updateMic();
    await this.keepRunningInBackground();
    if (this.ended) return;

    this.backend = this.createBackend();
    this.backend.start();
  }

  private createBackend(): Backend {
    const { settings } = this;
    const { server } = this.options;
    const events: BackendEvents = {
      onMessage: (message) => this.handle(message),
      onStateChange: (state) => this.setConnectionState(state),
      onEnded: (reason) => this.end(withCode(reason)),
      onProgress: (text) => {
        this.progress = text;
        this.updateStatus();
      },
    };
    if (server !== undefined) {
      return new Connection({ url: socketUrl(server), serverLabel: serverLabel(server), hello: () => this.hello(), ...events });
    }
    const prepare: InAppOptions['prepare'] =
      settings.engine === 'local'
        ? (signal, progress) => prepareLocal(settings, signal, progress)
        : (signal, progress) => prepareKeys(settings, signal, progress);
    return new InAppBackend({
      myLang: settings.myLang,
      theirLang: settings.theirLang,
      nearbyOnly: settings.nearbyOnly,
      prepare,
      ...events,
    });
  }

  /** The user ended the conversation. */
  stop(): void {
    if (this.ended) return;
    this.shutDown();
    this.options.onEnded(undefined, undefined);
  }

  private end(reason: EndReason): void {
    if (this.ended) return;
    this.shutDown();
    this.options.onEnded(reason, this.state.roomCode ?? this.options.room);
  }

  private shutDown(): void {
    this.ended = true;
    clearTimeout(this.holdTailTimer);
    clearTimeout(this.speakerTailTimer);
    clearTimeout(this.earphonesGoneTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.mic?.stop();
    this.backend?.stop();
    this.queue.clear();
    this.awaitingVoice.clear();
    this.voice.close();
    this.speech.cancel();
    this.speech.onWarning = undefined;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    EarbridgeAudio?.hideConversation();
    void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
  }

  /**
   * Android: a notification that keeps the conversation going while the phone is locked,
   * with buttons to mute and end it (the earphones' play/pause button mutes too).
   */
  private async keepRunningInBackground(): Promise<void> {
    if (!EarbridgeAudio) return;
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      // Without it the conversation still runs, but its notification stays hidden.
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {});
      if (this.ended) return;
    }
    const remote = EarbridgeAudio.addListener('onRemoteCommand', ({ command }) => {
      if (command === 'end') this.stop();
      else this.setMuted(command === 'mute');
    });
    this.cleanups.push(() => remote.remove());
    this.updateNotification();
  }

  private updateNotification(): void {
    if (!EarbridgeAudio || this.ended || !this.mic) return;
    const { settings } = this;
    const myLang = plainLanguageName(settings.myLang);
    const roomCode = this.state.roomCode;
    const text =
      settings.mode === 'solo'
        ? `${myLang} ⇄ ${plainLanguageName(settings.theirLang)}`
        : `${roomCode ? `Group ${formatRoomCode(roomCode)}` : 'Group'} · ${myLang}`;
    EarbridgeAudio.showConversation('Alo is translating', text, this.state.muted);
  }

  // ---------------------------------------------------------------- the server

  private hello(): ClientMessage {
    const { settings } = this;
    const token = settings.token.trim() || undefined;
    const voiceLangs = voiceLanguages(settings);
    if (settings.mode === 'solo') {
      const { myLang, theirLang, nearbyOnly } = settings;
      return { type: 'hello', mode: 'solo', myLang, theirLang, voiceLangs, nearbyOnly, token };
    }
    // After a reconnection, go back to the same room.
    const room = this.state.roomCode ?? this.options.room;
    return { type: 'hello', mode: 'room', lang: settings.myLang, name: settings.name, room, voiceLangs, token };
  }

  private handle(message: ServerMessage): void {
    if (this.ended) return;
    switch (message.type) {
      case 'ready':
        this.onReady(message);
        break;
      case 'participants':
        this.onParticipants(message.participants);
        break;
      case 'interim':
        this.onInterim(message);
        break;
      case 'utterance':
        this.onUtterance(message);
        break;
      case 'skipped':
        this.onSkipped(message);
        break;
      case 'translation':
        this.onTranslation(message);
        break;
      case 'speech':
        this.onSpeech(message);
        break;
      case 'status':
        // "connecting" also follows every switch of speaker, which is not worth
        // announcing; only the first one counts (see onReady).
        if (message.stt !== 'connecting') this.recognizer = message.stt;
        this.updateStatus();
        break;
      case 'error':
        this.toast(message.message);
        break;
    }
  }

  private onReady(message: ReadyMessage): void {
    this.myIds.add(message.clientId);
    this.recognizer = 'starting';
    this.voiced = new Set(message.voiceLangs ?? []);
    this.announceChanges = false;

    if (message.mode === 'solo') {
      const wanted = this.state.speaker ?? message.speaker ?? 'auto';
      const speaker = wanted === 'auto' && !message.autoDetect ? message.speaker : wanted;
      this.update({ autoDetect: message.autoDetect, speaker });
      // The server starts from its default; repeat a choice made before a reconnection.
      if (speaker && speaker !== message.speaker) this.backend?.send({ type: 'speaker', speaker });
    } else if (message.room) {
      const created = this.state.roomCode === undefined && this.options.room === undefined;
      this.update({ roomCode: message.room, inviteOpen: created || this.state.inviteOpen });
      this.updateNotification();
    }
  }

  private onParticipants(participants: readonly Participant[]): void {
    const others = participants.filter((participant) => !this.myIds.has(participant.id));
    if (this.announceChanges) {
      const before = new Set(this.others.map((participant) => participant.name));
      const after = new Set(others.map((participant) => participant.name));
      for (const name of after) if (!before.has(name)) this.toast(`${name} joined.`);
      for (const name of before) if (!after.has(name)) this.toast(`${name} left.`);
    }
    // The first list after (re)joining is everyone already there, not news.
    this.announceChanges = true;
    this.others = others;
    this.update({
      participants: [
        { name: this.settings.name, lang: this.settings.myLang, me: true },
        ...others.map((participant) => ({ name: participant.name, lang: participant.lang, me: false })),
      ],
    });
  }

  private isMine(speakerId: string): boolean {
    return this.settings.mode === 'solo' ? speakerId === SOLO_ME : this.myIds.has(speakerId);
  }

  private speakerName(speakerId: string, fallback: string): string {
    if (this.isMine(speakerId)) return 'You';
    if (this.settings.mode === 'solo') return 'Them';
    return this.others.find((participant) => participant.id === speakerId)?.name ?? fallback;
  }

  private onInterim(message: InterimMessage): void {
    // One-phone mode has a single recognizer, whose guess of who is talking can change
    // mid-sentence, so it keeps a single live line.
    const key = this.settings.mode === 'solo' ? 'solo' : message.speakerId;
    const interims = this.state.interims;
    if (!message.text) {
      this.update({ interims: interims.filter((interim) => interim.key !== key) });
      return;
    }
    const interim: Interim = {
      key,
      speaker: this.speakerName(message.speakerId, '…'),
      lang: message.lang,
      text: message.text,
      mine: this.isMine(message.speakerId),
    };
    const index = interims.findIndex((existing) => existing.key === key);
    this.update({
      interims: index < 0 ? [...interims, interim] : interims.map((existing, i) => (i === index ? interim : existing)),
    });
  }

  private onUtterance(message: UtteranceMessage): void {
    const { settings } = this;
    const solo = settings.mode === 'solo';
    const mine = this.isMine(message.speakerId);
    const interimKey = solo ? 'solo' : message.speakerId;

    // One phone: everything is translated for the other side. Room: this phone only
    // receives translations of other people speaking another language.
    let translationLang: string | undefined;
    if (solo) translationLang = mine ? settings.theirLang : settings.myLang;
    else if (!mine && !sameLanguage(message.lang, settings.myLang)) translationLang = settings.myLang;

    const entry: FeedEntry = {
      id: message.id,
      speaker: this.speakerName(message.speakerId, message.speakerName),
      lang: message.lang,
      text: message.text,
      mine,
      translation: translationLang ? { lang: translationLang, text: '', state: 'pending' } : undefined,
      skipped: undefined,
    };
    // Something skipped and then accepted stays where it was.
    const accepted = this.state.entries.some((existing) => existing.id === message.id);
    const patch: Partial<LiveState> = {
      entries: accepted
        ? this.state.entries.map((existing) => (existing.id === message.id ? entry : existing))
        : withEntry(this.state.entries, entry),
      interims: this.state.interims.filter((interim) => interim.key !== interimKey),
    };
    if (solo && mine) {
      this.forPartner.add(message.id);
      patch.partner = { text: '', state: 'streaming' };
    }
    this.update(patch);

    // With earphones, only what the other person said is played (in my ears); on the
    // speaker, my words are read out in their language too.
    const speak = translationLang !== undefined && (!solo || !mine || settings.output === 'speaker');
    if (speak) {
      this.toSpeak.add(message.id);
      this.queue.expect(message.id);
    }
  }

  private onSkipped(message: SkippedMessage): void {
    const entry: FeedEntry = {
      id: message.id,
      speaker: this.speakerName(message.speakerId, 'Them'),
      lang: message.lang,
      text: message.text,
      mine: this.isMine(message.speakerId),
      translation: undefined,
      skipped: { reason: message.reason, state: 'skipped' },
    };
    let entries = withEntry(this.state.entries, entry);
    // The server forgets the oldest, so it can no longer be translated.
    this.skips.push(message.id);
    const forgotten = this.skips.length > SKIPPED_KEPT ? this.skips.shift() : undefined;
    if (forgotten !== undefined) entries = markSkipped(entries, (id) => id === forgotten, 'gone');
    this.update({ entries });
  }

  private onTranslation(message: TranslationMessage): void {
    this.updateTranslation(message.id, message.text, message.done, message.error);
    if (this.forPartner.has(message.id)) {
      this.update({
        partner: message.error
          ? { text: '', state: 'failed' }
          : { text: message.text, state: message.done ? 'done' : 'streaming' },
      });
      if (message.done) this.forPartner.delete(message.id);
    }
    if (!message.done || !this.toSpeak.delete(message.id)) return;
    if (!message.text || message.error) {
      this.queue.skip(message.id);
      return;
    }
    const item = { id: message.id, text: message.text, lang: message.lang };
    // A natural voice follows in a `speech` message.
    if (this.voiced.has(message.lang)) this.awaitingVoice.set(message.id, item);
    else this.queue.ready(item);
  }

  /** `text` is the whole translation so far. */
  private updateTranslation(id: string, text: string, done: boolean, error: string | undefined): void {
    const entry = this.state.entries.find((candidate) => candidate.id === id);
    const translation = entry?.translation;
    if (!entry || !translation || (translation.state !== 'pending' && translation.state !== 'streaming')) return;
    let next: NonNullable<FeedEntry['translation']>;
    if (error) next = { ...translation, text: `Translation failed: ${error}`, state: 'failed' };
    else if (text) next = { ...translation, text, state: done ? 'done' : 'streaming' };
    else if (done) next = { ...translation, text: '', state: 'empty' };
    else return;
    this.update({
      entries: this.state.entries.map((candidate) => (candidate === entry ? { ...entry, translation: next } : candidate)),
    });
  }

  private onSpeech(message: SpeechMessage): void {
    const item = this.awaitingVoice.get(message.id);
    if (!item) return;
    this.awaitingVoice.delete(message.id);
    if (message.audio.length > 0) {
      this.queue.ready({ ...item, audio: message.audio });
      return;
    }
    if (message.error) this.warnVoice(`${message.error} The phone’s own voice reads instead.`);
    this.queue.ready(item);
  }

  /** Reads a translation aloud: with the natural voice if there is one, else the phone's own. */
  private async speak(item: SpeechItem): Promise<void> {
    if (item.audio) {
      try {
        await this.voice.play(item.audio);
        return;
      } catch {
        this.warnVoice('This phone could not play the natural voice, so its own voice reads instead.');
      }
    }
    if (!this.ended) await this.speech.speak(item.text, item.lang);
  }

  private warnVoice(message: string): void {
    if (this.voiceWarnings.has(message)) return;
    this.voiceWarnings.add(message);
    this.toast(message);
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    if (state !== 'ready') {
      // The server-side session is gone, and with it every translation in progress.
      // Translations already here are read by the phone's own voice instead.
      for (const item of this.awaitingVoice.values()) this.queue.ready(item);
      this.awaitingVoice.clear();
      this.queue.skipPending();
      this.toSpeak.clear();
      this.forPartner.clear();
      this.interruptPending();
    }
    this.updateStatus();
  }

  /**
   * The connection dropped: translations still on their way will not arrive, and the
   * server has forgotten what it skipped.
   */
  private interruptPending(): void {
    this.skips = [];
    const entries = markSkipped(this.state.entries, () => true, 'gone').map((entry): FeedEntry => {
      const translation = entry.translation;
      if (translation?.state === 'pending') {
        return {
          ...entry,
          translation: { ...translation, text: 'Translation interrupted: the connection was lost.', state: 'failed' },
        };
      }
      if (translation?.state === 'streaming') return { ...entry, translation: { ...translation, state: 'interrupted' } };
      return entry;
    });
    this.update({ entries, interims: [] });
  }

  // ---------------------------------------------------------------- controls

  /** One phone: translates something that was skipped after all. */
  accept(id: string): void {
    const entry = this.state.entries.find((candidate) => candidate.id === id);
    if (this.ended || this.connectionState !== 'ready' || entry?.skipped?.state !== 'skipped') return;
    this.skips = this.skips.filter((skip) => skip !== id);
    this.update({ entries: markSkipped(this.state.entries, (candidate) => candidate === id, 'accepting') });
    // The utterance comes back with the same id (see onUtterance).
    this.backend?.send({ type: 'accept', id });
  }

  selectSpeaker(selection: SpeakerSelection): void {
    if (this.ended || this.state.speaker === selection) return;
    this.update({ speaker: selection });
    // If not connected, onReady sends it once the connection is back.
    this.backend?.send({ type: 'speaker', speaker: selection });
  }

  setMuted(muted: boolean): void {
    if (this.ended || this.state.muted === muted) return;
    this.update({ muted });
    this.updateMic();
    this.updateNotification();
  }

  toggleInvite(): void {
    if (this.state.roomCode) this.update({ inviteOpen: !this.state.inviteOpen });
  }

  setHolding(target: HoldTarget, pressed: boolean): void {
    if (this.ended) return;
    if (pressed) {
      if (this.state.holding) return; // a second finger on the other button
      this.update({ holding: target });
      clearTimeout(this.holdTailTimer);
      this.holdTail = false;
      if (target !== 'room') this.selectSpeaker(target);
      // Do not talk over the person talking.
      this.queue.setPaused(true);
      if (this.speakerOutput()) {
        this.voice.cancel();
        this.speech.cancel();
      }
    } else {
      if (this.state.holding !== target) return;
      this.update({ holding: undefined });
      this.holdTail = true;
      this.holdTailTimer = setTimeout(() => {
        this.holdTail = false;
        this.updateMic();
      }, HOLD_TAIL_MS);
      this.queue.setPaused(false);
    }
    this.updateMic();
  }

  /** Shows a short message over the conversation for a few seconds. */
  toast(message: string): void {
    if (this.ended) return;
    const toast = { id: nextToastId++, message };
    this.update({ toasts: [...this.state.toasts, toast].slice(-MAX_TOASTS) });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.update({ toasts: this.state.toasts.filter((shown) => shown !== toast) });
    }, TOAST_MS);
    this.timers.add(timer);
  }

  // ---------------------------------------------------------------- earphones and microphone

  /** Translations play on the phone speaker: chosen so, or no earphones are connected. */
  private speakerOutput(): boolean {
    return this.settings.output === 'speaker' || !this.earphones;
  }

  private onEarphonesChange(connected: boolean): void {
    if (this.ended) return;
    clearTimeout(this.earphonesGoneTimer);
    if (!connected) {
      this.earphonesGoneTimer = setTimeout(() => void this.earphonesGone(), EARPHONES_GONE_MS);
      return;
    }
    if (this.earphones) return; // back within a moment
    this.earphones = true;
    this.voice.reset();
    if (this.settings.output === 'earphones') this.toast('Earphones connected. Translations play in them.');
    this.updateMic();
  }

  private async earphonesGone(): Promise<void> {
    const connected = await earphonesConnected();
    if (this.ended || connected || !this.earphones) return;
    if (this.mic?.input.input === 'earphones') {
      this.end({ message: 'The earphones were disconnected. Start again to continue.', code: 'earphones' });
      return;
    }
    this.earphones = false;
    // Like music apps: never carry on out loud when the earphones are pulled out.
    this.voice.reset();
    this.speech.cancel();
    if (this.settings.output === 'earphones') {
      this.toast('The earphones were disconnected, so translations play on the phone speaker.');
    }
    this.updateMic();
  }

  private setSpeaking(speaking: boolean): void {
    if (this.ended) return;
    clearTimeout(this.speakerTailTimer);
    this.speaking = speaking;
    this.speakerTail = !speaking;
    if (!speaking) {
      this.speakerTailTimer = setTimeout(() => {
        this.speakerTail = false;
        this.updateMic();
      }, SPEAKER_TAIL_MS);
    }
    this.updateMic();
  }

  /**
   * Off while muted or while no talk button is held (in hold-to-talk). Silent while the
   * phone speaker reads a translation, so it does not transcribe itself, unless someone
   * holds the talk button to interrupt.
   */
  private updateMic(): void {
    const mic = this.mic;
    if (!mic || this.ended) return;
    const { muted, holding } = this.state;
    const userOff = muted || (this.settings.talkMode === 'hold' && !holding && !this.holdTail);
    const phoneTalking = this.speakerOutput() && (this.speaking || this.speakerTail) && !holding;
    const mode: MicMode = userOff ? 'off' : phoneTalking ? 'silent' : 'live';
    // The turn is over: have what was just said transcribed and translated now.
    if (mode === 'off' && mic.mode !== 'off') this.backend?.send({ type: 'flush' });
    mic.mode = mode;
    if (this.state.micMode !== mode) this.update({ micMode: mode });
    this.updateStatus();
  }

  private updateStatus(): void {
    const [text, tone] = this.status();
    if (this.state.status.text !== text || this.state.status.tone !== tone) this.update({ status: { text, tone } });
  }

  private status(): [string, StatusTone] {
    if (!this.mic) return ['Starting the microphone…', 'busy'];
    if (this.connectionState === 'connecting') {
      const preparing = this.options.server === undefined && this.settings.engine === 'local' ? 'Getting ready…' : 'Connecting…';
      return [this.progress ?? preparing, 'busy'];
    }
    if (this.connectionState === 'reconnecting') return ['Connection lost. Reconnecting…', 'busy'];
    if (this.recognizer === 'reconnecting') return ['Reconnecting speech recognition…', 'busy'];
    if (this.recognizer === 'starting') return ['Starting…', 'busy'];
    if (this.state.muted) return ['Paused', 'idle'];
    if (this.speaking && this.speakerOutput()) return ['Speaking…', 'speaking'];
    if (this.settings.talkMode === 'hold' && !this.state.holding) {
      return [this.settings.mode === 'solo' ? 'Hold a button to talk' : 'Hold to talk', 'idle'];
    }
    return ['Listening', 'live'];
  }

  private update(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function withEntry(entries: readonly FeedEntry[], entry: FeedEntry): readonly FeedEntry[] {
  const longer = [...entries, entry];
  return longer.length > MAX_ENTRIES ? longer.slice(-MAX_ENTRIES) : longer;
}

/** Changes the state of skipped entries, unless they are gone already. */
function markSkipped(
  entries: readonly FeedEntry[],
  which: (id: string) => boolean,
  state: SkippedState,
): readonly FeedEntry[] {
  return entries.map((entry) =>
    entry.skipped && entry.skipped.state !== 'gone' && which(entry.id)
      ? { ...entry, skipped: { ...entry.skipped, state } }
      : entry,
  );
}

function micLabel(input: CaptureInput): string {
  if (input.input === 'test') return `Test recording: ${input.name}`;
  return input.name || 'Microphone';
}

/** Gives the engines' errors a code, so the screen can offer the right way out. */
function withCode(reason: EndReason): EndReason {
  if (reason.code) return reason;
  if (/rejected the API key/i.test(reason.message)) return { ...reason, code: 'keys' };
  if (/could not be downloaded|still downloading/i.test(reason.message)) return { ...reason, code: 'download' };
  return reason;
}
