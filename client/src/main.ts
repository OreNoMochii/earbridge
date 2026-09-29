// Entry point: the setup screen, then a conversation, then back to the setup screen.

import './styles.css';
import { normalizeRoomCode } from '../../shared/room-code.ts';
import type { EndReason } from './connection.ts';
import { LiveSession } from './live-session.ts';
import { loadSettings, saveSettings } from './settings.ts';
import type { KeyValueStore, Settings } from './settings.ts';
import { renderSetup } from './setup-view.ts';
import type { SetupView } from './setup-view.ts';
import { SpeechOutput } from './tts.ts';

const app = document.getElementById('app')!;
const storage = safeStorage();
let settings = loadSettings(storage, navigator.languages?.length ? navigator.languages : [navigator.language]);
// An invite link (https://…/?room=ABC234) opens the room form with the room filled in.
let invitedRoom = normalizeRoomCode(new URLSearchParams(location.search).get('room') ?? '');
if (invitedRoom) settings = { ...settings, mode: 'room' };
// One for the whole page: voices load once, and iOS unlocks speech once per page.
const speech = new SpeechOutput();
let setupView: SetupView | undefined;

function showSetup(error: EndReason | undefined): void {
  if (error?.code === 'room_not_found') forgetInvite();
  setupView?.destroy();
  setupView = renderSetup({
    settings,
    invitedRoom,
    error,
    onChange: (changed) => {
      settings = changed;
      saveSettings(storage, settings);
    },
    onStart: start,
    onForgetInvite: forgetInvite,
  });
  app.replaceChildren(setupView.element);
  window.scrollTo(0, 0);
}

function forgetInvite(): void {
  invitedRoom = undefined;
  if (location.search) history.replaceState(history.state, '', location.pathname);
}

/** Runs within the tap on Start: audio can only be started by a user gesture. */
function start(chosen: Settings, room: string | undefined): void {
  settings = chosen;
  saveSettings(storage, settings);

  let context: AudioContext;
  try {
    // At the device's own sample rate: Firefox cannot connect a microphone to a context
    // running at another rate. The capture resamples to what the recognizer needs.
    context = new AudioContext({ latencyHint: 'interactive' });
  } catch {
    showSetup({ message: 'This browser cannot record audio. Try a recent Chrome, Safari or Firefox.' });
    return;
  }
  void context.resume().catch(() => {});
  speech.unlock();

  setupView?.destroy();
  setupView = undefined;
  const session = new LiveSession({
    settings,
    context,
    speech,
    room: settings.mode === 'room' ? room : undefined,
    container: app,
    onEnded: (reason, roomCode) => {
      if (!reason) forgetInvite();
      // After a problem, offer to go back into the same room.
      else if (roomCode && reason.code !== 'room_not_found') invitedRoom = roomCode;
      showSetup(reason);
    },
  });
  void session.start();
}

function safeStorage(): KeyValueStore | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined; // blocked, e.g. in some private-browsing modes
  }
}

showSetup(undefined);
