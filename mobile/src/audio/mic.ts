// The microphone: 16 kHz mono 16-bit sound for the speech recognizer, in 100 ms chunks.
// Android records with the app's own module, which can use Bluetooth earphones'
// microphones and keeps listening while the phone is locked; iPhone uses the audio
// library's recorder.

import { PermissionsAndroid, Platform } from 'react-native';
import { AudioManager, AudioRecorder } from 'react-native-audio-api';
import type { AudioBuffer } from 'react-native-audio-api';

import { StreamingResampler, rms } from '../../../client/src/audio/resampler.ts';
import { AUDIO_SAMPLE_RATE } from '../../../shared/protocol.ts';
import EarbridgeAudio from '../../modules/earbridge-audio/src/EarbridgeAudioModule.ts';
import type { CaptureInput } from '../../modules/earbridge-audio/src/EarbridgeAudioModule.ts';
import { fromBase64 } from '../base64.ts';
import { startIosSession, stopIosSession } from './ios-session.ts';

/**
 * live:   the sound goes to the recognizer.
 * silent: silence goes instead, e.g. while the phone speaker reads a translation aloud,
 *         so the recognizer neither hears the phone nor gives up waiting.
 * off:    nothing is sent (muted, or hold-to-talk with no button held).
 */
export type MicMode = 'live' | 'silent' | 'off';

export interface MicrophoneOptions {
  /** Listen through the earphones' microphone when they have one. */
  earphoneMic: boolean;
  /** 16 kHz mono PCM16. */
  onAudio(pcm: ArrayBuffer): void;
  /** Input level 0..1, ten times a second, whatever the mode. */
  onLevel(level: number): void;
  /** The microphone stopped by itself, e.g. a call took it. The message says why, in a sentence. */
  onEnded(message: string): void;
}

/**
 * Android test builds play this raw recording (in the app's files folder) wherever the
 * microphone would be used.
 */
const TEST_AUDIO = process.env.EXPO_PUBLIC_TEST_AUDIO || undefined;

/** A problem worth showing as is. */
export class MicrophoneError extends Error {
  /** The phone does not let the app use the microphone: the way out is the phone's settings. */
  readonly notAllowed: boolean;

  constructor(message: string, notAllowed = false) {
    super(message);
    this.notAllowed = notAllowed;
  }
}

export interface Microphone {
  mode: MicMode;
  /** Which microphone listens. */
  readonly input: CaptureInput;
  stop(): void;
}

const NOT_ALLOWED_ANDROID = 'Alo isn’t allowed to use the microphone. Allow it in Settings › Apps › Alo › Permissions.';
const NOT_ALLOWED_IOS = 'Alo isn’t allowed to use the microphone. Allow it in Settings › Alo.';

export async function openMicrophone(options: MicrophoneOptions): Promise<Microphone> {
  if (EarbridgeAudio) {
    const status = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (status !== PermissionsAndroid.RESULTS.GRANTED) throw new MicrophoneError(NOT_ALLOWED_ANDROID, true);
    const mic = new AndroidMicrophone(EarbridgeAudio, options);
    await mic.start();
    return mic;
  }
  if (Platform.OS === 'ios') {
    if ((await AudioManager.requestRecordingPermissions()) !== 'Granted') throw new MicrophoneError(NOT_ALLOWED_IOS, true);
    const mic = new IosMicrophone(options);
    await mic.start();
    return mic;
  }
  throw new MicrophoneError('This device is not supported.');
}

class AndroidMicrophone implements Microphone {
  mode: MicMode = 'off';
  input: CaptureInput = { input: 'phone', name: 'Microphone' };
  private readonly module: NonNullable<typeof EarbridgeAudio>;
  private readonly options: MicrophoneOptions;
  private readonly subscriptions: { remove(): void }[];
  private stopped = false;

  constructor(module: NonNullable<typeof EarbridgeAudio>, options: MicrophoneOptions) {
    this.module = module;
    this.options = options;
    this.subscriptions = [
      module.addListener('onAudio', (event) => this.onAudio(event.pcm, event.level)),
      module.addListener('onCaptureError', (event) => {
        if (this.stopped) return;
        this.release();
        options.onEnded(event.message);
      }),
    ];
  }

  async start(): Promise<void> {
    try {
      this.input = await this.module.startCapture({
        earphoneMic: this.options.earphoneMic,
        testInputPath: TEST_AUDIO,
      });
    } catch (error) {
      this.release();
      throw new MicrophoneError(error instanceof Error ? error.message : String(error));
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.release();
    this.module.stopCapture().catch(() => {});
  }

  private onAudio(base64: string, level: number): void {
    if (this.stopped) return;
    this.options.onLevel(level);
    if (this.mode === 'off') return;
    const pcm = fromBase64(base64).buffer;
    this.options.onAudio(this.mode === 'live' ? pcm : new ArrayBuffer(pcm.byteLength));
  }

  private release(): void {
    this.stopped = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.remove();
  }
}

class IosMicrophone implements Microphone {
  mode: MicMode = 'off';
  input: CaptureInput = { input: 'phone', name: 'Microphone' };
  private readonly options: MicrophoneOptions;
  private readonly recorder = new AudioRecorder();
  private resampler: StreamingResampler | undefined;
  private resamplerRate = 0;
  private interruption: { remove(): void } | undefined;
  private stopped = false;

  constructor(options: MicrophoneOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    try {
      this.input = await startIosSession(this.options.earphoneMic);
    } catch (error) {
      throw new MicrophoneError(`Could not start the microphone: ${errorText(error)}`);
    }
    // A call (or Siri) takes the microphone away; the conversation has to be restarted.
    this.interruption = AudioManager.addSystemEventListener('interruption', (event) => {
      if (event.type === 'began') this.fail('A call or another app interrupted the microphone.');
    });
    this.recorder.onError((event) => this.fail(`The microphone stopped working: ${event.message}`));
    const callback = this.recorder.onAudioReady(
      { sampleRate: AUDIO_SAMPLE_RATE, bufferLength: AUDIO_SAMPLE_RATE / 10, channelCount: 1 },
      (event) => this.onBuffer(event.buffer),
    );
    const result = callback.status === 'error' ? callback : await this.recorder.start();
    if (result.status === 'error') {
      this.release();
      throw new MicrophoneError(`Could not start the microphone: ${result.message}`);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.release();
  }

  private onBuffer(buffer: AudioBuffer): void {
    if (this.stopped) return;
    const samples = buffer.getChannelData(0);
    this.options.onLevel(Math.min(1, rms(samples) * 4));
    // The recorder may deliver another rate than asked for.
    if (!this.resampler || this.resamplerRate !== buffer.sampleRate) {
      this.resampler = new StreamingResampler(buffer.sampleRate, AUDIO_SAMPLE_RATE);
      this.resamplerRate = buffer.sampleRate;
    }
    const pcm = this.resampler.process(samples);
    if (this.mode === 'live') this.options.onAudio(pcm.buffer);
    else if (this.mode === 'silent') this.options.onAudio(new ArrayBuffer(pcm.byteLength));
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.release();
    this.options.onEnded(message);
  }

  private release(): void {
    this.stopped = true;
    this.interruption?.remove();
    this.recorder.clearOnAudioReady();
    this.recorder.clearOnError();
    void this.recorder
      .stop()
      .catch(() => {})
      .then(() => stopIosSession());
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
