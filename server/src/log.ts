// Deliberately never logs what people say: transcripts and translations stay out of logs.

export interface Logger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

function detail(error: unknown): string {
  if (error === undefined) return '';
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : '';
    return `: ${error.message}${cause}`;
  }
  return `: ${String(error)}`;
}

function timestamp(): string {
  return new Date().toISOString();
}

export const consoleLogger: Logger = {
  info: (message) => console.log(`${timestamp()} ${message}`),
  warn: (message, error) => console.warn(`${timestamp()} WARN ${message}${detail(error)}`),
  error: (message, error) => console.error(`${timestamp()} ERROR ${message}${detail(error)}`),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
