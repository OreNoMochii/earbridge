import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import type Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.ts';
import { TranslationError, TranslationRefusedError } from './types.ts';
import type { TranslationRequest, Translator } from './types.ts';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ClaudeTranslatorOptions {
  client: Anthropic;
  model: string;
  /** Lower effort = less thinking = faster translations. */
  effort: Effort;
}

export class ClaudeTranslator implements Translator {
  private readonly options: ClaudeTranslatorOptions;

  constructor(options: ClaudeTranslatorOptions) {
    this.options = options;
  }

  async translate(request: TranslationRequest): Promise<string> {
    try {
      return await this.stream(request);
    } catch (error) {
      if (error instanceof TranslationError || error instanceof APIUserAbortError) throw error;
      throw this.describe(error);
    }
  }

  private async stream(request: TranslationRequest): Promise<string> {
    const stream = this.options.client.beta.messages.stream(
      {
        model: this.options.model,
        max_tokens: 16000,
        output_config: { effort: this.options.effort },
        // If a safety classifier declines, the API re-runs the request on
        // Anthropic's recommended fallback model instead of returning a refusal.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(request) }],
      },
      { signal: request.signal },
    );

    // Accumulate deltas ourselves: after a mid-stream fallback the text continues in a
    // new content block, and the per-block snapshot would restart from empty.
    let streamed = '';
    stream.on('text', (delta) => {
      streamed += delta;
      request.onPartial?.(streamed);
    });

    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new TranslationRefusedError();

    return message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
      .trim();
  }

  private describe(error: unknown): TranslationError {
    let message = 'Translation failed.';
    if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
      message = 'Claude rejected the API key. Check ANTHROPIC_API_KEY on the server.';
    } else if (error instanceof NotFoundError) {
      message = `Translation model "${this.options.model}" is not available. Check TRANSLATION_MODEL on the server.`;
    } else if (error instanceof RateLimitError) {
      message = 'Translation rate limit reached. Try again in a moment.';
    } else if (error instanceof APIConnectionError) {
      message = 'Could not reach the translation service.';
    } else if (error instanceof APIError && error.status !== undefined) {
      message = `Translation failed (HTTP ${error.status}).`;
    } else if (error instanceof Error && /credential|authentication/i.test(error.message)) {
      // No API key and no `ant auth login` profile: the SDK fails before sending.
      message = 'No Claude credentials on the server. Set ANTHROPIC_API_KEY.';
    }
    return new TranslationError(message, { cause: error });
  }
}
