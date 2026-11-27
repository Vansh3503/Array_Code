import { describe, expect, it } from "vitest";
import trip from "../trip.json";
import type { EnrichedPing, TrackerState, TripConfig } from "../src/types";
import { detect, initialState } from "../src/detect";
import { composeMessage, templateSafe } from "../src/message";
import { placesContaining, flagEmoji } from "../src/geo";
import { parseDeviceTimestamp, formatTimes } from "../src/time";
import { validatePing } from "../src/validate";
import { parseRecipients, verifyMetaSignature } from "../src/whatsapp";

const cfg = trip as unknown as TripConfig;
const H = 3600000;
const T0 = Date.UTC(2026, 10, 29, 2, 0); // 29 Nov 2026 07:30 IST

function at(id: string) {
  const p = cfg.places.find((x) => x.id === id)!;
  return { lat: p.lat, lon: p.lon };
}

function ping(over: Partial<EnrichedPing> & { lat: number; lon: number; deviceTs: number }): EnrichedPing {
  const places = placesContaining(cfg.places, over.lat, over.lon);
  return {
    nonce: Math.random().toString(),
    tzOffsetMin: null,
    accuracyM: null,
    battery: 80,
    trigger: "other",
    city: places.find((p) => p.city)?.city ?? null,
    country: places[0]?.country ?? null,
    countryCode: places[0]?.countryCode ?? null,
    note: null,
    isTest: false,
    timezone: places[0]?.tz ?? null,
    tempC: 20,
    weatherCode: 0,
    placeIds: places.map((p) => p.id),
    ...over,
  };
}

function run(state: TrackerState, p: EnrichedPing) {
  return detect(cfg, state, p);
}

describe("validation", () => {
  const now = Date.parse("2026-11-29T10:00:00Z");
  it("accepts a typical Shortcut payload with comma decimals and +HHMM offset", async () => {
    const r = await validatePing({ lat: "23,0772", lon: 72.6347, ts: "2026-11-29T15:28:00+0530", battery: "78", trigger: "Arrive Airport" }, now, false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ping.lat).toBeCloseTo(23.0772);
      expect(r.ping.tzOffsetMin).toBe(330);
      expect(r.ping.trigger).toBe("arrive_airport");
      expect(r.ping.battery).toBe(78);
    }
  });
  it("rejects bad coordinates, old and future timestamps", async () => {
    expect((await validatePing({ lat: 91, lon: 0, ts: "2026-11-29T10:00:00Z" }, now, false)).ok).toBe(false);
    expect((await validatePing({ lat: 0, lon: 0, ts: "2026-11-29T10:00:00Z" }, now, false)).ok).toBe(false);
    expect((await validatePing({ lat: 10, lon: 10, ts: "2026-11-29T09:00:00Z" }, now, false)).ok).toBe(false);
    expect((await validatePing({ lat: 10, lon: 10, ts: "2026-11-29T10:30:00Z" }, now, false)).ok).toBe(false);
    expect((await validatePing({ lat: 10, lon: 10, ts: "2026-11-29T10:00:00" }, now, false)).ok).toBe(false); // no offset
  });
  it("derives a deterministic nonce when none is sent (duplicate detection)", async () => {
    const b = { lat: 10, lon: 10, ts: "2026-11-29T10:00:00Z", battery: 50 };
    const a = await validatePing(b, now, false);
    const c = await validatePing(b, now, false);
    expect(a.ok && c.ok && a.ping.nonce === c.ping.nonce).toBe(true);
  });
});

describe("time", () => {
  it("formats local vs India time with day rollover", () => {
    // 15:30 New York on 29 Nov = 20:30 UTC = 02:00 IST on 30 Nov
    const ms = Date.UTC(2026, 10, 29, 20, 30);
    expect(formatTimes(ms, "America/New_York", null, "Asia/Kolkata")).toEqual({ local: "3:30 PM", home: "2:00 AM (next day)" });
    expect(parseDeviceTimestamp("2026-11-29T15:30:00-05:00")?.offsetMin).toBe(-300);
  });
});

describe("geofences", () => {
  it("finds the most specific place first", () => {
    expect(placesContaining(cfg.places, at("dublin_ca").lat, at("dublin_ca").lon).map((p) => p.id)).toEqual(["dublin_ca", "bay_area"]);
    expect(placesContaining(cfg.places, at("hotel_ti").lat, at("hotel_ti").lon).map((p) => p.id)).toEqual(["hotel_ti"]);
    expect(flagEmoji("US")).toBe("🇺🇸");
  });
});

