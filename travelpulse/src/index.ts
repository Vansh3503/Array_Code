import tripJson from "../trip.json";
import { ASSETS } from "./assets.gen";
import type { EnrichedPing, Env, TrackerState, TravelEvent, TripConfig } from "./types";
import { validatePing, sha256Hex } from "./validate";
import { placesContaining, flagEmoji, shortCountryName } from "./geo";
import { detect } from "./detect";
import { composeMessage, nextDestination } from "./message";
import { fetchWeather, reverseGeocode, weatherText } from "./enrich";
import { parseRecipients, sendWhatsApp, verifyMetaSignature, waMode, type WaMode } from "./whatsapp";
import {
  claimEvent,
  getState,
  insertEvent,
  insertPing,
  messagesInLastHour,
  nonceExists,
  setKv,
  trackingEnabled,
} from "./db";

const cfg = tripJson as unknown as TripConfig;

// ---------- helpers ----------

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return req.headers.get("X-Device-Token") ?? req.headers.get("X-Admin-Token");
}

async function tokenMatches(given: string | null, expected: string | undefined): Promise<boolean> {
  if (!given || !expected || expected.length < 16) return false;
  return safeEqual(given, expected);
}

function viewTokens(env: Env): string[] {
  return (env.VIEW_TOKENS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 16);
}

async function isViewToken(env: Env, t: string | null): Promise<boolean> {
  if (!t) return false;
  for (const v of viewTokens(env)) if (await safeEqual(t, v)) return true;
  return false;
}

function liveUrl(env: Env): string {
  const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  const t = viewTokens(env)[0];
  return t ? `${base}/v/${t}` : base;
}

async function readJson(req: Request): Promise<unknown> {
  const raw = await req.text();
  if (raw.length > 8192) throw new Error("body too large");
  return raw ? JSON.parse(raw) : {};
}

// ---------- WhatsApp fan-out ----------

interface Delivery {
  label: string;
  status: string;
  error?: string;
}

async function deliver(
  env: Env,
  pingId: number | null,
  text: string,
  params: string[],
  isEmergency: boolean,
  now: number,
): Promise<Delivery[]> {
  const mode = waMode(env);
  const recipients = parseRecipients(env.RECIPIENTS);
  if (recipients.length === 0) return [{ label: "(none)", status: "failed", error: "RECIPIENTS secret not configured" }];

  // Individual messages, sent in parallel.
  return Promise.all(
    recipients.map(async (r) => {
      const res = await sendWhatsApp(env, mode, r.phone, text, params);
      const status = mode === "dry_run" ? "dry_run" : res.ok ? "sent" : res.retryable ? "retry" : "failed";
      await env.DB.prepare(
        `INSERT INTO outbox (ping_id, recipient_label, body, params, mode, status, wamid, error, attempts, is_emergency, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`,
      )
        .bind(pingId, r.label, text, JSON.stringify(params), mode, status, res.wamid ?? null, res.error ?? null, isEmergency ? 1 : 0, now, now)
        .run();
      return { label: r.label, status, error: res.error };
    }),
  );
}

// ---------- /api/ping ----------

