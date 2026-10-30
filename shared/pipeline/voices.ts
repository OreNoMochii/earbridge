import { AUDIO_SAMPLE_RATE, SOLO_ME, SOLO_THEM } from '../protocol.ts';
import type { PartnerVoice, RecordingProblem } from '../protocol.ts';
import type { GateVerdict } from './gate.ts';
import type { Logger } from './log.ts';

/** Turns speech into voice prints: vectors that point the same way for the same voice. */
export interface VoicePrinter {
  /** The phone owner's voice print, from a recording made in the settings. */
  mine: Float32Array;
  /** A voice print of some 16 kHz mono speech; undefined when it cannot make one. */
  print(samples: Int16Array): Promise<Float32Array | undefined>;
  /** How alike its prints must be to be the same voice: on its model's own scale. */
  bars: VoiceBars;
}

/**
 * How alike two voice prints must be (cosine similarity) to be judged the same voice. Each
 * speaker model spreads voices over that scale in its own way, so the bars go with the
 * model that made the prints (see `VoicePrinter`); these were found on the test rig's
 * clips (tools/voice-rig, `probe/sweep.py`) and the phone's talk reports.
 */
export interface VoiceBars {
  /**
   * At least this alike: clearly the same voice. With the phone's speaker model (CAM++),
   * someone else's voice gets there about 1 time in 100; 2 seconds of the same voice in loud
   * chatter fall short about 4 times in 100.
   */
  same: number;
  /**
   * Voice prints less alike than this are of different voices; at least this alike, maybe of
   * the same voice sounding different here: next to its recording, made in another place or
   * with other noise around, a voice heard on a phone has fallen between the two. Only speech
   * somewhat like a voice as recorded or learned teaches how it sounds here, and only speech
   * unlike mine how theirs does.
   */
  alike: number;
  /**
   * Once my voice as heard here is settled (see SETTLED_PRINTS), speech less like it than this
   * is someone else's, however much like my recording, which a voice heard through earphones
   * matches poorly: on such a phone, with CAM++, the user's own lines scored 0.43 to 0.73
   * against their voice here, others' speech over the button 0.18 to 0.35; against a voice
   * here learned from one line only, the user's own scored as low as 0.25.
   */
  unlike: number;
}

/** The bars for CAM++ (3D-Speaker, Chinese and English), the phone's speaker model. */
export const CAMPPLUS_BARS: VoiceBars = { same: 0.4, alike: 0.2, unlike: 0.3 };
/**
 * The bars for ERes2Net (3D-Speaker, VoxCeleb), which spreads voices wider: on the rig's
 * clips of recorded voices they lose 125 of my 2288 words alone and let 114 of a stranger's
 * 996 through, against 177 and 346 for CAM++ at its bars, most of the gain from the higher
 * `unlike` (a stranger's lines through an earphone channel stay under it, mine over it there,
 * which may not hold for a voice heard as unevenly as the user's). It prints three times
 * slower than CAM++, and is not the phone's model.
 */
export const ERES2NET_BARS: VoiceBars = { same: 0.5, alike: 0.15, unlike: 0.5 };

/** How alike a voice is to each of the two (see `similarity`); -1 where that voice is unknown. */
export interface VoiceLikeness {
  /** To mine as recorded, and as heard here. */
  mine: number;
  mineHere: number;
  /** To theirs as recorded, saved or learned, and as heard here. */
  partner: number;
  partnerHere: number;
  /** Under how alike to mine as heard here a voice is someone else's (see `unlike`), once mine here is settled. */
  unlikeMineBelow?: number;
  /** Under how alike to mine as heard here a voice is in doubt (see `doubtful`), when any over `same` is. */
  doubtMineBelow?: number;
}

/** A voice as learned here (see LearnedVoice), to take it up again in a later conversation. */
export interface LearnedPrints {
  /** The sum of the voice prints it was learned from, the oldest slowly forgotten. */
  sum: Float32Array;
  /** How many prints that is, up to REMEMBERED_PRINTS. */
  count: number;
  /** How many seconds of speech those prints are from, when known. */
  seconds?: number;
  /** How alike each of the last prints was to the voice as learned before it (see UNLIKE_MARGIN), when known. */
  likenesses?: number[];
}

/**
 * Shorter speech is too short to tell whose voice it is. Short speech has less reliable
 * voice prints, but is checked all the same: someone else's "OK" is not translated.
 */
const MIN_CHECK_SECONDS = 0.5;
/** How a voice sounds here is learned from something at least this long. */
export const MIN_LEARN_SECONDS = 1.5;
/** Long speech is printed from its middle part, which is plenty and keeps the phone quick. */
const MAX_PRINT_SECONDS = 10;
/**
 * The `unlike` bar rises with how consistently the voice is heard here, up to `same`: it is this
 * much under the least alike of the last things learned from, each measured against the
 * voice as learned before it. On the test rig, each of my lines is 0.8 to 0.95 like my voice
 * here, while a stranger's voice of the same gender is 0.3 to 0.4 like it, which the bar
 * alone lets through; on the phone above, the user's own lines were as little as 0.43 like
 * their voice here, which leaves the bar where it is. What the rise would put over `same`
 * is not clearly someone else's, only in doubt (see `doubtful`).
 */
