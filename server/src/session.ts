import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isSupportedLanguage, sameLanguage } from '../../shared/languages.ts';
import { AUDIO_SAMPLE_RATE } from '../../shared/protocol.ts';
import type { ErrorCode, ServerMessage, SpeakerSelection } from '../../shared/protocol.ts';
import { normalizeRoomCode } from '../../shared/room-code.ts';
import type { Logger } from './log.ts';
import type { Room, RoomMember, RoomRegistry } from './rooms.ts';
import { SoloConversation } from './solo.ts';
import { UtteranceSegmenter } from './stt/segmenter.ts';
import type { SttProvider, SttStream } from './stt/types.ts';
import type { Translator } from './translate/types.ts';
import type { SpeechSynthesizer } from './voice/types.ts';

export interface Transport {
  send(message: ServerMessage): void;
  /** Close the connection because the session ended; the client should not reconnect. */
  close(): void;
}

export interface SessionDeps {
  stt: SttProvider;
  translator: Translator;
  /** Natural voices; without one, phones read translations with their own voice. */
  synthesizer: SpeechSynthesizer | undefined;
  rooms: RoomRegistry;
  /** When set, clients must present this shared secret in their hello message. */
  accessToken: string | undefined;
  log: Logger;
}

const HELLO_TIMEOUT_MS = 15_000;
const MAX_TEXT_MESSAGE_LENGTH = 4 * 1024;
const MAX_AUDIO_CHUNK_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 40;
const SPEAKER_SELECTIONS: readonly SpeakerSelection[] = ['auto', 'me', 'them'];

/**
 * One connected phone. It sends `hello` to start either a one-phone (solo) conversation
 * or to create/join a room, then streams microphone audio.
 */
export class ClientSession {
  readonly id = randomUUID();
  private readonly transport: Transport;
  private readonly deps: SessionDeps;
  private readonly audioBudget = new AudioBudget();
  private readonly helloTimer: NodeJS.Timeout;
  private started = false;
  private closed = false;
  private solo: SoloConversation | undefined;
  private room: Room | undefined;
  private roomStream: SttStream | undefined;

  constructor(transport: Transport, deps: SessionDeps) {
    this.transport = transport;
    this.deps = deps;
    this.helloTimer = setTimeout(() => this.fail('No hello message received.'), HELLO_TIMEOUT_MS);
    this.helloTimer.unref();
  }

  handleText(raw: string): void {
    if (this.closed) return;
    const message = raw.length <= MAX_TEXT_MESSAGE_LENGTH ? parseObject(raw) : undefined;

    switch (message?.['type']) {
      case 'hello':
        this.hello(message!);
        return;
      case 'speaker':
        this.speaker(message!['speaker']);
        return;
      case 'flush':
        this.solo?.flush();
        this.roomStream?.finalize();
        return;
      default:
        this.send({ type: 'error', message: 'Invalid message.', fatal: false });
    }
  }

  handleAudio(chunk: Buffer): void {
    if (this.closed || !this.started) return;
    // PCM16 samples are two bytes; an odd length would misalign everything after it.
    if (chunk.length === 0 || chunk.length > MAX_AUDIO_CHUNK_BYTES || chunk.length % 2 !== 0) return;
    if (!this.audioBudget.take(chunk.length)) return;
    this.solo?.sendAudio(chunk);
    this.roomStream?.sendAudio(chunk);
  }

