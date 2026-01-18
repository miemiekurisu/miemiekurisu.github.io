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

export function fmtTs(ms) {
  const d = new Date(ms);
  return d.toLocaleString();
}
