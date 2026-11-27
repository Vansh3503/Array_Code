/** Parse a timestamp from the phone. Accepts ISO 8601 (with offset), epoch seconds or ms. */
export function parseDeviceTimestamp(input: unknown): { ms: number; offsetMin: number | null } | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    const ms = input < 1e12 ? input * 1000 : input;
    return { ms, offsetMin: null };
  }
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (/^\d{10,13}$/.test(s)) return parseDeviceTimestamp(Number(s));
  // Normalise "+0530" -> "+05:30", and a space separator -> "T".
  s = s.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const m = s.match(/(Z|[+-]\d{2}:\d{2})$/);
  if (!m) return null; // require an explicit offset so we know the phone's local time
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  let offsetMin = 0;
  if (m[1] !== "Z") {
    const sign = m[1][0] === "-" ? -1 : 1;
    offsetMin = sign * (Number(m[1].slice(1, 3)) * 60 + Number(m[1].slice(4, 6)));
  }
  return { ms, offsetMin };
}

function partsIn(ms: number, tz: string | null, offsetMin: number | null) {
  // Use a real IANA zone when we have one, otherwise shift by the fixed offset and format as UTC.
  const useTz = tz ?? "UTC";
  const shifted = tz ? ms : ms + (offsetMin ?? 0) * 60000;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: useTz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(shifted)).map((x) => [x.type, x.value]));
  return {
    time: `${p.hour}:${p.minute} ${p.dayPeriod}`,
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Format local + home time, e.g. { local: "3:30 PM", home: "2:00 AM (next day)" }. */
export function formatTimes(
  ms: number,
  localTz: string | null,
  localOffsetMin: number | null,
  homeTz: string,
): { local: string | null; home: string } {
  const home = partsIn(ms, homeTz, null);
  if (!localTz && localOffsetMin === null) return { local: null, home: home.time };
  const local = partsIn(ms, localTz, localOffsetMin);
  let suffix = "";
  if (home.date > local.date) suffix = " (next day)";
  else if (home.date < local.date) suffix = " (previous day)";
  return { local: local.time, home: home.time + suffix };
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
