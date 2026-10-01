import type { ServerMessage } from '../../../shared/protocol.ts';
import type { Logger } from '../log.ts';
import { SpeechError } from './types.ts';
import type { SpeechRequest, SpeechSynthesizer } from './types.ts';

export type SpeechMessage = Extract<ServerMessage, { type: 'speech' }>;

/**
 * Reads one translation aloud and reports it as a single `speech` message: the audio, or
 * no audio and an `error`, in which case the phone's own voice reads it. Nothing is
 * reported once `request.signal` is aborted.
 */
export async function deliverSpeech(
  synthesizer: SpeechSynthesizer,
  request: SpeechRequest,
  utteranceId: string,
  deliver: (message: SpeechMessage) => void,
  log: Logger,
): Promise<void> {
  const base = { type: 'speech', id: utteranceId, lang: request.lang } as const;
  try {
    const clips = await synthesizer.synthesize(request);
    if (request.signal?.aborted) return;
    deliver({ ...base, audio: clips.map((clip) => clip.toString('base64')) });
  } catch (error) {
    if (request.signal?.aborted) return;
    log.warn(`speech (${request.lang}) failed`, error);
    const message = error instanceof SpeechError ? error.message : 'The voice failed.';
    deliver({ ...base, audio: [], error: message });
  }
}