async function handlePing(req: Request, env: Env): Promise<Response> {
  if (!(await tokenMatches(bearer(req), env.DEVICE_TOKEN))) return json({ ok: false, error: "unauthorized" }, 401);

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const now = Date.now();
  const v = await validatePing(body, now, env.ALLOW_SIMULATED_TIME === "true");
  if (!v.ok) return json({ ok: false, error: v.error, summary: `❌ Rejected: ${v.error}` }, 422);
  const ping = v.ping;

  if (!(await trackingEnabled(env.DB)) && ping.trigger !== "emergency") {
    return json({ ok: true, accepted: false, summary: "⏸️ Tracking is paused. Nothing was recorded." });
  }
  if (await nonceExists(env.DB, ping.nonce)) {
    return json({ ok: false, error: "duplicate submission", summary: "Duplicate ignored." }, 409);
  }

  // Enrichment: geofences, timezone + weather, city/country.
  const places = placesContaining(cfg.places, ping.lat, ping.lon);
  const specificWithCity = places.find((p) => p.city);
  const [weather, geo] = await Promise.all([
    fetchWeather(ping.lat, ping.lon),
    ping.city && ping.country
      ? Promise.resolve(null)
      : specificWithCity
        ? Promise.resolve({ city: specificWithCity.city!, country: specificWithCity.country ?? null, countryCode: specificWithCity.countryCode ?? null })
        : reverseGeocode(env, ping.lat, ping.lon),
  ]);
  const enriched: EnrichedPing = {
    ...ping,
    city: ping.city ?? geo?.city ?? null,
    country: ping.country ?? geo?.country ?? null,
    countryCode: ping.countryCode ?? geo?.countryCode ?? places.find((p) => p.countryCode)?.countryCode ?? null,
    timezone: places.find((p) => p.tz)?.tz ?? weather.timezone,
    tempC: weather.tempC,
    weatherCode: weather.weatherCode,
    placeIds: places.map((p) => p.id),
  };

  const state = await getState(env.DB);
  const result = detect(cfg, state, enriched);

  const pingId = await insertPing(env.DB, enriched, now, result.suspect);
  if (pingId === null) return json({ ok: false, error: "duplicate submission", summary: "Duplicate ignored." }, 409);
  await setKv(env.DB, "tracker", result.next);

  // Claim each candidate event atomically (persistent dedupe + cooldown).
  const claimed: TravelEvent[] = [];
  for (const e of result.events) {
    if (await claimEvent(env.DB, e.dedupeKey, now, cfg.rules.cooldownMinutes[e.type] ?? 60)) claimed.push(e);
  }

  let deliveries: Delivery[] = [];
  let skipped: string | null = null;
  if (claimed.length) {
    const msg = composeMessage(cfg, enriched, claimed, result.next, liveUrl(env));
    for (const { event, headline } of msg.shown) await insertEvent(env.DB, pingId, event, headline, now);
    const onlyMinor = claimed.every((e) => e.type === "significant_move");
    if (!msg.isEmergency && (await messagesInLastHour(env.DB, now)) >= cfg.rules.maxMessagesPerHour) {
      skipped = "hourly message limit reached";
    } else if (onlyMinor && result.suspect) {
      skipped = "suspect location";
    } else {
      deliveries = await deliver(env, pingId, msg.text, msg.params, msg.isEmergency, now);
    }
  }

  const sentOk = deliveries.filter((d) => d.status === "sent" || d.status === "dry_run").length;
  const summary = claimed.length
    ? skipped
      ? `📍 Logged. ${claimed.map((e) => e.type).join(", ")} (not sent: ${skipped})`
      : `📍 Logged. ${claimed.map((e) => e.type).join(", ")} → WhatsApp ${sentOk}/${deliveries.length}${waMode(env) === "dry_run" ? " (dry run)" : ""}`
    : `📍 Location logged${result.suspect ? " (ignored: implausible jump)" : result.stale ? " (older than last update)" : ""}. No notification needed.`;

  return json({
    ok: true,
    accepted: true,
    ping_id: pingId,
    events: claimed.map((e) => e.type),
    suppressed: result.events.filter((e) => !claimed.includes(e)).map((e) => e.type),
    deliveries,
    summary,
  });
}

// ---------- /api/status (dashboard) ----------

interface PingRow {
  device_ts: number;
  tz_offset_min: number | null;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  battery: number | null;
  trigger: string;
  city: string | null;
  country: string | null;
  country_code: string | null;
  place_ids: string;
  timezone: string | null;
  temp_c: number | null;
  weather_code: number | null;
  received_at: number;
}

async function handleStatus(env: Env): Promise<Response> {
  const [last, events, state, enabled] = await Promise.all([
    env.DB.prepare("SELECT * FROM pings WHERE suspect = 0 ORDER BY device_ts DESC LIMIT 1").first<PingRow>(),
    env.DB.prepare(
      "SELECT e.type, e.headline, p.device_ts AS created_at FROM events e JOIN pings p ON p.id = e.ping_id ORDER BY p.device_ts DESC, e.id ASC LIMIT 25",
    ).all<{
      type: string;
      headline: string;
      created_at: number;
    }>(),
    getState(env.DB),
    trackingEnabled(env.DB),
  ]);

  const placeById = new Map(cfg.places.map((p) => [p.id, p]));
  let lastOut = null;
  if (last) {
    const ids = JSON.parse(last.place_ids) as string[];
    const place = ids.map((id) => placeById.get(id)).find(Boolean) ?? null;
    const cc = last.country_code ?? place?.countryCode ?? (last.city ? null : state.countryCode);
    lastOut = {
      lat: last.lat,
      lon: last.lon,
      accuracy_m: last.accuracy_m,
      place: place?.name ?? null,
      // Fall back to the last confirmed city only for labelling; coordinates stay exact.
      city: place?.city ?? last.city ?? state.city,
      country: shortCountryName(cc, last.country ?? place?.country ?? null),
      flag: flagEmoji(cc),
      battery: last.battery,
      timezone: place?.tz ?? last.timezone,
      tz_offset_min: last.tz_offset_min,
      temp_c: last.temp_c,
      weather: weatherText(last.weather_code),
      confirmed_at: last.device_ts,
      trigger: last.trigger,
    };
  }

  return json({
    traveler: cfg.traveler,
    tracking_enabled: enabled,
    server_time: Date.now(),
    home_timezone: cfg.homeTimezone,
    home_label: cfg.homeLabel,
    last: lastOut,
    journey: journeyView(state),
    next_destination: nextDestination(cfg, state.journeyIndex),
    events: (events.results ?? []).map((e) => ({ type: e.type, headline: e.headline, at: e.created_at })),
  });
}

