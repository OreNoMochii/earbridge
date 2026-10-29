import { canAutoDetect } from '../languages.ts';
import { AUDIO_SAMPLE_RATE, SKIPPED_KEPT, SOLO_ME, SOLO_THEM } from '../protocol.ts';
import type { RecordingProblem, ServerMessage, SkipReason, SpeakerSelection, TalkMode } from '../protocol.ts';
import { DirectionFilter } from './direction.ts';
import type { Place, Spatial } from './direction.ts';
import { SpeechGate } from './gate.ts';
import type { GateVerdict, GateWindow } from './gate.ts';
import { ConversationHistory } from './history.ts';
import { judgeLanguages } from './language-filter.ts';
import type { Logger } from './log.ts';
import { AudioHistory, LoudnessGate, NoisyPlace, speechLevel } from './loudness.ts';
import type { Margin, Span } from './loudness.ts';
import type { TalkReporter, VoiceWindow } from './report.ts';
import { UtteranceSegmenter } from './stt/segmenter.ts';
import type { SpeechDetails } from './stt/segmenter.ts';
import type { SttProvider, SttStream, SttWord } from './stt/types.ts';
import { deliverTranslation } from './translate/deliver.ts';
import type { TranslationRequest, Translator } from './translate/types.ts';
import { deliverSpeech } from './voice/deliver.ts';
import type { SpeechSynthesizer } from './voice/types.ts';
import { joined, MIN_LEARN_SECONDS, PartnerRecording, QUIETEST_SPEECH_DB, VoiceFilter } from './voices.ts';
import type { LearnedPrints, VoiceLikeness, VoicePrinter } from './voices.ts';

export interface SoloOptions {
  myLang: string;
  theirLang: string;
  /** Translations into these languages are also read aloud by `synthesizer`. */
  voiceLangs: readonly string[];
  stt: SttProvider;
  translator: Translator;
  synthesizer: SpeechSynthesizer | undefined;
  send(message: ServerMessage): void;
  /** Speech recognition failed for good; the conversation cannot continue. */
  onFatal(error: Error): void;
  log: Logger;
  /** A unique id for each utterance. */
  newId(): string;
  /**
   * Whether `stt` can tell the two languages apart, so the speaker can be "auto".
   * Defaults to whether Deepgram can for this language pair.
   */
  autoDetect?: boolean;
  /**
   * Skip speech much quieter than the two people at the phone usually sound: others
   * further away, or a radio. Needs a recognizer that reports word timings.
   */
  nearbyOnly?: boolean;
  /**
   * Skip speech in any voice but the two people's: mine as recorded, and theirs once it is
   * recorded (see `recordPartner`), saved (see `usePartner`) or learned from what is said
   * for them, which is not skipped for its voice until then. Needs word timings too: speech
   * the recognizer did not time is skipped, its voice unchecked.
   */
  voices?: VoicePrinter;
  /**
   * Skip speech from the phone's sides, by which way it came: for a phone lying between
   * the two people. Needs word timings too, and audio with directions (see `sendAudio`).
   */
  directions?: boolean;
  /**
   * The recognizer is paid by the second of sound sent to it. With `voices`, sound in no
   * voice like the two people's, and silence, is then not sent at all once the voice
   * expected has been heard here (see `VoiceFilter.judge`): it costs nothing, and cannot be
   * translated after all. A short word said alone may be lost with it.
   */
  metered?: boolean;
  /**
   * Told of each line heard, what the filters measured of it and why it was skipped, to
   * check them on real talks. It gets everyone's words: only for test builds.
   */
  report?: TalkReporter;
}

type SoloSpeaker = typeof SOLO_ME | typeof SOLO_THEM;

/**
 * Something heard but not translated, kept a while in case the phone wants it after all.
 * Its words are only shown if it does.
 */
interface Skipped {
  speakerId: SoloSpeaker;
  /** The language it seemed to be in. */
  lang: string;
  text: string;
  reason: SkipReason;
  level: number | undefined;
  /** Which way it came from (see DirectionFilter). */
  heading: number | undefined;
  /** Its voice print, and how many seconds of speech that is from. */
  voice: { print: Float32Array; seconds: number } | undefined;
  /** How far above the place's background it stood. */
  margin: Margin | undefined;
  /** Said holding the button for that side. */
  held: boolean;
  /** Part of a line the rest of which was translated (see `judgeParts`): not vouched for by itself. */
  part?: boolean;
  /** When it was skipped, on the conversation's clock. */
  at: number;
}

/** Speech still being heard, while only the two people's voices are shown. */
interface Speech {
  /** The recognizer stream hearing it. */
  generation: number;
  speakerId: SoloSpeaker;
  /** Its latest live caption. */
  text: string;
  /** Known to be one of the two people's: its caption shows. */
  ours: boolean;
  /** How many seconds of it there must be to check its voice (again). */
  nextCheck: number;
}

/** A complete utterance as heard, with what the filters measured of it before it is judged. */
interface Heard {
  id: string;
  selection: SpeakerSelection;
  text: string;
  detected: string | undefined;
  details: SpeechDetails;
  /** The clock of the recognizer stream that heard it, on the conversation's. */
  clock: StreamClock;
  /** When it was said on the conversation's clock, if the recognizer timed it. */
  span: Span | undefined;
  samples: Int16Array | undefined;
  heading: number | undefined;
  margin: Margin | undefined;
}

/** What was measured of an utterance by the time it was judged, for the talk report. */
interface Judged {
  reason?: SkipReason;
  level?: number | undefined;
  place?: Place | undefined;
  /** Seconds of speech its voice print is from, and whose voice it sounds like. */
  seconds?: number | undefined;
  likeness?: VoiceLikeness | undefined;
  /** What of it was translated, when words of someone else's were left out. */
  kept?: string;
}

/** The words of a line that one talker said, as the recognizer tells talkers apart (see `judgeParts`). */
interface Part {
  speaker: string;
  words: SttWord[];
  /** Their sound, put together, and how many seconds that is. */
  samples: Int16Array;
  seconds: number;
  /** Its voice print, unless too short to tell; whose voice that sounded like, for the talk report. */
  print?: Float32Array;
  likeness?: VoiceLikeness;
  /** Whether it is ours; else the id it was skipped under. */
  kept: boolean;
  id?: string;
  /** A stretch of words judged apart from the rest of its talker's, by its own voice (see `judgeParts`). */
  apart?: true;
}

/** Words in a row that the recognizer gave to the same talker: one turn of theirs, as it heard it. */
interface Stretch {
  speaker: string;
  words: SttWord[];
  start: number;
  end: number;
}

/**
 * A line's words by turns, as the recognizer told its talkers apart (see `SttWord.speaker`),
 * or cut wherever `apart` says two words in a row are not one turn's.
 */
