// What does the work in a conversation: a computer running the server (see connection.ts), or
// the phone itself (see in-app-backend.ts). Both speak the server's protocol, so the
// conversation screen works the same either way.

import type { ClientMessage, ServerMessage } from '../../../shared/protocol.ts';
import type { ConnectionState, EndReason } from '../connection.ts';

export interface BackendEvents {
  onMessage(message: ServerMessage): void;
  onStateChange(state: ConnectionState): void;
  /** The conversation is over and will not resume. */
  onEnded(reason: EndReason): void;
  /** What is being got ready, e.g. a language download; undefined once it is done. */
  onProgress?(text: string | undefined): void;
}

export interface Backend {
  start(): void;
  send(message: ClientMessage): void;
  /** 16 kHz mono PCM16. */
  sendAudio(pcm: ArrayBuffer): void;
  stop(): void;
}
