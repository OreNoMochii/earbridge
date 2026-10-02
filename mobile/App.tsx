// The first-time setup, then Home and its pages (Settings, the keys, a group), and a
// conversation over all of them while it lasts.

import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { loadAppSettings, saveAppSettings } from './src/app-settings.ts';
import type { AppSettings } from './src/app-settings.ts';
import type { EndReason } from './src/connection.ts';
import { localSupport } from './src/engines/local.ts';
import { parseInvite } from './src/invite.ts';
import { LiveSession } from './src/live-session.ts';
import { GroupScreen } from './src/screens/GroupScreen.tsx';
import { HomeScreen } from './src/screens/HomeScreen.tsx';
import { KeysScreen } from './src/screens/KeysScreen.tsx';
import { LiveScreen } from './src/screens/LiveScreen.tsx';
import type { Update } from './src/screens/parts.tsx';
import { SettingsScreen } from './src/screens/SettingsScreen.tsx';
import { WizardScreen } from './src/screens/WizardScreen.tsx';
import { normalizeServerUrl, serverLabel } from './src/server-url.ts';
import { usePalette } from './src/theme.ts';

/** `check`: opened because a conversation needs something there, which it then points out. */
type Page =
  | { name: 'home' }
  | { name: 'settings'; check?: boolean }
  | { name: 'keys'; back: 'home' | 'settings'; check?: boolean }
  | { name: 'group' };

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const palette = usePalette();
  const [settings, setSettings] = useState(loadAppSettings);
  const [page, setPage] = useState<Page>({ name: 'home' });
  const [invitedRoom, setInvitedRoom] = useState<string>();
  const [error, setError] = useState<EndReason>();
  const [problem, setProblem] = useState<string>();
  const [session, setSession] = useState<LiveSession>();

  useEffect(() => saveAppSettings(settings), [settings]);

  const update: Update = useCallback((patch) => setSettings((current) => ({ ...current, ...patch })), []);

  const navigate = (next: Page) => {
    setPage(next);
    setError(undefined);
    setProblem(undefined);
  };

  // An invite (alo://join?room=ABC234&server=…) opens the group page with the group and
  // the computer filled in.
  useEffect(() => {
    const open = (url: string | null) => {
      const invite = url ? parseInvite(url) : undefined;
      if (!invite) return;
      const { server } = invite;
      setSettings((current) => ({ ...current, mode: 'room', server: server ? serverLabel(server) : current.server }));
      setInvitedRoom(invite.room);
      setError(undefined);
      setProblem(undefined);
      setPage({ name: 'group' });
    };
    Linking.getInitialURL().then(open, () => {});
    const subscription = Linking.addEventListener('url', ({ url }) => open(url));
    return () => subscription.remove();
  }, []);

  const start = useCallback((chosen: AppSettings, server: string | undefined, room: string | undefined) => {
    setSettings(chosen);
    setError(undefined);
    setProblem(undefined);
    const live = new LiveSession({
      settings: chosen,
      server,
      room: chosen.mode === 'room' ? room : undefined,
      onEnded: (reason, roomCode) => {
        if (!reason || reason.code === 'room_not_found') setInvitedRoom(undefined);
        // After a problem, offer to go back into the same group.
        else if (roomCode) setInvitedRoom(roomCode);
        setError(reason);
        setSession(undefined);
      },
    });
    setSession(live);
    void live.start();
  }, []);

  /** One phone, with the way of translating chosen in Settings. */
  const startSolo = () => {
    const chosen: AppSettings = { ...settings, mode: 'solo' };
    if (settings.engine === 'local') {
      const local = localSupport();
      if (!local.available) {
        setError(undefined);
        setProblem(local.reason ?? 'On-phone translation is not available.');
        return;
      }
      start(chosen, undefined, undefined);
    } else if (settings.engine === 'keys') {
      if (!settings.deepgramKey.trim() || !settings.deepinfraKey.trim()) {
        navigate({ name: 'keys', back: 'home', check: true });
        return;
      }
      start(chosen, undefined, undefined);
    } else {
      const server = normalizeServerUrl(settings.server);
      if (!server) {
        navigate({ name: 'settings', check: true });
        return;
      }
      start(chosen, server, undefined);
    }
  };

  const forgetInvite = useCallback(() => setInvitedRoom(undefined), []);

  let screen;
  if (session) {
    screen = <LiveScreen session={session} />;
  } else if (!settings.setupDone && page.name !== 'group') {
    screen = <WizardScreen settings={settings} onChange={update} />;
  } else if (page.name === 'settings') {
    screen = (
      <SettingsScreen
        settings={settings}
        onChange={update}
        check={page.check}
        onDone={() => navigate({ name: 'home' })}
        onKeys={() => navigate({ name: 'keys', back: 'settings' })}
      />
    );
  } else if (page.name === 'keys') {
    const back = () => navigate({ name: page.back });
    screen = <KeysScreen settings={settings} onChange={update} check={page.check} onBack={back} onDone={back} />;
  } else if (page.name === 'group') {
    screen = (
      <GroupScreen
        settings={settings}
        onChange={update}
        invitedRoom={invitedRoom}
        error={error}
        onForgetInvite={forgetInvite}
        onStart={start}
        onBack={() => navigate({ name: 'home' })}
      />
    );
  } else {
    screen = (
      <HomeScreen
        settings={settings}
        onChange={update}
        error={error}
        problem={problem}
        onStart={startSolo}
        onGroup={() => navigate({ name: 'group' })}
        onSettings={() => navigate({ name: 'settings' })}
        onKeys={() => navigate({ name: 'keys', back: 'home' })}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <StatusBar style="auto" />
      {screen}
    </View>
  );
}