function stretchesOf(words: readonly SttWord[], apart = (a: SttWord, b: SttWord) => a.speaker !== b.speaker): Stretch[] {
  const stretches: Stretch[] = [];
  for (const word of words) {
    const last = stretches.at(-1);
    if (last && !apart(last.words.at(-1)!, word)) {
      last.words.push(word);
      last.end = Math.max(last.end, word.end);
    } else stretches.push({ speaker: word.speaker ?? '', words: [word], start: word.start, end: word.end });
  }
  return stretches;
}

/** A piece of sound the gate judged on its way to the recognizer (see `judgeSound`), with its voice print. */
interface GatePiece {
  /** On the conversation's clock. */
  start: number;
  end: number;
  print: Float32Array;
}
/** Pieces the gate judged are kept this long, for lines still to be judged (see `splitBySound`). */
const GATE_PIECES_SECONDS = 60;

/** Seconds of audio around the recognized words that count as theirs. */
const PADDING = 0.1;
/** A talk report tells whose voice each piece of a line is in: pieces this long, this far apart, up to this many. */
const WINDOW_SECONDS = 1.5;
const WINDOW_HOP = 1;
const MAX_WINDOWS = 20;
/**
 * The voice of speech still being heard is checked once there is this much of it, and
 * again for every second more until it is one of the two people's.
 */
const CAPTION_CHECK_SECONDS = 1.5;
const CAPTION_RECHECK_SECONDS = 1;
/** Utterances without word timings, and none with, after which the user is told the filters cannot work. */
const UNTIMED_TOLD_AFTER = 2;
const NO_TIMINGS = 'The noisy-place filters can’t work with this speech recognition, so everything is translated.';
const NO_TIMINGS_VOICES = 'Voices can’t be checked with this speech recognition: tap Translate on a line to translate it.';
const UNLIKE_RECORDING = 'Your voice sounds unlike your recording of it here: tap the lines that are yours, or record it again in Settings.';
/** Lines said for me while holding the button, in a row and long enough to tell, in a voice nothing like mine as recorded: told after this many. */
const UNLIKE_TOLD_AFTER = 2;
/**
 * Once their voice is recorded or picked, what was skipped this many seconds before for its
 * voice is checked again: what they said while it was recorded is translated too.
 */
const RECHECK_SECONDS = 60;
/** Sound sent to the recognizer right after the last is one stretch with it; from further off on the conversation's clock, a new one. */
const STRETCH_GAP = 0.001;
/** Stretches remembered, the latest ones: the recognizer times words soon after they were sent. */
const MAX_STRETCHES = 200;

/**
 * Where a recognizer stream's clock stands on the conversation's: the recognizer times
 * words from the first sound its stream got, counting only the sound it got, which leaves
 * out whatever was not sent to it (see `SoloOptions.metered`). Each stretch of sound sent
 * in one go is noted by where it starts on both clocks.
 */
class StreamClock {
  private readonly origin: number;
  private readonly stretches: Array<{ stream: number; conversation: number }> = [];
  /** Seconds of sound sent to the stream so far. */
  private sent = 0;

  /** `origin`: where on the conversation's clock the stream was opened. */
  constructor(origin: number) {
    this.origin = origin;
  }

  /** Some sound was sent: this many `seconds` of it, from `at` on the conversation's clock. */
  note(seconds: number, at: number): void {
    const last = this.stretches.at(-1);
    if (!last || Math.abs(at - (last.conversation + this.sent - last.stream)) > STRETCH_GAP) {
      this.stretches.push({ stream: this.sent, conversation: at });
      if (this.stretches.length > MAX_STRETCHES) this.stretches.shift();
    }
    this.sent += seconds;
  }

  /**
   * A time on the stream's clock on the conversation's. With `endOf`, a time right where
   * a stretch ends is the end of that stretch, not the start of the next.
   */
  toConversation(seconds: number, endOf = false): number {
    let found: { stream: number; conversation: number } | undefined;
    for (const stretch of this.stretches) {
      if (endOf ? stretch.stream < seconds : stretch.stream <= seconds) found = stretch;
      else break;
    }
    return found ? found.conversation + seconds - found.stream : this.origin + seconds;
  }
}

/**
 * One phone shared by two people. A single recognizer stream listens at a time: in
 * "auto" it recognizes both languages and attributes each utterance by the language it
 * detected; otherwise it expects one side's language and attributes everything to them.
 * Speech in another language, and optionally from further away, from the phone's sides or
 * in neither of the two people's voices, is skipped rather than translated, and its words
 * are not shown.
 */
export class SoloConversation {
  readonly autoDetect: boolean;
  private readonly options: SoloOptions;
  private readonly history = new ConversationHistory();
  private readonly translations = new AbortController();
  /** How loud the place is, against how loud the two people sound; its clock is the conversation's. */
  private readonly place = new NoisyPlace();
  /** Told the phone that the place is too loud for the filters. */
  private toldLoud = false;
  private talkMode: TalkMode = 'handsfree';
  /** The last half minute of audio, when a filter needs to look back at what was said. */
  private readonly audio: AudioHistory | undefined;
  private readonly loudness: LoudnessGate | undefined;
  private readonly voices: VoiceFilter | undefined;
  private readonly directions: DirectionFilter | undefined;
  /** Keeps sound in no voice like the two people's from a recognizer paid by the second (see `SoloOptions.metered`). */
  private readonly gate: SpeechGate | undefined;
  /** The clock of the recognizer stream listening now, on the conversation's. */
  private clock: StreamClock | undefined;
  /** What the gate measured of the piece of sound it is judging, for the talk report. */
  private gateMeasured: { level: number; voice?: VoiceLikeness } | undefined;
  /** The latest pieces of sound the gate judged, with their voice prints (see `splitBySound`). */
  private gatePieces: GatePiece[] = [];
  /** Pieces of silence the gate judged in a row, told to the talk report as one. */
  private quietRun: { start: number; end: number; open: boolean } | undefined;
  private readonly skipped = new Map<string, Skipped>();
  /** The other person's voice being recorded, when it is. */
  private recording: PartnerRecording | undefined;
  /** The last `voices` message sent. */
  private reportedVoices = '';
  /** Their voice print as of it: told again when theirs was learned afresh, as the phone may keep only voices like it. */
  private reportedPrint: Float32Array | undefined;
  /** Lines said for me while holding the button, in a row, in a voice nothing like mine as recorded. */
  private unlikeMine = 0;
  /** Told the phone that my voice here sounds unlike its recording. */
  private toldUnlike = false;
  /** Voice checks take a moment; utterances wait for the ones before them, to stay in order. */
  private checks: Promise<void> = Promise.resolve();
  /** Utterances waiting for their voice check, which checks of live captions give way to. */
  private utteranceChecks = 0;
  /** Voice prints for the talk report, made while no utterance waits for its check. */
  private extras: Promise<void> = Promise.resolve();
  private checkingCaption = false;
  /** Speech still being heard, while only the two people's voices are shown. */
  private speech: Speech | undefined;
  private showingInterim = false;
  /**
   * Whether the recognizer says when words were said, which every filter but the language
   * one needs; unknown until its first utterances tell.
   */
  private timed: boolean | undefined;
  private untimed = 0;
  private selection: SpeakerSelection;
  private stream: SttStream | undefined;
  private generation = 0;
  private closed = false;

