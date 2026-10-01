// The setup screen, then a conversation, then back to the setup screen. A port of the
// web app's client/src/main.ts.

import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { loadAppSettings, saveAppSettings } from './src/app-settings.ts';
import type { AppSettings } from './src/app-settings.ts';
import type { EndReason } from './src/connection.ts';
import { parseInvite } from './src/invite.ts';
import { LiveSession } from './src/live-session.ts';
import { LiveScreen } from './src/screens/LiveScreen.tsx';
import { SetupScreen } from './src/screens/SetupScreen.tsx';
import { serverLabel } from './src/server-url.ts';
import { usePalette } from './src/theme.ts';

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
  const [invitedRoom, setInvitedRoom] = useState<string>();
  const [error, setError] = useState<EndReason>();
  const [session, setSession] = useState<LiveSession>();

  useEffect(() => saveAppSettings(settings), [settings]);

  // An invite (earbridge://join?room=ABC234&server=…) opens the room form with the room
  // and the server filled in.
  useEffect(() => {
    const open = (url: string | null) => {
      const invite = url ? parseInvite(url) : undefined;
      if (!invite) return;
      const { server } = invite;
      setSettings((current) => ({ ...current, mode: 'room', server: server ? serverLabel(server) : current.server }));
      setInvitedRoom(invite.room);
      setError(undefined);
    };
    Linking.getInitialURL().then(open, () => {});
    const subscription = Linking.addEventListener('url', ({ url }) => open(url));
    return () => subscription.remove();
  }, []);

  const start = useCallback((chosen: AppSettings, server: string, room: string | undefined) => {
    setSettings(chosen);
    setError(undefined);
    const live = new LiveSession({
      settings: chosen,
      server,
      room: chosen.mode === 'room' ? room : undefined,
      onEnded: (reason, roomCode) => {
        if (!reason || reason.code === 'room_not_found') setInvitedRoom(undefined);
        // After a problem, offer to go back into the same room.
        else if (roomCode) setInvitedRoom(roomCode);
        setError(reason);
        setSession(undefined);
      },
    });
    setSession(live);
    void live.start();
  }, []);

  const forgetInvite = useCallback(() => setInvitedRoom(undefined), []);

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <StatusBar style="auto" />
      {session ? (
        <LiveScreen session={session} />
      ) : (
        <SetupScreen
          settings={settings}
          invitedRoom={invitedRoom}
          error={error}
          onChange={setSettings}
          onStart={start}
          onForgetInvite={forgetInvite}
        />
      )}
    </View>
  );
}
