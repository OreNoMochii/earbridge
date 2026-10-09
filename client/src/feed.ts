// The running conversation: what each person said, in their language and translated,
// and, dimmed, what was heard but not translated.

import { languageName } from '../../shared/languages.ts';
import type { SkipReason } from '../../shared/protocol.ts';
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

/**
 * One phone: something heard but not translated, as it seemed to come from someone else.
 * Not its words: only the two people's are shown.
 */
export interface FeedSkipped {
  id: string;
  /** The language it seemed to be in. */
  lang: string;
  reason: SkipReason;
}

interface Entry {
  element: HTMLLIElement;
  translation: HTMLElement | undefined;
  translationLang: string | undefined;
  done: boolean;
}

interface Skipped {
  element: HTMLLIElement;
  /** The Translate button, or "Translating…" once it was tapped; none once too old. */
  action: HTMLElement | undefined;
}

const MAX_ENTRIES = 200;
const SKIP_REASONS: Record<Exclude<SkipReason, 'language'>, string> = {
  distant: 'far away',
  voice: 'another voice',
  unrecorded: 'voice not recorded',
  short: 'too short to tell',
  untimed: 'voice not checked',
  direction: 'from the side',
};
/** Keep following new lines only when the user has not scrolled up to read. */
const FOLLOW_WITHIN_PX = 80;

export class Feed {
  readonly element: HTMLElement;
  private readonly list: HTMLOListElement;
  private readonly interimBox: HTMLElement;
  private readonly placeholder: HTMLElement;
  private readonly entries = new Map<string, Entry>();
  private readonly skipped = new Map<string, Skipped>();
  /** "3 more not translated" before each run of skipped lines, by the id of its first line. */
  private moreButtons = new Map<string, HTMLLIElement>();
  /** Runs of skipped lines showing all their lines, by the id of their first line. */
  private readonly openRuns = new Set<string>();
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
        {
          class: `entry ${utterance.mine ? 'mine' : 'theirs'}${translation ? ' translated' : ''}`,
          'data-id': utterance.id,
        },
        h('p', { class: 'entry-meta' }, `${utterance.speaker} · ${shortName(utterance.lang)}`),
        h('p', { class: 'entry-original', lang: utterance.lang, dir: 'auto' }, utterance.text),
        translation,
      );
      // Something skipped and then translated after all stays where it was.
      const skipped = this.skipped.get(utterance.id);
      if (skipped) {
        skipped.element.replaceWith(element);
        this.skipped.delete(utterance.id);
      } else {
        this.list.append(element);
      }
      this.entries.set(utterance.id, {
        element,
        translation,
        translationLang: utterance.translationLang,
        done: !translation,
      });
      this.trim();
      this.regroup();
      this.placeholder.hidden = true;
    });
  }

  /** One phone: something heard but not translated. `onTranslate` asks for it to be. */
  addSkipped(line: FeedSkipped, onTranslate: () => void): void {
    this.change(() => {
      const why = line.reason === 'language' ? shortName(line.lang) : SKIP_REASONS[line.reason];
      const action = h(
        'button',
        { type: 'button', class: 'skipped-translate', 'aria-label': `Translate it after all (${why})`, onclick: onTranslate },
        'Translate',
      );
      const element = h(
        'li',
        { class: 'skipped', 'data-id': line.id },
        h('div', { class: 'skipped-text' }, h('p', { class: 'entry-meta' }, `Not translated · ${why}`)),
        action,
      );
      this.list.append(element);
      this.skipped.set(line.id, { element, action });
      this.trim();
      this.regroup();
      this.placeholder.hidden = true;
    });
  }

  /** accepting: on its way to be translated after all. gone: can no longer be translated. */
  markSkipped(id: string, state: 'accepting' | 'gone'): void {
    const skipped = this.skipped.get(id);
    if (!skipped?.action) return;
    const action = state === 'accepting' ? h('span', { class: 'skipped-wait' }, 'Translating…') : undefined;
    if (action) skipped.action.replaceWith(action);
    else skipped.action.remove();
    skipped.action = action;
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

  /**
   * The connection dropped: translations still on their way will not arrive, and what was
   * skipped can no longer be translated.
   */
  interruptPending(): void {
    for (const id of this.skipped.keys()) this.markSkipped(id, 'gone');
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

  /** Drops the oldest lines beyond MAX_ENTRIES. */
  private trim(): void {
    while (this.entries.size + this.skipped.size > MAX_ENTRIES) {
      const oldest = this.list.firstElementChild as HTMLElement | null;
      if (!oldest) return;
      oldest.remove();
      const id = oldest.dataset['id'];
      if (id === undefined) continue; // a "more not translated" button
      this.entries.delete(id);
      this.skipped.delete(id);
    }
  }

  /**
   * Of several skipped lines in a row only the latest shows, after a button that shows
   * the others, so that noise does not push the conversation off the screen.
   */
  private regroup(): void {
    const moreButtons = new Map<string, HTMLLIElement>();
    let run: HTMLElement[] = [];
    const endRun = (): void => {
      const lines = run;
      run = [];
      const first = lines[0];
      const id = first?.dataset['id'];
      if (!first || id === undefined) return;
      const open = this.openRuns.has(id);
      lines.forEach((line, i) => {
        line.hidden = !open && i < lines.length - 1;
      });
      if (lines.length < 2) return;
      const more = this.moreButtons.get(id) ?? this.moreButton(id);
      const button = more.firstElementChild as HTMLButtonElement;
      button.textContent = open ? 'Show fewer' : `${lines.length - 1} more not translated`;
      button.setAttribute('aria-expanded', String(open));
      // Moved only when needed: moving it would take the focus away from it.
      if (first.previousElementSibling !== more) first.before(more);
      moreButtons.set(id, more);
    };
    for (const child of [...this.list.children] as HTMLElement[]) {
      if (child.classList.contains('skipped')) run.push(child);
      else if (!child.classList.contains('skipped-more')) endRun();
    }
    endRun();
    for (const [id, more] of this.moreButtons) if (!moreButtons.has(id)) more.remove();
    for (const id of this.openRuns) if (!moreButtons.has(id)) this.openRuns.delete(id);
    this.moreButtons = moreButtons;
  }

  private moreButton(id: string): HTMLLIElement {
    const toggle = (): void => {
      if (!this.openRuns.delete(id)) this.openRuns.add(id);
      this.change(() => this.regroup());
    };
    return h('li', { class: 'skipped-more' }, h('button', { type: 'button', onclick: toggle }));
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