  constructor(options: SoloOptions) {
    this.options = options;
    this.autoDetect = options.autoDetect ?? canAutoDetect(options.myLang, options.theirLang);
    this.selection = this.autoDetect ? 'auto' : SOLO_THEM;
    this.loudness = options.nearbyOnly ? new LoudnessGate() : undefined;
    this.voices = options.voices ? new VoiceFilter(options.voices) : undefined;
    this.directions = options.directions ? new DirectionFilter() : undefined;
    this.audio = this.loudness || this.voices || this.directions ? new AudioHistory() : undefined;
    this.gate =
      this.voices && options.metered
        ? new SpeechGate({
            judge: (window) => this.judgeSound(window),
            send: (chunk, at) => this.send(chunk, at),
            ...(options.report && {
              judged: (window: GateWindow, verdict: GateVerdict, open: boolean) => this.reportGate(window, verdict, open),
            }),
          })
        : undefined;
  }

  get speaker(): SpeakerSelection {
    return this.selection;
  }

  start(): void {
    this.reportVoices();
    this.listen();
  }

  /** Returns false if the selection is not available for this language pair. */
  setSpeaker(selection: SpeakerSelection): boolean {
    if (selection === 'auto' && !this.autoDetect) return false;
    if (this.closed || selection === this.selection) return true;
    this.selection = selection;
    this.options.report?.({ type: 'speaker', selection });
    // The previous stream finishes gracefully: whatever it already heard is still
    // transcribed and attributed to the previous selection.
    this.stream?.close();
    this.listen();
    return true;
  }

  /**
   * 'hold' while whoever talks holds a button meanwhile, saying who it is: then no filter
   * skips what is heard, but for one in another voice than the two recorded.
   */
  setTalkMode(mode: TalkMode): void {
    this.talkMode = mode;
    this.options.report?.({ type: 'talk-mode', mode });
  }

  /** Some 16 kHz mono PCM16 from the microphone, and which way it came from when the phone can tell. */
  sendAudio(chunk: Uint8Array, spatial?: Spatial): void {
    const at = this.place.now;
    if (spatial && this.directions) {
      // Its direction counts for its middle.
      this.directions.hear(at + chunk.byteLength / 2 / AUDIO_SAMPLE_RATE / 2, spatial);
    }
    this.place.append(chunk);
    this.audio?.append(chunk);
    this.recording?.add(chunk);
    if (this.gate) this.gate.hear(chunk, at);
    else this.send(chunk, at);
  }

  /** Sends some sound on to the recognizer, noting where on the conversation's clock it is from. */
  private send(chunk: Uint8Array, at: number): void {
    this.clock?.note(chunk.byteLength / 2 / AUDIO_SAMPLE_RATE, at);
    this.stream?.sendAudio(chunk);
  }

  /** The current turn is over: transcribe and translate what was heard so far. */
  flush(): void {
    if (!this.gate) {
      this.stream?.finalize();
      return;
    }
    // Once the last of the turn's sound that gets through is sent.
    const stream = this.stream;
    void this.gate.flush().then(() => stream?.finalize());
  }

  /** Translates something that was skipped after all, and learns from the mistake. */
  accept(id: string): void {
    const skipped = this.skipped.get(id);
    if (!skipped || this.closed) return;
    this.skipped.delete(id);
    const { speakerId, reason, level, heading, voice } = skipped;
    if (level !== undefined) {
      const now = this.place.now;
      if (reason === 'distant') this.loudness?.allow(speakerId, level, now);
      else this.loudness?.learn(speakerId, level, now);
    }
    if (heading !== undefined) {
      // They are not where they were thought to sit: where is learned afresh.
      if (reason === 'direction') this.directions?.correct(speakerId, heading);
      else this.directions?.learn(speakerId, heading);
    }
    // That voice just sounds different here, or theirs was learned from someone else's. Part
    // of a held line, the rest of which was in that voice, is not vouched for on its own: it
    // was likely someone else's, asked for out of curiosity.
    const theirs = this.voices?.partnerPrint;
    if (voice) this.voices?.translated(speakerId, voice.print, voice.seconds, skipped.held && !skipped.part);
    this.hearMargin(speakerId, skipped.margin);
    this.options.report?.({ type: 'translated-after-all', id, why: 'asked' });
    this.deliver(id, speakerId, skipped.text, skipped.lang);
    this.reportVoices();
    if (theirs && this.voices?.partnerPrint !== theirs) this.recheckTheirs();
  }

  /**
   * Records the other person's voice from what the microphone hears next, for this
   * conversation, while only the two people's voices are translated.
   */
  recordPartner(): void {
    if (!this.voices || this.closed) return;
    this.recording?.stop();
    this.recording = new PartnerRecording(
      this.voices,
      {
        progress: () => this.reportVoices(),
        done: (failed) => {
          this.recording = undefined;
          this.reportVoices(failed);
          if (!failed) this.recheckTheirs();
        },
      },
      this.options.log,
    );
    this.reportVoices();
  }

  /** Stops recording their voice, keeping what was known of it before. */
  stopRecording(): void {
    if (!this.recording) return;
    this.recording.stop();
    this.recording = undefined;
    this.reportVoices();
  }

  /**
   * Their voice from a voice print saved in an earlier conversation, instead of recording
   * it. False when it cannot be used: made by another speaker model, or voices are not checked.
   */
  usePartner(print: Float32Array): boolean {
    if (!this.voices || this.closed || !this.voices.setPartner(print)) return false;
    // Whoever was being recorded is not who the phone says they are talking with.
    this.recording?.stop();
    this.recording = undefined;
    this.reportVoices();
    this.recheckTheirs();
    return true;
  }

  /**
   * The voice learned for them is someone else's, the phone says: it is forgotten and
   * skipped from now on, and theirs is learned afresh from what is said for them.
   */
  forgetPartner(): void {
    if (!this.voices || this.closed || !this.voices.rejectPartner()) return;
    this.reportVoices();
  }

  /** Their voice print as recorded, saved or learned in this conversation, e.g. to save it for the next. */
  get partnerPrint(): Float32Array | undefined {
    return this.voices?.partnerPrint;
  }

