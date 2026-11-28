import type { Env } from "./types";
import { isValidTimeZone } from "./time";

export interface Weather {
  tempC: number | null;
  weatherCode: number | null;
  timezone: string | null;
}

/** Open-Meteo: current temperature + IANA timezone of the coordinates, in one free call. */
export async function fetchWeather(lat: number, lon: number): Promise<Weather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&current=temperature_2m,weather_code&timezone=auto`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as { timezone?: string; current?: { temperature_2m?: number; weather_code?: number } };
    return {
      tempC: typeof d.current?.temperature_2m === "number" ? d.current.temperature_2m : null,
      weatherCode: typeof d.current?.weather_code === "number" ? d.current.weather_code : null,
      timezone: isValidTimeZone(d.timezone) ? d.timezone : null,
    };
  } catch (err) {
    console.warn("weather lookup failed", (err as Error).message);
    return { tempC: null, weatherCode: null, timezone: null };
  }
}

export interface Geo {
  city: string | null;
  country: string | null;
  countryCode: string | null;
}

/** Best-effort reverse geocoding with OpenStreetMap Nominatim (only used when the phone sent no city). */
export async function reverseGeocode(env: Env, lat: number, lon: number): Promise<Geo> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": env.NOMINATIM_USER_AGENT ?? "TravelPulse/1.0" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as {
      address?: Record<string, string>;
    };
    const a = d.address ?? {};
    return {
      // Prefer a real city/town; outside city limits use the district (e.g. "Ahmedabad")
      // rather than sub-district names like "Sabarmati Taluka".
      city:
        a.city ??
        a.town ??
        a.village ??
        a.municipality ??
        a.state_district?.replace(/\s+District$/i, "") ??
        a.county ??
        a.state ??
        null,
      country: a.country ?? null,
      countryCode: a.country_code ? a.country_code.toUpperCase() : null,
    };
  } catch (err) {
    console.warn("reverse geocode failed", (err as Error).message);
    return { city: null, country: null, countryCode: null };
  }
}

const WMO: Record<number, string> = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Fog",
  51: "Drizzle",
  53: "Drizzle",
  55: "Drizzle",
  61: "Rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Showers",
  81: "Showers",
  82: "Heavy showers",
  95: "Thunderstorm",
  96: "Thunderstorm",
  99: "Thunderstorm",
};
export const weatherText = (code: number | null) => (code === null ? null : WMO[code] ?? "—");