const UNLIKE_MARGIN = 0.25;
/**
 * Once a voice here is settled, it is not learned from speech this much less like it than
 * the least alike of the last things learned from: that is as likely someone else's whose
 * voice is somewhat like it (see `same`), and learning from it drags the voice here
 * their way and lowers the bar (see UNLIKE_MARGIN) for the rest of the talk, as a stranger's
 * line 0.44 like my recording did on the rig, from 0.48 to 0.30, with his later words let
 * through. Smaller than UNLIKE_MARGIN: the voice still follows a slow change in how it is
 * heard, and what the user asks for teaches it whatever its likeness (see `translated`).
 */
const LEARN_MARGIN = 0.1;
/**
 * Speech for me in a voice this much more like theirs than like mine is theirs, however like
 * mine it is (see `ratherTheirs`). A bar alone takes a voice somewhat like mine for mine, and
 * the other person's voice, of the same gender, is that like it now and then (on the rig a
 * man's voice like mine was as like my voice here as my own lines). Theirs is known from their
 * recording, or learned from what they say holding their button, so this tells the two apart
 * from early in a talk, whatever is settled of mine here. The margin is for a voice somewhat
 * like both by chance: my own lines through earphones in a crowd have been as little as 0.43
 * like my voice here, and 0.03 more like my recording than theirs.
 */
const NEARER_MARGIN = 0.1;
/**
 * A voice heard here is settled, and told from others by `unlike`, once learned from this many
 * prints, or from two prints of at least SETTLED_SECONDS of speech in all: a print of long
 * speech is a truer likeness than one of short speech.
 */
const SETTLED_PRINTS = 3;
const SETTLED_SECONDS = 8;
/** A learned voice follows the last few things said in it, as the voice and the place vary. */
const REMEMBERED_PRINTS = 10;
/**
 * Until their voice is recorded, it is learned from what is said for them: once one voice
 * said this many things of at least MIN_LEARN_SECONDS, as long as a recording of it in all
 * (PARTNER_SECONDS), and this many times as long as any other voice heard for them.
 */
const LEARN_LINES = 3;
const LEARN_LEAD = 2;
/** Voices heard for them while theirs is learned: the newest, and those that said the most. */
const HEARD_VOICES = 8;

/**
 * Tells the voices of the two people at the phone from everyone else's. Mine is recorded
 * in the settings. The other person's is recorded for the conversation (see
 * PartnerRecording), saved from an earlier one, or else learned from what is said for them:
 * until it is known, whatever is said for them is let through, so that talking with
 * someone needs no recording; a voice learned by mistake is forgotten when the user says
 * so, and skipped from then on. Each is also learned as the phone hears it here, from what
 * is clearly that voice.
 */
export class VoiceFilter {
  private readonly printer: VoicePrinter;
  private readonly bars: VoiceBars;
  private readonly mine: Float32Array;
  /** My voice as the phone hears it here, which a noisy place or a cold changes. */
  private readonly mineHere: LearnedVoice;
  /** The other person's voice once it is known, and how. */
  private theirs: { print: Float32Array; known: Exclude<PartnerVoice, 'unknown'> } | undefined;
  /** Their voice as the phone hears it here, once it is known. */
  private readonly partnerHere: LearnedVoice;
  /** The voices heard for them, until theirs is known. */
  private readonly heard: HeardVoices;
  /** Voices learned for them that the user said were someone else's: skipped while theirs is unknown. */
  private rejected: Float32Array[] = [];

  constructor(printer: VoicePrinter) {
    this.printer = printer;
    this.bars = printer.bars;
    this.mine = normalized(printer.mine);
    this.mineHere = new LearnedVoice(printer.bars);
    this.partnerHere = new LearnedVoice(printer.bars);
    this.heard = new HeardVoices(printer.bars);
  }

  /** How the other person's voice is known. */
  get partner(): PartnerVoice {
    return this.theirs?.known ?? 'unknown';
  }

  /** Their voice print, once it is known: e.g. to save it for later conversations. */
  get partnerPrint(): Float32Array | undefined {
    return this.theirs?.print;
  }

  /**
   * One of the two voices as the phone hears it here, as learned so far, or undefined until
   * it is: a voice may be less like its recording than like this, e.g. for keeping only
   * voices like it. The same array until it is learned further.
   */
  printHere(side: string): Float32Array | undefined {
    return side === SOLO_THEM ? this.partnerHere.print : this.mineHere.print;
  }

  /**
   * My voice as the phone hears it here, as learned so far, or undefined until it is: to
   * take it up again in later conversations through the same microphone (see
   * `useMyVoiceHere`). A copy.
   */
  get myVoiceHere(): LearnedPrints | undefined {
    return this.mineHere.saved();
  }

