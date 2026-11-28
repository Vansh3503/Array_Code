import type { EnrichedPing, TrackerState, TravelEvent } from "./types";
import { initialState } from "./detect";

export async function getKv<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM kv_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

export async function setKv(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO kv_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
}

export async function getState(db: D1Database): Promise<TrackerState> {
  return { ...initialState(), ...((await getKv<TrackerState>(db, "tracker")) ?? {}) };
}

export async function trackingEnabled(db: D1Database): Promise<boolean> {
  return (await getKv<boolean>(db, "tracking_enabled")) ?? true;
}

/** Returns the new ping id, or null if the nonce was already used (replay / duplicate). */
export async function insertPing(db: D1Database, p: EnrichedPing, now: number, suspect: boolean): Promise<number | null> {
  const r = await db
    .prepare(
      `INSERT INTO pings (nonce, received_at, device_ts, tz_offset_min, lat, lon, accuracy_m, battery, trigger,
         city, country, country_code, place_ids, timezone, temp_c, weather_code, note, suspect, is_test)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(nonce) DO NOTHING RETURNING id`,
    )
    .bind(
      p.nonce,
      now,
      p.deviceTs,
      p.tzOffsetMin,
      p.lat,
      p.lon,
      p.accuracyM,
      p.battery,
      p.trigger,
      p.city,
      p.country,
      p.countryCode,
      JSON.stringify(p.placeIds),
      p.timezone,
      p.tempC,
      p.weatherCode,
      p.note,
      suspect ? 1 : 0,
      p.isTest ? 1 : 0,
    )
    .first<{ id: number }>();
  return r?.id ?? null;
}

export async function nonceExists(db: D1Database, nonce: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM pings WHERE nonce = ?").bind(nonce).first());
}

/**
 * Atomically claim an event key. Succeeds only if the key never fired or its cooldown
 * expired. D1 serialises writes, so two concurrent pings cannot both claim the same key.
 */
export async function claimEvent(db: D1Database, key: string, now: number, cooldownMin: number): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO event_cooldowns(dedupe_key, last_at) VALUES(?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET last_at = excluded.last_at
       WHERE event_cooldowns.last_at < ?`,
    )
    .bind(key, now, now - cooldownMin * 60000)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function insertEvent(db: D1Database, pingId: number, e: TravelEvent, headline: string, now: number) {
  await db
    .prepare("INSERT INTO events (ping_id, type, dedupe_key, created_at, headline, place_id) VALUES (?,?,?,?,?,?)")
    .bind(pingId, e.type, e.dedupeKey, now, headline, e.placeId ?? null)
    .run();
}

export async function messagesInLastHour(db: D1Database, now: number): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(DISTINCT ping_id) AS n FROM outbox WHERE created_at > ? AND status != 'dry_run'")
    .bind(now - 3600000)
    .first<{ n: number }>();
  return r?.n ?? 0;
}
