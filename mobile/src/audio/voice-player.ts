// Plays the server's natural voices: audio clips (MP3) that arrive as base64 over the
// WebSocket. A port of the web app's client/src/voice-player.ts.

import { AudioContext } from 'react-native-audio-api';
import type { AudioBuffer, AudioBufferSourceNode } from 'react-native-audio-api';

import { fromBase64 } from '../base64.ts';

export class VoicePlayer {
  private context: AudioContext | undefined;
  // Clips still playing, with a function that settles them.
  private readonly active = new Map<AudioBufferSourceNode, () => void>();
  private generation = 0;
  private closed = false;

  /**
   * Plays the clips one after the other. Resolves when they have finished or were
   * cancelled; rejects if this phone cannot decode them.
   */
  async play(clips: readonly string[]): Promise<void> {
    const generation = this.generation;
    const context = this.open();
    let buffers: AudioBuffer[];
    try {
      buffers = await Promise.all(clips.map((clip) => context.decodeAudioData(fromBase64(clip).buffer)));
    } catch (error) {
      if (generation !== this.generation) return; // cancelled, e.g. by closing
      throw error;
    }
    if (context.state === 'suspended') await context.resume().catch(() => {});
    for (const buffer of buffers) {
      if (generation !== this.generation) return;
      await this.playBuffer(context, buffer);
    }
  }

  /** Stops playing now and drops whatever play() calls were still going. */
  cancel(): void {
    this.generation += 1;
    for (const settle of [...this.active.values()]) settle();
  }

  /** Earphones came or went: stop, and play the next clip through a new output on the new route. */
  reset(): void {
    this.cancel();
    void this.context?.close().catch(() => {});
    this.context = undefined;
  }

  close(): void {
    this.reset();
    this.closed = true;
  }

  /** Created on first use, so the conversation's audio settings are already in place. */
  private open(): AudioContext {
    if (this.closed) throw new Error('The conversation has ended.');
    this.context ??= new AudioContext();
    return this.context;
  }

  private playBuffer(context: AudioContext, buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (!this.active.delete(source)) return;
        clearTimeout(timer);
        source.onEnded = null;
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
        source.disconnect();
        resolve();
      };
      source.onEnded = settle;
      this.active.set(source, settle);
      // Audio paused by the phone (a call, an alarm) never reaches the end; do not wait
      // forever or every later translation would be stuck behind this one.
      timer = setTimeout(settle, buffer.duration * 1_000 + 2_000);
      source.start();
    });
  }
}
