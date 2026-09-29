// The conversation screen: status, the running transcript, and the talk controls.

import { toCanvas } from 'qrcode';
import { languageName } from '../../shared/languages.ts';
import type { Mode, SpeakerSelection } from '../../shared/protocol.ts';
import { formatRoomCode } from '../../shared/room-code.ts';
import type { MicMode } from './audio/mic.ts';
import { h } from './dom.ts';
import { Feed } from './feed.ts';
import { nativeLanguageName, shortLanguageLabel } from './language-names.ts';
import type { TalkMode } from './settings.ts';

export type StatusTone = 'live' | 'busy' | 'idle' | 'speaking';
/** Which hold-to-talk button: one per person in one-phone mode, a single one in a room. */
export type HoldTarget = 'me' | 'them' | 'room';

export interface LiveViewOptions {
  mode: Mode;
  myLang: string;
  /** One-phone mode: the other person's language. */
  theirLang: string;
  talkMode: TalkMode;
  onEnd(): void;
  onMuteChange(muted: boolean): void;
  onSpeakerSelect(selection: SpeakerSelection): void;
  onHoldChange(target: HoldTarget, pressed: boolean): void;
}

export interface ParticipantView {
  name: string;
  lang: string;
  me: boolean;
}

const TOAST_MS = 5_000;
const MAX_TOASTS = 3;

export class LiveView {
  readonly element: HTMLElement;
  readonly feed: Feed;
  private readonly options: LiveViewOptions;
  private readonly statusDot: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly title: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly meter: HTMLElement;
  private readonly meterFill: HTMLElement;
  private readonly micLabel: HTMLElement;
  private readonly speakerButtons = new Map<SpeakerSelection, HTMLButtonElement>();
  private readonly holdButtons: HoldButton[] = [];
  private readonly cleanups: Array<() => void> = [];
  private muteButton: HTMLButtonElement | undefined;
  private partner: HTMLElement | undefined;
  private partnerText: HTMLElement | undefined;
  private inviteButton: HTMLButtonElement | undefined;
  private sharePanel: HTMLElement | undefined;
  private participantList: HTMLElement | undefined;
  private displayedLevel = 0;
  private muted = false;

