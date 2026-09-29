// The running conversation: what each person said, in their language and translated.

import { languageName } from '../../shared/languages.ts';
import { h } from './dom.ts';

export interface FeedUtterance {
  id: string;
  speaker: string;
  lang: string;
  text: string;
  /** Said by the person holding this phone. */
  mine: boolean;
  /** Language of the translation this phone will receive, if any. */
  translationLang: string | undefined;
}

interface Entry {
  element: HTMLLIElement;
  translation: HTMLElement | undefined;
  translationLang: string | undefined;
  done: boolean;
}

const MAX_ENTRIES = 200;
/** Keep following new lines only when the user has not scrolled up to read. */
const FOLLOW_WITHIN_PX = 80;

export class Feed {
  readonly element: HTMLElement;
  private readonly list: HTMLOListElement;
  private readonly interimBox: HTMLElement;
  private readonly placeholder: HTMLElement;
  private readonly entries = new Map<string, Entry>();
  private readonly interims = new Map<string, HTMLElement>();

  constructor(placeholder: string) {
    this.placeholder = h('p', { class: 'feed-empty' }, placeholder);
    this.list = h('ol', { class: 'feed-list', role: 'log', 'aria-label': 'Conversation' });
    // Live, unfinished transcripts: too jumpy to announce to screen readers.
    this.interimBox = h('div', { class: 'feed-interims', 'aria-hidden': 'true' });
    this.element = h('section', { class: 'feed' }, this.placeholder, this.list, this.interimBox);
  }

  addUtterance(utterance: FeedUtterance): void {
    this.change(() => {
      const translation = utterance.translationLang
        ? h('p', { class: 'entry-translation pending', dir: 'auto' }, 'Translating…')
        : undefined;
      const element = h(
        'li',
        { class: `entry ${utterance.mine ? 'mine' : 'theirs'}${translation ? ' translated' : ''}` },
        h('p', { class: 'entry-meta' }, `${utterance.speaker} · ${shortName(utterance.lang)}`),
        h('p', { class: 'entry-original', lang: utterance.lang, dir: 'auto' }, utterance.text),
        translation,
      );
      this.list.append(element);
      this.entries.set(utterance.id, {
        element,
        translation,
        translationLang: utterance.translationLang,
        done: !translation,
      });
      for (const [id, entry] of this.entries) {
        if (this.entries.size <= MAX_ENTRIES) break;
        entry.element.remove();
        this.entries.delete(id);
      }
      this.placeholder.hidden = true;
    });
  }

  /** `text` is the whole translation so far. */
  updateTranslation(id: string, text: string, done: boolean, error?: string): void {
    const entry = this.entries.get(id);
    const element = entry?.translation;
    if (!entry || !element || entry.done) return;
    this.change(() => {
      entry.done = done;
      if (error) {
        element.className = 'entry-translation failed';
        element.removeAttribute('lang');
        element.textContent = `Translation failed: ${error}`;
      } else if (text) {
        element.className = done ? 'entry-translation' : 'entry-translation streaming';
        element.lang = entry.translationLang ?? '';
        element.textContent = text;
      } else if (done) {
        element.className = 'entry-translation empty';
        element.textContent = '(nothing to translate)';
      }
    });
  }

  /** The connection dropped: translations still on their way will not arrive. */
  interruptPending(): void {
    for (const entry of this.entries.values()) {
      const element = entry.translation;
      if (entry.done || !element) continue;
      entry.done = true;
      if (element.classList.contains('pending')) {
        element.className = 'entry-translation failed';
        element.textContent = 'Translation interrupted: the connection was lost.';
      } else {
        element.className = 'entry-translation interrupted';
      }
    }
  }

  /** Shows what someone is saying right now; empty text removes it. */
  setInterim(key: string, speaker: string, lang: string, text: string, mine: boolean): void {
    this.change(() => {
      let element = this.interims.get(key);
      if (!text) {
        element?.remove();
        this.interims.delete(key);
        return;
      }
      if (!element) {
        element = h('p', { class: 'interim' }, h('span', { class: 'interim-speaker' }), h('span', { dir: 'auto' }));
        this.interims.set(key, element);
        this.interimBox.append(element);
      }
      element.classList.toggle('mine', mine);
      element.firstElementChild!.textContent = `${speaker}: `;
      const textElement = element.lastElementChild as HTMLElement;
      textElement.lang = lang;
      textElement.textContent = text;
      this.placeholder.hidden = true;
    });
  }

  clearInterim(key: string): void {
    this.interims.get(key)?.remove();
    this.interims.delete(key);
  }

  clearInterims(): void {
    for (const element of this.interims.values()) element.remove();
    this.interims.clear();
  }

  private change(apply: () => void): void {
    const scroller = this.element;
    const following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_WITHIN_PX;
    apply();
    if (following) scroller.scrollTop = scroller.scrollHeight;
  }
}

/** "Portuguese (Brazil)" -> "Portuguese": the region matters for speech, not for reading. */
function shortName(code: string): string {
  return languageName(code).replace(/ \(.*\)$/, '');
}
