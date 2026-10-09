// A voice print drawn as a ring of strokes, one for each of its numbers: out from the ring
// for the positive ones, in for the negative ones. Each voice draws differently, like a
// fingerprint. It is only a picture of the numbers: there is no recording to play.

import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { usePalette } from '../theme.ts';

interface VoicePrintProps {
  print: Float32Array;
  /** Read out, e.g. "Your voice print". */
  label: string;
  size?: number;
}

export function VoicePrint({ print, label, size = 96 }: VoicePrintProps) {
  const palette = usePalette();
  const center = size / 2;
  const ring = size * 0.3;
  const reach = size * 0.18;
  let largest = 0;
  for (const value of print) largest = Math.max(largest, Math.abs(value));
  let outward = '';
  let inward = '';
  for (let i = 0; i < print.length; i++) {
    const value = print[i]! / (largest || 1);
    const angle = (i / print.length) * 2 * Math.PI - Math.PI / 2;
    const [x, y] = [Math.cos(angle), Math.sin(angle)];
    const end = ring + value * reach;
    const stroke = `M${point(center + ring * x)} ${point(center + ring * y)}L${point(center + end * x)} ${point(center + end * y)}`;
    if (value >= 0) outward += stroke;
    else inward += stroke;
  }
  // As thick as fits around the ring, within reason.
  const width = Math.max(1, Math.min(4, ((2 * Math.PI * ring) / Math.max(1, print.length)) * 0.6));
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label}>
      <Svg width={size} height={size}>
        <Circle cx={center} cy={center} r={ring} stroke={palette.border} strokeWidth={1} fill="none" />
        <Path d={inward} stroke={palette.accent} strokeOpacity={0.45} strokeWidth={width} strokeLinecap="round" />
        <Path d={outward} stroke={palette.accent} strokeWidth={width} strokeLinecap="round" />
      </Svg>
    </View>
  );
}

function point(value: number): string {
  return value.toFixed(1);
}
