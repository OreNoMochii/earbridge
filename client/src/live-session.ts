// One conversation, from the Start tap until it ends: wires the microphone, the server
// connection, the transcript and the spoken translations together.

import { sameLanguage } from '../../shared/languages.ts';
import { SOLO_ME } from '../../shared/protocol.ts';
import type { ClientMessage, Participant, ServerMessage, SpeakerSelection } from '../../shared/protocol.ts';
import { Microphone, MicrophoneError } from './audio/mic.ts';
import type { MicMode } from './audio/mic.ts';
import { Connection } from './connection.ts';
import type { ConnectionState, EndReason } from './connection.ts';
import { LiveView } from './live-view.ts';
import type { HoldTarget, StatusTone } from './live-view.ts';
import type { Settings } from './settings.ts';
import { OrderedSpeechQueue } from './speech-queue.ts';
import type { SpeechOutput } from './tts.ts';
import { ScreenWakeLock } from './wake-lock.ts';

/** After the phone speaker stops, its echo in the room takes a moment to die down. */
const SPEAKER_TAIL_MS = 300;
/** People let go of the button while finishing their last word. */
const HOLD_TAIL_MS = 250;

type ReadyMessage = Extract<ServerMessage, { type: 'ready' }>;
type InterimMessage = Extract<ServerMessage, { type: 'interim' }>;
type UtteranceMessage = Extract<ServerMessage, { type: 'utterance' }>;
type TranslationMessage = Extract<ServerMessage, { type: 'translation' }>;

export interface LiveSessionOptions {
  settings: Settings;
  /** Created and resumed during the Start tap; the session closes it when it ends. */
  context: AudioContext;
  speech: SpeechOutput;
  /** Room mode: the room to join, or undefined to start a new one. */
  room: string | undefined;
  container: HTMLElement;
  /**
   * The session is over: `reason` is undefined when the user ended it. `room` is the
   * room it was in, if any, so it can be offered again after an error.
   */
  onEnded(reason: EndReason | undefined, room: string | undefined): void;
}

export class LiveSession {
  private readonly options: LiveSessionOptions;
  private readonly settings: Settings;
  private readonly view: LiveView;
  private readonly queue: OrderedSpeechQueue;
  private readonly wakeLock = new ScreenWakeLock();
  private mic: Microphone | undefined;
  private connection: Connection | undefined;
  private connectionState: ConnectionState = 'connecting';
  private recognizer: 'starting' | 'live' | 'reconnecting' = 'starting';
  private ended = false;

  // One-phone mode: who the recognizer should expect, as chosen here.
  private speaker: SpeakerSelection | undefined;

  // Room mode. Every reconnection gets a new id, and the server may briefly still list
  // an old one, so all of them count as "me".
  private roomCode: string | undefined;
  private readonly myIds = new Set<string>();
  private others: Participant[] = [];
  private announceChanges = false;

  // What decides whether the microphone is sent (see updateMic).
  private muted = false;
  private holding: HoldTarget | undefined;
  private holdTail = false;
  private speaking = false;
  private speakerTail = false;
  private holdTailTimer: number | undefined;
  private speakerTailTimer: number | undefined;

  /** Utterances whose translation will be spoken on this phone. */
  private readonly toSpeak = new Set<string>();
  /** One-phone mode: my utterances, whose translations are shown to the other person. */
  private readonly forPartner = new Set<string>();

  constructor(options: LiveSessionOptions) {
    this.options = options;
    this.settings = options.settings;
    const { settings } = options;
    this.view = new LiveView({
      mode: settings.mode,
      myLang: settings.myLang,
      theirLang: settings.theirLang,
      talkMode: settings.talkMode,
      onEnd: () => this.stop(),
      onMuteChange: (muted) => this.setMuted(muted),
      onSpeakerSelect: (selection) => this.selectSpeaker(selection),
      onHoldChange: (target, pressed) => this.setHolding(target, pressed),
    });
    this.queue = new OrderedSpeechQueue({
      speak: (item) => options.speech.speak(item.text, item.lang),
      onSpeakingChange: (speaking) => this.setSpeaking(speaking),
    });
  }

  async start(): Promise<void> {
    const { context, speech } = this.options;
    this.options.container.replaceChildren(this.view.element);
    speech.onWarning = (message) => this.view.toast(message);
    this.wakeLock.start();
    document.addEventListener('visibilitychange', this.resumeAudio);
    // A tap is what allows audio to resume after the phone interrupted it.
    document.addEventListener('pointerdown', this.resumeAudio, true);
    context.addEventListener('statechange', this.onContextStateChange);
    this.updateStatus();

    let mic: Microphone;
    try {
      mic = await Microphone.open(context, {
        deviceId: this.settings.micId,
        // In a room the mic only needs its wearer. With one phone, suppression could
        // treat the other person's (more distant) voice as noise.
        noiseSuppression: this.settings.mode === 'room',
        onAudio: (pcm) => this.connection?.sendAudio(pcm),
        onLevel: (level) => this.view.setLevel(level),
        onEnded: () =>
          this.end({
            message:
              'The microphone stopped, for example because the earphones were disconnected. Start again to continue.',
          }),
      });
    } catch (error) {
      this.end({
        message: error instanceof MicrophoneError ? error.message : `Could not start the microphone: ${String(error)}`,
      });
      return;
    }
    if (this.ended) {
      mic.stop();
      return;
    }
    this.mic = mic;
    this.view.setMicLabel(mic.label);
    this.updateMic();

    this.connection = new Connection({
      hello: () => this.hello(),
      onMessage: (message) => this.handle(message),
      onStateChange: (state) => this.setConnectionState(state),
      onEnded: (reason) => this.end(reason),
    });
    this.connection.start();
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
    this.options.onEnded(reason, this.roomCode ?? this.options.room);
  }