  /**
   * My voice as the phone heard it in earlier conversations, through the microphone it
   * listens with now: it is learned further from there. Undefined forgets what was learned,
   * e.g. as another microphone takes over. False for prints from another speaker model.
   */
  useMyVoiceHere(learned: LearnedPrints | undefined): boolean {
    if (!learned) {
      this.mineHere.forget();
      return true;
    }
    if (learned.sum.length !== this.mine.length) return false;
    this.mineHere.restore(learned);
    return true;
  }

  /**
   * Whether speech for `side` must be in one of the two voices: for me always, for them
   * once their voice is known. Until then, theirs is learned from what is said for them.
   */
  checks(side: string): boolean {
    return side !== SOLO_THEM || this.theirs !== undefined;
  }

  /** A voice print of some speech, unless it is too short to tell whose voice it is. */
  async printOf(samples: Int16Array): Promise<Float32Array | undefined> {
    const seconds = samples.length / AUDIO_SAMPLE_RATE;
    if (seconds < MIN_CHECK_SECONDS) return undefined;
    const keep = MAX_PRINT_SECONDS * AUDIO_SAMPLE_RATE;
    const start = Math.max(0, Math.floor((samples.length - keep) / 2));
    const print = await this.printer.print(samples.subarray(start, start + keep));
    return print && print.length === this.mine.length ? normalized(print) : undefined;
  }

  /**
   * Whether a voice is one of the conversation's two, for speech attributed to `side`
   * (by its language, or by the "Me" / "Them" choice): speech for me must be in my voice,
   * speech for them in mine or theirs. Until theirs is known, speech for them is let
   * through in any voice but one the user said was not theirs, and theirs is learned from
   * it. Speech in either voice teaches how it sounds here.
   *
   * Speech `vouched` for, by whoever holds a button to talk, is that side's unless its voice
   * is nothing like theirs, or clearly the other one's: a voice here may be only somewhat
   * like its recording (see `alike`). How it sounds here is learned from such speech only
   * while nothing is known of that yet, as a first foothold: once it is, speech only
   * somewhat like the voice is as likely someone else's, said over the button, and what is
   * learned must not drift their way, or their voice passes for ours from then on. Once how
   * it sounds here is settled, such speech is not even that side's unless it is somewhat
   * like that too (see `unlike`): it is left for the user to ask for.
   * Speech for me in a voice more like theirs than mine is theirs, however like mine it is (see
   * `ratherTheirs`); said for them holding the button, such speech teaches how theirs sounds
   * here, however like my voice here it is (see `learn`).
   */
  admits(side: string, print: Float32Array, seconds: number, vouched = false): boolean {
    // So that each is still told when the noise around changes how it sounds; only from
    // what is clearly that voice, so that no one else's creeps in.
    const theirs = this.theirs?.print;
    if (side === SOLO_THEM && this.likePartner(print) >= this.bars.same) {
      if (theirs && similarity(print, theirs) >= this.bars.same) this.learn(SOLO_THEM, print, seconds);
      return true;
    }
    if (this.isMine(print) && !this.ratherTheirs(side, print)) {
      if (similarity(print, this.mine) >= this.bars.same) this.learn(SOLO_ME, print, seconds);
      else if (vouched && side === SOLO_THEM) this.learn(SOLO_THEM, print, seconds);
      return true;
    }
    if (vouched && this.mayBe(side, print) && !this.unlike(side, print)) {
      const here = side === SOLO_THEM ? this.partnerHere : this.mineHere;
      if (!here.print) this.learn(side, print, seconds);
      return true;
    }
    if (this.checks(side) || this.isRejected(print)) return false;
    this.learnPartner(print, seconds);
    return true;
  }

  /**
   * Whether a voice is clearly not `side`'s as that sounds here, once that is settled (see
   * `unlike`, and UNLIKE_MARGIN for how the bar rises): as learned from a line or two it is
   * still a poor likeness, so nothing is unlike it until then. For me by my voice here
   * alone, which my recording matches poorly on some phones; for them by their voice as
   * learned too, which is of speech heard here as well.
   * For me, a voice clearly more like theirs than mine as well, whatever is settled (see
   * `ratherTheirs`).
   */
  unlike(side: string, print: Float32Array): boolean {
    if (this.ratherTheirs(side, print)) return true;
    const here = side === SOLO_THEM ? this.partnerHere : this.mineHere;
    return here.settled && this.likenessHere(side, print) < here.unlikeBelow;
  }

  /** How alike a voice is to that side's as it sounds here, which `unlike` goes by; -1 while that is unknown. */
  likenessHere(side: string, print: Float32Array): number {
    return side === SOLO_THEM ? this.likePartner(print) : this.mineHere.likeness(print);
  }

  /**
   * Whether a voice is not clearly `side`'s as that sounds here, for a voice heard so evenly
   * here that one merely somewhat like it (see `same`) is still less like it than each
   * of that side's own lines has been (see UNLIKE_MARGIN): such a voice is in doubt, neither
   * clearly that side's nor clearly someone else's (see `unlike`), and the pieces of a line's
   * sound may settle it (see `SoloConversation.splitBySound`). Never while that side's voice
   * is heard less evenly here: a voice somewhat like it is then as likely that side's own.
   */
  doubtful(side: string, print: Float32Array): boolean {
    const here = side === SOLO_THEM ? this.partnerHere : this.mineHere;
    const below = here.doubtBelow;
    return below !== undefined && this.likenessHere(side, print) < below;
  }

