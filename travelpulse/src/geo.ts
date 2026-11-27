import type { Place } from "./types";

const R = 6371008.8; // mean Earth radius, metres

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** All configured places containing the point, most specific (smallest radius) first. */
export function placesContaining(places: Place[], lat: number, lon: number): Place[] {
  return places
    .filter((p) => distanceM(lat, lon, p.lat, p.lon) <= p.radiusM)
    .sort((a, b) => a.radiusM - b.radiusM);
}

export function flagEmoji(countryCode: string | null | undefined): string {
  if (!countryCode || !/^[A-Za-z]{2}$/.test(countryCode)) return "";
  const cc = countryCode.toUpperCase();
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

const SHORT_NAMES: Record<string, string> = {
  US: "USA",
  GB: "UK",
  AE: "UAE",
  IN: "India",
  QA: "Qatar",
};

const NAME_TO_CODE: Record<string, string> = {
  india: "IN",
  qatar: "QA",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  "united kingdom": "GB",
  uk: "GB",
  england: "GB",
  ireland: "IE",
  "united arab emirates": "AE",
};

export function countryCodeFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  return NAME_TO_CODE[name.trim().toLowerCase()] ?? null;
}

export function shortCountryName(code: string | null, fallback: string | null): string | null {
  if (code && SHORT_NAMES[code.toUpperCase()]) return SHORT_NAMES[code.toUpperCase()];
  return fallback;
}

export function mapsLink(lat: number, lon: number): string {
  return `https://maps.google.com/?q=${lat.toFixed(5)},${lon.toFixed(5)}`;
}
