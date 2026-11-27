#!/usr/bin/env node
/**
 * TravelPulse travel simulation.
 *
 *   Local (historic timestamps, needs ALLOW_SIMULATED_TIME=true in .dev.vars):
 *     DEVICE_TOKEN=... node scripts/simulate.mjs --url http://localhost:8787
 *
 *   Production (real timestamps, messages are prefixed with [TEST]):
 *     DEVICE_TOKEN=... node scripts/simulate.mjs --url https://travelpulse.<you>.workers.dev --live
 *
 * Afterwards wipe the test data:
 *     curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"confirm":"RESET"}' $URL/api/admin/reset
 */
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};

const URL_BASE = (opt("url", process.env.TRAVELPULSE_URL ?? "http://localhost:8787")).replace(/\/$/, "");
const TOKEN = process.env.DEVICE_TOKEN;
const LIVE = flag("live");
const DELAY = Number(opt("delay", LIVE ? "8" : "0.3")) * 1000;
const ONLY_ARRIVALS = flag("arrivals-only");
if (!TOKEN) {
  console.error("Set DEVICE_TOKEN in the environment.");
  process.exit(1);
}

const H = 3600000;
const start = Date.UTC(2026, 10, 29, 1, 30); // 29 Nov 2026, 07:00 IST

// [hoursFromStart, label, payload]
const steps = [
  [0, "Home, Ahmedabad", { lat: 23.0300, lon: 72.5800, trigger: "manual", battery: 100, city: "Ahmedabad", country: "India", note: "Leaving for the airport" }],
  [1.5, "Arrive AMD airport", { lat: 23.0772, lon: 72.6347, trigger: "arrive_airport", battery: 96 }],
  [1.6, "Duplicate AMD automation", { lat: 23.0775, lon: 72.6350, trigger: "wifi", battery: 96 }],
  [7.5, "Land in Doha (airplane mode off)", { lat: 25.2731, lon: 51.6081, trigger: "airplane_off", battery: 81 }],
  [24, "Land at JFK", { lat: 40.6413, lon: -73.7781, trigger: "airplane_off", battery: 78 }],
  [33, "Land at LAS", { lat: 36.0840, lon: -115.1537, trigger: "airplane_off", battery: 64 }],
  [34, "Arrive Treasure Island hotel", { lat: 36.1247, lon: -115.1721, trigger: "arrive_hotel", battery: 55 }],
  [40, "Low battery on the Strip", { lat: 36.1147, lon: -115.1728, trigger: "low_battery", battery: 14 }],
];

function isoWithOffset(ms, offsetMin) {
  const d = new Date(ms + offsetMin * 60000);
  const pad = (n) => String(Math.abs(n)).padStart(2, "0");
  const sign = offsetMin >= 0 ? "+" : "-";
  return `${d.toISOString().slice(0, 19)}${sign}${pad(Math.trunc(offsetMin / 60))}:${pad(offsetMin % 60)}`;
}

const offsets = { 23: 330, 25: 180, 40: -300, 36: -480 }; // by integer latitude

async function send(label, payload, tsMs) {
  const offset = offsets[Math.trunc(payload.lat)] ?? 0;
  const body = {
    ...payload,
    ts: isoWithOffset(tsMs, offset),
    nonce: `sim-${tsMs}-${Math.random().toString(36).slice(2, 8)}`,
    test: LIVE, // production runs are labelled [TEST]
  };
  const res = await fetch(`${URL_BASE}/api/ping`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`${res.status} ${label.padEnd(34)} ${data.summary ?? data.error ?? ""}`);
  return { res, data, body };
}

let failures = 0;
const sel = ONLY_ARRIVALS ? steps.filter(([, l]) => /Arrive AMD|Doha|JFK|LAS/.test(l)) : steps;
let last;
for (const [h, label, payload] of sel) {
  const ts = LIVE ? Date.now() : start + h * H;
  last = await send(label, payload, ts);
  if (!last.res.ok) failures++;
  await new Promise((r) => setTimeout(r, DELAY));
}

// Replay protection check: resend the exact last request.
const replay = await fetch(`${URL_BASE}/api/ping`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(last.body),
});
console.log(`${replay.status} ${"Replay of last request".padEnd(34)} ${replay.status === 409 ? "rejected ✔" : "NOT rejected ✘"}`);
if (replay.status !== 409) failures++;

// Bad token check.
const bad = await fetch(`${URL_BASE}/api/ping`, { method: "POST", headers: { Authorization: "Bearer wrong-token-wrong-token" }, body: "{}" });
console.log(`${bad.status} ${"Wrong device token".padEnd(34)} ${bad.status === 401 ? "rejected ✔" : "NOT rejected ✘"}`);
if (bad.status !== 401) failures++;

console.log(failures ? `\n${failures} problem(s).` : "\nSimulation finished OK.");
process.exit(failures ? 1 : 0);