  /**
   * Whether a voice heard for `side` is rather the other person's: for me, one more like theirs
   * than like mine by NEARER_MARGIN; never for them, whose speech may be in my voice, and never
   * while theirs is not known. Like against like: their recording against mine, where it must be
   * somewhat like theirs (see `alike`), and their voice as heard here, or learned from what they
   * said here, against mine as heard here, where it must be clearly like theirs (see `same`). My
   * voice as learned here, through earphones in a loud place, is much like anyone heard through
   * them: on the rig the other person's lines through the same earphones were as like it as my
   * own, so it tells the two apart no better than their recording, of a voice on its own, against
   * mine, which kept most of their words out of my lines on the clean clip, and half at 10 dB.
   */
  ratherTheirs(side: string, print: Float32Array): boolean {
    return side === SOLO_ME && this.nearerTheirs(print);
  }

  /** Whether a voice is more like theirs than like mine, like against like (see `ratherTheirs`). */
  private nearerTheirs(print: Float32Array): boolean {
    if (!this.theirs) return false;
    const recorded = this.theirs.known === 'recorded';
    const theirs = similarity(print, this.theirs.print);
    if (recorded && theirs >= this.bars.alike && theirs >= similarity(print, this.mine) + NEARER_MARGIN) return true;
    const here = Math.max(this.partnerHere.likeness(print), recorded ? -1 : theirs);
    return here >= this.bars.same && here >= this.likeMine(print) + NEARER_MARGIN;
  }

  /**
   * Whether a voice is somewhat like `side`'s as recorded or learned, and not clearly the
   * other person's. Not as heard here: a voice learned here is itself only somewhat like the
   * recording, so someone else's voice gets that near it now and then.
   */
  private mayBe(side: string, print: Float32Array): boolean {
    if (side === SOLO_THEM) return this.theirs !== undefined && similarity(print, this.theirs.print) >= this.bars.alike;
    return similarity(print, this.mine) >= this.bars.alike && this.likePartner(print) < this.bars.same;
  }

  /**
   * Whose voice a piece of sound is in, for speech expected from `sides` (by the "Me" /
   * "Them" choice, or both in "auto"), before it is recognized: 'ours' if it is somewhat
   * like one of the two voices as recorded or learned (see `alike`), or clearly like one as
   * heard here (only clearly: see `mayBe`); 'other' if it is nobody's we know; 'maybe'
   * while a wanted voice is not known well enough to leave anything out on its account:
   * theirs until it is known, but for a voice the user said was not theirs; either until
   * it has been heard here, as a voice recorded somewhere else may sound unlike its
   * recording. Learns nothing.
   * When only mine is wanted, a voice clearly more like theirs than mine is 'other', however like
   * mine it is (see `ratherTheirs`).
   */
  judge(sides: readonly string[], print: Float32Array): GateVerdict {
    const rather = !sides.includes(SOLO_THEM) && this.ratherTheirs(SOLO_ME, print);
    if (!rather && (this.isMine(print) || similarity(print, this.mine) >= this.bars.alike)) return 'ours';
    if (sides.includes(SOLO_THEM)) {
      const theirs = this.theirs?.print;
      if (!theirs) return this.isRejected(print) ? 'other' : 'maybe';
      if (this.likePartner(print) >= this.bars.same || similarity(print, theirs) >= this.bars.alike) return 'ours';
      if (!this.partnerHere.print) return 'maybe';
    }
    if (sides.includes(SOLO_ME) && !this.mineHere.print) return 'maybe';
    return 'other';
  }

  /**
   * Whether a voice is clearly one of the two, as far as they are known, without learning
   * anything; with a side, one that speaks for it (see `admits`).
   * For me, never a voice clearly more like theirs than mine (see `ratherTheirs`).
   */
  recognizes(print: Float32Array, side?: string): boolean {
    if (side === SOLO_ME && this.ratherTheirs(side, print)) return false;
    return this.isMine(print) || (side !== SOLO_ME && this.likePartner(print) >= this.bars.same);
  }

  /** Whether two pieces of speech are clearly in the same voice. */
  sameVoice(a: Float32Array, b: Float32Array): boolean {
    return similarity(a, b) >= this.bars.same;
  }

  /** Whether a voice is clearly mine. */
  isMine(print: Float32Array): boolean {
    return this.likeMine(print) >= this.bars.same;
  }

