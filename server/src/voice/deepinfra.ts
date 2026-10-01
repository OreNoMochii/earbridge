import { splitForSpeech } from '../../../shared/speech-text.ts';
import { DEEPINFRA_URL, errorCause } from '../deepinfra.ts';
import { SpeechError } from './types.ts';
import type { SpeechRequest, SpeechSynthesizer } from './types.ts';

interface Voice {
  model: string;
  /** Request body for DeepInfra's inference API, apart from the text. */
  body: Record<string, unknown>;
  /** The most text sent in one request. Longer text is split at sentence boundaries. */
  maxChars: number;
}

function kokoro(voice: string): Voice {
  return {
    model: 'hexgrad/Kokoro-82M',
    // The priority tier keeps Kokoro at 0.4 to 0.9 s; the default tier has slow spells.
    body: { preset_voice: [voice], output_format: 'mp3', service_tier: 'priority' },
    maxChars: 500,
  };
}

function chatterbox(languageId: string): Voice {
  return {
    model: 'ResembleAI/chatterbox-multilingual',
    body: { language_id: languageId, response_format: 'mp3' },
    // Chatterbox takes longer the longer the text, so long text goes as parallel pieces.
    maxChars: 200,
  };
}

/** Kokoro where it has a voice for the language, Chatterbox for the rest. */
const VOICES: ReadonlyMap<string, Voice> = new Map([
  ['en-US', kokoro('af_heart')],
  ['en-GB', kokoro('bf_emma')],
  ['es', kokoro('ef_dora')],
  ['fr', kokoro('ff_siwis')],
  ['hi', kokoro('hf_alpha')],
  ['it', kokoro('if_sara')],
  ['ja', kokoro('jf_alpha')],
  ['pt-BR', kokoro('pf_dora')],
  ['zh-CN', kokoro('zf_xiaobei')],
  ['zh-TW', kokoro('zf_xiaobei')],
  ['ar', chatterbox('ar')],
  ['da', chatterbox('da')],
  ['de', chatterbox('de')],
  ['el', chatterbox('el')],
  ['fi', chatterbox('fi')],
  ['ko', chatterbox('ko')],
  ['ms', chatterbox('ms')],
  ['nl', chatterbox('nl')],
  ['no', chatterbox('no')],
  ['pl', chatterbox('pl')],
  ['pt-PT', chatterbox('pt')],
  ['ru', chatterbox('ru')],
  ['sv', chatterbox('sv')],
  ['tr', chatterbox('tr')],
]);

/** The languages DeepInfra voices; the phone's own voice reads the others. */
export const DEEPINFRA_VOICE_LANGUAGES: readonly string[] = [...VOICES.keys()];

/** Longer text is left to the phone's own voice. Utterances are capped at about 40 words. */
const MAX_TEXT_LENGTH = 1_000;

const ASCII_PUNCTUATION: Record<string, string> = {
  '，': ',', '、': ',', '；': ';', '：': ':', '。': '.', '！': '!', '？': '?',
};

/** Kokoro cuts Mandarin audio short at full-width punctuation, so use ASCII punctuation. */
function withAsciiPunctuation(text: string): string {
  return text
    .replace(/[，、；：。！？]/g, (mark) => `${ASCII_PUNCTUATION[mark]} `)
    .replace(/ {2,}/g, ' ')
    .trim();
}

export interface DeepInfraSpeechOptions {
  apiKey: string;
  baseUrl?: string;
  /** Past this, the phone's own voice reads the translation instead. */
  timeoutMs?: number;
}

/** Natural voices from text-to-speech models hosted on DeepInfra. */
export class DeepInfraSpeech implements SpeechSynthesizer {
  private readonly options: DeepInfraSpeechOptions;

  constructor(options: DeepInfraSpeechOptions) {
    this.options = options;
  }

  supports(lang: string): boolean {
    return VOICES.has(lang);
  }

  async synthesize(request: SpeechRequest): Promise<Buffer[]> {
    const voice = VOICES.get(request.lang);
    if (!voice) throw new SpeechError(`There is no natural voice for ${request.lang}.`);
    const text = request.lang.startsWith('zh-') ? withAsciiPunctuation(request.text) : request.text;
    if (text.length > MAX_TEXT_LENGTH) throw new SpeechError('This translation is too long for the natural voice.');
    const pieces = splitForSpeech(text, voice.maxChars);
    if (pieces.length === 0) return [];

    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 6_000);
    // When one piece fails, stop the others: the phone's voice will read all of it.
    const failed = new AbortController();
    const signal = AbortSignal.any([timeout, failed.signal, ...(request.signal ? [request.signal] : [])]);
    try {
      return await Promise.all(
        pieces.map(async (piece) => {
          try {
            return await this.request(voice, piece, signal);
          } catch (error) {
            failed.abort();
            throw error;
          }
        }),
      );
    } catch (error) {
      if (request.signal?.aborted || error instanceof SpeechError) throw error;
      if (timeout.aborted) throw new SpeechError('The voice took too long.', { cause: error });
      throw new SpeechError('Could not reach the voice service.', { cause: error });
    }
  }

  private async request(voice: Voice, text: string, signal: AbortSignal): Promise<Buffer> {
    const response = await fetch(`${this.options.baseUrl ?? DEEPINFRA_URL}/v1/inference/${voice.model}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...voice.body }),
      signal,
    });
    if (!response.ok) throw await this.httpError(response);

    let body: { audio?: unknown };
    try {
      body = (await response.json()) as { audio?: unknown };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SpeechError('The voice service sent an unreadable reply.', { cause: error });
    }
    // The audio comes as a data URL: data:audio/mp3;base64,...
    const audio = typeof body.audio === 'string' ? Buffer.from(body.audio.replace(/^data:[^,]*,/, ''), 'base64') : undefined;
    if (!audio?.length) throw new SpeechError('The voice returned no audio.');
    return audio;
  }

  private async httpError(response: Response): Promise<SpeechError> {
    const { status } = response;
    let message = `The voice failed (HTTP ${status}).`;
    if (status === 401 || status === 403) {
      message = 'DeepInfra rejected the API key. Check DEEPINFRA_API_KEY on the server.';
    } else if (status === 402) {
      message = 'DeepInfra wants payment (HTTP 402). Check the balance of the DeepInfra account.';
    } else if (status === 429) {
      message = 'The voice service is busy.';
    }
    const cause = await errorCause(response);
    return new SpeechError(message, cause ? { cause } : undefined);
  }
}