  constructor(options: LiveViewOptions) {
    this.options = options;
    const solo = options.mode === 'solo';

    this.statusDot = h('span', { class: 'status-dot', 'data-tone': 'busy' });
    this.statusText = h('span', { class: 'status-text' }, 'Starting…');
    this.title = h(
      'h1',
      { class: 'live-title' },
      solo ? `${shortLanguageLabel(options.myLang)} ⇄ ${shortLanguageLabel(options.theirLang)}` : 'Room',
    );
    const actions = h('div', { class: 'live-actions' });
    if (!solo) {
      this.inviteButton = h(
        'button',
        { type: 'button', class: 'button small', 'aria-expanded': 'false', disabled: true, onclick: () => this.toggleInvite() },
        'Invite',
      );
      actions.append(this.inviteButton);
    }
    actions.append(
      h('button', { type: 'button', class: 'button small danger', onclick: () => options.onEnd() }, solo ? 'End' : 'Leave'),
    );
    const header = h(
      'header',
      { class: 'live-header' },
      h('div', { class: 'live-heading' }, this.title, h('p', { class: 'status', role: 'status' }, this.statusDot, this.statusText)),
      actions,
    );

    this.toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
    this.feed = new Feed(
      !solo
        ? 'When someone speaks, it appears here in their language and in yours.'
        : options.talkMode === 'hold'
          ? 'Hold your button while you talk. Everything you both say appears here, translated.'
          : 'Start talking. Everything you both say appears here, translated.',
    );

    this.meterFill = h('span', { class: 'meter-fill' });
    this.meter = h('span', { class: 'meter', 'data-mode': 'off', 'aria-hidden': 'true' }, this.meterFill);
    this.micLabel = h('span', { class: 'mic-label' }, 'Microphone');
    const controls = h(
      'footer',
      { class: 'controls' },
      h('div', { class: 'mic-row' }, this.meter, this.micLabel),
      this.buildTalkControls(),
    );

    const parts: Node[] = [header, this.toasts];
    if (solo) {
      parts.push(this.buildPartnerPanel());
    } else {
      this.sharePanel = h('section', { class: 'share', 'aria-label': 'Invite others', hidden: true });
      this.participantList = h('ul', { class: 'participants', 'aria-label': 'People in the room' });
      parts.push(this.sharePanel, this.participantList);
    }
    parts.push(this.feed.element, controls);
    this.element = h('div', { class: `live ${solo ? 'solo' : 'room'}` }, ...parts);

    // A hidden page gets no pointerup; never leave the microphone open.
    this.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') for (const button of this.holdButtons) button.release();
    });
  }

  setStatus(text: string, tone: StatusTone): void {
    this.statusText.textContent = text;
    this.statusDot.dataset['tone'] = tone;
  }

  /** 0..1 */
  setLevel(level: number): void {
    // Rise at once, fall slowly: easier to read than the raw level.
    this.displayedLevel = Math.max(level, this.displayedLevel * 0.85);
    this.meterFill.style.transform = `scaleX(${this.displayedLevel.toFixed(3)})`;
  }

  setMicMode(mode: MicMode): void {
    this.meter.dataset['mode'] = mode;
  }

  setMicLabel(label: string): void {
    this.micLabel.textContent = label || 'Microphone';
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.muteButton?.setAttribute('aria-pressed', String(muted));
  }

  /** One-phone mode: whether "Auto" can be offered. */
  setAutoDetect(available: boolean): void {
    const auto = this.speakerButtons.get('auto');
    if (auto) auto.hidden = !available;
  }

  setSpeaker(selection: SpeakerSelection): void {
    for (const [value, button] of this.speakerButtons) button.setAttribute('aria-pressed', String(value === selection));
  }

  /** One-phone mode: the latest translation for the other person, shown large. */
  showPartnerTranslation(text: string, done: boolean, error?: string): void {
    const element = this.partnerText;
    if (!element) return;
    element.classList.remove('placeholder');
    element.classList.toggle('streaming', !done);
    if (error) {
      element.removeAttribute('lang');
      element.textContent = '⚠︎';
    } else {
      element.lang = this.options.theirLang;
      element.textContent = text || '…';
    }
  }

  setRoomCode(code: string): void {
    const formatted = formatRoomCode(code);
    this.title.textContent = `Room ${formatted}`;
    if (this.inviteButton) this.inviteButton.disabled = false;
    this.renderInvite(code, formatted);
  }

  showInvite(open: boolean): void {
    if (!this.sharePanel || !this.inviteButton || this.inviteButton.disabled) return;
    this.sharePanel.hidden = !open;
    this.inviteButton.setAttribute('aria-expanded', String(open));
  }

  setParticipants(participants: readonly ParticipantView[]): void {
    this.participantList?.replaceChildren(
      ...participants.map((participant) =>
        h(
          'li',
          { class: participant.me ? 'chip me' : 'chip', title: languageName(participant.lang) },
          participant.me ? 'You' : participant.name,
          h('span', { class: 'chip-lang' }, shortLanguageLabel(participant.lang)),
        ),
      ),
    );
  }

  toast(message: string): void {
    const toast = h('p', { class: 'toast' }, message);
    this.toasts.append(toast);
    while (this.toasts.childElementCount > MAX_TOASTS) this.toasts.firstElementChild?.remove();
    window.setTimeout(() => toast.remove(), TOAST_MS);
  }

  /** Removes the listeners this view added outside its own element. */
  destroy(): void {
    for (const button of this.holdButtons) button.release();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  private buildPartnerPanel(): HTMLElement {
    const theirLang = this.options.theirLang;
    this.partnerText = h('p', { class: 'partner-text placeholder', dir: 'auto' }, 'Waiting for you to speak…');
    const flip = h(
      'button',
      {
        type: 'button',
        class: 'button small ghost',
        'aria-pressed': 'false',
        title: 'Turn this text around for the person facing you',
      },
      'Flip ↻',
    );
    this.partner = h(
      'section',
      { class: 'partner', 'aria-label': `For the other person, in ${languageName(theirLang)}` },
      h(
        'div',
        { class: 'partner-head' },
        h('span', { class: 'partner-lang', lang: theirLang }, nativeLanguageName(theirLang) ?? languageName(theirLang)),
        flip,
      ),
      this.partnerText,
    );
    flip.addEventListener('click', () => {
      const flipped = this.partner!.classList.toggle('flipped');
      flip.setAttribute('aria-pressed', String(flipped));
    });
    return this.partner;
  }

  private buildTalkControls(): HTMLElement {
    const { mode, talkMode, myLang, theirLang } = this.options;
    const row = h('div', { class: 'talk-row' });

    if (talkMode === 'hold') {
      // [target, label, detail, language of the detail (undefined: the app's English)]
      const targets: Array<[HoldTarget, string, string, string | undefined]> =
        mode === 'solo'
          ? [
              ['me', 'Me', nativeLanguageName(myLang) ?? languageName(myLang), myLang],
              ['them', 'Them', nativeLanguageName(theirLang) ?? languageName(theirLang), theirLang],
            ]
          : [['room', 'Hold to talk', 'or hold the space bar', undefined]];
      for (const [target, label, detail, detailLang] of targets) {
        const button = new HoldButton(label, detail, detailLang, (pressed) => this.options.onHoldChange(target, pressed));
        this.holdButtons.push(button);
        row.append(button.element);
      }
      if (mode === 'room') this.bindSpaceBar(this.holdButtons[0]!);
      return row;
    }

    if (mode === 'solo') {
      const group = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Who is talking' });
      const choices: Array<[SpeakerSelection, string]> = [
        ['auto', 'Auto'],
        ['me', `Me · ${shortLanguageLabel(myLang)}`],
        ['them', `Them · ${shortLanguageLabel(theirLang)}`],
      ];
      for (const [value, label] of choices) {
        const button = h(
          'button',
          { type: 'button', 'aria-pressed': 'false', onclick: () => this.options.onSpeakerSelect(value) },
          label,
        );
        this.speakerButtons.set(value, button);
        group.append(button);
      }
      row.append(group);
    }
    this.muteButton = h(
      'button',
      {
        type: 'button',
        class: mode === 'solo' ? 'button mute' : 'button mute wide',
        'aria-pressed': 'false',
        onclick: () => this.options.onMuteChange(!this.muted),
      },
      'Mute',
    );
    row.append(this.muteButton);
    return row;
  }

  private bindSpaceBar(button: HoldButton): void {
    // Only when nothing else has focus, so Space still works on focused buttons.
    this.listen(document, 'keydown', (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.target !== document.body) return;
      event.preventDefault();
      if (!event.repeat) button.press();
    });
    this.listen(document, 'keyup', (event: KeyboardEvent) => {
      if (event.code === 'Space') button.release();
    });
    this.listen(window, 'blur', () => button.release());
  }

  private toggleInvite(): void {
    this.showInvite(Boolean(this.sharePanel?.hidden));
  }

  private renderInvite(code: string, formatted: string): void {
    const panel = this.sharePanel;
    if (!panel) return;
    const url = `${location.origin}${import.meta.env.BASE_URL}?room=${code}`;
    const canvas = h('canvas', { class: 'qr', role: 'img', 'aria-label': 'QR code of the invite link' });
    toCanvas(canvas, url, { margin: 1, width: 200, color: { dark: '#000000', light: '#ffffff' } }).catch(() =>
      canvas.remove(),
    );

    const buttons = h('div', { class: 'share-buttons' });
    if ('share' in navigator) {
      buttons.append(
        h(
          'button',
          {
            type: 'button',
            class: 'button primary',
            onclick: () => {
              navigator
                .share({ title: 'EarBridge', text: `Join my EarBridge conversation (room ${formatted}):`, url })
                .catch(() => {});
            },
          },
          'Share link',
        ),
      );
    }
    if (navigator.clipboard) {
      buttons.append(
        h(
          'button',
          {
            type: 'button',
            class: 'button',
            onclick: () => {
              navigator.clipboard.writeText(url).then(
                () => this.toast('Link copied.'),
                () => this.toast('Could not copy the link.'),
              );
            },
          },
          'Copy link',
        ),
      );
    }

    panel.replaceChildren(
      h('div', { class: 'qr-frame' }, canvas),
      h(
        'div',
        { class: 'share-details' },
        h('p', { class: 'share-code' }, formatted),
        h(
          'p',
          { class: 'hint' },
          'Others scan the code with their camera (or open the link, or type the room code), pick their language, and put in their earphones.',
        ),
        h('p', { class: 'share-url' }, url),
        buttons,
      ),
    );
  }

  private listen<E extends Event>(target: EventTarget, type: string, handler: (event: E) => void): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener);
    this.cleanups.push(() => target.removeEventListener(type, listener));
  }
}