  /** The connection is gone. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    this.solo?.close();
    this.roomStream?.close();
    if (this.room) this.deps.rooms.leave(this.room, this.id);
  }

  private hello(message: Record<string, unknown>): void {
    if (this.started) {
      this.send({ type: 'error', message: 'The session has already started.', fatal: false });
      return;
    }
    clearTimeout(this.helloTimer);

    const denied = this.checkAccess(message['token']);
    if (denied) {
      this.fail(denied, 'unauthorized');
      return;
    }

    if (message['mode'] === 'solo') this.startSolo(message);
    else if (message['mode'] === 'room') this.startRoom(message);
    else this.fail('Unknown mode.');
  }

  private checkAccess(token: unknown): string | undefined {
    const expected = this.deps.accessToken;
    if (expected === undefined) return undefined;
    if (typeof token !== 'string' || token === '') return 'This server requires an access code.';
    // Compare digests so the comparison takes the same time whatever the input length.
    const digest = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(token), digest(expected)) ? undefined : 'Wrong access code.';
  }

  private startSolo(message: Record<string, unknown>): void {
    const myLang = message['myLang'];
    const theirLang = message['theirLang'];
    if (!isSupportedLanguage(myLang) || !isSupportedLanguage(theirLang)) {
      this.fail('Unsupported language.');
      return;
    }
    if (sameLanguage(myLang, theirLang)) {
      this.fail('Choose two different languages.');
      return;
    }

    const voiceLangs = this.voiceLangs(message['voiceLangs'], [myLang, theirLang]);
    this.started = true;
    this.solo = new SoloConversation({
      myLang,
      theirLang,
      voiceLangs,
      stt: this.deps.stt,
      translator: this.deps.translator,
      synthesizer: this.deps.synthesizer,
      send: (m) => this.send(m),
      onFatal: (error) => this.fail(error.message),
      log: this.deps.log,
    });
    this.send({
      type: 'ready',
      clientId: this.id,
      mode: 'solo',
      autoDetect: this.solo.autoDetect,
      speaker: this.solo.speaker,
      voiceLangs,
    });
    this.solo.start();
  }

  private startRoom(message: Record<string, unknown>): void {
    const lang = message['lang'];
    if (!isSupportedLanguage(lang)) {
      this.fail('Unsupported language.');
      return;
    }
    let code: string | undefined;
    if (message['room'] !== undefined) {
      code = typeof message['room'] === 'string' ? normalizeRoomCode(message['room']) : undefined;
      if (!code) {
        this.fail('That room code is not valid.', 'room_not_found');
        return;
      }
    }

    const voiceLangs = this.voiceLangs(message['voiceLangs'], [lang]);
    const member: RoomMember = {
      id: this.id,
      name: sanitizeName(message['name']),
      lang,
      voice: voiceLangs.length > 0,
      send: (m) => this.send(m),
    };
    const result = code ? this.deps.rooms.join(code, member) : this.deps.rooms.create(member);
    if (!result.ok) {
      this.fail(result.error, result.code);
      return;
    }

    const room = result.room;
    this.started = true;
    this.room = room;
    this.send({ type: 'ready', clientId: this.id, mode: 'room', room: room.code, autoDetect: false, voiceLangs });
    room.announce();

    // In a room each phone's microphone only has to capture its own wearer, whose
    // language is known.
    const segmenter = new UtteranceSegmenter({
      interim: (text) => {
        if (!this.closed) room.interim(member, text);
      },
      utterance: (text) => {
        if (!this.closed) room.utterance(member, text);
      },
    });
    this.roomStream = this.deps.stt.open(
      { language: lang },
      {
        onResult: (result) => segmenter.handleResult(result),
        onUtteranceEnd: () => segmenter.handleUtteranceEnd(),
        onStatus: (status) => this.send({ type: 'status', stt: status }),
        onError: (error, fatal) => {
          if (fatal) this.fail(error.message);
          else this.deps.log.warn(`speech recognition (${lang})`, error);
        },
        onClosed: () => segmenter.flush(),
      },
    );
  }

  /** The requested languages that will be read aloud by a natural voice. */
  private voiceLangs(requested: unknown, listening: readonly string[]): string[] {
    const { synthesizer } = this.deps;
    if (!synthesizer || !Array.isArray(requested)) return [];
    return listening.filter((lang) => requested.includes(lang) && synthesizer.supports(lang));
  }

  private speaker(selection: unknown): void {
    if (!this.solo) return;
    if (!SPEAKER_SELECTIONS.includes(selection as SpeakerSelection)) {
      this.send({ type: 'error', message: 'Invalid message.', fatal: false });
      return;
    }
    if (!this.solo.setSpeaker(selection as SpeakerSelection)) {
      this.send({
        type: 'error',
        message: 'Automatic speaker detection is not available for this language pair.',
        fatal: false,
      });
    }
  }

  private send(message: ServerMessage): void {
    if (!this.closed) this.transport.send(message);
  }

  private fail(message: string, code?: ErrorCode): void {
    if (this.closed) return;
    this.send({ type: 'error', message, fatal: true, ...(code ? { code } : {}) });
    this.close();
    this.transport.close();
  }
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Display names are shown to other people and included in translation context. */
export function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') return 'Guest';
  const name = value
    // Control characters, markup brackets and bidirectional overrides.
    .replace(/[\u0000-\u001f\u007f-\u009f<>‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(name).slice(0, MAX_NAME_LENGTH).join('').trim() || 'Guest';
}

/**
 * Token bucket over incoming audio bytes. Audio arriving much faster than real time is
 * dropped: it could only come from a misbehaving client and would burn recognizer credit.
 */
class AudioBudget {
  private static readonly BYTES_PER_SECOND = AUDIO_SAMPLE_RATE * 2;
  private static readonly RATE = AudioBudget.BYTES_PER_SECOND * 1.5;
  private static readonly CAPACITY = AudioBudget.BYTES_PER_SECOND * 10;
  private tokens = AudioBudget.CAPACITY;
  private last = Date.now();

  take(bytes: number, now = Date.now()): boolean {
    this.tokens = Math.min(AudioBudget.CAPACITY, this.tokens + ((now - this.last) / 1000) * AudioBudget.RATE);
    this.last = now;
    if (bytes > this.tokens) return false;
    this.tokens -= bytes;
    return true;
  }
}