  /**
   * One of the two voices as the phone hears it here, as learned so far, or undefined until
   * it is: for keeping only voices like it, as it may sound less like its recording than like this.
   */
  voiceHere(side: SoloSpeaker): Float32Array | undefined {
    return this.voices?.printHere(side);
  }

  /** My voice as the phone hears it here, as learned so far: to take it up again next time (see `useMyVoiceHere`). */
  get myVoiceHere(): LearnedPrints | undefined {
    return this.voices?.myVoiceHere;
  }

  /**
   * My voice as the phone heard it in earlier conversations through the microphone it
   * listens with now, to learn further from there; undefined forgets what was learned, as
   * for another microphone. False when it cannot be used: made by another speaker model, or
   * voices are not checked.
   */
  useMyVoiceHere(learned: LearnedPrints | undefined): boolean {
    if (!this.voices || this.closed || !this.voices.useMyVoiceHere(learned)) return false;
    this.options.report?.({ type: 'my-voice-here', prints: learned?.count ?? 0 });
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.gate?.close();
    this.reportSent();
    this.recording?.stop();
    this.recording = undefined;
    this.translations.abort();
    this.stream?.close();
    this.stream = undefined;
  }

  private listen(): void {
    const selection = this.selection;
    const generation = ++this.generation;
    const isCurrent = () => generation === this.generation && !this.closed;
    const language = selection === 'auto' ? 'multi' : this.langOf(selection);
    // The recognizer times words from the stream's first audio, which is this far into the conversation's.
    const clock = new StreamClock(this.place.now);
    this.clock = clock;

    const segmenter = new UtteranceSegmenter({
      interim: (text, _detected, details) => this.interim(selection, generation, text, details, clock),
      utterance: (text, detected, details) => {
        if (this.speech?.generation === generation) this.speech = undefined;
        this.utterance(selection, text, detected, details, clock);
      },
    });

    // Who said each word, where the recognizer can tell: a line two people talked over is then judged voice by voice (see `judgeParts`).
    this.stream = this.options.stt.open(
      { language, ...(this.voices && { speakers: true }) },
      {
        onResult: (result) => segmenter.handleResult(result),
        onUtteranceEnd: () => segmenter.handleUtteranceEnd(),
        onStatus: (status) => {
          if (isCurrent()) this.options.send({ type: 'status', stt: status });
        },
        onError: (error, fatal) => {
          if (fatal && isCurrent()) this.options.onFatal(error);
          else this.options.log.warn(`speech recognition (${language})`, error);
        },
        onClosed: () => segmenter.flush(),
      },
    );
  }

  /** Who said it: the selected side, or in "auto" whoever speaks its language. */
  private attribute(selection: SpeakerSelection, details: SpeechDetails): SoloSpeaker | 'other' {
    if (selection !== 'auto') return selection;
    return judgeLanguages(details.languages, this.options.myLang, this.options.theirLang);
  }

  private langOf(speaker: SoloSpeaker): string {
    return speaker === SOLO_ME ? this.options.myLang : this.options.theirLang;
  }

  /** When some speech was on the conversation's clock, if the recognizer said. */
  private spanOf(details: SpeechDetails, clock: StreamClock): Span | undefined {
    if (details.start === undefined || details.end === undefined) return undefined;
    return { start: clock.toConversation(details.start) - PADDING, end: clock.toConversation(details.end, true) + PADDING };
  }

  /** The audio of some speech, when the recognizer said when it was. */
  private audioOf(details: SpeechDetails, clock: StreamClock): Int16Array | undefined {
    const span = this.spanOf(details, clock);
    return span && this.audio?.slice(span.start, span.end);
  }

  /** Which way some speech came from, when the recognizer said when it was and the phone could tell. */
  private headingOf(details: SpeechDetails, clock: StreamClock): number | undefined {
    const span = this.spanOf(details, clock);
    return span && this.directions?.headingBetween(span.start, span.end);
  }

  private tooQuiet(speakerId: SoloSpeaker, level: number | undefined): boolean {
    return level !== undefined && !!this.loudness && !this.loudness.accepts(speakerId, level, this.place.now);
  }

  private fromTheSide(heading: number | undefined): boolean {
    return heading !== undefined && this.directions?.judge(heading) === 'between';
  }

  private interim(
    selection: SpeakerSelection,
    generation: number,
    text: string,
    details: SpeechDetails,
    clock: StreamClock,
  ): void {
    if (this.closed) return;
    const verdict = this.attribute(selection, details);
    const speakerId = verdict === 'other' ? SOLO_THEM : verdict;
    if (verdict === 'other') {
      this.showInterim(speakerId, '');
      return;
    }
    // Whoever holds a button says it is them, wherever they are: only their voice is checked.
    const held = this.talkMode === 'hold';
    if (held && !this.voices) {
      this.showInterim(speakerId, text);
      return;
    }
    const samples = this.loudness || this.voices ? this.audioOf(details, clock) : undefined;
    const heading = this.headingOf(details, clock);
    if (!held && this.tooQuiet(speakerId, samples && speechLevel(samples))) {
      this.showInterim(speakerId, '');
      return;
    }
    if (!this.voices) {
      this.showInterim(speakerId, this.fromTheSide(heading) ? '' : text);
      return;
    }
    // Shown only once its voice is known to be one of the two, wherever it comes from: never
    // from a recognizer that does not time words.
    if (this.speech?.generation !== generation) {
      this.speech = { generation, speakerId, text, ours: false, nextCheck: CAPTION_CHECK_SECONDS };
    }
    const speech = this.speech;
    speech.speakerId = speakerId;
    speech.text = text;
    // Until their voice is known, what is said for them shows as it will be translated: from
    // anywhere but a side of the phone, unless whoever talks holds a button.
    if (!this.voices.checks(speakerId)) {
      this.showInterim(speakerId, held || !this.fromTheSide(heading) ? text : '');
      return;
    }
    this.showInterim(speakerId, speech.ours ? text : '');
    if (!speech.ours && samples) {
      this.checkCaption(speech, samples).catch((error: unknown) => this.options.log.warn('voice check', error));
    }
  }

  /**
   * Checks whose voice speech still being heard is, one check at a time, and none while
   * complete utterances wait for theirs. Its caption shows once it is one of the two.
   */
  private async checkCaption(speech: Speech, samples: Int16Array): Promise<void> {
    const seconds = samples.length / AUDIO_SAMPLE_RATE;
    if (this.checkingCaption || this.utteranceChecks > 0 || seconds < speech.nextCheck) return;
    speech.nextCheck = seconds + CAPTION_RECHECK_SECONDS;
    this.checkingCaption = true;
    try {
      const print = await this.voices!.printOf(samples);
      if (print && this.voices!.recognizes(print, speech.speakerId)) speech.ours = true;
    } finally {
      this.checkingCaption = false;
    }
    // Unless it is complete by now, or another stream hears what is said now.
    if (speech.ours && speech === this.speech && !this.closed) this.showInterim(speech.speakerId, speech.text);
  }

