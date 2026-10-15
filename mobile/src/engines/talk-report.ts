// A talk report kept on the phone, to check the noisy-place filters on real talks: one JSON
// line per event, in the app's external files folder (reports/<when the talk started>.jsonl),
// read over USB with adb pull. Only builds made with EXPO_PUBLIC_TALK_REPORT=1 keep them:
// they hold the words of everyone heard. They never leave the phone by themselves.

import type { TalkReportEntry } from '../../../shared/pipeline/report.ts';
import EarbridgeAudio from '../../modules/earbridge-audio/src/EarbridgeAudioModule.ts';
import type {
  CaptureInput,
  IsolationEvent,
  SeparationEvent,
} from '../../modules/earbridge-audio/src/EarbridgeAudioModule.ts';
import type { SpeakerSelection } from '../../../shared/protocol.ts';
import type { AppSettings } from '../app-settings.ts';

const TALK_REPORT = process.env.EXPO_PUBLIC_TALK_REPORT === '1';

/** Whether this build keeps talk reports (Android only). */
export const keepsTalkReports = TALK_REPORT && EarbridgeAudio !== null;

/** Why the microphone changed during a talk: the user switched, or earphones came or went. */
export type MicChange = 'switched' | 'connected' | 'disconnected';

/** What the phone notes besides the pipeline's entries. */
export type PhoneReportEntry =
  | {
      type: 'start';
      settings: Pick<
        AppSettings,
        | 'engine'
        | 'mode'
        | 'myLang'
        | 'theirLang'
        | 'talkMode'
        | 'output'
        | 'mic'
        | 'nearbyOnly'
        | 'ignoreSides'
        | 'onlyOurVoices'
        | 'separateVoices'
      >;
    }
  /** Which microphone listens: from the start, or after a change (see MicChange). */
  | { type: 'mic'; input: CaptureInput; change?: MicChange }
  /**
   * Keeping only some voices in what the microphone sends: asked for (`asked`), with this
   * many voice `prints`, for whoever is expected to talk (`speaker`), passing sound in no
   * such voice as heard or not (`passUnmatched`); or as the phone says.
   */
  | ({
      type: 'isolation';
      asked?: boolean;
      prints?: number;
      speaker?: SpeakerSelection;
      passUnmatched?: boolean;
    } & Partial<IsolationEvent>)
  /** How a stretch of sound was split into voices, and which were kept. */
  | ({ type: 'separation' } & SeparationEvent)
  | { type: 'end'; reason?: string };

/** Numbers are rounded to keep the lines short: scores, seconds and decibels need no more. */
const DECIMALS = 4;

export class TalkReport {
  private readonly name: string;

  constructor(settings: AppSettings) {
    this.name = `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    const { engine, mode, myLang, theirLang, talkMode, output, mic, nearbyOnly, ignoreSides, onlyOurVoices, separateVoices } = settings;
    const picked = { engine, mode, myLang, theirLang, talkMode, output, mic, nearbyOnly, ignoreSides, onlyOurVoices, separateVoices };
    this.note({ type: 'start', settings: picked });
  }

  /** Notes something that happened, with the time. */
  note(entry: TalkReportEntry | PhoneReportEntry): void {
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry }, (_key, value: unknown) =>
      typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(DECIMALS)) : value,
    );
    EarbridgeAudio?.appendReport(this.name, line);
  }
}

/** A report of the talk starting now, in a build that keeps them. */
export function openTalkReport(settings: AppSettings): TalkReport | undefined {
  return keepsTalkReports ? new TalkReport(settings) : undefined;
}
