// What does the work in a conversation: a computer running the server (see connection.ts), or
// the phone itself (see in-app-backend.ts). Both speak the server's protocol, so the
// conversation screen works the same either way.

import type { Spatial } from '../../../shared/pipeline/direction.ts';
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
  /** 16 kHz mono PCM16, and which way it came from when the phone can tell. */
  sendAudio(pcm: ArrayBuffer, spatial?: Spatial): void;
  stop(): void;
  /**
   * The other person's voice from a print saved in an earlier conversation. Only the phone
   * itself prints voices: prints are never sent anywhere. False when it cannot be used.
   */
  usePartnerVoice?(print: Float32Array): boolean;
  /** Their voice print as recorded in this conversation, e.g. to save it for the next. */
  partnerVoice?(): Float32Array | undefined;
  /** The two voices as the phone hears them here, those learned so far, for keeping only voices like them. */
  voicesHere?(): Float32Array[];
}