  /** Shows what is being said, or with no text, stops showing it. */
  private showInterim(speakerId: SoloSpeaker, text: string): void {
    if (!text && !this.showingInterim) return;
    this.showingInterim = text !== '';
    this.options.send({ type: 'interim', speakerId, lang: this.langOf(speakerId), text });
  }

  private utterance(
    selection: SpeakerSelection,
    text: string,
    detected: string | undefined,
    details: SpeechDetails,
    clock: StreamClock,
  ): void {
    if (this.closed) return;
    this.learnTimings(details);
    const span = this.spanOf(details, clock);
    const heard: Heard = {
      id: this.options.newId(),
      selection,
      text,
      detected,
      details,
      clock,
      span,
      samples: span && this.audio?.slice(span.start, span.end),
      heading: span && this.directions?.headingBetween(span.start, span.end),
      margin: this.place.margin(span),
    };
    const check = () => this.check(heard);
    if (!this.voices) {
      void check();
      return;
    }
    this.utteranceChecks += 1;
    this.checks = this.checks
      .then(check)
      .catch((error: unknown) => this.options.log.warn('voice check', error))
      .finally(() => {
        this.utteranceChecks -= 1;
      });
  }

  /** Tells the user, once, when the recognizer turns out not to say when words were said. */
  private learnTimings(details: SpeechDetails): void {
    // Holding a button, only the voices need checking.
    if (!this.audio || this.timed !== undefined || (this.talkMode === 'hold' && !this.voices)) return;
    if (details.start !== undefined && details.end !== undefined) this.timed = true;
    else if (++this.untimed >= UNTIMED_TOLD_AFTER) {
      this.timed = false;
      this.options.send({ type: 'error', message: this.voices ? NO_TIMINGS_VOICES : NO_TIMINGS, fatal: false });
    }
  }

  /**
   * Translates an utterance, unless it seems to come from someone else; what someone else
   * said over it is left out, where the recognizer tells talkers apart.
   */
  private async check(heard: Heard): Promise<void> {
    if (this.closed) return;
    const { id, selection, text, detected, details, samples, heading, margin } = heard;
    const verdict = this.attribute(selection, details);
    if (verdict === 'other') {
      const lang = detected ?? this.options.theirLang;
      const unmeasured = { level: undefined, heading: undefined, voice: undefined, margin: undefined, held: false };
      this.skip(id, { speakerId: SOLO_THEM, lang, text, reason: 'language', ...unmeasured });
      this.report(heard, 'other', { reason: 'language' });
      return;
    }
    const speakerId = verdict;
    // Whoever holds a button says it is them, wherever they are: only their voice is checked,
    // and how loud they are or where they sit is not learned from it.
    const held = this.talkMode === 'hold';
    if (held && !this.voices) {
      this.deliver(id, speakerId, text);
      this.report(heard, speakerId, {});
      return;
    }
    const lang = this.langOf(speakerId);
    const level = samples && speechLevel(samples);
    const now = this.place.now;
    if (!held && this.tooQuiet(speakerId, level)) {
      this.skip(id, { speakerId, lang, text, reason: 'distant', level, heading, voice: undefined, margin, held });
      this.report(heard, speakerId, { reason: 'distant', level });
      return;
    }
    const print = this.voices && samples ? await this.voices.printOf(samples) : undefined;
    if (this.closed) return;
    const voice = print && { print, seconds: samples!.length / AUDIO_SAMPLE_RATE };
    // For the report, as it sounded before anything was learned from it.
    const likeness = this.options.report && voice ? this.voices!.describe(voice.print) : undefined;
    const place = held || heading === undefined ? undefined : this.directions?.judge(heading);
    const measured: Judged = { level, place, seconds: voice?.seconds, likeness };
    // From a side of the phone: someone else, unless it was clearly one of the two voices.
    if (place === 'between' && !(voice && this.voices!.recognizes(voice.print, speakerId))) {
      this.skip(id, { speakerId, lang, text, reason: 'direction', level, heading, voice, margin, held });
      this.report(heard, speakerId, { ...measured, reason: 'direction' });
      return;
    }
    // Only in one of the two voices, even from where one of us sits: not speech too short to
    // tell, nor speech the recognizer did not time. Until their voice is known, anything said
    // for them, which it is learned from.
    const voices = this.voices;
    // Two or more talkers in it, as far as the recognizer can tell: only what is in our voices, once part of it clearly is.
    const parts =
      voices && voice && details.words
        ? ((await this.judgeParts(speakerId, details.words, heard.clock, held)) ?? (await this.splitBySound(speakerId, details.words, heard.clock, held)))
        : undefined;
    if (this.closed) return;
    if (parts) {
      const words = details.words!;
      const ours = new Set(parts.flatMap((part) => (part.kept ? part.words : [])));
      const kept = ours.size === words.length ? text : textOf(words.filter((word) => ours.has(word)), text, words.length);
      if (speakerId === SOLO_ME) this.unlikeMine = 0;
      this.reportVoices();
      if (!held) this.learnOurs(speakerId, { level, heading, margin }, now);
      this.deliver(id, speakerId, kept);
      this.report(heard, speakerId, { ...measured, ...(kept !== text && { kept }) });
      // What was left out can still be asked for, as a line of its own.
      for (const part of parts) {
        if (part.kept) continue;
        part.id = this.options.newId();
        const partVoice = part.print && { print: part.print, seconds: part.seconds };
        const partText = textOf(part.words, text, words.length);
        this.skip(part.id, { speakerId, lang, text: partText, reason: 'voice', level: speechLevel(part.samples), heading, voice: partVoice, margin, held, part: true });
      }
      this.reportParts(id, parts, text, words.length);
      return;
    }
    if (voices && !(voice ? voices.admits(speakerId, voice.print, voice.seconds, held) : !voices.checks(speakerId))) {
      const reason = !samples ? 'untimed' : !voice ? 'short' : 'voice';
      this.skip(id, { speakerId, lang, text, reason, level, heading, voice, margin, held });
      this.report(heard, speakerId, { ...measured, reason });
      if (held && speakerId === SOLO_ME && voice && reason === 'voice' && voice.seconds >= MIN_LEARN_SECONDS) this.hearUnlike();
      return;
    }
    if (speakerId === SOLO_ME) this.unlikeMine = 0;
    // In case their voice was just learned from it.
    this.reportVoices();
    if (!held) this.learnOurs(speakerId, { level, heading, margin }, now);
    this.deliver(id, speakerId, text);
    this.report(heard, speakerId, measured);
  }