  /**
   * Speech that is that side's, e.g. translated after all: how its voice sounds here is
   * learned from it, if it is still somewhat like that voice as recorded or learned, and
   * not much less like the voice here than that side's own lines have been (see
   * LEARN_MARGIN). Theirs only once it is known, and never from speech that may be in my
   * voice, said for them: from speech nothing like mine, or more like theirs than mine (see
   * `ratherTheirs`), as the other person's voice, of the same gender, is somewhat like mine
   * now and then, and nothing else would teach how theirs sounds here, through this
   * microphone in this place.
   */
  learn(side: string, print: Float32Array, seconds: number): void {
    if (seconds < MIN_LEARN_SECONDS) return;
    if (side !== SOLO_THEM) {
      if (similarity(print, this.mine) >= this.bars.alike && this.mineHere.mayLearn(print)) this.mineHere.add(print, seconds);
      return;
    }
    const theirs = this.theirs?.print;
    if (!theirs) return;
    const own = (similarity(print, theirs) >= this.bars.alike && this.likeMine(print) < this.bars.alike) || this.nearerTheirs(print);
    if (own && this.partnerHere.mayLearn(print)) this.partnerHere.add(print, seconds);
  }

  /**
   * Speech skipped, then translated after all: that side's. For them, in a voice other than
   * the one learned from what was said, nor mine, it means that one was someone else's:
   * theirs is this one from then on. A recorded voice stays: it just sounds different here.
   * Until theirs is known, a voice the user said was not theirs may be theirs after all.
   *
   * Said for me holding the button (`vouched`), it is my voice as heard here however unlike
   * my recording it is, unless it is clearly theirs: a recording made somewhere else, or
   * through another microphone, can be nothing like my voice through earphones in a crowd,
   * and nothing else would teach how it sounds there.
   */
  translated(side: string, print: Float32Array, seconds: number, vouched = false): void {
    const learned = side === SOLO_THEM && this.theirs?.known === 'learned';
    if (learned && !this.recognizes(print, side) && seconds >= MIN_LEARN_SECONDS) {
      this.theirs = { print: normalized(print), known: 'learned' };
      this.partnerHere.forget();
    } else if (vouched && side !== SOLO_THEM) {
      if (seconds >= MIN_LEARN_SECONDS && this.likePartner(print) < this.bars.same) this.mineHere.add(print, seconds);
    } else if (this.checks(side)) {
      this.learn(side, print, seconds);
    } else {
      this.rejected = this.rejected.filter((voice) => similarity(print, voice) < this.bars.same);
      this.learnPartner(print, seconds);
    }
  }

  /**
   * The voice learned for them is someone else's, the user says: it is forgotten, skipped
   * from now on, and theirs is learned afresh from what is said for them. False when their
   * voice is not learned: a recorded one is replaced by recording it again, or picking them.
   */
  rejectPartner(): boolean {
    if (this.theirs?.known !== 'learned') return false;
    this.rejected.push(this.theirs.print);
    this.theirs = undefined;
    this.partnerHere.forget();
    this.heard.forget();
    return true;
  }

  /**
   * Their voice, as recorded for this conversation or saved from an earlier one: it
   * replaces whatever was known of it. False for a voice print from another speaker model.
   */
  setPartner(print: Float32Array): boolean {
    if (print.length !== this.mine.length) return false;
    this.theirs = { print: normalized(print), known: 'recorded' };
    this.partnerHere.forget();
    this.heard.forget();
    return true;
  }

  /**
   * How alike a voice is to each of the two as recorded, and as heard here, without learning
   * anything: for a talk report (see `TalkReportEntry`).
   */
  describe(print: Float32Array): VoiceLikeness {
    const theirs = this.theirs?.print;
    return {
      mine: similarity(print, this.mine),
      mineHere: this.mineHere.likeness(print),
      partner: theirs ? similarity(print, theirs) : -1,
      partnerHere: this.partnerHere.likeness(print),
      ...(this.mineHere.settled && { unlikeMineBelow: this.mineHere.unlikeBelow }),
      ...(this.mineHere.doubtBelow !== undefined && { doubtMineBelow: this.mineHere.doubtBelow }),
    };
  }

  /**
   * Something said for them while their voice is not known: theirs is the voice that keeps
   * coming back and says the most, as anyone else around speaks only now and then. Not from
   * anything short. Their voice may be rather like mine: only one that, from all it said, is
   * clearly mine is not theirs, as each thing I say may be too unclear to tell on its own.
   */
  private learnPartner(print: Float32Array, seconds: number): void {
    if (seconds < MIN_LEARN_SECONDS) return;
    const theirs = this.heard.add(print, seconds);
    if (!theirs || this.isMine(theirs)) return;
    this.theirs = { print: theirs, known: 'learned' };
    this.heard.forget();
  }

  /** Whether a voice is one the user said was not theirs. */
  private isRejected(print: Float32Array): boolean {
    return this.rejected.some((voice) => similarity(print, voice) >= this.bars.same);
  }

  /** How alike a voice is to mine, as recorded or as heard here. */
  private likeMine(print: Float32Array): number {
    return Math.max(similarity(print, this.mine), this.mineHere.likeness(print));
  }

  /** How alike a voice is to theirs, as recorded or learned, or as heard here; -1 until it is known. */
  private likePartner(print: Float32Array): number {
    const theirs = this.theirs ? similarity(print, this.theirs.print) : -1;
    return Math.max(theirs, this.partnerHere.likeness(print));
  }
}

/** A voice heard for the other person while theirs is learned. */
interface HeardVoice {
  /** The sum of the prints of what it said. */
  sum: Float32Array;
  lines: number;
  seconds: number;
}

