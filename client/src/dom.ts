// A tiny helper for building DOM trees. Text always goes in as text nodes (never parsed
// as HTML), and there is deliberately no way to set a style attribute: the server's
// Content-Security-Policy blocks inline styles, so set element.style properties instead.

type Child = Node | string | false | null | undefined;
type Handler = (event: never) => void;
type AttributeValue = string | number | boolean | Handler | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, AttributeValue> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'style') throw new Error('Set element.style properties instead of a style attribute.');
    if (typeof value === 'function') {
      element.addEventListener(name.replace(/^on/, ''), value as EventListener);
    } else if (name === 'class') {
      element.className = String(value);
    } else {
      element.setAttribute(name, value === true ? '' : String(value));
    }
  }
  for (const child of children) {
    if (child !== false && child !== null && child !== undefined) element.append(child);
  }
  return element;
}
