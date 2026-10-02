// The computer running Alo's server, as the user typed it: "192.168.1.20:8787",
// "http://my-mac.local:8787" or "https://alo.example.com". React Native's URL class
// cannot read the parts of an address, so this uses a pattern.

const ADDRESS = /^(https?|wss?):\/\/([^/?#\s]+)(\/[^?#\s]*)?(?:[?#]\S*)?$/i;

/**
 * The server's web address without a trailing slash, e.g. "http://192.168.1.20:8787";
 * undefined if the text is not an address. Without a scheme, http is assumed.
 */
export function normalizeServerUrl(input: string): string | undefined {
  let text = input.trim();
  if (!text) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  const match = ADDRESS.exec(text);
  if (!match) return undefined;
  const scheme = match[1]!.toLowerCase();
  const web = scheme === 'ws' ? 'http' : scheme === 'wss' ? 'https' : scheme;
  // A pasted WebSocket address ends in /ws, which is added back by socketUrl().
  const path = (match[3] ?? '').replace(/\/+$/, '').replace(/\/ws$/, '');
  return `${web}://${match[2]}${path}`;
}

/** The WebSocket the conversation runs over. */
export function socketUrl(server: string): string {
  return `${server.replace(/^http/, 'ws')}/ws`;
}

export function isSecure(server: string): boolean {
  return server.startsWith('https://');
}

/** "192.168.1.20:8787": the address without http://, for people to read or type. */
export function serverLabel(server: string): string {
  return server.replace(/^http:\/\//, '');
}
