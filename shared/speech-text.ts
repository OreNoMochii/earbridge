// Used on both sides: the app splits text for the phone's own voice, the server for cloud voices.

/**
 * Splits text into pieces of at most `maxLength` characters, at sentence boundaries where
 * possible: some engines (Chrome's) stop in the middle of long text, and cloud voices limit
 * how much text one request can take.
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
