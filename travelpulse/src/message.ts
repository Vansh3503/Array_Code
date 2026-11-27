import type { EnrichedPing, EventType, Place, TrackerState, TravelEvent, TripConfig } from "./types";
import { flagEmoji, mapsLink, shortCountryName } from "./geo";
import { formatDuration, formatTimes } from "./time";

export const EVENT_PRIORITY: EventType[] = [
  "emergency",
  "airport_arrival",
  "hotel_arrival",
  "destination_arrival",
  "new_country",
  "new_city",
  "reconnected",
  "airport_departure",
  "significant_move",
  "manual_checkin",
  "low_battery",
];

export interface ComposedMessage {
  title: string;
  headline: string; // single line (template-safe)
  text: string; // full free-form text body
  params: string[]; // template body parameters {{1}}..{{9}}
  isEmergency: boolean;
  shown: { event: TravelEvent; headline: string }[]; // events that made it into the message
}

export function nextDestination(cfg: TripConfig, journeyIndex: number): string {
  const nxt = cfg.itinerary[journeyIndex + 1];
  if (nxt) return nxt.label;
  return journeyIndex >= cfg.itinerary.length - 1 ? "Home 🏠 (trip complete)" : "—";
}

/** Template parameters may not contain newlines, tabs or 4+ consecutive spaces. */
export function templateSafe(s: string, max = 400): string {
  const clean = s.replace(/[\r\n\t]+/g, " · ").replace(/ {2,}/g, " ").trim();
  return (clean || "—").slice(0, max);
}

export function headlineFor(
  e: TravelEvent,
  ctx: { cfg: TripConfig; ping: EnrichedPing; placeById: Map<string, Place>; cityChanged: boolean },
): string {
  const T = ctx.cfg.traveler;
  const p = e.placeId ? ctx.placeById.get(e.placeId) : undefined;
  const cc = p?.countryCode ?? ctx.ping.countryCode;
  const country = shortCountryName(cc, p?.country ?? ctx.ping.country);
  const flag = flagEmoji(cc);
  const where = (city: string | null | undefined) =>
    [city, country].filter(Boolean).join(", ") + (flag ? ` ${flag}` : "");

  switch (e.type) {
    case "emergency":
      return `🚨 EMERGENCY: ${T} has sent an emergency alert. Please try to call right away.`;
    case "airport_arrival":
      return ctx.cityChanged && p?.city
        ? `${T} has arrived in ${where(p.city)}`
        : `${T} has reached ${p?.name ?? "the airport"}${flag ? ` ${flag}` : ""}`;
    case "hotel_arrival":
      return `🏨 ${T} has reached ${p?.name ?? "the hotel"}`;
    case "destination_arrival":
      return `${T} has arrived in ${p?.name ?? "a new destination"}${flag ? ` ${flag}` : ""}`;
    case "new_country":
      return `${T} is now in ${country ?? "a new country"}${flag ? ` ${flag}` : ""}`;
    case "new_city":
      return `${T} is now in ${where(String(e.data?.city ?? ctx.ping.city ?? "a new city"))}`;
    case "reconnected":
      return `📶 ${T}'s phone is reporting again after ${formatDuration(Number(e.data?.gapMs ?? 0))} without updates`;
    case "airport_departure":
      return `${T} has left ${p?.name ?? "the airport"}`;
    case "significant_move":
      return `${T} has moved about ${e.data?.km ?? "?"} km since the last update`;
    case "manual_checkin":
      return `✅ ${T} checked in`;
    case "low_battery":
      return `🪫 ${T}'s phone battery is low (${e.data?.battery ?? "?"}%). Updates may pause until it is charged`;
  }
}

export function composeMessage(
  cfg: TripConfig,
  ping: EnrichedPing,
  events: TravelEvent[],
  state: TrackerState,
  liveUrl: string,
): ComposedMessage {
  const placeById = new Map(cfg.places.map((p) => [p.id, p]));
  const sorted = [...events].sort((a, b) => EVENT_PRIORITY.indexOf(a.type) - EVENT_PRIORITY.indexOf(b.type));
  const types = new Set(sorted.map((e) => e.type));
  const cityChanged = types.has("new_city") || types.has("new_country") || types.has("reconnected");
  const arrivalNamesCity = sorted.some((e) => e.type === "airport_arrival" && cityChanged);

  const shown: { event: TravelEvent; headline: string }[] = [];
  for (const e of sorted) {
    // An arrival headline already names the city and country.
    if (arrivalNamesCity && (e.type === "new_city" || e.type === "new_country")) continue;
    if (types.has("new_city") && e.type === "new_country") continue;
    shown.push({ event: e, headline: headlineFor(e, { cfg, ping, placeById, cityChanged }) });
  }
  const lines = shown.map((x) => x.headline);
  if (ping.note) lines.push(`💬 "${ping.note}"`);
  if (ping.isTest && lines.length) lines[0] = `[TEST] ${lines[0]}`;

  const specific = ping.placeIds.map((id) => placeById.get(id)).find(Boolean);
  const cc = specific?.countryCode ?? ping.countryCode;
  const country = shortCountryName(cc, specific?.country ?? ping.country);
  const location =
    specific?.name ??
    ([ping.city, country].filter(Boolean).join(", ") || `${ping.lat.toFixed(4)}, ${ping.lon.toFixed(4)}`);

  const tz = specific?.tz ?? ping.timezone;
  const times = formatTimes(ping.deviceTs, tz, ping.tzOffsetMin, cfg.homeTimezone);
  const battery = ping.battery !== null ? `${ping.battery}%` : null;
  const temp = ping.tempC !== null ? `${Math.round(ping.tempC)}°C` : null;
  const next = nextDestination(cfg, state.journeyIndex);
  const maps = mapsLink(ping.lat, ping.lon);
  const isEmergency = types.has("emergency");
  const title = isEmergency ? "🚨 EMERGENCY ALERT" : "✈️ Travel Update";

  const textLines = [
    title,
    "",
    ...lines,
    "",
    `📍 ${location}`,
    times.local ? `🕒 Local time: ${times.local}` : null,
    `${cfg.homeFlag} ${cfg.homeLabel}: ${times.home}`,
    battery ? `🔋 Battery: ${battery}` : null,
    temp ? `🌡️ Temperature: ${temp}` : null,
    `🛫 Next destination: ${next}`,
    "",
    `Google Maps: ${maps}`,
    `Live tracking: ${liveUrl}`,
  ].filter((l): l is string => l !== null);

  const headline = lines.join(" · ");
  return {
    title,
    headline,
    text: textLines.join("\n"),
    params: [
      templateSafe(headline, 500),
      templateSafe(location, 120),
      templateSafe(times.local ?? "unavailable", 40),
      templateSafe(times.home, 40),
      templateSafe(battery ?? "unknown", 10),
      templateSafe(temp ?? "unavailable", 20),
      templateSafe(next, 80),
      templateSafe(maps, 120),
      templateSafe(liveUrl, 200),
    ],
    isEmergency,
    shown,
  };
}