/** The voices heard for the other person while theirs is learned, to tell which is theirs. */
class HeardVoices {
  private readonly bars: VoiceBars;
  private voices: HeardVoice[] = [];

  constructor(bars: VoiceBars) {
    this.bars = bars;
  }

  /** Something said in some voice: that voice once it is clearly theirs (see LEARN_LINES). */
  add(print: Float32Array, seconds: number): Float32Array | undefined {
    let voice: HeardVoice | undefined;
    let best = this.bars.same;
    for (const candidate of this.voices) {
      const likeness = similarity(print, normalized(candidate.sum));
      if (likeness >= best) [voice, best] = [candidate, likeness];
    }
    if (voice) {
      for (let i = 0; i < print.length; i++) voice.sum[i] = voice.sum[i]! + print[i]!;
      voice.lines += 1;
      voice.seconds += seconds;
    } else {
      voice = { sum: new Float32Array(print), lines: 1, seconds };
      // Those that said the least are forgotten, but not the newest, which has barely begun.
      const kept = this.voices.sort((a, b) => b.seconds - a.seconds).slice(0, HEARD_VOICES - 1);
      this.voices = [...kept, voice];
    }
    const others = Math.max(0, ...this.voices.filter((other) => other !== voice).map((other) => other.seconds));
    const theirs = voice.lines >= LEARN_LINES && voice.seconds >= PARTNER_SECONDS && voice.seconds >= LEARN_LEAD * others;
    return theirs ? normalized(voice.sum) : undefined;
  }

  forget(): void {
    this.voices = [];
  }
}

/** A voice learned from the last few voice prints of what someone said. */
class LearnedVoice {
  private readonly bars: VoiceBars;
  /** The sum of the prints, when any. */
  private sum: Float32Array | undefined;
  private count = 0;
  /** Seconds of speech the prints are from, each counting at most MAX_PRINT_SECONDS. */
  private seconds = 0;
  /** How alike each of the last prints was to the voice as learned before it, the first aside. */
  private likenesses: number[] = [];
  /** The voice print of the voice as learned so far; undefined while it is unknown. */
  print: Float32Array | undefined;

  constructor(bars: VoiceBars) {
    this.bars = bars;
  }

  /** How alike a voice is to this one (see `similarity`); -1 while it is unknown. */
  likeness(print: Float32Array): number {
    return this.print ? similarity(print, this.print) : -1;
  }

  /** Whether it is learned from enough to be a fair likeness of the voice (see SETTLED_PRINTS). */
  get settled(): boolean {
    return this.count >= SETTLED_PRINTS || (this.count >= 2 && this.seconds >= SETTLED_SECONDS);
  }

  /**
   * How alike to this voice the least alike of the last prints learned from was, once this
   * one is settled: how evenly it is heard here. Not from one print alone, which is still a
   * poor measure of that.
   */
  private get leastAlike(): number | undefined {
    if (!this.settled || this.likenesses.length < 2) return undefined;
    return Math.min(...this.likenesses);
  }

  /**
   * Under how alike to this voice another is not it, as far as its own speech tells, once
   * this one is settled: the least alike of the last prints learned from, less UNLIKE_MARGIN.
   */
  private get bar(): number | undefined {
    const least = this.leastAlike;
    return least === undefined ? undefined : least - UNLIKE_MARGIN;
  }

  /**
   * Whether this voice may be learned from a print of speech that is its own as far as the
   * voice as recorded or learned tells (see `VoiceFilter.learn`): not once it is settled from
   * one much less like it than its own lines have been (see LEARN_MARGIN). What the user asks
   * for is learned from whatever its likeness (see `add`).
   */
  mayLearn(print: Float32Array): boolean {
    const least = this.leastAlike;
    return least === undefined || this.likeness(print) >= least - LEARN_MARGIN;
  }

  /**
   * Under how alike to this voice another is clearly not it, once this one is settled (see
   * `unlike`, UNLIKE_MARGIN): the bar its own speech tells (see `bar`), but never under `unlike`
   * nor over `same`, which is clearly this voice whatever the bar.
   */
  get unlikeBelow(): number {
    const bar = this.bar;
    return bar === undefined ? this.bars.unlike : Math.min(this.bars.same, Math.max(this.bars.unlike, bar));
  }

  /**
   * Under how alike to this voice another is in doubt (see `VoiceFilter.doubtful`): the bar
   * its own speech tells (see `bar`), when that is over `same`; undefined when nothing
   * clearly like this voice is in doubt.
   */
  get doubtBelow(): number | undefined {
    const bar = this.bar;
    return bar !== undefined && bar > this.bars.same ? bar : undefined;
  }

