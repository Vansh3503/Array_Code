export interface Env {
  DB: D1Database;
  WHATSAPP_MODE?: string;
  WHATSAPP_API_VERSION?: string;
  WHATSAPP_TEMPLATE_NAME?: string;
  WHATSAPP_TEMPLATE_LANG?: string;
  PUBLIC_BASE_URL?: string;
  ALLOW_SIMULATED_TIME?: string;
  NOMINATIM_USER_AGENT?: string;
  // secrets
  DEVICE_TOKEN?: string;
  VIEW_TOKENS?: string;
  ADMIN_TOKEN?: string;
  RECIPIENTS?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
}

export type PlaceType = "airport" | "hotel" | "destination";

export interface Place {
  id: string;
  type: PlaceType;
  name: string;
  code?: string;
  lat: number;
  lon: number;
  radiusM: number;
  city?: string;
  country?: string;
  countryCode?: string;
  tz?: string;
}

export interface Stop {
  label: string;
  match: string[];
  scheduled?: string;
}

export interface Rules {
  lowBatteryPercent: number;
  lowBatteryRearmPercent: number;
  gapMinutes: number;
  significantMoveKm: number;
  newCityMinKm: number;
  maxPlausibleSpeedKmh: number;
  maxAccuracyForGeofenceM: number;
  maxMessagesPerHour: number;
  cooldownMinutes: Record<EventType, number>;
}

export interface TripConfig {
  traveler: string;
  homeTimezone: string;
  homeLabel: string;
  homeFlag: string;
  places: Place[];
  itinerary: Stop[];
  rules: Rules;
}

export type Trigger =
  | "manual"
  | "emergency"
  | "arrive_airport"
  | "leave_airport"
  | "arrive_hotel"
  | "airplane_off"
  | "wifi"
  | "low_battery"
  | "scheduled"
  | "other";

/** A validated ping, after parsing but before enrichment. */
export interface Ping {
  nonce: string;
  deviceTs: number;
  tzOffsetMin: number | null;
  lat: number;
  lon: number;
  accuracyM: number | null;
  battery: number | null;
  trigger: Trigger;
  city: string | null;
  country: string | null;
  countryCode: string | null;
  note: string | null;
  isTest: boolean;
}

/** Ping after reverse geocoding / weather. */
export interface EnrichedPing extends Ping {
  timezone: string | null;
  tempC: number | null;
  weatherCode: number | null;
  placeIds: string[];
}

export interface TrackerState {
  lastTs: number | null;
  lastLat: number | null;
  lastLon: number | null;
  inside: string[];
  city: string | null;
  countryCode: string | null;
  cityAnchorLat: number | null;
  cityAnchorLon: number | null;
  notifiedLat: number | null;
  notifiedLon: number | null;
  lowBatteryArmed: boolean;
  journeyIndex: number;
  reached: Record<string, number>; // itinerary index -> first confirmed ms
}

export type EventType =
  | "emergency"
  | "airport_arrival"
  | "hotel_arrival"
  | "destination_arrival"
  | "new_country"
  | "new_city"
  | "reconnected"
  | "airport_departure"
  | "significant_move"
  | "manual_checkin"
  | "low_battery";

export interface TravelEvent {
  type: EventType;
  dedupeKey: string;
  placeId?: string;
  data?: Record<string, string | number>;
}
