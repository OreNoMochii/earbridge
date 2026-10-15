import { type NativeModule, requireOptionalNativeModule } from 'expo';

export type CaptureOptions = {
  /** Listen through the earphones' microphone when they have one; otherwise the phone's. */
  earphoneMic: boolean;
  /**
   * Record two of the phone's microphones, when it has them, to tell which way voices come
   * from (see AudioEvent). Not with earphones: they have one.
   */
  directions?: boolean;
  /** Test builds only: a raw 16 kHz 16-bit mono file (in the app's external files folder) to play instead of the microphone. */
  testInputPath?: string;
};

export type CaptureInput = {
  /** Where it is listening: the phone, the earphones, or a test recording. */
  input: 'phone' | 'earphones' | 'test';
  /** The earphones' name, or a description of the microphone. */
  name: string;
};

/**
 * 100 ms of sound from the microphone, as the mode it was heard in says (see setMicMode):
 * as heard, or silence. While keeping only some voices (keepVoices), the rest of what was
 * heard is taken out, and it comes 0.5 to 2 s late, in bursts.
 */
export type AudioEvent = {
  /** 16 kHz 16-bit mono PCM, base64. */
  pcm: string;
  /**
   * While recording two microphones: changes whenever the phone is turned or recording
   * changes, as the directions heard before then no longer apply.
   */
  pose?: number;
  /**
   * Which way the sound came from, when it stood out from the background: how many samples
   * after the first microphone the second heard it (negative when before), and how clearly
   * it came from one place, from 0 to 1.
   */
  delay?: number;
  clarity?: number;
};

/** How the last 2 s or so of sound were split into two voices (see keepVoices). */
export type SeparationEvent = {
  /** How much sound. */
  seconds: number;
  /** How long splitting it took, and printing the two voices. */
  splitMs: number;
  printMs: number;
  /** How alike each voice was to the closer of the prints, from -1 to 1; -1 when there was none. */
  scores: number[];
  /** Which voices were kept. */
  kept: boolean[];
  /** None was, and the sound passed on as heard instead (see keepVoices). */
  passed: boolean;
  /** How many seconds of sound wait to be split. */
  waiting: number;
};

/**
 * Keeping only some voices: "on" from now; "off" again; "slow" when the phone couldn't
 * keep up, so everything passes on until capture stops; "failed" when it couldn't start.
 */
export type IsolationEvent = { state: 'on' | 'off' | 'slow' | 'failed'; message?: string };

export type EarbridgeAudioEvents = {
  onAudio: (event: AudioEvent) => void;
  /** As the microphone hears, every 100 ms: its loudness, from 0 to 1. */
  onLevel: (event: { level: number }) => void;
  /** The mode went off and all that was heard before has come (onAudio). */
  onTurnEnd: () => void;
  onSeparation: (event: SeparationEvent) => void;
  onIsolation: (event: IsolationEvent) => void;
  /** The microphone stopped; capture has ended. */
  onCaptureError: (event: { message: string }) => void;
  onEarphonesChange: (event: { connected: boolean }) => void;
  /** From the notification's buttons or the earphones' play/pause button ("playing" means listening). */
  onRemoteCommand: (event: { command: 'mute' | 'unmute' | 'end' }) => void;
};

declare class EarbridgeAudioModule extends NativeModule<EarbridgeAudioEvents> {
  startCapture(options: CaptureOptions): Promise<CaptureInput>;
  /** Also forgets the voices to keep. */
  stopCapture(): Promise<void>;
  /** What happens to what is heard from now on: sent as heard, as silence, or not sent. Off at first. */
  setMicMode(mode: 'live' | 'silent' | 'off'): void;
  /**
   * Keeps only voices like these prints in what is sent, from now until keepAllVoices or
   * stopCapture. `model`: the file name of the speaker model that made them (EarbridgeVoice).
   * With `passUnmatched`, a stretch of sound with no voice like the prints is sent as heard
   * rather than as nothing.
   */
  keepVoices(options: { model: string; prints: number[][]; passUnmatched?: boolean }): void;
  keepAllVoices(): void;
  earphonesConnected(): boolean;
  /** Shows or updates the notification that keeps the conversation going in the background. False if Android refused. */
  showConversation(title: string, text: string, muted: boolean): boolean;
  hideConversation(): void;
  /** Test builds only: adds a line to the file `reports/<name>` in the app's external files folder. */
  appendReport(name: string, line: string): void;
}

/** Android only; null on iOS, which uses the audio library's recorder. */
export default requireOptionalNativeModule<EarbridgeAudioModule>('EarbridgeAudio');