describe("event detection — full outbound journey", () => {
  it("AMD → DOH → JFK → LAS → hotel produces the right events without duplicates", () => {
    let s = initialState();

    // Home in Ahmedabad (not at airport): baseline only.
    let r = run(s, ping({ lat: 23.03, lon: 72.58, deviceTs: T0, city: "Ahmedabad", country: "India", countryCode: "IN" }));
    expect(r.events).toEqual([]);
    s = r.next;

    // Arrive AMD airport.
    r = run(s, ping({ ...at("amd"), deviceTs: T0 + 1 * H, trigger: "arrive_airport" }));
    expect(r.events.map((e) => e.type)).toEqual(["airport_arrival"]);
    expect(r.next.journeyIndex).toBe(0);
    s = r.next;

    // Same airport again (automation fired twice) -> nothing new.
    r = run(s, ping({ ...at("amd"), deviceTs: T0 + 1.2 * H }));
    expect(r.events).toEqual([]);
    s = r.next;

    // Land in Doha 4.5h later (airplane mode off).
    r = run(s, ping({ ...at("doh"), deviceTs: T0 + 6 * H, trigger: "airplane_off" }));
    expect(r.events.map((e) => e.type).sort()).toEqual(["airport_arrival", "new_city", "new_country", "reconnected"].sort());
    expect(r.events.some((e) => e.type === "airport_departure")).toBe(false); // never inferred from a flight
    expect(r.next.journeyIndex).toBe(1);
    const msg = composeMessage(cfg, ping({ ...at("doh"), deviceTs: T0 + 6 * H }), r.events, r.next, "https://x/v/tok");
    expect(msg.text).toContain("Vansh has arrived in Doha, Qatar 🇶🇦");
    expect(msg.text).toContain("Next destination: New York (JFK)");
    expect(msg.text).not.toContain("is now in");
    s = r.next;

    // JFK.
    r = run(s, ping({ ...at("jfk"), deviceTs: T0 + 22 * H, battery: 78 }));
    expect(r.events.map((e) => e.type)).toContain("airport_arrival");
    expect(r.next.journeyIndex).toBe(2);
    s = r.next;

    // LAS.
    r = run(s, ping({ ...at("las"), deviceTs: T0 + 30 * H }));
    expect(r.next.journeyIndex).toBe(3);
    s = r.next;

    // Taxi to Treasure Island: hotel arrival + airport departure (ground evidence).
    r = run(s, ping({ ...at("hotel_ti"), deviceTs: T0 + 31 * H, trigger: "arrive_hotel" }));
    expect(r.events.map((e) => e.type).sort()).toEqual(["airport_departure", "hotel_arrival"]);
    expect(r.next.journeyIndex).toBe(4);
  });

  it("handles the Bay Area / Dublin / SFO return ordering", () => {
    let s: TrackerState = { ...initialState(), journeyIndex: 4, lastTs: T0, reached: { 4: T0 } };
    let r = run(s, ping({ ...at("sfo"), deviceTs: T0 + 48 * H }));
    expect(r.next.journeyIndex).toBe(5); // arrival into Bay Area via SFO
    s = r.next;
    r = run(s, ping({ ...at("dublin_ca"), deviceTs: T0 + 50 * H }));
    expect(r.next.journeyIndex).toBe(6);
    s = r.next;
    r = run(s, ping({ ...at("sfo"), deviceTs: T0 + 100 * H }));
    expect(r.next.journeyIndex).toBe(7); // return departure
    s = r.next;
    for (const [id, idx, h] of [["lhr", 8, 112], ["del", 9, 125], ["amd", 10, 130]] as const) {
      r = run(s, ping({ ...at(id), deviceTs: T0 + h * H }));
      expect(r.next.journeyIndex).toBe(idx);
      s = r.next;
    }
  });
});

describe("event detection — safety rules", () => {
  it("low battery fires once until recharged", () => {
    let s: TrackerState = { ...initialState(), lastTs: T0, lastLat: 36.12, lastLon: -115.17 };
    let r = run(s, ping({ lat: 36.12, lon: -115.17, deviceTs: T0 + 60000, battery: 14 }));
    expect(r.events.map((e) => e.type)).toEqual(["low_battery"]);
    s = r.next;
    r = run(s, ping({ lat: 36.12, lon: -115.17, deviceTs: T0 + 120000, battery: 12 }));
    expect(r.events).toEqual([]);
    s = r.next;
    r = run(s, ping({ lat: 36.12, lon: -115.17, deviceTs: T0 + 180000, battery: 90 }));
    s = r.next;
    r = run(s, ping({ lat: 36.12, lon: -115.17, deviceTs: T0 + 240000, battery: 10 }));
    expect(r.events.map((e) => e.type)).toEqual(["low_battery"]);
  });

  it("ignores implausible jumps and out-of-order pings", () => {
    const s = { ...initialState(), lastTs: T0, lastLat: 23.07, lastLon: 72.63 };
    const jump = run(s, ping({ ...at("jfk"), deviceTs: T0 + 60000 }));
    expect(jump.suspect).toBe(true);
    expect(jump.events).toEqual([]);
    const old = run(s, ping({ ...at("jfk"), deviceTs: T0 - 60000 }));
    expect(old.stale).toBe(true);
    expect(old.events).toEqual([]);
  });

  it("emergency always produces an event, even when stale", () => {
    const s = { ...initialState(), lastTs: T0 };
    const r = run(s, ping({ lat: 10, lon: 10, deviceTs: T0 - 1000, trigger: "emergency" }));
    expect(r.events.map((e) => e.type)).toEqual(["emergency"]);
  });

  it("significant move only when nothing more specific happened", () => {
    const s = { ...initialState(), lastTs: T0, lastLat: 36.12, lastLon: -115.17, notifiedLat: 36.12, notifiedLon: -115.17, city: "Las Vegas", countryCode: "US", cityAnchorLat: 36.12, cityAnchorLon: -115.17 };
    const r = run(s, ping({ lat: 35.0, lon: -114.6, deviceTs: T0 + 3 * H, city: "Las Vegas", countryCode: "US" }));
    expect(r.events.map((e) => e.type)).toEqual(["significant_move"]);
  });
});

describe("whatsapp helpers", () => {
  it("parses recipients and never keeps formatting characters", () => {
    expect(parseRecipients("Mom:+91 98000 00000, Dad:+91-98111-11111")).toEqual([
      { label: "Mom", phone: "919800000000" },
      { label: "Dad", phone: "919811111111" },
    ]);
  });
  it("makes template parameters safe", () => {
    expect(templateSafe("a\nb\t c     d")).toBe("a · b · c d");
    expect(templateSafe("")).toBe("—");
  });
  it("verifies Meta webhook signatures", async () => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("{}")))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await verifyMetaSignature("secret", "{}", `sha256=${sig}`)).toBe(true);
    expect(await verifyMetaSignature("secret", "{} ", `sha256=${sig}`)).toBe(false);
  });
});
