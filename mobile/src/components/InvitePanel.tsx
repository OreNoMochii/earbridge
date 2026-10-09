// A group: how others join. A QR code to scan with the camera, the code to type, and the
// link to send.

import * as Clipboard from 'expo-clipboard';
import { Share, Text, View } from 'react-native';

import { formatRoomCode } from '../../../shared/room-code.ts';
import { inviteUrl } from '../invite.ts';
import { isSecure, serverLabel } from '../server-url.ts';
import { RADIUS_LG, themedStyles, type } from '../theme.ts';
import { CompactButton } from './Button.tsx';
import { QrCode } from './QrCode.tsx';

interface InvitePanelProps {
  server: string;
  room: string;
  onToast(message: string): void;
}

export function InvitePanel({ server, room, onToast }: InvitePanelProps) {
  const { styles } = useStyles();
  const code = formatRoomCode(room);
  const url = inviteUrl(server, room);
  const how = isSecure(server)
    ? 'Others scan this with their camera, or type the code, then pick their language and put in their earphones.'
    : `Others with the Alo app scan this with their camera, or type the code with the computer’s address, ${serverLabel(server)}. Then they pick their language and put in their earphones.`;
  const share = () => {
    Share.share({ message: `Join my Alo group conversation: ${url}\nGroup code: ${code}` }).catch(() => {});
  };
  const copy = () => {
    Clipboard.setStringAsync(url).then(
      () => onToast('Link copied.'),
      () => onToast('Couldn’t copy the link.'),
    );
  };
  return (
    <View style={styles.panel}>
      <View style={styles.qr}>
        <QrCode value={url} size={168} />
      </View>
      <Text style={styles.code} accessibilityLabel={`Group code ${room.split('').join(' ')}`}>
        {code}
      </Text>
      <Text style={styles.how}>{how}</Text>
      <Text style={styles.link} selectable>
        {url}
      </Text>
      <View style={styles.buttons}>
        <CompactButton label="Share link" icon="share-2" onPress={share} style={styles.button} />
        <CompactButton label="Copy link" icon="copy" onPress={copy} style={styles.button} />
      </View>
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  panel: {
    alignItems: 'center',
    gap: 14,
    padding: 18,
    borderWidth: 2,
    borderColor: palette.accent,
    borderRadius: RADIUS_LG,
    backgroundColor: palette.surface,
  },
  qr: {
    padding: 2,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  code: {
    ...type.code,
    letterSpacing: 2,
    color: palette.text,
  },
  how: {
    ...type.secondary,
    color: palette.text,
    textAlign: 'center',
  },
  link: {
    ...type.small,
    color: palette.muted,
    textAlign: 'center',
  },
  buttons: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    flex: 1,
  },
}));
