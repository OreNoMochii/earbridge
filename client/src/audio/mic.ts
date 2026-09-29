// Microphone capture: whichever input the phone uses (its own mic, wired earphones, or a
// Bluetooth headset's mic) is resampled to 16 kHz PCM for the speech recognizer.

import { AUDIO_SAMPLE_RATE } from '../../../shared/protocol.ts';
import { StreamingResampler, rms } from './resampler.ts';

/**
 * live:   send what the microphone hears.
 * silent: send silence, e.g. while the phone speaker reads a translation aloud, so the
 *         recognizer does not transcribe the phone itself but still notices the pause
 *         and finishes the sentence it was hearing.
 * off:    send nothing (muted, or push-to-talk released).
 */
export type MicMode = 'live' | 'silent' | 'off';

export interface MicrophoneOptions {
  /** A deviceId from listMicrophones(), or '' for the system default. */
  deviceId: string;
  /**
   * Browser noise suppression helps a mic that only has to hear its wearer, but can
   * treat the other person's voice (further away) as noise.
   */
  noiseSuppression: boolean;
  onAudio(pcm: Int16Array<ArrayBuffer>): void;
  /** Input level 0..1, about 20 times a second, whatever the mode. */
  onLevel(level: number): void;
  /** The input went away (e.g. the headset disconnected or another app took it). */
  onEnded(): void;
}

export class MicrophoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrophoneError';
  }
}

export class Microphone {
  mode: MicMode = 'off';
  private readonly stream: MediaStream;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly node: AudioWorkletNode;
  private stopped = false;

  private constructor(stream: MediaStream, source: MediaStreamAudioSourceNode, node: AudioWorkletNode) {
    this.stream = stream;
    this.source = source;
    this.node = node;
  }

  /** Name of the input in use, e.g. "AirPods Pro" (empty on some browsers). */
  get label(): string {
    return this.stream.getAudioTracks()[0]?.label ?? '';
  }

  /** The context must already be running (created and resumed during a tap). */
  static async open(context: AudioContext, options: MicrophoneOptions): Promise<Microphone> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new MicrophoneError(
        'This page cannot use the microphone because it was not opened over HTTPS. ' +
          'Open the https:// address instead.',
      );
    }

    const stream = await getStream(options);
    try {
      await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm-worklet.js`);
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      const microphone = new Microphone(stream, source, node);
      microphone.start(context.sampleRate, options);
      return microphone;
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      throw error instanceof MicrophoneError
        ? error
        : new MicrophoneError(`Could not start audio capture: ${(error as Error).message}`);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.node.port.onmessage = null;
    this.source.disconnect();
    this.node.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
  }

  private start(sampleRate: number, options: MicrophoneOptions): void {
    const resampler = new StreamingResampler(sampleRate, AUDIO_SAMPLE_RATE);
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (this.stopped) return;
      const samples = event.data;
      // Always resample, even when nothing is sent, so the filter stays primed.
      const pcm = resampler.process(samples);
      options.onLevel(Math.min(1, rms(samples) * 4));
      if (this.mode === 'live') options.onAudio(pcm);
      else if (this.mode === 'silent') options.onAudio(new Int16Array(pcm.length));
    };
    this.source.connect(this.node);
    // Some browsers only pull audio through nodes that lead to the output; the worklet
    // outputs silence.
    this.node.connect(this.node.context.destination);
    for (const track of this.stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (!this.stopped) options.onEnded();
      });
    }
  }
}

async function getStream(options: MicrophoneOptions): Promise<MediaStream> {
  const constraints = (deviceId: string): MediaStreamConstraints => ({
    audio: {
      // Removes the phone's own speech output from the input.
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: options.noiseSuppression,
      channelCount: 1,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  });

  try {
    return await navigator.mediaDevices.getUserMedia(constraints(options.deviceId));
  } catch (error) {
    const name = (error as DOMException).name;
    // The chosen input was unplugged or renamed since last time: use the default one.
    if (options.deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints(''));
      } catch (retryError) {
        throw describe(retryError);
      }
    }
    throw describe(error);
  }
}

function describe(error: unknown): MicrophoneError {
  switch ((error as DOMException).name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new MicrophoneError(
        'Microphone access is blocked. Allow it for this site in your browser settings, then try again.',
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new MicrophoneError('No microphone was found. Connect your earphones or use the phone’s microphone.');
    case 'NotReadableError':
    case 'AbortError':
      return new MicrophoneError(
        'The microphone is being used by another app (a call, or a recording). Close it and try again.',
      );
    default:
      return new MicrophoneError(`Could not open the microphone: ${(error as Error).message ?? error}`);
  }
}

export interface MicrophoneInfo {
  deviceId: string;
  label: string;
}

/**
 * Inputs the user can choose from. Labels are only known after microphone permission
 * has been granted once, so the list may be empty or unnamed before the first start.
 */
export async function listMicrophones(): Promise<MicrophoneInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(
        (device) =>
          device.kind === 'audioinput' &&
          device.deviceId !== '' &&
          device.deviceId !== 'default' &&
          device.deviceId !== 'communications',
      )
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }));
  } catch {
    return [];
  }
}
