import { baseLanguage } from '../languages.ts';
import { SOLO_ME, SOLO_THEM } from '../protocol.ts';

/** Who said something, judging by its language; "other" when it was neither side's. */
export type LanguageVerdict = typeof SOLO_ME | typeof SOLO_THEM | 'other';

/** Languages the multilingual recognizer tends to mix up, word by word. */
const RELATED: readonly (readonly string[])[] = [
  ['es', 'pt', 'it'],
  ['de', 'nl'],
];

/** A few stray words in another language are normal (names, loanwords, mistakes). */
const MIN_FOREIGN_WORDS = 2;

/**
 * Attributes an utterance to one side of a conversation between `myLang` and `theirLang`
 * by the languages its words were tagged with. Mostly another language means someone
 * else nearby, or a song: "other". Untagged speech goes to them, as it always did.
 */
export function judgeLanguages(
  votes: ReadonlyMap<string, number>,
  myLang: string,
  theirLang: string,
): LanguageVerdict {
  const mine = baseLanguage(myLang);
  const theirs = baseLanguage(theirLang);
  let me = 0;
  let them = 0;
  let ours = 0;
  let foreign = 0;
  for (const [lang, count] of votes) {
    const forMe = lang === mine || (lang !== theirs && related(lang, mine));
    const forThem = lang === theirs || (lang !== mine && related(lang, theirs));
    if (forMe || forThem) ours += count;
    else foreign += count;
    // A language related to both sides is still ours, but says nothing about who spoke.
    if (forMe && !forThem) me += count;
    if (forThem && !forMe) them += count;
  }
  if (foreign >= MIN_FOREIGN_WORDS && foreign > ours) return 'other';
  return me > them ? SOLO_ME : SOLO_THEM;
}

function related(a: string, b: string): boolean {
  return RELATED.some((group) => group.includes(a) && group.includes(b));
}