function journeyView(state: TrackerState) {
  return cfg.itinerary.map((s, i) => {
    const reachedAt = state.reached[i];
    let status: string;
    if (i === state.journeyIndex) status = "current";
    else if (reachedAt !== undefined) status = "reached";
    else if (i < state.journeyIndex) status = "not_confirmed";
    else status = "upcoming";
    return { label: s.label, scheduled: s.scheduled ?? null, status, confirmed_at: reachedAt ?? null };
  });
}

// ---------- admin ----------

async function handleAdmin(req: Request, env: Env, path: string): Promise<Response> {
  if (!(await tokenMatches(bearer(req), env.ADMIN_TOKEN))) return json({ ok: false, error: "unauthorized" }, 401);
  const now = Date.now();

  if (path === "/api/admin/health" && req.method === "GET") {
    const outbox = await env.DB.prepare(
      "SELECT id, ping_id, recipient_label, mode, status, error, attempts, created_at FROM outbox ORDER BY id DESC LIMIT 20",
    ).all();
    const lastPing = await env.DB.prepare("SELECT device_ts, trigger, battery FROM pings ORDER BY id DESC LIMIT 1").first();
    return json({
      ok: true,
      tracking_enabled: await trackingEnabled(env.DB),
      whatsapp_mode: waMode(env),
      configured: {
        DEVICE_TOKEN: !!env.DEVICE_TOKEN,
        VIEW_TOKENS: viewTokens(env).length,
        RECIPIENTS: parseRecipients(env.RECIPIENTS).map((r) => `${r.label} (…${r.phone.slice(-3)})`),
        WHATSAPP_TOKEN: !!env.WHATSAPP_TOKEN,
        WHATSAPP_PHONE_NUMBER_ID: !!env.WHATSAPP_PHONE_NUMBER_ID,
        WHATSAPP_APP_SECRET: !!env.WHATSAPP_APP_SECRET,
        template: env.WHATSAPP_TEMPLATE_NAME,
        PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
      },
      last_ping: lastPing,
      outbox: outbox.results,
    });
  }

  if (path === "/api/admin/tracking" && req.method === "POST") {
    const b = (await readJson(req)) as { enabled?: boolean };
    if (typeof b.enabled !== "boolean") return json({ ok: false, error: "enabled must be boolean" }, 400);
    await setKv(env.DB, "tracking_enabled", b.enabled);
    return json({ ok: true, tracking_enabled: b.enabled });
  }

  if (path === "/api/admin/test-message" && req.method === "POST") {
    const headline = `[TEST] TravelPulse is set up. You will receive ${cfg.traveler}'s travel updates here automatically.`;
    const params = [headline, "Setup test", "—", "—", "—", "—", cfg.itinerary[0]?.label ?? "—", "—", liveUrl(env)];
    const text = `✈️ Travel Update\n\n${headline}\n\nLive tracking: ${liveUrl(env)}`;
    const deliveries = await deliver(env, null, text, params, false, now);
    return json({ ok: true, mode: waMode(env), deliveries });
  }

  if (path === "/api/admin/reset" && req.method === "POST") {
    const b = (await readJson(req)) as { confirm?: string };
    if (b.confirm !== "RESET") return json({ ok: false, error: 'send {"confirm":"RESET"}' }, 400);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pings"),
      env.DB.prepare("DELETE FROM events"),
      env.DB.prepare("DELETE FROM event_cooldowns"),
      env.DB.prepare("DELETE FROM outbox"),
      env.DB.prepare("DELETE FROM kv_state WHERE key = 'tracker'"),
    ]);
    return json({ ok: true, reset: true });
  }

  return json({ ok: false, error: "not found" }, 404);
}

// ---------- WhatsApp status webhook (delivery receipts only; inbound messages are ignored) ----------

