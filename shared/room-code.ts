// Room codes, shared so the phone app can check a typed code before trying to join.

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L look-alikes
export const ROOM_CODE_LENGTH = 6;

/** "abc 123" -> "ABC123"; undefined if the input cannot be a room code. */
export function normalizeRoomCode(input: string): string | undefined {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return undefined;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return undefined;
  return code;
}

/** "ABC234" -> "ABC 234": easier to read out loud. */
export function formatRoomCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
