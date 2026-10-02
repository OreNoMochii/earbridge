// "Only our voices": voice prints made on the phone by a small speaker model, downloaded
// once. The phone owner's print comes from a recording made in the settings and is kept
// in the phone's secure storage. Neither the recording nor the print leaves the phone.

import * as SecureStore from 'expo-secure-store';

import type { VoicePrinter } from '../../../shared/pipeline/voices.ts';
import EarbridgeVoice from '../../modules/earbridge-audio/src/EarbridgeVoiceModule.ts';
import { fromBase64, toBase64 } from '../base64.ts';

/** The speaker model. Voice prints can only be compared with prints from the same model. */
const MODEL = {
  // CAM++ from 3D-Speaker, trained on Chinese and English speech (Apache-2.0).
  file: '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
  sha256: 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2',
};
/** About how much the voice model downloads, in MB. */
export const VOICE_MODEL_MB = 28;

const MY_VOICE = 'earbridge.myVoice';
/** Like the API keys: kept out of backups and off other phones. */
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** Whether this phone can tell voices apart: Android, with the app's own module. */
export function canCheckVoices(): boolean {
  return EarbridgeVoice !== null;
}

/** Whether the speaker model is on the phone already. */
export function hasVoiceModel(): boolean {
  return EarbridgeVoice?.hasModel(MODEL.file) ?? false;
}

/**
 * Gets the speaker model onto the phone unless it is there already, reporting how much
 * is done (0 to 1). Rejects with an error whose message can be shown.
 */
export async function prepareVoiceModel(signal: AbortSignal, progress: (done: number) => void): Promise<void> {
  const module = voiceModule();
  if (!module.hasModel(MODEL.file)) {
    const subscription = module.addListener('onModelProgress', ({ received, total }) => {
      if (total > 0) progress(Math.min(1, received / total));
    });
    const cancel = () => module.cancelDownload();
    signal.addEventListener('abort', cancel);
    try {
      if (signal.aborted) throw abortError(signal);
      await module.downloadModel(MODEL.url, MODEL.sha256, MODEL.file);
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      throw new Error(`Couldn’t download the voice model: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      signal.removeEventListener('abort', cancel);
      subscription.remove();
    }
  }
  await module.loadModel(MODEL.file);
  if (signal.aborted) throw abortError(signal);
}

/** A voice print of some 16 kHz mono speech, once the model is ready. */
export async function printVoice(samples: Int16Array): Promise<Float32Array | undefined> {
  // A copy: the module reads whole arrays, not views into larger ones.
  const pcm = new Uint8Array(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
  const print = await voiceModule().voicePrint(pcm);
  return print.length > 0 ? Float32Array.from(print) : undefined;
}

/** Frees the speaker model's memory, e.g. once the conversation is over. */
export function releaseVoiceModel(): void {
  EarbridgeVoice?.unloadModel();
}

/**
 * Prints voices for a conversation: makes sure the model is ready, downloading it if it
 * went missing. Undefined when my voice is not recorded.
 */
export async function conversationVoices(
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<VoicePrinter | undefined> {
  const mine = loadMyVoice();
  if (!mine || !canCheckVoices()) return undefined;
  await prepareVoiceModel(signal, (done) => progress(`Downloading the voice model… ${Math.round(done * 100)}%`));
  return { mine, print: printVoice };
}

// ---------------------------------------------------------------- my voice

/** My voice print, if it was recorded with the current model. */
export function loadMyVoice(): Float32Array | undefined {
  try {
    const saved: unknown = JSON.parse(SecureStore.getItem(MY_VOICE) ?? 'null');
    if (typeof saved !== 'object' || saved === null) return undefined;
    const { model, print } = saved as Record<string, unknown>;
    if (model !== MODEL.file || typeof print !== 'string') return undefined;
    const bytes = fromBase64(print);
    return bytes.length > 0 && bytes.length % 4 === 0 ? new Float32Array(bytes.buffer) : undefined;
  } catch {
    // Unreadable, e.g. Android reset its keystore: my voice has to be recorded again.
    return undefined;
  }
}

/** Rejects if the phone could not store it. */
export async function saveMyVoice(print: Float32Array): Promise<void> {
  const bytes = new Uint8Array(print.buffer, print.byteOffset, print.byteLength);
  await SecureStore.setItemAsync(MY_VOICE, JSON.stringify({ model: MODEL.file, print: toBase64(bytes) }), SECURE_OPTIONS);
}

export async function deleteMyVoice(): Promise<void> {
  await SecureStore.deleteItemAsync(MY_VOICE);
}

function voiceModule(): NonNullable<typeof EarbridgeVoice> {
  if (!EarbridgeVoice) throw new Error('Telling voices apart isn’t available on this phone.');
  return EarbridgeVoice;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Aborted');
}
