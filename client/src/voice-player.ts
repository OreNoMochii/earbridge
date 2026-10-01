// Plays the server's natural voices: audio clips (MP3) that arrive as base64 over the
// WebSocket. Played with Web Audio, in the AudioContext started by the Start tap, because
// phones only let a page play sound that a tap started.

export class VoicePlayer {
  private readonly context: AudioContext;
  // Clips still playing, with a function that settles them.
  private readonly active = new Map<AudioBufferSourceNode, () => void>();
  private generation = 0;

  constructor(context: AudioContext) {
    this.context = context;
  }

  /**
   * Plays the clips one after the other. Resolves when they have finished or were
   * cancelled; rejects if this device cannot decode them.
   */
  async play(clips: readonly string[]): Promise<void> {
    const generation = this.generation;
    let buffers: AudioBuffer[];
    try {
      buffers = await Promise.all(clips.map((clip) => this.context.decodeAudioData(fromBase64(clip))));
    } catch (error) {
      if (generation !== this.generation) return; // cancelled, e.g. by closing the context
      throw error;
    }
    for (const buffer of buffers) {
      if (generation !== this.generation) return;
      await this.playBuffer(buffer);
    }
  }

  /** Stops playing now and drops whatever play() calls were still going. */
  cancel(): void {
    this.generation += 1;
    for (const settle of [...this.active.values()]) settle();
  }

  private playBuffer(buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);

      let timer: number | undefined;
      const settle = () => {
        if (!this.active.delete(source)) return;
        window.clearTimeout(timer);
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
        source.disconnect();
        resolve();
      };
      source.onended = settle;
      this.active.set(source, settle);
      // A suspended context (a call, an alarm) never reaches the end; do not wait forever
      // or every later translation would be stuck behind this one.
      timer = window.setTimeout(settle, buffer.duration * 1_000 + 2_000);
      source.start();
    });
  }
}

function fromBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
