import { randomInt, randomUUID } from 'node:crypto';
import { sameLanguage } from '../../shared/languages.ts';
import type { ErrorCode, Participant, ServerMessage } from '../../shared/protocol.ts';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../shared/room-code.ts';
import { ConversationHistory } from './history.ts';
import type { Logger } from './log.ts';
import { deliverTranslation } from './translate/deliver.ts';
import type { TranslationRequest, Translator } from './translate/types.ts';
import { deliverSpeech } from './voice/deliver.ts';
import type { SpeechSynthesizer } from './voice/types.ts';

export const MAX_ROOM_SIZE = 10;

export interface RoomMember {
  readonly id: string;
  readonly name: string;
  readonly lang: string;
  /** Wants translations read aloud by a natural voice, which exists for their language. */
  readonly voice: boolean;
  send(message: ServerMessage): void;
}

export interface RoomServices {
  translator: Translator;
  /** Natural voices, for members who want them. */
  synthesizer?: SpeechSynthesizer | undefined;
  log: Logger;
}

function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

/**
 * A conversation between people who each use their own phone and earphones. Everyone
 * sees every utterance; each listener whose language differs from the speaker's gets
 * a translation, made once per target language however many people share it.
 */
export class Room {
  readonly code: string;
  private readonly services: RoomServices;
  private readonly members = new Map<string, RoomMember>();
  private readonly history = new ConversationHistory();
  private inFlight = new AbortController();

  constructor(code: string, services: RoomServices) {
    this.code = code;
    this.services = services;
  }

  get size(): number {
    return this.members.size;
  }

  /** Adds a member silently; call announce() once they have been told they joined. */
  add(member: RoomMember): void {
    this.members.set(member.id, member);
  }

  remove(memberId: string): void {
    if (!this.members.delete(memberId)) return;
    if (this.members.size > 0) {
      this.announce();
    } else {
      // Nobody is left to listen.
      this.inFlight.abort();
      this.inFlight = new AbortController();
    }
  }

  announce(): void {
    const participants: Participant[] = [...this.members.values()].map(({ id, name, lang }) => ({
      id,
      name,
      lang,
    }));
    this.broadcast({ type: 'participants', participants });
  }

  interim(speaker: RoomMember, text: string): void {
    if (!this.isMember(speaker)) return;
    this.broadcast({ type: 'interim', speakerId: speaker.id, lang: speaker.lang, text });
  }

  utterance(speaker: RoomMember, text: string): void {
    if (!this.isMember(speaker)) return;
    const id = randomUUID();
    this.broadcast({
      type: 'utterance',
      id,
      speakerId: speaker.id,
      speakerName: speaker.name,
      lang: speaker.lang,
      text,
    });

    const context = this.history.recent();
    this.history.add({ speaker: speaker.name, lang: speaker.lang, text });

    // Listeners who share the speaker's language hear them directly.
    const listenersByLang = new Map<string, RoomMember[]>();
    for (const member of this.members.values()) {
      if (member === speaker || sameLanguage(member.lang, speaker.lang)) continue;
      const group = listenersByLang.get(member.lang);
      if (group) group.push(member);
      else listenersByLang.set(member.lang, [member]);
    }

    for (const [targetLang, listeners] of listenersByLang) {
      void this.translate(id, listeners, { text, sourceLang: speaker.lang, targetLang, context });
    }
  }

  /**
   * Translates once for everyone listening in one language, then has a natural voice read
   * the translation for those of them who want one.
   */
  private async translate(
    id: string,
    listeners: readonly RoomMember[],
    request: Omit<TranslationRequest, 'onPartial' | 'signal'>,
  ): Promise<void> {
    const { translator, synthesizer, log } = this.services;
    const signal = this.inFlight.signal;
    const sendTo = (members: readonly RoomMember[]) => (message: ServerMessage) => {
      for (const member of members) {
        if (this.isMember(member)) member.send(message);
      }
    };
    const translation = await deliverTranslation(translator, { ...request, signal }, id, sendTo(listeners), log);
    const voiced = listeners.filter((listener) => listener.voice && this.isMember(listener));
    if (!translation || !synthesizer || voiced.length === 0) return;
    await deliverSpeech(synthesizer, { text: translation, lang: request.targetLang, signal }, id, sendTo(voiced), log);
  }

  private isMember(member: RoomMember): boolean {
    return this.members.get(member.id) === member;
  }

  private broadcast(message: ServerMessage): void {
    for (const member of this.members.values()) member.send(message);
  }
}

export type JoinResult =
  | { ok: true; room: Room }
  | { ok: false; error: string; code?: ErrorCode };

export interface RoomRegistryOptions extends RoomServices {
  /** How long an empty room stays joinable, e.g. while someone's phone reconnects. */
  emptyRoomTtlMs?: number;
  maxRooms?: number;
}

export class RoomRegistry {
  private readonly services: RoomServices;
  private readonly emptyRoomTtlMs: number;
  private readonly maxRooms: number;
  private readonly rooms = new Map<string, Room>();
  private readonly expiries = new Map<string, NodeJS.Timeout>();

  constructor(options: RoomRegistryOptions) {
    this.services = { translator: options.translator, synthesizer: options.synthesizer, log: options.log };
    this.emptyRoomTtlMs = options.emptyRoomTtlMs ?? 10 * 60_000;
    this.maxRooms = options.maxRooms ?? 1_000;
  }

  get count(): number {
    return this.rooms.size;
  }

  create(member: RoomMember): JoinResult {
    if (this.rooms.size >= this.maxRooms) {
      return { ok: false, error: 'The server is busy. Try again in a few minutes.' };
    }
    let code: string;
    do code = generateRoomCode();
    while (this.rooms.has(code));

    const room = new Room(code, this.services);
    this.rooms.set(code, room);
    room.add(member);
    return { ok: true, room };
  }

  join(code: string, member: RoomMember): JoinResult {
    const room = this.rooms.get(code);
    if (!room) {
      return {
        ok: false,
        error: `Room ${code} was not found. Check the code, or start a new room.`,
        code: 'room_not_found',
      };
    }
    if (room.size >= MAX_ROOM_SIZE) {
      return { ok: false, error: `Room ${code} is full (${MAX_ROOM_SIZE} people max).` };
    }
    clearTimeout(this.expiries.get(code));
    this.expiries.delete(code);
    room.add(member);
    return { ok: true, room };
  }

  leave(room: Room, memberId: string): void {
    room.remove(memberId);
    if (room.size > 0 || this.rooms.get(room.code) !== room || this.expiries.has(room.code)) return;

    const timer = setTimeout(() => {
      this.expiries.delete(room.code);
      if (room.size === 0) this.rooms.delete(room.code);
    }, this.emptyRoomTtlMs);
    timer.unref();
    this.expiries.set(room.code, timer);
  }

  close(): void {
    for (const timer of this.expiries.values()) clearTimeout(timer);
    this.expiries.clear();
    this.rooms.clear();
  }
}
