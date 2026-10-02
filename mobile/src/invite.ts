// Invites into a room. A server with https gets the web app's link, which opens in any
// phone's browser. Otherwise browsers may not use the microphone, so the link opens this
// app instead, and carries the server's address along with the room.

import { normalizeRoomCode } from '../../shared/room-code.ts';
import { isSecure, normalizeServerUrl } from './server-url.ts';

export interface Invite {
  room: string;
  /** The server the room is on; undefined for a web link, which leaves the server as set. */
  server: string | undefined;
}

export function inviteUrl(server: string, room: string): string {
  return isSecure(server) ? `${server}/?room=${room}` : `alo://join?room=${room}&server=${encodeURIComponent(server)}`;
}

/** Reads alo://join?room=…&server=… (or the older earbridge://), or a web app invite link. */
export function parseInvite(url: string): Invite | undefined {
  const room = normalizeRoomCode(param(url, 'room') ?? '');
  if (!room) return undefined;
  const server = param(url, 'server');
  return { room, server: server ? normalizeServerUrl(server) : undefined };
}

function param(url: string, name: string): string | undefined {
  const match = new RegExp(`[?&]${name}=([^&#]*)`).exec(url);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!.replace(/\+/g, ' '));
  } catch {
    return undefined; // malformed
  }
}