  /** Learns from a print of that many seconds of speech. */
  add(print: Float32Array, seconds: number): void {
    this.seconds += Math.min(seconds, MAX_PRINT_SECONDS);
    if (this.print) this.likenesses = [...this.likenesses, similarity(print, this.print)].slice(-(REMEMBERED_PRINTS - 1));
    if (!this.sum) {
      this.sum = new Float32Array(print);
      this.count = 1;
    } else {
      // A running mean at first, then one that slowly forgets the oldest prints.
      const keep = this.count >= REMEMBERED_PRINTS ? (REMEMBERED_PRINTS - 1) / REMEMBERED_PRINTS : 1;
      for (let i = 0; i < print.length; i++) this.sum[i] = this.sum[i]! * keep + print[i]!;
      this.count = Math.min(this.count + 1, REMEMBERED_PRINTS);
    }
    this.print = normalized(this.sum);
  }

  /** What it was learned from, as a copy; undefined while it is unknown. */
  saved(): LearnedPrints | undefined {
    return this.sum && { sum: new Float32Array(this.sum), count: this.count, seconds: this.seconds, likenesses: [...this.likenesses] };
  }

  /** Takes up a voice as learned before, e.g. in an earlier conversation. */
  restore(learned: LearnedPrints): void {
    const count = Number.isFinite(learned.count) ? Math.round(learned.count) : 1;
    this.sum = new Float32Array(learned.sum);
    this.count = Math.max(1, Math.min(count, REMEMBERED_PRINTS));
    this.seconds = Number.isFinite(learned.seconds) && learned.seconds! > 0 ? learned.seconds! : 0;
    this.likenesses = (learned.likenesses ?? []).filter((value) => Number.isFinite(value) && Math.abs(value) <= 1).slice(-(REMEMBERED_PRINTS - 1));
    this.print = normalized(this.sum);
  }

  forget(): void {
    this.sum = undefined;
    this.count = 0;
    this.seconds = 0;
    this.likenesses = [];
    this.print = undefined;
  }
}

/** Seconds of speech a recording of someone's voice needs for a reliable voice print. */
export const RECORDING_SECONDS = 10;
/** Moments louder than the background by this much are speech, in dB. */
const SPEECH_ABOVE_NOISE_DB = 12;
/** Anything quieter is not speech, in dB below full scale. */
export const QUIETEST_SPEECH_DB = -50;
/** The background is as loud as the quietest 10% of a recording's moments. */
const NOISE_PERCENTILE = 0.1;

/**
 * A recording of someone's voice, for their voice print: keeps the moments clearly louder
 * than the background, which are them talking, and leaves out the pauses.
 */
export class VoiceRecording {
  private readonly chunks: Int16Array[] = [];
  /** How loud each chunk is, in dB below full scale. */
  private readonly levels: number[] = [];

  /** Adds some 16 kHz mono audio, such as 100 ms from the microphone. */
  add(chunk: Int16Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk.slice());
    let sum = 0;
    for (const sample of chunk) sum += sample * sample;
    this.levels.push(Math.max(-100, 10 * Math.log10(sum / chunk.length / 32768 ** 2)));
  }

  /** How many chunks were added. */
  get length(): number {
    return this.chunks.length;
  }

  /** Seconds of speech so far. */
  get speechSeconds(): number {
    return this.secondsOfSpeech(0);
  }

  /** Seconds of speech from the `from`th chunk on. */
  secondsOfSpeech(from: number): number {
    return this.speechChunks(from).reduce((total, chunk) => total + chunk.length, 0) / AUDIO_SAMPLE_RATE;
  }

  /** The speech so far, from the `from`th chunk on, without the pauses. */
  speech(from = 0): Int16Array {
    return joined(this.speechChunks(from));
  }

  /** The chunks from the `from`th on that are speech, against the background of the whole recording. */
  private speechChunks(from: number): Int16Array[] {
    const sorted = [...this.levels].sort((a, b) => a - b);
    const noise = sorted[Math.floor(sorted.length * NOISE_PERCENTILE)] ?? 0;
    const threshold = Math.max(QUIETEST_SPEECH_DB, noise + SPEECH_ABOVE_NOISE_DB);
    return this.chunks.filter((_, i) => i >= from && this.levels[i]! >= threshold);
  }
}

/** Seconds of the other person's speech their voice print is made from. */
export const PARTNER_SECONDS = 6;
/** When a recording of their voice gives up, this much of it is still enough. */
const MIN_PARTNER_SECONDS = 3;
/** Their recording is checked this many seconds of speech at a time, to leave out my voice. */
const PART_SECONDS = 2;
/** Seconds of sound after which a recording that heard too little of them gives up. */
const PARTNER_GIVE_UP_SECONDS = 30;
/** Seconds of sound after which a recording that heard little of them says so. */
const PARTNER_HINT_SECONDS = 10;

/** How recording the other person's voice is going. */
export interface RecordingProgress {
  /** Seconds of their voice so far. */
  seconds: number;
  /** Seconds of it needed. */
  of: number;
  /** What is going wrong, if anything. */
  hint?: RecordingProblem;
}

export interface PartnerRecordingEvents {
  /** How the recording is going, whenever that changes. */
  progress(progress: RecordingProgress): void;
  /** It is over: their voice is recorded, unless it `failed`. */
  done(failed: RecordingProblem | undefined): void;
}

/**
 * Records the other person's voice for a conversation, from what the microphone hears
 * next. It is checked a couple of seconds of speech at a time, leaving out what is in my
 * voice, until there is enough of theirs for a reliable voice print, which the VoiceFilter
 * then keeps for the conversation.
 */
