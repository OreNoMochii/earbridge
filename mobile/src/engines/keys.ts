// Own API keys: the phone uses Deepgram and DeepInfra directly with the user's keys,
// so no computer is needed. The keys go only to those two services.

import { voiceLanguages } from '../../../client/src/settings.ts';
import { DeepgramProvider } from '../../../shared/pipeline/stt/deepgram.ts';
import { DeepInfraTranslator } from '../../../shared/pipeline/translate/deepinfra.ts';
import { DeepInfraSpeech } from '../../../shared/pipeline/voice/deepinfra.ts';
import type { AppSettings } from '../app-settings.ts';
import { openDeepgramSocket } from './deepgram-socket.ts';
import type { Pipeline } from './in-app-backend.ts';
import { conversationVoices, releaseVoiceModel } from './voices.ts';

// The models the server uses by default.
const DEEPGRAM_MODEL = 'nova-3';
/** Covers languages nova-3 does not. */
const DEEPGRAM_FALLBACK_MODEL = 'nova-2';
const TRANSLATION_MODEL = 'google/gemma-4-31B-it';

const DEEPGRAM_KEY_HINT = 'Check your Deepgram key in Settings.';
const DEEPINFRA_KEY_HINT = 'Check your DeepInfra key in Settings.';

/** The pipeline, with the voice model ready when only our two voices are translated. */
export async function prepareKeys(
  settings: AppSettings,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<Pipeline> {
  const voices = settings.onlyOurVoices ? await conversationVoices(signal, progress) : undefined;
  return voices ? { ...keysPipeline(settings), voices, dispose: releaseVoiceModel } : keysPipeline(settings);
}

function keysPipeline(settings: AppSettings): Pipeline {
  const deepinfraKey = settings.deepinfraKey.trim();
  const synthesizer =
    settings.voice === 'natural' ? new DeepInfraSpeech({ apiKey: deepinfraKey, keyHint: DEEPINFRA_KEY_HINT }) : undefined;
  const requested = voiceLanguages(settings);
  return {
    stt: new DeepgramProvider({
      apiKey: settings.deepgramKey.trim(),
      model: DEEPGRAM_MODEL,
      fallbackModel: DEEPGRAM_FALLBACK_MODEL,
      openSocket: openDeepgramSocket,
      keyHint: DEEPGRAM_KEY_HINT,
    }),
    translator: new DeepInfraTranslator({ apiKey: deepinfraKey, model: TRANSLATION_MODEL, keyHint: DEEPINFRA_KEY_HINT }),
    // Deepgram charges by the second of sound sent.
    metered: true,
    synthesizer,
    // As the server decides: the languages asked for that have a natural voice.
    voiceLangs: synthesizer
      ? [settings.myLang, settings.theirLang].filter((lang) => requested.includes(lang) && synthesizer.supports(lang))
      : [],
  };
}
