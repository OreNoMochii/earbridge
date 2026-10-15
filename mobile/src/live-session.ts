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
import { SKIPPED_KEPT, SOLO_ME, SOLO_THEM } from '../../shared/protocol.ts';
import type {
  ClientMessage,
  Participant,
  PartnerVoice,
  RecordingProblem,
  ServerMessage,
  SkipReason,
  SpeakerSelection,
} from '../../shared/protocol.ts';
import { formatRoomCode } from '../../shared/room-code.ts';
import EarbridgeAudio from '../modules/earbridge-audio/src/EarbridgeAudioModule.ts';
import type { CaptureInput, IsolationEvent } from '../modules/earbridge-audio/src/EarbridgeAudioModule.ts';
import { appFilters, wantsEarphoneMic } from './app-settings.ts';
import type { AppSettings } from './app-settings.ts';
import { earphonesConnected, watchEarphones } from './audio/earphones.ts';
import { MicrophoneError, openMicrophone } from './audio/mic.ts';
import type { KeptVoices, MicMode, Microphone } from './audio/mic.ts';
import { PhoneVoice } from './audio/phone-voice.ts';
import { VoicePlayer } from './audio/voice-player.ts';
import { Connection } from './connection.ts';
import type { ConnectionState, EndReason } from './connection.ts';
import type { Backend, BackendEvents } from './engines/backend.ts';
import { InAppBackend } from './engines/in-app-backend.ts';
import { openTalkReport } from './engines/talk-report.ts';
import type { MicChange, TalkReport } from './engines/talk-report.ts';
import type { InAppOptions } from './engines/in-app-backend.ts';
import { prepareKeys } from './engines/keys.ts';
import { prepareLocal } from './engines/local.ts';
import { VOICE_MODEL_FILE, listPeople, loadMyVoice, readPersonVoice, savePerson } from './engines/voices.ts';
import type { SavedPerson } from './engines/voices.ts';
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

/** One phone, while only the two people's voices are translated: how they are known. */
export interface VoicesView {
  /** How the other person's voice is known (mine always is, from Settings). */
  partner: PartnerVoice;
  /**
   * While their voice is being recorded: `seconds` of it so far, of the `of` seconds
   * needed (0 when not known yet), and maybe a `hint` of what is going wrong.
   */
  recording: { seconds: number; of: number; hint: RecordingProblem | undefined } | undefined;
  /** Why the last recording of their voice did not work, until put away. */
  failed: RecordingProblem | undefined;
  /** The offer to choose them among people whose voices were saved was put away. */
  dismissed: boolean;
  /** Who they are, when their voice is one saved on the phone. */
  name: string | undefined;
  /** Their voice was just recorded: offer to save it for the next talks. */
  offerSave: boolean;
  /** People whose voices are saved on the phone, to choose instead of learning or recording theirs. */
  people: SavedPerson[];
}

export interface LiveState {
  status: { text: string; tone: StatusTone };
  micMode: MicMode;
  micLabel: string;
  /** The microphone to switch to (see switchMic): the earphones' while they are connected, or the phone's. */
  otherMic: 'phone' | 'earphones' | undefined;
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
  /** One phone, while only the two people's voices are translated: how they are known. */
  voices: VoicesView | undefined;
  /** Whether people hold a button while they talk; it can change to that during the conversation. */
  talkMode: AppSettings['talkMode'];
  /** One phone: too loud here for the filters, so holding a button would work better. Until put away. */
  loud: boolean;
}

