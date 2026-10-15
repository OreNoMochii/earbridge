// A record of a one-phone conversation, kept for checking the noisy-place filters on real
// talks: each line heard, what was measured of it, and why it was translated or not. It
// holds the words of everyone heard, so it is only kept where asked for (see
// `SoloOptions.report`), and only test builds ask.

import type { Place } from './direction.ts';
import type { GateVerdict } from './gate.ts';
import type { Margin } from './loudness.ts';
import type { PartnerVoice, RecordingProblem, SkipReason, SpeakerSelection, TalkMode } from '../protocol.ts';
import type { VoiceLikeness } from './voices.ts';

/** One recognized word, on the conversation's clock. */
export interface ReportedWord {
  text: string;
  start: number;
  end: number;
  language?: string;
}

/** A piece of a line, and whose voice it sounds like. */
export interface VoiceWindow {
  /** On the conversation's clock. */
  start: number;
  end: number;
  /** How loud it is, in dBFS. */
  level?: number;
  voice: VoiceLikeness;
}

export type TalkReportEntry =
  | {
      type: 'line';
      id: string;
      /** Seconds into the conversation when it was judged. */
      at: number;
      selection: SpeakerSelection;
      /** Whoever talked was holding a button. */
      held: boolean;
      /** Whose it seemed: by its language in "auto", else the selected side. */
      side: 'me' | 'them' | 'other';
      text: string;
      /** How many words the recognizer tagged with each language. */
      languages: Record<string, number>;
      /** When it was said on the conversation's clock, with the padding the filters add, if the recognizer timed it. */
      start?: number;
      end?: number;
      words?: ReportedWord[];
      /** How loud its words were, in dBFS. */
      level?: number;
      /** How far above the place's background it stood. */
      margin?: Margin;
      /** Which way it came from, and where that is. */
      heading?: number;
      place?: Place;
      /** Seconds of speech its voice print is from. */
      seconds?: number;
      /** Whose voice it sounds like, as a whole. */
      voice?: VoiceLikeness;
      outcome: 'translated' | 'skipped';
      reason?: SkipReason;
    }
  /** A line's voice, piece by piece: which parts of it were in whose voice. */
  | { type: 'windows'; id: string; windows: VoiceWindow[] }
  | { type: 'translation'; id: string; text: string }
  /**
   * A skipped line translated after all: the user asked, or it is in their voice as just
   * recorded or picked, or learned afresh from a line the user asked for.
   */
  | { type: 'translated-after-all'; id: string; why: 'asked' | 'recorded' | 'learned' }
  | { type: 'speaker'; selection: SpeakerSelection }
  | { type: 'talk-mode'; mode: TalkMode }
  | { type: 'voices'; partner: PartnerVoice; recording?: { seconds: number; of: number; hint?: RecordingProblem }; failed?: RecordingProblem }
  /** The place turned out too loud for the filters: holding a button was suggested. */
  | { type: 'loud' }
  /** What I said while holding the button sounded nothing like my recording: recording it again was suggested. */
  | { type: 'unlike-recording' }
  /**
   * With a recognizer paid by the second (see `SoloOptions.metered`): a piece of sound as
   * the gate in front of the recognizer judged it, how loud it was and whose voice it
   * sounded like, and whether sound went through after it. Quiet pieces in a row are one entry.
   */
  | { type: 'gate'; start: number; end: number; level?: number; voice?: VoiceLikeness; verdict: GateVerdict; open: boolean }
  /** At the end: seconds of sound heard in all, and of it sent to the recognizer. */
  | { type: 'sent'; heard: number; sent: number };

export type TalkReporter = (entry: TalkReportEntry) => void;
