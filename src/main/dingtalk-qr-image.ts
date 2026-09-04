import jsQR from 'jsqr';

export interface DingTalkQrImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Finds a QR code in an Electron NativeImage bitmap.
 * Electron returns Windows bitmaps in BGRA order, while jsQR expects RGBA.
 */
export function findDingTalkQrImageRect(bitmap: Uint8Array, width: number, height: number): DingTalkQrImageRect | null {
  if (width <= 0 || height <= 0 || bitmap.length < width * height * 4) return null;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let source = 0, target = 0; target < rgba.length; source += 4, target += 4) {
    rgba[target] = bitmap[source + 2] ?? 0;
    rgba[target + 1] = bitmap[source + 1] ?? 0;
    rgba[target + 2] = bitmap[source] ?? 0;
    rgba[target + 3] = bitmap[source + 3] ?? 255;
  }

  const result = jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' });
  if (!result) return null;
  const points = [
    result.location.topLeftCorner,
    result.location.topRightCorner,
    result.location.bottomRightCorner,
    result.location.bottomLeftCorner,
  ];
  const left = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x))));
  const top = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
  const right = Math.min(width, Math.ceil(Math.max(...points.map((point) => point.x))));
  const bottom = Math.min(height, Math.ceil(Math.max(...points.map((point) => point.y))));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
