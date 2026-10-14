import { canAutoDetect } from '../languages.ts';
import { AUDIO_SAMPLE_RATE, SKIPPED_KEPT, SOLO_ME, SOLO_THEM } from '../protocol.ts';
import type { RecordingProblem, ServerMessage, SkipReason, SpeakerSelection, TalkMode } from '../protocol.ts';
import { DirectionFilter } from './direction.ts';
import type { Place, Spatial } from './direction.ts';
import { ConversationHistory } from './history.ts';
import { judgeLanguages } from './language-filter.ts';
import type { Logger } from './log.ts';
import { AudioHistory, LoudnessGate, NoisyPlace, speechLevel } from './loudness.ts';
import type { Margin, Span } from './loudness.ts';
import type { TalkReporter, VoiceWindow } from './report.ts';
import { UtteranceSegmenter } from './stt/segmenter.ts';
import type { SpeechDetails } from './stt/segmenter.ts';
import type { SttProvider, SttStream } from './stt/types.ts';
import { deliverTranslation } from './translate/deliver.ts';
import type { TranslationRequest, Translator } from './translate/types.ts';
import { deliverSpeech } from './voice/deliver.ts';
import type { SpeechSynthesizer } from './voice/types.ts';
import { MIN_LEARN_SECONDS, PartnerRecording, VoiceFilter } from './voices.ts';
import type { VoiceLikeness, VoicePrinter } from './voices.ts';

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
  /** Where the recognizer's clock started on the conversation's. */
  origin: number;
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
}

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
    if (spatial && this.directions) {
      // Its direction counts for its middle.
      this.directions.hear(this.place.now + chunk.byteLength / 2 / AUDIO_SAMPLE_RATE / 2, spatial);
    }
    this.place.append(chunk);
    this.audio?.append(chunk);
    this.recording?.add(chunk);
    this.stream?.sendAudio(chunk);
  }

  /** The current turn is over: transcribe and translate what was heard so far. */
  flush(): void {
    this.stream?.finalize();
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
    // That voice just sounds different here, or theirs was learned from someone else's.
    const theirs = this.voices?.partnerPrint;
    if (voice) this.voices?.translated(speakerId, voice.print, voice.seconds);
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
   * The two voices as the phone hears them here, those learned so far: for keeping only
   * voices like them, as each may sound less like its recording than like this.
   */
  get voicesHere(): Float32Array[] {
    return this.voices?.printsHere ?? [];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
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
    const origin = this.place.now;

    const segmenter = new UtteranceSegmenter({
      interim: (text, _detected, details) => this.interim(selection, generation, text, details, origin),
      utterance: (text, detected, details) => {
        if (this.speech?.generation === generation) this.speech = undefined;
        this.utterance(selection, text, detected, details, origin);
      },
    });

    this.stream = this.options.stt.open(
      { language },
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
  private spanOf(details: SpeechDetails, origin: number): Span | undefined {
    if (details.start === undefined || details.end === undefined) return undefined;
    return { start: origin + details.start - PADDING, end: origin + details.end + PADDING };
  }

  /** The audio of some speech, when the recognizer said when it was. */
  private audioOf(details: SpeechDetails, origin: number): Int16Array | undefined {
    const span = this.spanOf(details, origin);
    return span && this.audio?.slice(span.start, span.end);
  }

  /** Which way some speech came from, when the recognizer said when it was and the phone could tell. */
  private headingOf(details: SpeechDetails, origin: number): number | undefined {
    const span = this.spanOf(details, origin);
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
    origin: number,
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
    const samples = this.loudness || this.voices ? this.audioOf(details, origin) : undefined;
    const heading = this.headingOf(details, origin);
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
    origin: number,
  ): void {
    if (this.closed) return;
    this.learnTimings(details);
    const span = this.spanOf(details, origin);
    const heard: Heard = {
      id: this.options.newId(),
      selection,
      text,
      detected,
      details,
      origin,
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

  /** Translates an utterance, unless it seems to come from someone else. */
  private async check(heard: Heard): Promise<void> {
    if (this.closed) return;
    const { id, selection, text, detected, details, samples, heading, margin } = heard;
    const verdict = this.attribute(selection, details);
    if (verdict === 'other') {
      const lang = detected ?? this.options.theirLang;
      const unmeasured = { level: undefined, heading: undefined, voice: undefined, margin: undefined };
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
      this.skip(id, { speakerId, lang, text, reason: 'distant', level, heading, voice: undefined, margin });
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
      this.skip(id, { speakerId, lang, text, reason: 'direction', level, heading, voice, margin });
      this.report(heard, speakerId, { ...measured, reason: 'direction' });
      return;
    }
    // Only in one of the two voices, even from where one of us sits: not speech too short to
    // tell, nor speech the recognizer did not time. Until their voice is known, anything said
    // for them, which it is learned from.
    const voices = this.voices;
    if (voices && !(voice ? voices.admits(speakerId, voice.print, voice.seconds, held) : !voices.checks(speakerId))) {
      const reason = !samples ? 'untimed' : !voice ? 'short' : 'voice';
      this.skip(id, { speakerId, lang, text, reason, level, heading, voice, margin });
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
    const { id, selection, text, details, origin, span, samples, heading, margin } = heard;
    const { reason, level, place, seconds, likeness } = judged;
    // On the conversation's clock, like everything else in the report.
    const words = details.words?.map(({ text, start, end, language }) => ({
      text,
      start: origin + start,
      end: origin + end,
      ...(language !== undefined && { language }),
    }));
    report({
      type: 'line',
      id,
      at: this.place.now,
      selection,
      held: this.talkMode === 'hold',
      side,
      text,
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
   * each is delivered (see `voicesHere`).
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