export class PartnerRecording {
  private readonly voices: VoiceFilter;
  private readonly events: PartnerRecordingEvents;
  private readonly log: Logger;
  private readonly recording = new VoiceRecording();
  /** Samples of sound heard, pauses included. */
  private heard = 0;
  /** The recording's first chunk in the part still being heard. */
  private partStart = 0;
  /** Seconds of speech in the parts not checked yet. */
  private unchecked = 0;
  /** The parts in their voice. */
  private readonly theirs: Int16Array[] = [];
  private theirSeconds = 0;
  private mineParts = 0;
  private hint: RecordingProblem | undefined;
  /** Parts are checked one at a time, in order. */
  private checks: Promise<void> = Promise.resolve();
  /** Enough was heard: what comes next does not count. */
  private full = false;
  /** Done, or stopped: it reports nothing more. */
  private over = false;
  private reported = '';

  constructor(voices: VoiceFilter, events: PartnerRecordingEvents, log: Logger) {
    this.voices = voices;
    this.events = events;
    this.log = log;
  }

  get progress(): RecordingProgress {
    const speech = this.theirSeconds + this.unchecked + this.recording.secondsOfSpeech(this.partStart);
    const seconds = Math.min(PARTNER_SECONDS, Math.floor(speech));
    const quiet = this.heard >= PARTNER_HINT_SECONDS * AUDIO_SAMPLE_RATE && seconds < PARTNER_SECONDS / 3;
    const hint = this.hint ?? (quiet ? 'quiet' : undefined);
    return hint ? { seconds, of: PARTNER_SECONDS, hint } : { seconds, of: PARTNER_SECONDS };
  }

  /** Some 16 kHz mono PCM16 from the microphone. */
  add(pcm: Uint8Array): void {
    if (this.full || this.over) return;
    const chunk = new Int16Array(pcm.byteLength >> 1);
    new Uint8Array(chunk.buffer).set(pcm.subarray(0, chunk.byteLength));
    // Silence in place of the microphone's sound, while the phone talks.
    if (chunk.every((sample) => sample === 0)) return;
    this.heard += chunk.length;
    this.recording.add(chunk);
    const giveUp = this.heard >= PARTNER_GIVE_UP_SECONDS * AUDIO_SAMPLE_RATE;
    const speech = this.recording.secondsOfSpeech(this.partStart);
    // Giving up, the last of what they said still counts, if it is long enough to tell.
    if (speech >= PART_SECONDS || (giveUp && speech >= MIN_CHECK_SECONDS)) {
      const part = this.recording.speech(this.partStart);
      this.partStart = this.recording.length;
      this.unchecked += part.length / AUDIO_SAMPLE_RATE;
      this.queue(() => this.check(part));
    }
    if (giveUp) {
      this.full = true;
      this.queue(() => this.finish());
    }
    this.report();
  }

  /** Stops recording, leaving what is known of their voice as it was. */
  stop(): void {
    this.over = true;
  }

  private queue(task: () => Promise<void>): void {
    this.checks = this.checks.then(task).catch((error: unknown) => {
      this.log.warn('voice recording', error);
      this.end('quiet');
    });
  }

  /** Keeps a part of the recording, unless it is in my voice. */
  private async check(part: Int16Array): Promise<void> {
    if (this.over) return;
    const print = await this.voices.printOf(part);
    const seconds = part.length / AUDIO_SAMPLE_RATE;
    this.unchecked -= seconds;
    if (this.over) return;
    if (print && this.voices.isMine(print)) {
      this.mineParts += 1;
      this.hint = 'mine';
    } else {
      this.theirs.push(part);
      this.theirSeconds += seconds;
      this.hint = undefined;
    }
    if (this.theirSeconds >= PARTNER_SECONDS) {
      this.full = true;
      await this.finish();
    } else {
      this.report();
    }
  }

  /** Makes their voice print from the parts in their voice, if there is enough of them. */
  private async finish(): Promise<void> {
    if (this.over) return;
    if (this.theirSeconds < MIN_PARTNER_SECONDS) {
      this.end(this.mineParts > this.theirs.length ? 'mine' : 'quiet');
      return;
    }
    const print = await this.voices.printOf(joined(this.theirs));
    if (this.over) return;
    if (!print) {
      this.end('quiet');
    } else if (this.voices.isMine(print)) {
      this.end('mine');
    } else {
      this.voices.setPartner(print);
      this.end(undefined);
    }
  }

  private end(failed: RecordingProblem | undefined): void {
    if (this.over) return;
    this.stop();
    this.events.done(failed);
  }

  private report(): void {
    if (this.over) return;
    const progress = this.progress;
    const key = `${progress.seconds} ${progress.hint ?? ''}`;
    if (key === this.reported) return;
    this.reported = key;
    this.events.progress(progress);
  }
}

export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** Pieces of sound, one after the other. */
export function joined(chunks: readonly Int16Array[]): Int16Array {
  const all = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}

function normalized(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  return vector.map((value) => value / norm);
}