  private shutDown(): void {
    this.ended = true;
    window.clearTimeout(this.holdTailTimer);
    window.clearTimeout(this.speakerTailTimer);
    this.mic?.stop();
    this.connection?.stop();
    this.queue.clear();
    this.options.speech.cancel();
    this.options.speech.onWarning = undefined;
    this.wakeLock.stop();
    this.view.destroy();
    document.removeEventListener('visibilitychange', this.resumeAudio);
    document.removeEventListener('pointerdown', this.resumeAudio, true);
    this.options.context.removeEventListener('statechange', this.onContextStateChange);
    void this.options.context.close().catch(() => {});
  }

  private hello(): ClientMessage {
    const { settings } = this;
    const token = settings.token.trim() || undefined;
    if (settings.mode === 'solo') {
      return { type: 'hello', mode: 'solo', myLang: settings.myLang, theirLang: settings.theirLang, token };
    }
    // After a reconnection, go back to the same room.
    const room = this.roomCode ?? this.options.room;
    return { type: 'hello', mode: 'room', lang: settings.myLang, name: settings.name, room, token };
  }

  private handle(message: ServerMessage): void {
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
      case 'translation':
        this.onTranslation(message);
        break;
      case 'status':
        // "connecting" also follows every switch of speaker, which is not worth
        // announcing; only the first one counts (see onReady).
        if (message.stt !== 'connecting') this.recognizer = message.stt;
        this.updateStatus();
        break;
      case 'error':
        this.view.toast(message.message);
        break;
    }
  }

  private onReady(message: ReadyMessage): void {
    this.myIds.add(message.clientId);
    this.recognizer = 'starting';
    this.announceChanges = false;

    if (message.mode === 'solo') {
      this.view.setAutoDetect(message.autoDetect);
      const wanted = this.speaker ?? message.speaker ?? 'auto';
      this.speaker = wanted === 'auto' && !message.autoDetect ? message.speaker : wanted;
      // The server starts from its default; repeat a choice made before a reconnection.
      if (this.speaker && this.speaker !== message.speaker) {
        this.connection?.send({ type: 'speaker', speaker: this.speaker });
      }
      if (this.speaker) this.view.setSpeaker(this.speaker);
    } else if (message.room) {
      const created = this.roomCode === undefined && this.options.room === undefined;
      this.roomCode = message.room;
      this.view.setRoomCode(message.room);
      // A reload (or a shared screenshot of the address) leads back to this room.
      history.replaceState(history.state, '', `${location.pathname}?room=${message.room}`);
      if (created) this.view.showInvite(true);
    }
  }

  private onParticipants(participants: readonly Participant[]): void {
    const others = participants.filter((participant) => !this.myIds.has(participant.id));
    if (this.announceChanges) {
      const before = new Set(this.others.map((participant) => participant.name));
      const after = new Set(others.map((participant) => participant.name));
      for (const name of after) if (!before.has(name)) this.view.toast(`${name} joined.`);
      for (const name of before) if (!after.has(name)) this.view.toast(`${name} left.`);
    }
    // The first list after (re)joining is everyone already there, not news.
    this.announceChanges = true;
    this.others = others;
    this.view.setParticipants([
      { name: this.settings.name, lang: this.settings.myLang, me: true },
      ...others.map((participant) => ({ name: participant.name, lang: participant.lang, me: false })),
    ]);
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
    const mine = this.isMine(message.speakerId);
    this.view.feed.setInterim(key, this.speakerName(message.speakerId, '…'), message.lang, message.text, mine);
  }

  private onUtterance(message: UtteranceMessage): void {
    const { settings } = this;
    const solo = settings.mode === 'solo';
    const mine = this.isMine(message.speakerId);
    this.view.feed.clearInterim(solo ? 'solo' : message.speakerId);

    // One phone: everything is translated for the other side. Room: this phone only
    // receives translations of other people speaking another language.
    let translationLang: string | undefined;
    if (solo) translationLang = mine ? settings.theirLang : settings.myLang;
    else if (!mine && !sameLanguage(message.lang, settings.myLang)) translationLang = settings.myLang;

    this.view.feed.addUtterance({
      id: message.id,
      speaker: this.speakerName(message.speakerId, message.speakerName),
      lang: message.lang,
      text: message.text,
      mine,
      translationLang,
    });

    if (solo && mine) {
      this.forPartner.add(message.id);
      this.view.showPartnerTranslation('', false);
    }
    // With earphones, only what the other person said is played (in my ears); on the
    // speaker, my words are read out in their language too.
    const speak = translationLang !== undefined && (!solo || !mine || settings.output === 'speaker');
    if (speak) {
      this.toSpeak.add(message.id);
      this.queue.expect(message.id);
    }
  }

  private onTranslation(message: TranslationMessage): void {
    this.view.feed.updateTranslation(message.id, message.text, message.done, message.error);
    if (this.forPartner.has(message.id)) {
      this.view.showPartnerTranslation(message.text, message.done, message.error);
      if (message.done) this.forPartner.delete(message.id);
    }
    if (!message.done || !this.toSpeak.delete(message.id)) return;
    if (message.text && !message.error) this.queue.ready({ id: message.id, text: message.text, lang: message.lang });
    else this.queue.skip(message.id);
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    if (state !== 'ready') {
      // The server-side session is gone, and with it every translation in progress.
      this.queue.skipPending();
      this.toSpeak.clear();
      this.forPartner.clear();
      this.view.feed.clearInterims();
      this.view.feed.interruptPending();
    }
    this.updateStatus();
  }

  private selectSpeaker(selection: SpeakerSelection): void {
    if (this.speaker === selection) return;
    this.speaker = selection;
    this.view.setSpeaker(selection);
    // If not connected, onReady sends it once the connection is back.
    this.connection?.send({ type: 'speaker', speaker: selection });
  }

  private setMuted(muted: boolean): void {
    this.muted = muted;
    this.view.setMuted(muted);
    this.updateMic();
  }

  private setHolding(target: HoldTarget, pressed: boolean): void {
    if (this.ended) return; // the view releases its buttons when destroyed
    if (pressed) {
      if (this.holding) return; // a second finger on the other button
      this.holding = target;
      window.clearTimeout(this.holdTailTimer);
      this.holdTail = false;
      if (target !== 'room') this.selectSpeaker(target);
      // Do not talk over the person talking.
      this.queue.setPaused(true);
      if (this.settings.output === 'speaker') this.options.speech.cancel();
    } else {
      if (this.holding !== target) return;
      this.holding = undefined;
      this.holdTail = true;
      this.holdTailTimer = window.setTimeout(() => {
        this.holdTail = false;
        this.updateMic();
      }, HOLD_TAIL_MS);
      this.queue.setPaused(false);
    }
    this.updateMic();
  }

  private setSpeaking(speaking: boolean): void {
    if (this.ended) return;
    window.clearTimeout(this.speakerTailTimer);
    this.speaking = speaking;
    this.speakerTail = !speaking;
    if (!speaking) {
      this.speakerTailTimer = window.setTimeout(() => {
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
    const userOff = this.muted || (this.settings.talkMode === 'hold' && !this.holding && !this.holdTail);
    const phoneTalking =
      this.settings.output === 'speaker' && (this.speaking || this.speakerTail) && !this.holding;
    const mode: MicMode = userOff ? 'off' : phoneTalking ? 'silent' : 'live';
    // The turn is over: have what was just said transcribed and translated now.
    if (mode === 'off' && mic.mode !== 'off') this.connection?.send({ type: 'flush' });
    mic.mode = mode;
    this.view.setMicMode(mode);
    this.updateStatus();
  }

  private updateStatus(): void {
    const [text, tone] = this.status();
    this.view.setStatus(text, tone);
  }

  private status(): [string, StatusTone] {
    if (!this.mic) return ['Starting the microphone…', 'busy'];
    if (this.connectionState === 'connecting') return ['Connecting…', 'busy'];
    if (this.connectionState === 'reconnecting') return ['Connection lost. Reconnecting…', 'busy'];
    if (this.recognizer === 'reconnecting') return ['Reconnecting speech recognition…', 'busy'];
    if (this.recognizer === 'starting') return ['Starting…', 'busy'];
    if (this.muted) return ['Muted', 'idle'];
    if (this.speaking && this.settings.output === 'speaker') return ['Speaking…', 'speaking'];
    if (this.settings.talkMode === 'hold' && !this.holding) return ['Hold to talk', 'idle'];
    return ['Listening', 'live'];
  }

  private readonly resumeAudio = (): void => {
    const { context } = this.options;
    if (this.ended || document.visibilityState !== 'visible') return;
    if (context.state !== 'running' && context.state !== 'closed') void context.resume().catch(() => {});
  };

  /** Phones suspend audio for calls, alarms or other apps; try to get it back. */
  private readonly onContextStateChange = (): void => {
    const { context } = this.options;
    if (this.ended || context.state === 'running' || context.state === 'closed') return;
    this.resumeAudio();
    window.setTimeout(() => {
      if (!this.ended && context.state !== 'running' && context.state !== 'closed') {
        this.view.toast('The phone paused the microphone. Tap the screen to continue.');
      }
    }, 1_000);
  };
}
