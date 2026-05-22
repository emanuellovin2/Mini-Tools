const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP = [0x57, 0x45, 0x42, 0x50]; // "WEBP" at offset 8

export function detectLogoMimeType(
  buf: Buffer
): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buf.length >= 8 && PNG.every((b, i) => buf[i] === b)) return "image/png";
  if (buf.length >= 3 && JPEG.every((b, i) => buf[i] === b)) return "image/jpeg";
  if (
    buf.length >= 12 &&
    RIFF.every((b, i) => buf[i] === b) &&
    WEBP.every((b, i) => buf[i + 8] === b)
  )
    return "image/webp";
  return null;
}
