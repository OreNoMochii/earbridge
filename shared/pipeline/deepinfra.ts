// Shared by the DeepInfra translator and the DeepInfra voices.

export const DEEPINFRA_URL = 'https://api.deepinfra.com';

/**
 * A short description of what went wrong, taken from a DeepInfra error body, for the
 * server log. Only plain messages are kept: validation errors repeat the request, and
 * the request holds what people said.
 */
export function errorDetail(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  // DeepInfra answers {"error":{"message":"..."}}, {"detail":"..."} or {"detail":{"error":"..."}};
  // validation errors come as {"detail":[...]}.
  const { detail, error } = body as { detail?: unknown; error?: unknown };
  const message = plainMessage(detail) ?? plainMessage(error);
  return message?.slice(0, 200);
}

function plainMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { message, error } = value as { message?: unknown; error?: unknown };
  if (typeof message === 'string' && message) return message;
  if (typeof error === 'string' && error) return error;
  return undefined;
}

/** `message`, followed by where to fix the problem when there is a hint. */
export function withHint(message: string, hint: string | undefined): string {
  return hint ? `${message} ${hint}` : message;
}

/** The detail of an error response, wrapped to become the `cause` of a user-facing error. */
export async function errorCause(response: Response): Promise<Error | undefined> {
  try {
    const detail = errorDetail(await response.json());
    return detail === undefined ? undefined : new Error(detail);
  } catch {
    return undefined;
  }
}
