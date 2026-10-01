// A QR code drawn with plain views: one view per run of dark squares in a row.

import { memo, useMemo } from 'react';
import { View } from 'react-native';
import { create } from 'qrcode';

interface QrCodeProps {
  value: string;
  /** At most this wide, quiet zone included. */
  size: number;
}

/** Light margin around the code, in squares; scanners need it. */
const QUIET_ZONE = 2;

export const QrCode = memo(function QrCode({ value, size }: QrCodeProps) {
  const runs = useMemo(() => {
    let modules;
    try {
      modules = create(value, { errorCorrectionLevel: 'M' }).modules;
    } catch {
      return undefined; // too long to encode
    }
    const found: { row: number; col: number; length: number }[] = [];
    for (let row = 0; row < modules.size; row += 1) {
      let start = -1;
      for (let col = 0; col <= modules.size; col += 1) {
        const dark = col < modules.size && modules.get(row, col);
        if (dark && start < 0) start = col;
        else if (!dark && start >= 0) {
          found.push({ row, col: start, length: col - start });
          start = -1;
        }
      }
    }
    return { count: modules.size, found };
  }, [value]);
  if (!runs) return null;

  // Whole pixels per square, or thin seams can show between the rows.
  const cell = Math.max(1, Math.floor(size / (runs.count + QUIET_ZONE * 2)));
  const side = cell * (runs.count + QUIET_ZONE * 2);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="QR code of the invite link"
      style={{ width: side, height: side, backgroundColor: '#ffffff', borderRadius: 8 }}
    >
      {runs.found.map(({ row, col, length }) => (
        <View
          key={`${row}:${col}`}
          style={{
            position: 'absolute',
            top: (row + QUIET_ZONE) * cell,
            left: (col + QUIET_ZONE) * cell,
            width: length * cell,
            height: cell,
            backgroundColor: '#000000',
          }}
        />
      ))}
    </View>
  );
});
