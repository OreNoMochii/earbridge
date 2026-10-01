import { DEEPINFRA_URL, errorCause, errorDetail } from '../deepinfra.ts';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.ts';
import { TranslationError, TranslationRefusedError } from './types.ts';
import type { TranslationRequest, Translator } from './types.ts';

export interface DeepInfraTranslatorOptions {
  apiKey: string;
  /** A chat model hosted on DeepInfra. */
  model: string;
  baseUrl?: string;
  /** A translation that takes longer than this is no use in a live conversation. */
  timeoutMs?: number;
}

interface ChatChunk {
  choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
  error?: unknown;
}

/** Translates with a chat model on DeepInfra, through its OpenAI-compatible API. */
export class DeepInfraTranslator implements Translator {
  private readonly options: DeepInfraTranslatorOptions;

  constructor(options: DeepInfraTranslatorOptions) {
    this.options = options;
  }

  async translate(request: TranslationRequest): Promise<string> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    try {
      return await this.stream(request, signal);
    } catch (error) {
      if (request.signal?.aborted || error instanceof TranslationError) throw error;
      if (timeout.aborted) throw new TranslationError('Translation took too long.', { cause: error });
      throw new TranslationError('Could not reach the translation service.', { cause: error });
    }
  }

  private async stream(request: TranslationRequest, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${this.options.baseUrl ?? DEEPINFRA_URL}/v1/openai/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model,
        stream: true,
        max_tokens: 2000,
        temperature: 0.2,
        // Answer straight away: a model that can reason would otherwise think before every line.
        reasoning_effort: 'none',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(request) },
        ],
      }),
      signal,
    });
    if (!response.ok) throw await this.httpError(response);
    if (!response.body) throw new TranslationError('Translation failed.');

    let text = '';
    for await (const data of eventData(response.body)) {
      if (data === '[DONE]') break;
      const chunk = parseChunk(data);
      if (chunk.error !== undefined) {
        const detail = errorDetail(chunk);
        throw new TranslationError('Translation failed.', detail ? { cause: new Error(detail) } : undefined);
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta) {
        text += delta;
        request.onPartial?.(text);
      }
      if (choice?.finish_reason === 'content_filter') throw new TranslationRefusedError();
    }

    const translation = text.trim();
    if (!translation) throw new TranslationError('The translation service returned an empty translation.');
    return translation;
  }

  private async httpError(response: Response): Promise<TranslationError> {
    const { status } = response;
    let message = `Translation failed (HTTP ${status}).`;
    if (status === 401 || status === 403) {
      message = 'DeepInfra rejected the API key. Check DEEPINFRA_API_KEY on the server.';
    } else if (status === 402) {
      message = 'DeepInfra wants payment (HTTP 402). Check the balance of the DeepInfra account.';
    } else if (status === 404) {
      message = `Translation model "${this.options.model}" is not available on DeepInfra. Check TRANSLATION_MODEL on the server.`;
    } else if (status === 429) {
      message = 'Translation rate limit reached, or the model is busy. Try again in a moment.';
    }
    const cause = await errorCause(response);
    return new TranslationError(message, cause ? { cause } : undefined);
  }
}

/** The data line of each server-sent event in a streamed response body. */
async function* eventData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) yield buffer.slice(5).trim();
}

function parseChunk(data: string): ChatChunk {
  try {
    const chunk: unknown = JSON.parse(data);
    if (chunk && typeof chunk === 'object') return chunk as ChatChunk;
  } catch {
    // Reported below.
  }
  throw new TranslationError('Translation failed: the translation service sent an unreadable reply.');
}
