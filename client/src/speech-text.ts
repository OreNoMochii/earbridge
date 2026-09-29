// Text-to-speech helpers, kept free of DOM APIs so they can be unit-tested in Node.

/** The parts of SpeechSynthesisVoice used to pick a voice. */
export interface VoiceInfo {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

// Language codes some speech engines use instead of ours.
const ALIASES: Record<string, readonly string[]> = {
  no: ['no', 'nb', 'nn'],
  id: ['id', 'in'],
};

// Apple's novelty voices are tagged en-US; never pick them for real speech.
const NOVELTY_VOICES = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'good news',
  'jester', 'organ', 'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox',
]);

function normalize(tag: string): string {
  return tag.replace(/_/g, '-').toLowerCase();
}

/** Picks the best installed voice for a BCP-47 language code, if there is one. */
export function pickVoice<V extends VoiceInfo>(voices: readonly V[], lang: string): V | undefined {
  const target = normalize(lang);
  const base = target.split('-')[0]!;
  const bases = ALIASES[base] ?? [base];
  let best: V | undefined;
  let bestScore = 0;
  for (const voice of voices) {
    const voiceLang = normalize(voice.lang);
    const voiceBase = voiceLang.split('-')[0]!;
    let score = voiceLang === target ? 100 : bases.includes(voiceBase) ? 50 : 0;
    if (score === 0) continue;
    // Mandarin text read by a Cantonese voice is understandable but not what was asked for.
    if (base === 'zh' && voiceLang !== target && /^zh-(hk|mo)/.test(voiceLang)) score -= 30;
    if (NOVELTY_VOICES.has(voice.name.toLowerCase())) score -= 60;
    if (/premium|enhanced|natural|neural/i.test(voice.name)) score += 4;
    if (voice.localService) score += 2; // no network round trip
    if (voice.default) score += 1;
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Splits a translation into pieces of at most `maxLength` characters, at sentence
 * boundaries where possible: some engines (Chrome's) stop in the middle of long utterances.
 */
export function splitForSpeech(text: string, maxLength = 200): string[] {
  const sentences = text
    .trim()
    .split(/(?<=[.!?…؟।])\s+|(?<=[。！？])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const pieces: string[] = [];
  for (const sentence of sentences) {
    const last = pieces.at(-1);
    // Fewer, longer pieces mean fewer pauses between them.
    if (last !== undefined && last.length + 1 + sentence.length <= maxLength) {
      pieces[pieces.length - 1] = `${last} ${sentence}`;
    } else {
      pieces.push(...splitLong(sentence, maxLength));
    }
  }
  return pieces;
}

function splitLong(sentence: string, maxLength: number): string[] {
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > maxLength) {
    // Prefer a comma, then a space; text without spaces (Chinese, Japanese, Thai) is cut anywhere.
    const window = rest.slice(0, maxLength);
    const comma = Math.max(window.lastIndexOf(', '), window.lastIndexOf('，'), window.lastIndexOf('、'));
    const space = window.lastIndexOf(' ');
    const at = comma > maxLength / 3 ? comma + 1 : space > maxLength / 3 ? space : maxLength;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}
