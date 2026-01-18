export function bytesToHex(data) {
  return new Uint8Array(data).reduce((memo, i) => memo + ("0" + i.toString(16)).slice(-2), "");
}

export function hexToBytes(hex) {
  const bytes = [];
  for (let c = 0; c < hex.length; c += 2) bytes.push(parseInt(hex.substr(c, 2), 16));
  return new Uint8Array(bytes);
}

export function u32beToBytes(value) {
  const v = value >>> 0;
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

export function u16beToBytes(value) {
  const v = value & 0xffff;
  return new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Format a timestamp as UTC time (no local timezone involved).
 * Example: 2026/01/18 15:04:05 (UTC)
 */
export function fmtUtc(ms) {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

/**
 * Format a timestamp that has already been shifted into a target timezone.
 * We intentionally read it using UTC getters to avoid applying the browser's
 * local timezone a second time.
 */
export function fmtShiftedAsLocal(msShifted) {
  return fmtUtc(msShifted);
}