const STATUS_RANK: Record<string, number> = { retry: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.WHATSAPP_APP_SECRET || !env.WHATSAPP_VERIFY_TOKEN) return new Response("not found", { status: 404 });
  const url = new URL(req.url);
  if (req.method === "GET") {
    const ok =
      url.searchParams.get("hub.mode") === "subscribe" &&
      (await safeEqual(url.searchParams.get("hub.verify_token") ?? "", env.WHATSAPP_VERIFY_TOKEN));
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "") : new Response("forbidden", { status: 403 });
  }
  const raw = await req.text();
  if (!(await verifyMetaSignature(env.WHATSAPP_APP_SECRET, raw, req.headers.get("X-Hub-Signature-256")))) {
    return new Response("bad signature", { status: 401 });
  }
  type Status = { id: string; status: string; errors?: { code?: number; title?: string; message?: string }[] };
  const payload = JSON.parse(raw) as { entry?: { changes?: { value?: { statuses?: Status[] } }[] }[] };
  for (const entry of payload.entry ?? []) {
    for (const ch of entry.changes ?? []) {
      for (const s of ch.value?.statuses ?? []) {
        const row = await env.DB.prepare("SELECT id, status FROM outbox WHERE wamid = ?").bind(s.id).first<{ id: number; status: string }>();
        if (!row || (STATUS_RANK[s.status] ?? 0) <= (STATUS_RANK[row.status] ?? 0)) continue;
        const err = s.errors?.map((e) => `${e.code} ${e.title ?? e.message ?? ""}`).join("; ") ?? null;
        await env.DB.prepare("UPDATE outbox SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ?")
          .bind(s.status, err, Date.now(), row.id)
          .run();
      }
    }
  }
  return new Response("ok");
}

// ---------- cron: retry transient WhatsApp failures ----------

async function retryFailed(env: Env): Promise<void> {
  const now = Date.now();
  const rows = await env.DB.prepare(
    "SELECT id, recipient_label, body, params, mode, attempts FROM outbox WHERE status = 'retry' AND attempts < 4 AND created_at > ? LIMIT 20",
  )
    .bind(now - 2 * 3600000)
    .all<{ id: number; recipient_label: string; body: string; params: string; mode: string; attempts: number }>();
  const recipients = parseRecipients(env.RECIPIENTS);
  for (const r of rows.results ?? []) {
    const rcpt = recipients.find((x) => x.label === r.recipient_label);
    if (!rcpt) continue;
    const res = await sendWhatsApp(env, r.mode as WaMode, rcpt.phone, r.body, JSON.parse(r.params));
    const status = res.ok ? "sent" : res.retryable && r.attempts + 1 < 4 ? "retry" : "failed";
    await env.DB.prepare("UPDATE outbox SET status = ?, wamid = COALESCE(?, wamid), error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?")
      .bind(status, res.wamid ?? null, res.error ?? null, now, r.id)
      .run();
  }
  // Give up on anything older than 2h: a stale travel update is worse than none.
  await env.DB.prepare("UPDATE outbox SET status = 'failed', error = COALESCE(error, '') || ' (expired)' WHERE status = 'retry' AND created_at <= ?")
    .bind(now - 2 * 3600000)
    .run();
}

function serveAsset(path: string, headers: Record<string, string>): Response {
  const a = ASSETS[path];
  if (!a) return new Response("Not found", { status: 404 });
  const bytes = Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "Content-Type": a.type, ...headers } });
}

// ---------- router ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/api/ping" && req.method === "POST") return await handlePing(req, env);

      if (path === "/api/status" && req.method === "GET") {
        const t = req.headers.get("X-View-Token") ?? url.searchParams.get("t");
        if (!(await isViewToken(env, t))) return json({ ok: false, error: "link revoked or invalid" }, 401);
        return await handleStatus(env);
      }

      // Phone-side pause/resume using the device token (also available via admin API).
      if (path === "/api/tracking" && req.method === "POST") {
        if (!(await tokenMatches(bearer(req), env.DEVICE_TOKEN))) return json({ ok: false, error: "unauthorized" }, 401);
        const b = (await readJson(req)) as { enabled?: unknown };
        const enabled = b.enabled === true || b.enabled === "true";
        await setKv(env.DB, "tracking_enabled", enabled);
        return json({ ok: true, tracking_enabled: enabled, summary: enabled ? "▶️ Tracking resumed" : "⏸️ Tracking paused" });
      }

      if (path.startsWith("/api/admin/")) return await handleAdmin(req, env, path);
      if (path === "/webhooks/whatsapp") return await handleWebhook(req, env);

      const m = path.match(/^\/v\/([A-Za-z0-9_-]{16,128})\/?$/);
      if (m && req.method === "GET") {
        if (!(await isViewToken(env, m[1]))) {
          return new Response("This tracking link is invalid or has been revoked.", { status: 404, headers: SECURITY_HEADERS });
        }
        return serveAsset("/index.html", SECURITY_HEADERS);
      }

      // Public static assets (no data inside them).
      if (req.method === "GET" && /^\/(app\.js|style\.css|vendor\/.+)$/.test(path) && ASSETS[path]) {
        return serveAsset(path, { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" });
      }

      return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
    } catch (err) {
      console.error("unhandled", (err as Error).stack);
      return json({ ok: false, error: "internal error" }, 500);
    }
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(retryFailed(env));
  },
} satisfies ExportedHandler<Env>;