  /** Notes a line in the talk report, when one is kept: what was measured of it, and why it was skipped. */
  private report(heard: Heard, side: SoloSpeaker | 'other', judged: Judged): void {
    const { report } = this.options;
    if (!report) return;
    const { id, selection, text, details, clock, span, samples, heading, margin } = heard;
    const { reason, level, place, seconds, likeness, kept } = judged;
    // On the conversation's clock, like everything else in the report.
    const words = details.words?.map(({ text, start, end, language, speaker }) => ({
      text,
      start: clock.toConversation(start),
      end: clock.toConversation(end, true),
      ...(language !== undefined && { language }),
      ...(speaker !== undefined && { speaker }),
    }));
    report({
      type: 'line',
      id,
      at: this.place.now,
      selection,
      held: this.talkMode === 'hold',
      side,
      text,
      ...(kept !== undefined && { kept }),
      languages: Object.fromEntries(details.languages),
      ...(span && { start: span.start, end: span.end }),
      ...(words && { words }),
      ...(level !== undefined && { level }),
      ...(margin && { margin }),
      ...(heading !== undefined && { heading }),
      ...(place !== undefined && { place }),
      ...(seconds !== undefined && { seconds }),
      ...(likeness && { voice: likeness }),
      outcome: reason ? 'skipped' : 'translated',
      ...(reason && { reason }),
    });
    // The audio kept starts at the conversation's start at the earliest.
    if (span && samples && this.voices) this.reportWindows(id, Math.max(0, span.start), samples);
  }

  /**
   * Tells the talk report whose voice each piece of a line is in: a line judged as a whole
   * may be two people's. Its voice prints wait for the checks of utterances, which matter more.
   */
  private reportWindows(id: string, start: number, samples: Int16Array): void {
    const seconds = samples.length / AUDIO_SAMPLE_RATE;
    const pieces: Span[] = [];
    for (let at = 0; at + WINDOW_SECONDS <= seconds && pieces.length < MAX_WINDOWS; at += WINDOW_HOP) {
      pieces.push({ start: at, end: at + WINDOW_SECONDS });
    }
    // Its end too, when a piece worth printing would be left out.
    const covered = pieces.length > 0 ? pieces[pieces.length - 1]!.end : 0;
    if (seconds - covered >= WINDOW_HOP / 2) pieces.push({ start: Math.max(0, seconds - WINDOW_SECONDS), end: seconds });

    this.extras = this.extras
      .then(async () => {
        const windows: VoiceWindow[] = [];
        for (const piece of pieces) {
          await this.checks;
          if (this.closed) return;
          const audio = samples.subarray(Math.round(piece.start * AUDIO_SAMPLE_RATE), Math.round(piece.end * AUDIO_SAMPLE_RATE));
          const print = await this.voices!.printOf(audio);
          if (!print) continue;
          const level = speechLevel(audio);
          windows.push({
            start: start + piece.start,
            end: start + piece.end,
            ...(level !== undefined && { level }),
            voice: this.voices!.describe(print),
          });
        }
        if (!this.closed) this.options.report?.({ type: 'windows', id, windows });
      })
      .catch((error: unknown) => this.options.log.warn('talk report', error));
  }

  /**
   * A line's words by who said them, when the recognizer heard more than one talker in it
   * (see `SttWord.speaker`), each talker's with their sound: the stretches of their words,
   * cut out around them like a line's (see PADDING) and put together. Nothing without the
   * sound, or when a word is nobody's.
   */
  private partsOf(words: readonly SttWord[], clock: StreamClock): Part[] | undefined {
    if (!this.audio || words.some((word) => word.speaker === undefined)) return undefined;
    const stretches = stretchesOf(words);
    const speakers = [...new Set(stretches.map((stretch) => stretch.speaker))];
    if (speakers.length < 2) return undefined;
    return speakers.map((speaker) => {
      const samples = this.soundOf(stretches.filter((stretch) => stretch.speaker === speaker), clock);
      return { speaker, words: words.filter((word) => word.speaker === speaker), samples, seconds: samples.length / AUDIO_SAMPLE_RATE, kept: false };
    });
  }

  /** The sound of some stretches of words, cut out around them like a line's (see PADDING) and put together. */
  private soundOf(stretches: readonly Stretch[], clock: StreamClock): Int16Array {
    const audio = this.audio!;
    return joined(stretches.map((stretch) => audio.slice(clock.toConversation(stretch.start) - PADDING, clock.toConversation(stretch.end, true) + PADDING)));
  }

  /**
   * Whose words a line's are, by the voice of each talker's part of it as the recognizer
   * told them apart, once one part is clearly in a voice that speaks for `speakerId` (see
   * `VoiceFilter.recognizes`): that part is ours, and so is one clearly in the same voice,
   * as the recognizer may tell one voice as two, or one too short to tell; the rest is
   * someone else's, said over us. Nothing when the recognizer heard one talker, while
   * anything said for that side goes through (see `VoiceFilter.checks`), or while no part
   * is clearly ours: the line is then judged as a whole, which may be ours by a lower
   * standard (see `VoiceFilter.admits`), as each part may be too short to be clear.
   *
   * Where voices overlap, the recognizer's word of who said what is approximate: a turn of
   * someone's may land among ours and the other way round. So each turn long enough to tell
   * (see MIN_LEARN_SECONDS) that is not all of its talker's part is judged by its own voice
   * too: one among ours that is clearly not in our voice as settled here (see
   * `VoiceFilter.unlike`) is left out on its own, one among someone else's that is clearly
   * ours is kept on its own.
   */
  private async judgeParts(speakerId: SoloSpeaker, words: readonly SttWord[], clock: StreamClock, vouched: boolean): Promise<Part[] | undefined> {
    const voices = this.voices;
    if (!voices || !voices.checks(speakerId)) return undefined;
    const parts = this.partsOf(words, clock);
    if (!parts) return undefined;
    for (const part of parts) {
      part.print = await voices.printOf(part.samples);
      if (this.closed) return undefined;
      // As it sounded before anything was learned from it.
      if (part.print && this.options.report) part.likeness = voices.describe(part.print);
    }
    const clear = parts.filter((part) => part.print && voices.recognizes(part.print, speakerId));
    if (clear.length === 0) return undefined;
    for (const part of parts) {
      part.kept = clear.includes(part) || !part.print || clear.some((ours) => voices.sameVoice(part.print!, ours.print!));
    }
    const apart: Part[] = [];
    const broken = new Set<Part>();
    for (const stretch of stretchesOf(words)) {
      const part = parts.find((candidate) => candidate.speaker === stretch.speaker)!;
      if (stretch.words.length === part.words.length) continue;
      const samples = this.soundOf([stretch], clock);
      const seconds = samples.length / AUDIO_SAMPLE_RATE;
      if (seconds < MIN_LEARN_SECONDS) continue;
      const print = await voices.printOf(samples);
      if (this.closed) return undefined;
      if (!print) continue;
      const ours = voices.recognizes(print, speakerId) || clear.some((other) => other !== part && voices.sameVoice(print, other.print!));
      const kept = part.kept ? ours || !voices.unlike(speakerId, print) : ours;
      if (kept === part.kept) continue;
      part.words = part.words.filter((word) => !stretch.words.includes(word));
      broken.add(part);
      apart.push({ speaker: stretch.speaker, words: stretch.words, samples, seconds, print, ...(this.options.report && { likeness: voices.describe(print) }), kept, apart: true });
    }
    for (const part of broken) {
      part.samples = this.soundOf(stretchesOf(part.words), clock);
      part.seconds = part.samples.length / AUDIO_SAMPLE_RATE;
    }
    // How that voice sounds here is learned from each clear part, as from a line (see
    // `VoiceFilter.admits`), unless some of it turned out to be someone else's.
    for (const part of clear) if (!broken.has(part)) voices.admits(speakerId, part.print!, part.seconds, vouched);
    return [...parts.filter((part) => part.words.length > 0), ...apart];
  }

