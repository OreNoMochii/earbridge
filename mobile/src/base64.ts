// The server sends the natural voice as base64 MP3 clips, and the Android microphone
// module hands over its sound the same way. React Native has no decoder built in.
// Voice prints are stored as base64 too.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(128);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

/** Decodes standard base64; the "=" padding is optional. */
export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  let end = base64.length;
  while (end > 0 && base64.charCodeAt(end - 1) === 61 /* = */) end--;
  const bytes = new Uint8Array((end * 3) >> 2);
  let out = 0;
  for (let i = 0; i < end; i += 4) {
    const triple =
      ((LOOKUP[base64.charCodeAt(i)] ?? 0) << 18) |
      ((LOOKUP[base64.charCodeAt(i + 1)] ?? 0) << 12) |
      ((LOOKUP[base64.charCodeAt(i + 2)] ?? 0) << 6) |
      (LOOKUP[base64.charCodeAt(i + 3)] ?? 0);
    if (out < bytes.length) bytes[out++] = triple >> 16;
    if (out < bytes.length) bytes[out++] = (triple >> 8) & 0xff;
    if (out < bytes.length) bytes[out++] = triple & 0xff;
  }
  return bytes;
}

/** Encodes as standard base64, with "=" padding. */
export function toBase64(bytes: Uint8Array): string {
  let base64 = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const triple = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    base64 += ALPHABET[triple >> 18]! + ALPHABET[(triple >> 12) & 63]!;
    base64 += i + 1 < bytes.length ? ALPHABET[(triple >> 6) & 63]! : '=';
    base64 += i + 2 < bytes.length ? ALPHABET[triple & 63]! : '=';
  }
  return base64;
}