type ReadyMessage = Extract<ServerMessage, { type: 'ready' }>;
type InterimMessage = Extract<ServerMessage, { type: 'interim' }>;
type UtteranceMessage = Extract<ServerMessage, { type: 'utterance' }>;
type SkippedMessage = Extract<ServerMessage, { type: 'skipped' }>;
type TranslationMessage = Extract<ServerMessage, { type: 'translation' }>;
type SpeechMessage = Extract<ServerMessage, { type: 'speech' }>;
type VoicesMessage = Extract<ServerMessage, { type: 'voices' }>;

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
  /** The way to talk was changed during the conversation, to keep for the next ones. */
  onTalkModeChange?(talkMode: AppSettings['talkMode']): void;
  /** The microphone was switched during the conversation, to keep for the next ones. */
  onMicChange?(mic: 'phone' | 'earphones'): void;
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
  /** What this talk's lines were and why they were skipped, in builds that keep one. */
  private report: TalkReport | undefined;
  /** My voice print, when the microphone may keep only some voices (see keptVoices). */
  private myPrint: Float32Array | undefined;
  /** What the microphone was last asked to keep, in short, so that the talk report notes each change. */
  private isolationNoted: string | undefined;
  private toldSeparating = false;
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
  /** Listen through the earphones' microphone whenever they are connected: as set, or switched to during the talk. */
  private earphoneMic: boolean;
  /** Changes of microphone, one after the other (see changeMic). */
  private micChange: Promise<void> = Promise.resolve();

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
    this.earphoneMic = wantsEarphoneMic(settings);
    this.state = {
      status: { text: 'Starting the microphone…', tone: 'busy' },
      micMode: 'off',
      micLabel: 'Microphone',
      otherMic: undefined,
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
      voices: undefined,
      talkMode: settings.talkMode,
      loud: false,
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
        earphoneMic: this.earphoneMic,
        // Only the phone's own filters use them.
        directions: this.options.server === undefined && appFilters(settings.engine) && settings.ignoreSides,
        onAudio: (pcm, spatial) => this.backend?.sendAudio(pcm, spatial),
        onLevel: (level) => {
          for (const listener of this.levelListeners) listener(level);
        },
        onEnded: (message) => this.end({ message: `${message} Start again to continue.` }),
        // The turn is over: have what was just said transcribed and translated now.
        onTurnEnd: () => this.backend?.send({ type: 'flush' }),
        onSeparation: (event) => this.report?.note({ type: 'separation', ...event }),
        onIsolation: (event) => this.onIsolation(event),
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
    this.report?.note({ type: 'mic', input: mic.input });
    this.update({ micLabel: micLabel(mic.input) });
    this.updateMicSwitch();
    if (this.earphoneMic && this.earphones && mic.input.input === 'phone') {
      this.toast('Listening with the phone’s microphone.');
    }
    if (settings.output === 'earphones' && !this.earphones) {
      this.toast('No earphones · using the phone speaker.');
    }
    this.updateMic();
    await this.keepRunningInBackground();
    if (this.ended) return;

    if (this.separatesVoices()) this.myPrint = loadMyVoice();
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
    const report = openTalkReport(settings);
    this.report = report;
    return new InAppBackend({
      myLang: settings.myLang,
      theirLang: settings.theirLang,
      nearbyOnly: settings.nearbyOnly,
      ignoreSides: settings.ignoreSides,
      prepare,
      ...(report && { report: (entry) => report.note(entry) }),
      ...events,
    });
  }

  /** The user ended the conversation. */
  stop(): void {
    if (this.ended) return;
    this.report?.note({ type: 'end' });
    this.shutDown();
    this.options.onEnded(undefined, undefined);
  }

  private end(reason: EndReason): void {
    if (this.ended) return;
    this.report?.note({ type: 'end', reason: reason.message });
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
      case 'voices':
        this.onVoices(message);
        break;
      case 'loud':
        // Unless a button is held to talk already.
        if (this.state.talkMode === 'handsfree') this.update({ loud: true });
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
      // Holding a button to talk: no filter skips what is heard.
      if (this.state.talkMode === 'hold') this.backend?.send({ type: 'talk-mode', mode: 'hold' });
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
    // A line may have taught how one of the two voices sounds here (see updateIsolation).
    this.updateIsolation();
  }

  private onSkipped(message: SkippedMessage): void {
    const entry: FeedEntry = {
      id: message.id,
      speaker: this.speakerName(message.speakerId, 'Them'),
      lang: message.lang,
      // Not its words: only ours are shown.
      text: '',
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

  private onVoices(message: VoicesMessage): void {
    const before = this.state.voices;
    const progress = message.recording;
    const recording = progress && { seconds: progress.seconds, of: progress.of, hint: progress.hint };
    // Newly recorded: someone not saved, or not yet.
    const recorded = !!before?.recording && !recording && !message.failed && message.partner === 'recorded';
    if (before?.partner === 'unknown' && message.partner === 'learned') this.toast('Their voice is learned.');
    this.update({
      voices: {
        partner: message.partner,
        recording,
        // A failure shows until put away, or until their voice is recorded again.
        failed: message.failed ?? (recording ? undefined : before?.failed),
        dismissed: before?.dismissed ?? false,
        name: recorded || message.partner !== 'recorded' ? undefined : before?.name,
        offerSave: recorded || (!recording && (before?.offerSave ?? false)),
        people: before?.people ?? usablePeople(),
      },
    });
    // The microphone stays on while it records, even in hold-to-talk.
    if (!before?.recording !== !recording) this.updateMic();
    this.updateIsolation();
  }

  /** One phone, translated by the app, with only our voices: whether the microphone may separate them. */
  private separatesVoices(): boolean {
    const { settings } = this;
    return this.options.server === undefined && settings.mode === 'solo' && settings.onlyOurVoices && settings.separateVoices;
  }

  /**
   * The voices the microphone keeps in what it sends, by who is expected to talk (the side
   * held or chosen, see selectSpeaker). While it is me: only my voice, from the start. While
   * it is them: only theirs, once learned from what they said or recorded; until then,
   * everything, so that it can be learned. Sound in no voice like those passes as heard
   * then: whoever holds or chooses a side says the sound is theirs, and my voice can be
   * unlike my recording here until it is learned (see onVoices). Either of us (hands-free,
   * told apart by language): both voices once theirs is known, and nothing in neither,
   * once both have been heard here; until then sound in neither passes as heard too, as
   * either of us may sound unlike the recording. Each voice as heard here, once learned,
   * counts too: a voice can be less like its recording, made somewhere else, than like
   * itself here; learned further from most lines, it is looked up again as each is
   * delivered. Nothing while their voice is being recorded: it is recorded as heard. As it
   * hides the other voices, a voice learned by mistake leaves no skipped line to tap:
   * "Not them" (forgetPartner) puts it right.
   */
  private keptVoices(): KeptVoices | undefined {
    const voices = this.state.voices;
    const mine = this.myPrint;
    if (!this.separatesVoices() || !mine || !voices || voices.recording) return undefined;
    const known = voices.partner === 'learned' || voices.partner === 'recorded';
    const theirs = known ? this.backend?.partnerVoice?.() : undefined;
    const here = (side: 'me' | 'them') => this.backend?.voiceHere?.(side);
    const learned = (prints: (Float32Array | undefined)[]) => prints.filter((print) => print !== undefined);
    const model = VOICE_MODEL_FILE;
    const speaker = this.state.speaker;
    if (speaker === SOLO_ME) return { model, prints: learned([mine, here('me')]), passUnmatched: true };
    if (!theirs) return undefined;
    if (speaker === SOLO_THEM) return { model, prints: learned([theirs, here('them')]), passUnmatched: true };
    const mineHere = here('me');
    const theirsHere = here('them');
    return { model, prints: learned([mine, theirs, mineHere, theirsHere]), passUnmatched: !mineHere || !theirsHere };
  }

  /** Has the microphone keep the voices of the moment (see keptVoices), noting a change in the talk report. */
  private updateIsolation(): void {
    const mic = this.mic;
    if (!mic || this.ended) return;
    const kept = this.keptVoices();
    if (!mic.isolate(kept)) return;
    const asked = kept !== undefined;
    const prints = kept?.prints.length ?? 0;
    const speaker = this.state.speaker ?? 'auto';
    const passUnmatched = kept?.passUnmatched ?? false;
    const noted = [asked, prints, speaker, passUnmatched].join(' ');
    if (noted === this.isolationNoted) return;
    this.isolationNoted = noted;
    this.report?.note({ type: 'isolation', asked, prints, speaker, passUnmatched });
  }

  private onIsolation(event: IsolationEvent): void {
    this.report?.note({ type: 'isolation', ...event });
    if (event.state === 'on' && !this.toldSeparating) {
      this.toldSeparating = true;
      this.toast('Separating voices.');
    } else if (event.state === 'slow') {
      this.toast('Phone too slow to separate voices.');
    } else if (event.state === 'failed') {
      this.toast('Couldn’t separate voices.');
    }
  }

  /** Reads a translation aloud: with the natural voice if there is one, else the phone's own. */
  private async speak(item: SpeechItem): Promise<void> {
    if (item.audio) {
      try {
        await this.voice.play(item.audio);
        return;
      } catch {
        this.warnVoice('Natural voice unavailable · using the phone’s own voice.');
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
      const voices = this.state.voices;
      if (voices?.recording) {
        this.update({ voices: { ...voices, recording: undefined } });
        this.updateMic();
        this.updateIsolation();
      }
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

  /**
   * One phone, while only the two people's voices are translated: records the other
   * person's voice from what the microphone hears next, for this conversation only.
   */
  recordPartner(): void {
    const voices = this.state.voices;
    if (this.ended || this.connectionState !== 'ready' || !voices || voices.recording) return;
    // Until the engine says how it goes, which it does straight away.
    this.update({ voices: { ...voices, recording: { seconds: 0, of: 0, hint: undefined }, failed: undefined } });
    // Their voice as heard: nothing separated out.
    this.updateIsolation();
    // They speak their language: recognized as theirs, they are translated meanwhile.
    if (this.state.speaker === SOLO_ME) this.selectSpeaker(SOLO_THEM);
    this.setMuted(false);
    this.backend?.send({ type: 'record-voice' });
    this.updateMic();
  }

  /** Stops recording their voice, keeping what was known of it before. */
  stopRecording(): void {
    const voices = this.state.voices;
    if (this.ended || !voices?.recording) return;
    this.update({ voices: { ...voices, recording: undefined } });
    this.backend?.send({ type: 'stop-recording' });
    this.updateMic();
  }

  /** Puts away the offer to choose them among saved people, or what says a recording did not work. */
  dismissVoices(): void {
    const voices = this.state.voices;
    if (!this.ended && voices) this.update({ voices: { ...voices, dismissed: true, failed: undefined } });
  }

  /** One phone: they are someone whose voice was saved in an earlier talk, so it needs no recording. */
  usePartner(person: SavedPerson): void {
    if (this.ended || this.connectionState !== 'ready' || !this.state.voices) return;
    const print = readPersonVoice(person.id)?.print;
    // Stopped first, so that it does not count as a new voice recorded (see onVoices).
    this.stopRecording();
    if (!print || !this.backend?.usePartnerVoice?.(print)) {
      this.toast(`Couldn’t use ${person.name}’s voice. Record it instead.`);
      return;
    }
    const voices = this.state.voices;
    if (voices) this.update({ voices: { ...voices, name: person.name, offerSave: false, failed: undefined, dismissed: true } });
    // Their print may be new even when the engine says nothing new.
    this.updateIsolation();
  }

  /**
   * One phone: the voice learned for them is someone else's, so it is forgotten, and theirs
   * is learned afresh as they talk. Every voice is heard again meanwhile.
   */
  forgetPartner(): void {
    const voices = this.state.voices;
    if (this.ended || this.connectionState !== 'ready' || voices?.partner !== 'learned') return;
    this.update({ voices: { ...voices, partner: 'unknown' } });
    this.backend?.send({ type: 'forget-voice' });
    this.updateIsolation();
    this.toast('Their voice is learned again as they talk.');
  }

  /**
   * Saves their voice as recorded or learned in this talk on the phone, under their name,
   * for the next talks. Only with their OK. False if it could not be saved.
   */
  async savePartner(name: string): Promise<boolean> {
    const print = this.backend?.partnerVoice?.();
    if (!print) return false;
    try {
      const person = await savePerson(name, print);
      const voices = this.state.voices;
      if (voices && !this.ended) {
        const people = [person, ...voices.people.filter((other) => other.id !== person.id)];
        this.update({ voices: { ...voices, name: person.name, offerSave: false, people } });
        // Theirs for sure now, as when chosen among saved people.
        if (voices.partner === 'learned') this.backend?.usePartnerVoice?.(print);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Puts away the offer to save their voice. */
  dismissSave(): void {
    const voices = this.state.voices;
    if (!this.ended && voices) this.update({ voices: { ...voices, offerSave: false } });
  }

  /**
   * One phone: from now on, whoever talks holds their button meanwhile, which works better
   * where it is loud. Kept for the next conversations too.
   */
  holdToTalk(): void {
    if (this.ended || this.state.talkMode === 'hold') return;
    this.update({ talkMode: 'hold', loud: false });
    // If not connected, onReady sends it once the connection is back.
    this.backend?.send({ type: 'talk-mode', mode: 'hold' });
    this.options.onTalkModeChange?.('hold');
    // Holding a button has no pause.
    this.setMuted(false);
    this.updateMic();
  }

  /** Puts away the advice to hold a button to talk. */
  dismissLoud(): void {
    if (!this.ended && this.state.loud) this.update({ loud: false });
  }

  selectSpeaker(selection: SpeakerSelection): void {
    if (this.ended || this.state.speaker === selection) return;
    this.update({ speaker: selection });
    // If not connected, onReady sends it once the connection is back.
    this.backend?.send({ type: 'speaker', speaker: selection });
    // The microphone keeps that side's voice.
    this.updateIsolation();
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
    this.updateMicSwitch();
    if (this.state.otherMic === 'earphones') {
      if (this.earphoneMic) this.changeMic('connected');
      else this.toast('Earphones connected · tap the microphone to use theirs.');
    } else if (this.settings.output === 'earphones') {
      this.toast('Earphones connected.');
    }
    this.updateMic();
  }

  private async earphonesGone(): Promise<void> {
    const connected = await earphonesConnected();
    if (this.ended || connected || !this.earphones) return;
    this.earphones = false;
    // Like music apps: never carry on out loud when the earphones are pulled out.
    this.voice.reset();
    this.speech.cancel();
    if (this.mic?.input.input === 'earphones') {
      this.changeMic('disconnected');
    } else {
      this.updateMicSwitch();
      if (this.settings.output === 'earphones') this.toast('Earphones disconnected · using the phone speaker.');
    }
    this.updateMic();
  }

  /**
   * Listens through the earphones' microphone (while they are connected) or the phone's
   * from now on, in this conversation and the next ones.
   */
  switchMic(input: 'phone' | 'earphones'): void {
    if (this.ended || !this.mic) return;
    this.earphoneMic = input === 'earphones';
    this.options.onMicChange?.(input);
    this.changeMic('switched');
  }

  /** Changes happen one after the other: switching to Bluetooth earphones takes a second or two. */
  private changeMic(change: MicChange): void {
    this.micChange = this.micChange.then(() => this.applyMic(change));
  }

  private async applyMic(change: MicChange): Promise<void> {
    const mic = this.mic;
    if (!mic || this.ended || mic.input.input === 'test') return;
    const wanted = this.earphoneMic && this.earphones;
    if ((mic.input.input === 'earphones') === wanted) {
      this.updateMicSwitch();
      return;
    }
    this.update({ micLabel: 'Switching the microphone…', otherMic: undefined });
    let input: CaptureInput;
    try {
      input = await mic.switchInput(wanted);
    } catch (error) {
      this.end({ message: `${error instanceof Error ? error.message : String(error)} Start again to continue.` });
      return;
    }
    if (this.ended) return;
    this.report?.note({ type: 'mic', input, change });
    this.update({ micLabel: micLabel(input) });
    this.updateMicSwitch();
    if (wanted && input.input !== 'earphones') {
      this.toast(
        change === 'connected'
          ? 'Earphones connected · their microphone couldn’t be used, listening with the phone’s.'
          : 'The earphones’ microphone couldn’t be used · listening with the phone’s.',
      );
    } else if (change === 'connected') {
      this.toast('Earphones connected · listening with their microphone.');
    } else if (change === 'disconnected') {
      this.toast('Earphones disconnected · using the phone’s microphone and speaker.');
    }
    this.updateMic();
  }

  /** Whether there is another microphone to switch to: the earphones' while they are connected, or the phone's. */
  private updateMicSwitch(): void {
    const input = this.mic?.input.input;
    const otherMic = !input || input === 'test' || !this.earphones ? undefined : input === 'earphones' ? 'phone' : 'earphones';
    if (this.state.otherMic !== otherMic) this.update({ otherMic });
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
   * Off while muted or while no talk button is held (in hold-to-talk), unless the other
   * person's voice is being recorded. Silent while the phone speaker reads a translation,
   * so it does not transcribe itself, unless someone holds the talk button to interrupt.
   */
  private updateMic(): void {
    const mic = this.mic;
    if (!mic || this.ended) return;
    const { muted, holding } = this.state;
    const recording = this.state.voices?.recording !== undefined;
    const userOff = muted || (this.state.talkMode === 'hold' && !holding && !this.holdTail && !recording);
    const phoneTalking = this.speakerOutput() && (this.speaking || this.speakerTail) && !holding;
    const mode: MicMode = userOff ? 'off' : phoneTalking ? 'silent' : 'live';
    // Going off ends the turn: see onTurnEnd.
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
    if (this.state.talkMode === 'hold' && !this.state.holding && !this.state.voices?.recording) {
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

/** People whose saved voices this phone can use: printed by the current speaker model. */
function usablePeople(): SavedPerson[] {
  return listPeople().filter((person) => readPersonVoice(person.id) !== undefined);
}