  /**
   * Whose words a line's are, by the voice of each piece of its sound as the gate judged
   * them on the way to the recognizer (see `judgeSound`), when the recognizer heard one
   * talker in it: someone else's words said over ours land in our line then, as one
   * talker's. Once our voice as settled here is known well enough to tell (see
   * `VoiceFilter.unlike`), a word most of whose pieces are clearly not in it is someone
   * else's; each such run of words is left out on its own, judged again by its own sound
   * when there is enough of it to tell (see MIN_LEARN_SECONDS), else by the pieces over
   * it; the rest is the line, judged as one (see `VoiceFilter.admits`). Nothing without
   * such a run, or when the rest is not ours after all: the line is then judged as a whole.
   */
  private async splitBySound(speakerId: SoloSpeaker, words: readonly SttWord[], clock: StreamClock, vouched: boolean): Promise<Part[] | undefined> {
    const voices = this.voices;
    if (!voices || !this.audio || !voices.checks(speakerId) || this.gatePieces.length === 0) return undefined;
    const unlike = (print: Float32Array) => voices.unlike(speakerId, print) && !voices.recognizes(print, speakerId);
    /** How many more of the gate's pieces over a span of the conversation, or at an instant, are in a voice unlike ours than not. */
    const against = (from: number, to = from) => {
      let count = 0;
      for (const piece of this.gatePieces) {
        const over = from < to ? piece.start < to && piece.end > from : piece.start <= from && from < piece.end;
        if (over) count += unlike(piece.print) ? 1 : -1;
      }
      return count;
    };
    const taken = new Set<SttWord>();
    for (const word of words) {
      if (against((clock.toConversation(word.start) + clock.toConversation(word.end, true)) / 2) > 0) taken.add(word);
    }
    if (taken.size === 0) return undefined;
    const cut = (a: SttWord, b: SttWord) => taken.has(a) !== taken.has(b);
    const apart: Part[] = [];
    for (const stretch of stretchesOf(words, cut)) {
      if (!taken.has(stretch.words[0]!)) continue;
      const samples = this.soundOf([stretch], clock);
      const seconds = samples.length / AUDIO_SAMPLE_RATE;
      let print: Float32Array | undefined;
      if (seconds >= MIN_LEARN_SECONDS) {
        print = await voices.printOf(samples);
        if (this.closed) return undefined;
      }
      const theirs = print ? unlike(print) : against(clock.toConversation(stretch.start), clock.toConversation(stretch.end, true)) > 0;
      if (!theirs) {
        for (const word of stretch.words) taken.delete(word);
        continue;
      }
      apart.push({ speaker: stretch.speaker, words: stretch.words, samples, seconds, ...(print && { print, ...(this.options.report && { likeness: voices.describe(print) }) }), kept: false, apart: true });
    }
    if (apart.length === 0) return undefined;
    const rest = stretchesOf(words, cut).filter((stretch) => !taken.has(stretch.words[0]!));
    const ours = rest.flatMap((stretch) => stretch.words);
    if (ours.length === 0) return undefined;
    const samples = this.soundOf(rest, clock);
    const seconds = samples.length / AUDIO_SAMPLE_RATE;
    const print = await voices.printOf(samples);
    if (this.closed) return undefined;
    if (!print) return undefined;
    const likeness = this.options.report ? voices.describe(print) : undefined;
    if (!voices.admits(speakerId, print, seconds, vouched)) return undefined;
    return [{ speaker: rest[0]!.speaker, words: ours, samples, seconds, print, ...(likeness && { likeness }), kept: true }, ...apart];
  }

  /** Notes in the talk report how a line in two or more voices was judged (see `judgeParts`). */
  private reportParts(id: string, parts: readonly Part[], line: string, words: number): void {
    this.options.report?.({
      type: 'parts',
      id,
      parts: parts.map((part) => ({
        speaker: part.speaker,
        text: textOf(part.words, line, words),
        seconds: part.seconds,
        ...(part.likeness && { voice: part.likeness }),
        kept: part.kept,
        ...(part.id !== undefined && { id: part.id }),
        ...(part.apart && { apart: true }),
      })),
    });
  }

  /** Learns from speech in one of the two people's voices how loud they are and where they sit. */
  private learnOurs(speakerId: SoloSpeaker, speech: Pick<Skipped, 'level' | 'heading' | 'margin'>, now: number): void {
    if (speech.level !== undefined) this.loudness?.learn(speakerId, speech.level, now);
    if (speech.heading !== undefined) this.directions?.learn(speakerId, speech.heading);
    this.hearMargin(speakerId, speech.margin);
  }

  /**
   * Their voice was just recorded or picked, or learned afresh from what the user said was
   * theirs: what was skipped lately for its voice is translated after all if it is theirs,
   * in the order it was said.
   */
  private recheckTheirs(): void {
    const voices = this.voices;
    if (!voices || voices.partner === 'unknown') return;
    const why = voices.partner;
    const since = this.place.now - RECHECK_SECONDS;
    for (const [id, skipped] of this.skipped) {
      const { speakerId, voice } = skipped;
      if (speakerId !== SOLO_THEM || skipped.reason !== 'voice' || skipped.at < since || !voice) continue;
      if (!voices.admits(speakerId, voice.print, voice.seconds, this.talkMode === 'hold')) continue;
      this.skipped.delete(id);
      if (this.talkMode !== 'hold') this.learnOurs(speakerId, skipped, this.place.now);
      this.options.report?.({ type: 'translated-after-all', id, why });
      this.deliver(id, speakerId, skipped.text, skipped.lang);
    }
  }

