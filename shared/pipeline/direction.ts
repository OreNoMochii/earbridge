import { SOLO_ME, SOLO_THEM } from '../protocol.ts';

/** Which way some sound came from, as the phone's two microphones heard it. */
export interface Direction {
  /**
   * How many samples (at 16 kHz) after the phone's first microphone the sound reached its
   * second; negative when it reached the second first. Up to about 7 for microphones 15 cm apart.
   */
  delay: number;
  /** How clearly it came from one place: near 0 for chatter from all around, up to 1. */
  clarity: number;
}

/** What a phone recording two of its microphones tells about some sound, besides the sound itself. */
export interface Spatial {
  /** Changes whenever the phone was turned, or recording changed: the directions heard before no longer apply. */
  pose: number;
  /** Which way it came from, unless too little of it stood out from the background to tell. */
  direction?: Direction;
}

type Side = typeof SOLO_ME | typeof SOLO_THEM;

/** Where speech came from: where one of the two people sits, or in between, from a side of the phone. */
export type Place = Side | 'between';

/** Moments less clear than this tell nothing about where speech came from. */
const CLEAR = 0.2;
/** Speech has a direction when at least this many of its moments (100 ms each) are clear… */
const MIN_CLEAR_MOMENTS = 3;
/** …and most of them, counting clearer ones for more, came from this close to each other (in samples). */
const FOCUS = 1.5;
const MIN_FOCUSED = 0.5;

/** Seconds of directions kept: as long as the conversation's audio is. */
const KEEP_SECONDS = 30;
/** The last few directions each side spoke from are kept… */
const KEEP_HEADINGS = 8;
/** …and where a side sits is known once it spoke this many times from the same end of the phone. */
const MIN_HEADINGS = 2;
/**
 * Speech from closer than this to straight off the phone's sides, in samples, tells nothing
 * about where the two people sit: they sit beyond its ends. (With microphones 15 cm apart,
 * that is anyone within about 17° of straight off a side.)
 */
const MIN_SIT = 2;
/**
 * How far from where a side sits its speech may come, in samples: people lean and turn.
 * Further for a side whose directions vary more.
 */
const MIN_REACH = 2;
const MAX_REACH = 3;
const REACH_PER_SPREAD = 2.5;
/** Room needed between the two sides' reaches to tell voices from the sides, in samples. */
const MIN_GAP = 1;

/**
 * The direction speech came from, from the directions of its moments: where most of its
 * clear moments agree, as a delay between the microphones (see Direction). Undefined when
 * too few moments were clear, or they disagree, as with chatter from all around.
 */
export function headingOf(moments: readonly Direction[]): number | undefined {
  const clear = moments.filter((moment) => moment.clarity >= CLEAR).sort((a, b) => a.delay - b.delay);
  if (clear.length < MIN_CLEAR_MOMENTS) return undefined;
  const total = sum(clear, (moment) => moment.clarity);
  // The middle direction, counting clearer moments for more.
  let below = 0;
  const middle = (clear.find((moment) => (below += moment.clarity) >= total / 2) ?? clear[clear.length - 1]!).delay;
  const focused = clear.filter((moment) => Math.abs(moment.delay - middle) <= FOCUS);
  const weight = sum(focused, (moment) => moment.clarity);
  if (weight < total * MIN_FOCUSED) return undefined;
  return sum(focused, (moment) => moment.delay * moment.clarity) / weight;
}

/**
 * Tells the two people at the phone from people at its sides, by which way their voices
 * come. A phone recording two of its microphones hears how much later a sound reaches one
 * than the other. With the phone lying flat between the two people, pointing from one to
 * the other, each one's voice reaches one microphone well before the other, and voices from
 * the sides reach both at about the same time. Where each one sits is learned from what
 * they say.
 */
export class DirectionFilter {
  /** The directions of the last stretch of sound, by when they were heard. */
  private moments: { at: number; direction: Direction }[] = [];
  /** The last few directions each side spoke from. */
  private readonly headings = new Map<Side, number[]>();
  private pose: number | undefined;

  /** Adds what the microphones told about some sound heard at `at`, in seconds on the conversation's audio clock. */
  hear(at: number, spatial: Spatial): void {
    if (spatial.pose !== this.pose) {
      // The phone moved: as it hears them, nobody sits where they did.
      this.headings.clear();
      this.moments = [];
      this.pose = spatial.pose;
    }
    if (!spatial.direction) return;
    this.moments.push({ at, direction: spatial.direction });
    while (this.moments[0]!.at < at - KEEP_SECONDS) this.moments.shift();
  }

  /** The direction of the speech heard between two times on the audio clock, if clear (see `headingOf`). */
  headingBetween(start: number, end: number): number | undefined {
    return headingOf(this.moments.filter((moment) => moment.at >= start && moment.at <= end).map((moment) => moment.direction));
  }

  /** Where speech from this direction came from; undefined while that cannot be told. */
  judge(heading: number): Place | undefined {
    const me = this.placeOf(SOLO_ME);
    const them = this.placeOf(SOLO_THEM);
    if (!me || !them) {
      // Only speech from where the one side known sits can be told.
      const known = me ?? them;
      return known && Math.abs(heading - known.center) <= known.reach ? known.side : undefined;
    }
    // Not at its two ends, or too close together to tell anyone else from them.
    if (Math.sign(me.center) === Math.sign(them.center)) return undefined;
    const [low, high] = me.center < them.center ? [me, them] : [them, me];
    if (high.center - high.reach - (low.center + low.reach) < MIN_GAP) return undefined;
    // Beyond where someone sits counts as them: they lean back.
    if (heading <= low.center + low.reach) return low.side;
    if (heading >= high.center - high.reach) return high.side;
    return 'between';
  }

  /**
   * That side said something from this direction. Not learned if it came from where the
   * other sits, or from the phone's sides: speech from there, say someone passing by taken
   * for them, would teach a wrong place.
   */
  learn(side: Side, heading: number): void {
    if (Math.abs(heading) < MIN_SIT) return;
    const place = this.judge(heading);
    if (place !== undefined && place !== side && place !== 'between') return;
    this.headings.set(side, [...(this.headings.get(side) ?? []), heading].slice(-KEEP_HEADINGS));
  }

  /**
   * Speech from this direction was that side's after all: where it sits is learned afresh.
   * When that is a side of the phone, it stays unknown, and nobody is skipped for where
   * they speak from until it lies elsewhere.
   */
  correct(side: Side, heading: number): void {
    this.headings.set(side, Math.abs(heading) < MIN_SIT ? [] : [heading]);
  }

  /** Where a side sits, and how far from there its speech may come; undefined until known. */
  private placeOf(side: Side): { side: Side; center: number; reach: number } | undefined {
    const headings = this.headings.get(side) ?? [];
    // At the end of the phone most of it came from: any from the other end was the other person's.
    const ahead = headings.filter((heading) => heading > 0);
    const behind = headings.filter((heading) => heading < 0);
    const usual = ahead.length > behind.length ? ahead : behind.length > ahead.length ? behind : [];
    if (usual.length < MIN_HEADINGS) return undefined;
    const center = median(usual);
    const spread = median(usual.map((heading) => Math.abs(heading - center)));
    return { side, center, reach: Math.min(MAX_REACH, Math.max(MIN_REACH, spread * REACH_PER_SPREAD)) };
  }
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
