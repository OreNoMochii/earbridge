// WebSocket protocol between the browser and the relay server (path: /ws).
//
// Client -> server: JSON text frames (ClientMessage) plus binary frames carrying
// microphone audio as 16 kHz, mono, signed 16-bit little-endian PCM.
// Server -> client: JSON text frames (ServerMessage).

export const AUDIO_SAMPLE_RATE = 16_000;

/**
 * solo: one phone between two people. The phone (or earphone) mic hears both sides;
 *       translations into my language play in my earphones, translations into theirs
 *       are shown on screen (and optionally spoken aloud).
 * room: every participant uses their own phone + earphones and joins a shared room.
 *       Each person's mic only has to capture its wearer, and everyone hears everyone
 *       else in their own language.
 */
export type Mode = 'solo' | 'room';

/** Who the one-phone recognizer should expect to hear next. */
export type SpeakerSelection = 'auto' | 'me' | 'them';

/**
 * One phone: whether the two just talk ('handsfree', at the start), or whoever talks holds
 * a button meanwhile ('hold').
 */
export type TalkMode = 'handsfree' | 'hold';

export interface HelloSolo {
  type: 'hello';
  mode: 'solo';
  myLang: string;
  theirLang: string;
  /**
   * Languages to read aloud with the server's natural voices (if it has them), not the
   * phone's own voice. The server answers with the ones it can do in `ready`.
   */
  voiceLangs?: string[];
  /**
   * Skip speech much quieter than the two people at the phone usually sound: others
   * further away, or a radio.
   */
  nearbyOnly?: boolean;
  token?: string;
}

export interface HelloRoom {
  type: 'hello';
  mode: 'room';
  lang: string;
  name: string;
  /** Join this room; omit to create a new one. */
  room?: string;
  /**
   * Languages to read aloud with the server's natural voices (if it has them), not the
   * phone's own voice. The server answers with the ones it can do in `ready`.
   */
  voiceLangs?: string[];
  token?: string;
}

export type ClientMessage =
  | HelloSolo
  | HelloRoom
  | { type: 'speaker'; speaker: SpeakerSelection }
  /** End of a turn (e.g. push-to-talk released): translate what was heard so far. */
  | { type: 'flush' }
  /** solo: translate something that was `skipped` after all (one of the latest SKIPPED_KEPT). */
  | { type: 'accept'; id: string }
  /**
   * solo, while only the two people's voices are translated: record the other person's
   * voice from what the microphone hears next, for this conversation only, instead of
   * learning it from what they say.
   */
  | { type: 'record-voice' }
  /** Stop recording their voice, keeping what was known of it before. */
  | { type: 'stop-recording' }
  /**
   * solo: the voice learned for the other person is someone else's: forget it, never take
   * it for theirs again, and learn theirs afresh from what is said for them.
   */
  | { type: 'forget-voice' }
  /** solo: holding a button, whoever talks says it is them, so no noisy-place filter skips it. */
  | { type: 'talk-mode'; mode: TalkMode };

export interface Participant {
  id: string;
  name: string;
  lang: string;
}

/** In solo mode, speakerId is one of these; in room mode it is a participant id. */
export const SOLO_ME = 'me';
export const SOLO_THEM = 'them';

/** solo: how many of the latest `skipped` utterances the server keeps, for `accept`. */
export const SKIPPED_KEPT = 20;

/** Why something heard in a one-phone conversation was not translated. */
export type SkipReason =
  /** It was mostly in another language than the conversation's two. */
  | 'language'
  /** Much quieter than the two people at the phone: someone further away, or a radio. */
  | 'distant'
  /** Neither of the two voices of the conversation. */
  | 'voice'
  /** Too short to tell whose voice it is, while only the two voices are translated. */
  | 'short'
  /** The recognizer did not say when it was said, so whose voice it is could not be checked. */
  | 'untimed'
  /** From a side of the phone, not from where either of the two people sits. */
  | 'direction';

/** solo: how the other person's voice is known, while only the two people's are translated. */
export type PartnerVoice =
  /** Not yet: until it is, whatever is said for them is translated, and their voice learned from it. */
  | 'unknown'
  /** From what was said for them in this conversation: the voice that kept coming back. */
  | 'learned'
  /** From a recording made for this conversation (`record-voice`), or saved from an earlier one. */
  | 'recorded';

/** Why recording the other person's voice is not going well, or did not work. */
export type RecordingProblem =
  /** Too little of their voice was heard. */
  | 'quiet'
  /** It heard my voice, not theirs. */
  | 'mine';

export type ServerMessage =
  | {
      type: 'ready';
      clientId: string;
      mode: Mode;
      room?: string;
      /** solo: whether automatic speaker detection is available for this language pair */
      autoDetect: boolean;
      speaker?: SpeakerSelection;
      /** Each finished translation into one of these languages is followed by a `speech` message. */
      voiceLangs: string[];
    }
  | { type: 'participants'; participants: Participant[] }
  /**
   * Live, not-yet-final transcript of what someone is saying. solo: only once it seems to
   * be one of the two people; empty text stops showing it.
   */
  | { type: 'interim'; speakerId: string; lang: string; text: string }
  /** A finished utterance in its original language. Translations reference its id. */
  | {
      type: 'utterance';
      id: string;
      speakerId: string;
      speakerName: string;
      lang: string;
      text: string;
    }
  /**
   * solo: something heard that seems to come from someone else, so it is not translated
   * unless the phone sends `accept` with its id. `lang` is the language it seemed to be in.
   * Its words are not sent: only the two people's are shown.
   */
  | {
      type: 'skipped';
      id: string;
      speakerId: string;
      lang: string;
      reason: SkipReason;
    }
  /** Translation of an utterance; `text` is cumulative, sent repeatedly while streaming. */
  | {
      type: 'translation';
      id: string;
      lang: string;
      text: string;
      done: boolean;
      error?: string;
    }
  /**
   * A finished translation read aloud by a natural voice: base64-encoded audio clips (such
   * as MP3) to play one after the other. With an `error` there is no audio, and the phone's
   * own voice should read the translation instead.
   */
  | { type: 'speech'; id: string; lang: string; audio: string[]; error?: string }
  /**
   * solo, while only the two people's voices are translated: how the other person's voice
   * is known, sent at the start and whenever that changes, and again when their voice is
   * learned afresh (see `accept`), as the phone may keep only voices like it. `recording` while their voice
   * is being recorded: `seconds` of it so far, `of` the seconds needed, and maybe a
   * `hint` of what is going wrong. `failed` once, when a recording did not work.
   */
  | {
      type: 'voices';
      partner: PartnerVoice;
      recording?: { seconds: number; of: number; hint?: RecordingProblem };
      failed?: RecordingProblem;
    }
  /**
   * solo, at most once, while the two just talk: the place is so loud, compared with how
   * they sound, that no filter can tell them from the others. Holding a button works better.
   */
  | { type: 'loud' }
  | { type: 'status'; stt: 'connecting' | 'live' | 'reconnecting' }
  /** A fatal error ends the session; the server closes the socket right after it. */
  | { type: 'error'; message: string; fatal: boolean; code?: ErrorCode };

/** Machine-readable reasons the client reacts to (ask for an access code, forget a room). */
export type ErrorCode = 'unauthorized' | 'room_not_found';

/** WebSocket close code used when the server ends a session on purpose: do not reconnect. */
export const CLOSE_SESSION_ENDED = 4000;