  /**
   * Tells the phone, once, when what I say while holding the button is nothing like my
   * voice as recorded: recorded somewhere else, it may be too unlike my voice here to tell.
   */
  private hearUnlike(): void {
    if (this.toldUnlike || ++this.unlikeMine < UNLIKE_TOLD_AFTER || this.closed) return;
    this.toldUnlike = true;
    this.options.send({ type: 'error', message: UNLIKE_RECORDING, fatal: false });
    this.options.report?.({ type: 'unlike-recording' });
  }

  /**
   * Tells the phone, once, when one of the two people barely stands out of the place: no
   * filter can tell them from the others then, and holding a button to talk works better.
   */
  private hearMargin(speakerId: SoloSpeaker, margin: Margin | undefined): void {
    if (!margin || this.talkMode === 'hold' || this.toldLoud || this.closed) return;
    this.place.hear(speakerId, margin);
    if (!this.place.tooLoud) return;
    this.toldLoud = true;
    this.options.log.info('too loud here for the filters: holding a button suggested');
    this.options.send({ type: 'loud' });
    this.options.report?.({ type: 'loud' });
  }

  /**
   * Tells the phone how the other person's voice is known, when that changed or a recording
   * `failed`; again when their voice was learned afresh, as the phone may keep only voices
   * like it. How either sounds here, learned further from most lines, the phone looks up as
   * each is delivered (see `voiceHere`).
   */
  private reportVoices(failed?: RecordingProblem): void {
    if (!this.voices || this.closed) return;
    const message = {
      type: 'voices' as const,
      partner: this.voices.partner,
      ...(this.recording && { recording: this.recording.progress }),
      ...(failed && { failed }),
    };
    const key = JSON.stringify(message);
    const print = this.voices.partnerPrint;
    if (key === this.reportedVoices && print === this.reportedPrint) return;
    this.reportedVoices = key;
    this.reportedPrint = print;
    this.options.send(message);
    this.options.report?.(message);
  }

  /**
   * Whose voice the sound between two times is in, for the gate: nobody's when it is too
   * quiet for speech; else as `VoiceFilter.judge` tells, for the side expected (both in
   * "auto"). While their voice is recorded, everything heard is theirs to record: nothing
   * is left out, and no voice told. Nor when the sound is too short to print.
   */
  private async judgeSound(window: GateWindow): Promise<GateVerdict> {
    this.gateMeasured = undefined;
    const samples = this.audio!.slice(window.start, window.end);
    const level = speechLevel(samples);
    if (level === undefined || level < QUIETEST_SPEECH_DB) return 'quiet';
    this.gateMeasured = { level };
    if (this.recording) return 'maybe';
    const print = await this.voices!.printOf(samples);
    if (!print || this.closed) return 'maybe';
    this.gatePieces.push({ start: window.start, end: window.end, print });
    while (this.gatePieces[0]!.end < window.end - GATE_PIECES_SECONDS) this.gatePieces.shift();
    if (this.options.report) this.gateMeasured = { level, voice: this.voices!.describe(print) };
    const sides = this.selection === 'auto' ? [SOLO_ME, SOLO_THEM] : [this.selection];
    return this.voices!.judge(sides, print);
  }

  /** Notes in the talk report how the gate judged a piece of sound; pieces of silence in a row as one entry. */
  private reportGate(window: GateWindow, verdict: GateVerdict, open: boolean): void {
    if (verdict === 'quiet') {
      if (this.quietRun) {
        this.quietRun.end = window.end;
        this.quietRun.open = open;
      } else {
        this.quietRun = { start: window.start, end: window.end, open };
      }
      return;
    }
    this.reportQuiet();
    const measured = this.gateMeasured;
    this.options.report?.({
      type: 'gate',
      start: window.start,
      end: window.end,
      ...(measured && { level: measured.level }),
      ...(measured?.voice && { voice: measured.voice }),
      verdict,
      open,
    });
  }

  private reportQuiet(): void {
    const run = this.quietRun;
    if (!run) return;
    this.quietRun = undefined;
    this.options.report?.({ type: 'gate', start: run.start, end: run.end, verdict: 'quiet', open: run.open });
  }

  /** Notes in the talk report, at the end, how much of the sound heard the gate sent on. */
  private reportSent(): void {
    if (!this.gate || !this.options.report) return;
    this.reportQuiet();
    this.options.report({ type: 'sent', ...this.gate.stats });
  }

  private skip(id: string, skipped: Omit<Skipped, 'at'>): void {
    this.skipped.set(id, { ...skipped, at: this.place.now });
    if (this.skipped.size > SKIPPED_KEPT) this.skipped.delete(this.skipped.keys().next().value!);
    // Phones that do not know "skipped" still stop showing the live caption.
    this.showInterim(skipped.speakerId, '');
    // Without its words: only the two people's are shown.
    const { speakerId, lang, reason } = skipped;
    this.options.send({ type: 'skipped', id, speakerId, lang, reason });
  }

  private deliver(id: string, speakerId: SoloSpeaker, text: string, sourceLang = this.langOf(speakerId)): void {
    if (this.closed) return;
    const listenerId = speakerId === SOLO_ME ? SOLO_THEM : SOLO_ME;
    const targetLang = this.langOf(listenerId);

    this.showingInterim = false; // the phone stops showing it when the utterance arrives
    this.options.send({
      type: 'utterance',
      id,
      speakerId,
      speakerName: speakerId === SOLO_ME ? 'You' : 'Them',
      lang: sourceLang,
      text,
    });

    const context = this.history.recent();
    this.history.add({ speaker: speakerId === SOLO_ME ? 'Person A' : 'Person B', lang: sourceLang, text });

    void this.translate(id, { text, sourceLang, targetLang, context });
  }

  /** Translates an utterance, then has a natural voice read the translation if wanted. */
  private async translate(id: string, request: Omit<TranslationRequest, 'onPartial' | 'signal'>): Promise<void> {
    const { translator, synthesizer, voiceLangs, log } = this.options;
    const signal = this.translations.signal;
    const send = (message: ServerMessage) => {
      if (!this.closed) this.options.send(message);
    };
    const translation = await deliverTranslation(translator, { ...request, signal }, id, send, log);
    if (translation && !this.closed) this.options.report?.({ type: 'translation', id, text: translation });
    if (translation && synthesizer && voiceLangs.includes(request.targetLang)) {
      await deliverSpeech(synthesizer, { text: translation, lang: request.targetLang, signal }, id, send, log);
    }
  }
}

/**
 * What some of a line's words say, in the order given: with spaces between them, unless the
 * line itself, of `lineWords` words, was written with hardly any, as in Japanese.
 */
function textOf(words: readonly SttWord[], line: string, lineWords: number): string {
  const spaced = (line.match(/ /g)?.length ?? 0) >= (lineWords - 1) / 2;
  return words.map((word) => word.text).join(spaced ? ' ' : '');
}
