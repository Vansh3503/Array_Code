import type { Ping, Trigger } from "./types";
import { parseDeviceTimestamp } from "./time";
import { countryCodeFromName } from "./geo";

const TRIGGERS: Trigger[] = [
  "manual",
  "emergency",
  "arrive_airport",
  "leave_airport",
  "arrive_hotel",
  "airplane_off",
  "wifi",
  "low_battery",
  "scheduled",
  "other",
];

export const MAX_PAST_MS = 15 * 60 * 1000; // ping must be at most 15 min old
export const MAX_FUTURE_MS = 5 * 60 * 1000; // and at most 5 min in the future

export type ValidationResult = { ok: true; ping: Ping } | { ok: false; error: string };

/** Accepts numbers or strings (including "37,7749" from comma-decimal locales). */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim().replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  // strip control characters, collapse whitespace
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function normaliseTrigger(v: unknown): Trigger {
  const t = (text(v, 40) ?? "manual").toLowerCase().replace(/[\s-]+/g, "_");
  return (TRIGGERS as string[]).includes(t) ? (t as Trigger) : "other";
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function validatePing(
  body: unknown,
  nowMs: number,
  allowSimulatedTime: boolean,
): Promise<ValidationResult> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;

  const lat = num(b.lat ?? b.latitude);
  const lon = num(b.lon ?? b.lng ?? b.longitude);
  if (lat === null || lon === null) return { ok: false, error: "lat and lon are required numbers" };
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { ok: false, error: "coordinates out of range" };
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return { ok: false, error: "null-island coordinates rejected" };

  // ts is optional: Shortcuts can omit it and the server receive time is used instead.
  const rawTs = b.ts ?? b.timestamp;
  const tsProvided = rawTs !== undefined && rawTs !== null && rawTs !== "";
  const ts = tsProvided ? parseDeviceTimestamp(rawTs) : { ms: nowMs, offsetMin: null };
  if (!ts) return { ok: false, error: "ts must be ISO 8601 with timezone offset (e.g. 2026-11-29T15:30:00+05:30)" };
  if (tsProvided && !allowSimulatedTime) {
    if (ts.ms < nowMs - MAX_PAST_MS) return { ok: false, error: "timestamp too old (possible replay)" };
    if (ts.ms > nowMs + MAX_FUTURE_MS) return { ok: false, error: "timestamp is in the future" };
  }

  let battery = num(b.battery);
  if (battery !== null) {
    if (battery > 0 && battery <= 1 && !Number.isInteger(battery)) battery *= 100; // 0.78 -> 78
    if (battery < 0 || battery > 100) return { ok: false, error: "battery must be 0-100" };
    battery = Math.round(battery);
  }

  let accuracyM = num(b.accuracy ?? b.accuracy_m);
  if (accuracyM !== null && (accuracyM <= 0 || accuracyM > 100000)) accuracyM = null;

  const trigger = normaliseTrigger(b.trigger);
  const city = text(b.city, 80);
  const country = text(b.country, 80);
  let countryCode = text(b.country_code ?? b.countryCode, 2);
  countryCode = countryCode && /^[A-Za-z]{2}$/.test(countryCode) ? countryCode.toUpperCase() : countryCodeFromName(country);

  const rawNonce = text(b.nonce ?? b.id, 100);
  const nonce = rawNonce
    ? `n:${rawNonce}`
    : // Without ts, identical submissions within the same minute are treated as duplicates.
      `h:${await sha256Hex(`${tsProvided ? ts.ms : Math.floor(nowMs / 60000)}|${lat.toFixed(6)}|${lon.toFixed(6)}|${trigger}|${battery}`)}`;

  return {
    ok: true,
    ping: {
      nonce,
      deviceTs: ts.ms,
      tzOffsetMin: ts.offsetMin,
      lat,
      lon,
      accuracyM,
      battery,
      trigger,
      city,
      country,
      countryCode,
      note: text(b.note, 200),
      isTest: b.test === true || b.test === "true" || b.test === 1,
    },
  };
}
