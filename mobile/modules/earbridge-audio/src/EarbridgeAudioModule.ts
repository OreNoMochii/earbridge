import { type NativeModule, requireOptionalNativeModule } from 'expo';

export type CaptureOptions = {
  /** Listen through the earphones' microphone when they have one; otherwise the phone's. */
  earphoneMic: boolean;
  /** Test builds only: a raw 16 kHz 16-bit mono file (in the app's external files folder) to play instead of the microphone. */
  testInputPath?: string;
};

export type CaptureInput = {
  /** Where it is listening: the phone, the earphones, or a test recording. */
  input: 'phone' | 'earphones' | 'test';
  /** The earphones' name, or a description of the microphone. */
  name: string;
};

export type EarbridgeAudioEvents = {
  /** 100 ms of 16 kHz 16-bit mono PCM (base64) and its loudness from 0 to 1. */
  onAudio: (event: { pcm: string; level: number }) => void;
  /** The microphone stopped; capture has ended. */
  onCaptureError: (event: { message: string }) => void;
  onEarphonesChange: (event: { connected: boolean }) => void;
  /** From the notification's buttons or the earphones' play/pause button ("playing" means listening). */
  onRemoteCommand: (event: { command: 'mute' | 'unmute' | 'end' }) => void;
};

declare class EarbridgeAudioModule extends NativeModule<EarbridgeAudioEvents> {
  startCapture(options: CaptureOptions): Promise<CaptureInput>;
  stopCapture(): Promise<void>;
  earphonesConnected(): boolean;
  /** Shows or updates the notification that keeps the conversation going in the background. False if Android refused. */
  showConversation(title: string, text: string, muted: boolean): boolean;
  hideConversation(): void;
}

/** Android only; null on iOS, which uses the audio library's recorder. */
export default requireOptionalNativeModule<EarbridgeAudioModule>('EarbridgeAudio');
