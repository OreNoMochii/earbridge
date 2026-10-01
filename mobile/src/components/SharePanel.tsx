// Room mode: how others join. A QR code to scan with the camera, the link to send, and
// the room code to type.

import * as Clipboard from 'expo-clipboard';
import { Share, Text, View } from 'react-native';

import { formatRoomCode } from '../../../shared/room-code.ts';
import { inviteUrl } from '../invite.ts';
import { isSecure, serverLabel } from '../server-url.ts';
import { RADIUS, themedStyles } from '../theme.ts';
import { Button } from './Button.tsx';
import { QrCode } from './QrCode.tsx';

interface SharePanelProps {
  server: string;
  room: string;
  onToast(message: string): void;
}

export function SharePanel({ server, room, onToast }: SharePanelProps) {
  const { styles } = useStyles();
  const formatted = formatRoomCode(room);
  const url = inviteUrl(server, room);
  const hint = isSecure(server)
    ? 'Others scan the code with their camera (or open the link, or type the room code), pick their language, and put in their earphones.'
    : `Others with the EarBridge app scan the code with their camera, or type the room code, with ${serverLabel(server)} as the server under Advanced. Then they pick their language and put in their earphones.`;

  const share = () => {
    Share.share({ message: `Join my EarBridge conversation (room ${formatted}): ${url}` }).catch(() => {});
  };
  const copy = () => {
    Clipboard.setStringAsync(url).then(
      () => onToast('Link copied.'),
      () => onToast('Could not copy the link.'),
    );
  };

  return (
    <View style={styles.share} accessibilityLabel="Invite others">
      <QrCode value={url} size={200} />
      <View style={styles.details}>
        <Text style={styles.code} accessibilityLabel={`Room code ${room.split('').join(' ')}`}>
          {formatted}
        </Text>
        <Text style={styles.hint}>{hint}</Text>
        <Text style={styles.url} selectable>
          {url}
        </Text>
        <View style={styles.buttons}>
          <Button kind="primary" label="Share link" onPress={share} />
          <Button label="Copy link" onPress={copy} />
        </View>
      </View>
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  share: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    marginTop: 12,
    marginHorizontal: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: RADIUS,
    backgroundColor: palette.surface,
  },
  details: {
    flexGrow: 1,
    flexBasis: 220,
    gap: 8,
  },
  code: {
    color: palette.text,
    fontFamily: 'monospace',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 4,
  },
  hint: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  url: {
    color: palette.muted,
    fontSize: 13,
  },
  buttons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
}));