/**
 * A button that is "on" while pressed: by touch, mouse, or Space/Enter. Releasing the
 * pointer anywhere (even off the button) ends the press.
 */
class HoldButton {
  readonly element: HTMLButtonElement;
  private readonly onChange: (pressed: boolean) => void;
  private pressed = false;

  constructor(label: string, detail: string, detailLang: string | undefined, onChange: (pressed: boolean) => void) {
    this.onChange = onChange;
    this.element = h(
      'button',
      { type: 'button', class: 'hold', 'aria-pressed': 'false' },
      h('span', { class: 'hold-label' }, label),
      h('span', { class: 'hold-detail', lang: detailLang }, detail),
    );
    const button = this.element;
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault(); // no text selection, focus change or long-press menu
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone.
      }
      this.press();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(type, () => this.release());
    }
    button.addEventListener('contextmenu', (event) => event.preventDefault());
    button.addEventListener('keydown', (event) => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      if (!event.repeat) this.press();
    });
    button.addEventListener('keyup', (event) => {
      if (event.key === ' ' || event.key === 'Enter') this.release();
    });
    button.addEventListener('blur', () => this.release());
  }

  press(): void {
    this.set(true);
  }

  release(): void {
    this.set(false);
  }

  private set(pressed: boolean): void {
    if (pressed === this.pressed) return;
    this.pressed = pressed;
    this.element.setAttribute('aria-pressed', String(pressed));
    this.onChange(pressed);
  }
}
