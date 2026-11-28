(() => {
  "use strict";
  const token = (location.pathname.match(/^\/v\/([A-Za-z0-9_-]+)/) || [])[1];
  const $ = (id) => document.getElementById(id);
  let map, marker, circle, data;

  function setText(id, v) { $(id).textContent = v == null || v === "" ? "—" : String(v); }

  function fmtTime(ms, tz, offsetMin) {
    const opts = { hour: "numeric", minute: "2-digit", weekday: "short", day: "numeric", month: "short" };
    try {
      if (tz) return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(new Date(ms));
    } catch (_) { /* fall through */ }
    if (offsetMin != null) {
      return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(ms + offsetMin * 60000));
    }
    return null;
  }

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return "just now";
    const m = Math.round(s / 60);
    if (m < 90) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${m % 60}m ago`;
    return `${Math.floor(h / 24)} days ago`;
  }

  function renderClock() {
    if (!data) return;
    const now = Date.now();
    const l = data.last;
    setText("local", l ? fmtTime(now, l.timezone, l.tz_offset_min) : null);
    setText("home", fmtTime(now, data.home_timezone, null));
    if (l) setText("updated", `${ago(l.confirmed_at)} · ${fmtTime(l.confirmed_at, data.home_timezone)} ${data.home_label.replace(" time", "")}`);
  }

  function render(d) {
    data = d;
    setText("traveler", d.traveler);
    $("home-label").textContent = d.home_label;
    setText("next", d.next_destination);

    const banner = $("banner");
    const l = d.last;
    let warn = "";
    if (!d.tracking_enabled) warn = "⏸️ Tracking is paused. Showing the last known location.";
    else if (!l) warn = "No location has been received yet.";
    else {
      const ageMin = (Date.now() - l.confirmed_at) / 60000;
      if (ageMin > 30) {
        warn = `No recent update. This is the LAST KNOWN location, confirmed ${ago(l.confirmed_at)}. ` +
          "The phone may be on a flight, offline, or in low-power mode.";
      }
    }
    banner.hidden = !warn;
    banner.textContent = warn;

    if (l) {
      const place = l.place ? `${l.place}` : [l.city, l.country].filter(Boolean).join(", ");
      setText("loc", `${place || `${l.lat.toFixed(4)}, ${l.lon.toFixed(4)}`} ${l.flag || ""}`.trim());
      setText("battery", l.battery != null ? `${l.battery}%${l.battery < 15 ? " ⚠️" : ""}` : null);
      setText("weather", l.temp_c != null ? `${Math.round(l.temp_c)}°C${l.weather ? ` · ${l.weather}` : ""} (at last update)` : null);
      const ll = [l.lat, l.lon];
      if (!marker) {
        marker = L.marker(ll).addTo(map);
        map.setView(ll, 12);
      } else {
        marker.setLatLng(ll);
      }
      if (l.accuracy_m) {
        if (!circle) circle = L.circle(ll, { radius: l.accuracy_m, weight: 1 }).addTo(map);
        else circle.setLatLng(ll).setRadius(l.accuracy_m);
      }
      marker.bindPopup(`Last confirmed here<br>${fmtTime(l.confirmed_at, l.timezone, l.tz_offset_min) || ""} local`);
      $("map-caption").textContent = `Last confirmed location · ${ago(l.confirmed_at)} · ` +
        `Open in Google Maps: maps.google.com/?q=${l.lat.toFixed(5)},${l.lon.toFixed(5)}`;
    }

    const j = $("journey");
    j.replaceChildren(...d.journey.map((s) => {
      const li = document.createElement("li");
      li.className = s.status;
      li.textContent = s.label;
      const sub = document.createElement("span");
      sub.className = "sub";
      if (s.confirmed_at) sub.textContent = `Confirmed ${fmtTime(s.confirmed_at, d.home_timezone)} (${d.home_label})`;
      else if (s.status === "not_confirmed") sub.textContent = "Not confirmed by phone";
      else if (s.scheduled) sub.textContent = `Scheduled: ${s.scheduled}`;
      if (s.status === "current") sub.textContent = (sub.textContent ? sub.textContent + " · " : "") + "Latest confirmed stop";
      if (sub.textContent) li.appendChild(sub);
      return li;
    }));

    const ev = $("events");
    if (d.events.length) {
      ev.replaceChildren(...d.events.map((e) => {
        const li = document.createElement("li");
        const t = document.createElement("time");
        t.textContent = `${fmtTime(e.at, d.home_timezone)} (${d.home_label}) · ${ago(e.at)}`;
        li.append(t, document.createTextNode(e.headline));
        return li;
      }));
    }
    renderClock();
  }

  async function refresh() {
    try {
      const res = await fetch("/api/status", { headers: { "X-View-Token": token }, cache: "no-store" });
      if (res.status === 401) {
        $("banner").hidden = false;
        $("banner").textContent = "This tracking link is invalid or has been revoked.";
        return;
      }
      render(await res.json());
      $("refreshed").textContent = `checked ${new Date().toLocaleTimeString()}`;
    } catch (e) {
      $("refreshed").textContent = "offline – retrying";
    }
  }

  map = L.map("map", { zoomControl: true }).setView([30, 0], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  refresh();
  setInterval(refresh, 30000);
  setInterval(renderClock, 15000);
})();
