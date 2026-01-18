import { fmtShiftedAsLocal } from './utils.js';

// Browser cannot do UDP NTP. We use HTTPS time APIs as an NTP-like source.
// We treat the returned time as UTC milliseconds.
const TIME_ENDPOINTS = [
  {
    name: 'worldtimeapi.org',
    url: 'https://worldtimeapi.org/api/timezone/Etc/UTC',
    parse: async (res) => {
      const j = await res.json();
      // worldtimeapi: { unixtime: seconds, ... }
      if (typeof j.unixtime === 'number') return j.unixtime * 1000;
      if (typeof j.datetime === 'string') return Date.parse(j.datetime);
      return null;
    },
  },
  {
    name: 'timeapi.io',
    url: 'https://timeapi.io/api/Time/current/zone?timeZone=Etc/UTC',
    parse: async (res) => {
      const j = await res.json();
      // timeapi.io: { dateTime: '2026-01-18T12:34:56.123', ... }
      if (typeof j.dateTime === 'string') {
        const s = j.dateTime;
        // If timezone info is present, parse directly; otherwise treat as UTC.
        if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
        return Date.parse(s + 'Z');
      }
      return null;
    },
  },
];

/**
 * Returns an object describing the best known UTC time.
 * - If network works: uses HTTPS time API.
 * - Else: falls back to local system time.
 *
 * Also returns a monotonic "now" function based on performance.now() so we
 * don't need to refetch too often.
 */
export async function getAccurateClock() {
  const startedPerf = performance.now();

  for (const ep of TIME_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(ep.url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) continue;

      const utcMs = await ep.parse(res);
      if (!utcMs || !Number.isFinite(utcMs)) continue;

      const basePerf = performance.now();
      const baseUtcMs = utcMs + Math.round(basePerf - startedPerf); // include fetch latency

      return {
        source: ep.name,
        baseUtcMs,
        basePerf,
        utcNowMs: () => Math.round(baseUtcMs + (performance.now() - basePerf)),
      };
    } catch {
      // try next
    }
  }

  // Offline fallback.
  const basePerf = performance.now();
  const baseUtcMs = Date.now();
  return {
    source: 'local',
    baseUtcMs,
    basePerf,
    utcNowMs: () => Math.round(baseUtcMs + (performance.now() - basePerf)),
  };
}

/**
 * Computes "device local seconds" and Y/M/D/W fields.
 * The firmware uses a local-time epoch (UTC shifted) so that 86400 boundaries
 * match local midnight.
 */
export function computeDeviceTimeFields(utcNowMs, tzOffsetHours) {
  const tzOffsetSec = Math.round(tzOffsetHours * 3600);
  const utcSec = Math.floor(utcNowMs / 1000);

  // This is NOT true Unix time; it's UTC + offset seconds.
  const deviceEpochSec = (utcSec + tzOffsetSec) >>> 0;

  // Derive Y/M/D/W in the chosen timezone using UTC getters.
  const shiftedMs = utcNowMs + tzOffsetSec * 1000;
  const d = new Date(shiftedMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const week = d.getUTCDay() || 7;

  return {
    deviceEpochSec,
    year,
    month,
    day,
    week,
    debugLocalString: fmtShiftedAsLocal(shiftedMs),
  };
}
