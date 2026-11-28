import type { EnrichedPing, Place, TrackerState, TravelEvent, TripConfig } from "./types";
import { distanceM } from "./geo";

export function initialState(): TrackerState {
  return {
    lastTs: null,
    lastLat: null,
    lastLon: null,
    inside: [],
    city: null,
    countryCode: null,
    cityAnchorLat: null,
    cityAnchorLon: null,
    notifiedLat: null,
    notifiedLon: null,
    lowBatteryArmed: true,
    journeyIndex: -1,
    reached: {},
  };
}

export interface DetectResult {
  events: TravelEvent[];
  next: TrackerState;
  /** Ping is older than the last processed ping (out-of-order delivery). */
  stale: boolean;
  /** Implausible jump (GPS glitch); location events suppressed. */
  suspect: boolean;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Advance to the nearest later itinerary stop matching a place we are inside that the
 * current stop does not already explain (e.g. Dublin is inside the Bay Area, but is its own stop).
 * Progress never moves backwards.
 */
export function advanceJourney(cfg: TripConfig, current: number, inside: string[]): number {
  const explained = current >= 0 ? cfg.itinerary[current].match : [];
  const unexplained = inside.filter((id) => !explained.includes(id));
  for (let i = current + 1; i < cfg.itinerary.length; i++) {
    if (cfg.itinerary[i].match.some((id) => unexplained.includes(id))) return i;
  }
  return current;
}

/**
 * Pure event detection. Given previous persistent state and a new ping, return the
 * candidate events and the next state. Cooldown/duplicate claiming happens later in D1.
 */
export function detect(cfg: TripConfig, state: TrackerState, ping: EnrichedPing): DetectResult {
  const rules = cfg.rules;
  const placeById = new Map<string, Place>(cfg.places.map((p) => [p.id, p]));
  const events: TravelEvent[] = [];

  // Trigger-driven events are always honoured, even for stale/suspect pings.
  if (ping.trigger === "emergency") events.push({ type: "emergency", dedupeKey: "emergency" });
  if (ping.trigger === "manual") events.push({ type: "manual_checkin", dedupeKey: "manual" });

  const next: TrackerState = { ...state, inside: [...state.inside], reached: { ...state.reached } };

  // Low battery with hysteresis: fire once, re-arm only after charging above rearm level.
  if (ping.battery !== null) {
    const low =
      ping.battery < rules.lowBatteryPercent ||
      (ping.trigger === "low_battery" && ping.battery <= rules.lowBatteryPercent);
    if (low && state.lowBatteryArmed) {
      events.push({ type: "low_battery", dedupeKey: "battery_low", data: { battery: ping.battery } });
      next.lowBatteryArmed = false;
    } else if (ping.battery >= rules.lowBatteryRearmPercent) {
      next.lowBatteryArmed = true;
    }
  }

  const stale = state.lastTs !== null && ping.deviceTs < state.lastTs;
  if (stale) return { events, next: { ...state, lowBatteryArmed: next.lowBatteryArmed }, stale, suspect: false };

  // Test pings (simulation against production) skip the speed check so a whole
  // itinerary can be replayed in a few minutes.
  let suspect = false;
  if (!ping.isTest && state.lastTs !== null && state.lastLat !== null && state.lastLon !== null) {
    const km = distanceM(state.lastLat, state.lastLon, ping.lat, ping.lon) / 1000;
    const hours = Math.max((ping.deviceTs - state.lastTs) / 3600000, 1 / 60);
    suspect = km > 50 && km / hours > rules.maxPlausibleSpeedKmh;
  }

  // Connectivity gap (detected even on suspect pings: the phone *is* reporting again).
  if (state.lastTs !== null && ping.deviceTs - state.lastTs > rules.gapMinutes * 60000) {
    events.push({
      type: "reconnected",
      dedupeKey: `reconnect:${state.lastTs}`,
      data: { gapMs: ping.deviceTs - state.lastTs },
    });
  }

  if (suspect) return { events, next: { ...next, lastTs: state.lastTs }, stale, suspect };

  next.lastTs = ping.deviceTs;
  next.lastLat = ping.lat;
  next.lastLon = ping.lon;

  const geofenceOk = ping.accuracyM === null || ping.accuracyM <= rules.maxAccuracyForGeofenceM;
  const inside = geofenceOk ? ping.placeIds : state.inside;
  const locationEvents: TravelEvent[] = [];

  // Geofence entries.
  for (const id of inside) {
    if (state.inside.includes(id)) continue;
    const p = placeById.get(id);
    if (!p) continue;
    const type = p.type === "airport" ? "airport_arrival" : p.type === "hotel" ? "hotel_arrival" : "destination_arrival";
    locationEvents.push({ type, dedupeKey: `arrive:${id}`, placeId: id });
  }

  // Geofence exits: only airports, and only when the evidence is a ground-level ping
  // reasonably near the airport. A ping far away means a flight; we never infer take-off.
  for (const id of state.inside) {
    if (inside.includes(id)) continue;
    const p = placeById.get(id);
    if (!p || p.type !== "airport") continue;
    const km = distanceM(p.lat, p.lon, ping.lat, ping.lon) / 1000;
    if (km <= 150) locationEvents.push({ type: "airport_departure", dedupeKey: `depart:${id}`, placeId: id });
  }
  next.inside = [...inside];

  // Country change (first ever ping only sets the baseline).
  const cc = ping.countryCode;
  if (cc) {
    if (state.countryCode && state.countryCode !== cc) {
      locationEvents.push({ type: "new_country", dedupeKey: `country:${cc}` });
    }
    next.countryCode = cc;
  }

  // City change, debounced by distance so suburb-name flapping does not spam.
  const specific = inside.map((id) => placeById.get(id)).find((p) => p?.city);
  const city = specific?.city ?? ping.city;
  if (city) {
    const farEnough =
      state.cityAnchorLat === null ||
      state.cityAnchorLon === null ||
      distanceM(state.cityAnchorLat, state.cityAnchorLon, ping.lat, ping.lon) / 1000 >= rules.newCityMinKm;
    if (!state.city) {
      next.city = city;
      next.cityAnchorLat = ping.lat;
      next.cityAnchorLon = ping.lon;
    } else if (norm(city) !== norm(state.city) && farEnough) {
      locationEvents.push({ type: "new_city", dedupeKey: `city:${norm(city)}`, data: { city } });
      next.city = city;
      next.cityAnchorLat = ping.lat;
      next.cityAnchorLon = ping.lon;
    }
  }

  // Significant move, only when nothing more specific explains it.
  if (state.notifiedLat !== null && state.notifiedLon !== null) {
    const km = distanceM(state.notifiedLat, state.notifiedLon, ping.lat, ping.lon) / 1000;
    if (locationEvents.length === 0 && km >= rules.significantMoveKm) {
      locationEvents.push({ type: "significant_move", dedupeKey: "move", data: { km: Math.round(km) } });
    }
  }

  events.push(...locationEvents);
  if (state.notifiedLat === null || locationEvents.length > 0 || events.some((e) => e.type === "reconnected")) {
    next.notifiedLat = ping.lat;
    next.notifiedLon = ping.lon;
  }

  // Journey progress is driven only by confirmed geofence presence.
  const j = advanceJourney(cfg, state.journeyIndex, inside);
  if (j !== state.journeyIndex || (j >= 0 && next.reached[j] === undefined)) {
    next.journeyIndex = j;
    if (j >= 0 && next.reached[j] === undefined) next.reached[j] = ping.deviceTs;
  }

  return { events, next, stale, suspect };
}
