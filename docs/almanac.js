/* =====================================================================
 * almanac.js — a self-contained observing almanac for the ETC.
 *
 * Pure-JS, offline (no network). Given a target RA/Dec, a UT instant and the
 * active instrument's site (lat/lon from instruments/*.json), it computes the
 * Sun and Moon positions (low-precision analytic theory, ~arcmin), the
 * target/Moon/Sun horizontal coordinates, airmass, rise/transit/set, the lunar
 * illuminated fraction and Moon–target separation, and a night-long altitude
 * visibility plot with twilight shading. It can hand airmass + Moon geometry
 * back to the ETC via localStorage ("Use in ETC").
 *
 * Sun/Moon formulae follow Paul Schlyter's low-precision planetary positions
 * (the Moon includes the dominant periodic perturbations).
 * ===================================================================== */

"use strict";

/* ---------------- angle helpers (degree-based trig) ---------------- */
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const norm360 = (x) => ((x % 360) + 360) % 360;
const norm24 = (x) => ((x % 24) + 24) % 24;
const sind = (x) => Math.sin(x * D2R);
const cosd = (x) => Math.cos(x * D2R);
const tand = (x) => Math.tan(x * D2R);
const asind = (x) => Math.asin(Math.max(-1, Math.min(1, x))) * R2D;
const acosd = (x) => Math.acos(Math.max(-1, Math.min(1, x))) * R2D;
const atan2d = (y, x) => Math.atan2(y, x) * R2D;

/* ---------------- time ---------------- */
// JS Date holds an absolute instant; UTC <-> JD is exact.
const jdFromDate = (date) => date.getTime() / 86400000 + 2440587.5;
const dSinceJ2000 = (date) => jdFromDate(date) - 2451545.0;   // GMST epoch
const mjdFromDate = (date) => jdFromDate(date) - 2400000.5;
// Schlyter's Sun/Moon mean elements count days from 2000 Jan 0.0 = JD 2451543.5
// (1.5 d before J2000.0); using J2000 here lags the ecliptic longitude ~1.5°.
const dSchlyter = (date) => jdFromDate(date) - 2451543.5;

// Greenwich mean sidereal time [hours], then local apparent sidereal [deg].
function gmstHours(date) {
  return norm24(18.697374558 + 24.06570982441908 * dSinceJ2000(date));
}
function lstDeg(date, lonEast) {
  return norm360(gmstHours(date) * 15 + lonEast);
}

/* ---------------- EU daylight-saving + local civil time ---------------- */
function lastSundayUTC(year, monthZeroBased) {
  const d = new Date(Date.UTC(year, monthZeroBased + 1, 0)); // last day of month
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());              // step back to Sunday
  return d;
}
function euDstActive(date) {
  const y = date.getUTCFullYear();
  const start = lastSundayUTC(y, 2); start.setUTCHours(1, 0, 0, 0); // last Sun Mar 01:00 UTC
  const end = lastSundayUTC(y, 9); end.setUTCHours(1, 0, 0, 0);     // last Sun Oct 01:00 UTC
  return date >= start && date < end;
}
// Returns the local-civil offset [h] and name for a site at this instant.
function civilOffset(date, site) {
  let off = site.tz_standard_offset_hours || 0;
  let name = site.tz_name_standard || "UTC";
  if (site.uses_eu_dst && euDstActive(date)) {
    off += 1;
    name = site.tz_name_dst || name;
  }
  return { offsetHours: off, name };
}

/* ---------------- Sun (low precision) ---------------- */
function sunPos(date) {
  const d = dSchlyter(date);
  const w = 282.9404 + 4.70935e-5 * d;       // longitude of perihelion
  const e = 0.016709 - 1.151e-9 * d;         // eccentricity
  const M = norm360(356.0470 + 0.9856002585 * d); // mean anomaly
  const oblec = 23.4393 - 3.563e-7 * d;      // obliquity of the ecliptic
  let E = M + R2D * e * sind(M) * (1 + e * cosd(M));
  const xv = cosd(E) - e;
  const yv = Math.sqrt(1 - e * e) * sind(E);
  const v = atan2d(yv, xv);
  const r = Math.sqrt(xv * xv + yv * yv);
  const lon = norm360(v + w);                // ecliptic longitude (lat = 0)
  const xs = r * cosd(lon), ys = r * sind(lon);
  const xe = xs;
  const ye = ys * cosd(oblec);
  const ze = ys * sind(oblec);
  return {
    ra: norm360(atan2d(ye, xe)),
    dec: atan2d(ze, Math.sqrt(xe * xe + ye * ye)),
    eclLon: lon, dist: r, M, w, oblec,
  };
}

/* ---------------- Moon (low precision, main perturbations) ---------------- */
function moonPos(date) {
  const d = dSchlyter(date);
  const N = norm360(125.1228 - 0.0529538083 * d); // ascending node
  const i = 5.1454;
  const w = norm360(318.0634 + 0.1643573223 * d); // arg. of perigee
  const a = 60.2666;                              // mean distance [Earth radii]
  const e = 0.054900;
  const M = norm360(115.3654 + 13.0649929509 * d); // mean anomaly
  let E = M + R2D * e * sind(M) * (1 + e * cosd(M));
  for (let k = 0; k < 3; k++) {
    E = E - (E - R2D * e * sind(E) - M) / (1 - e * cosd(E));
  }
  const xv = a * (cosd(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * sind(E);
  const v = atan2d(yv, xv);
  const r = Math.sqrt(xv * xv + yv * yv);
  let xec = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
  let yec = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
  let zec = r * (sind(v + w) * sind(i));
  let lon = atan2d(yec, xec);
  let lat = atan2d(zec, Math.sqrt(xec * xec + yec * yec));

  // periodic perturbations (degrees)
  const sun = sunPos(date);
  const Ls = norm360(sun.M + sun.w);
  const Lm = norm360(M + w + N);
  const Dm = norm360(Lm - Ls);
  const F = norm360(Lm - N);
  const Ms = sun.M, Mm = M;
  lon += -1.274 * sind(Mm - 2 * Dm)
    + 0.658 * sind(2 * Dm)
    - 0.186 * sind(Ms)
    - 0.059 * sind(2 * Mm - 2 * Dm)
    - 0.057 * sind(Mm - 2 * Dm + Ms)
    + 0.053 * sind(Mm + 2 * Dm)
    + 0.046 * sind(2 * Dm - Ms)
    + 0.041 * sind(Mm - Ms)
    - 0.035 * sind(Dm)
    - 0.031 * sind(Mm + Ms)
    - 0.015 * sind(2 * F - 2 * Dm)
    + 0.011 * sind(Mm - 4 * Dm);
  lat += -0.173 * sind(F - 2 * Dm)
    - 0.055 * sind(Mm - F - 2 * Dm)
    - 0.046 * sind(Mm + F - 2 * Dm)
    + 0.033 * sind(F + 2 * Dm)
    + 0.017 * sind(2 * Mm + F);
  lon = norm360(lon);

  const oblec = sun.oblec;
  const xg = cosd(lon) * cosd(lat);
  const yg = sind(lon) * cosd(lat);
  const zg = sind(lat);
  const xe = xg;
  const ye = yg * cosd(oblec) - zg * sind(oblec);
  const ze = yg * sind(oblec) + zg * cosd(oblec);
  return {
    ra: norm360(atan2d(ye, xe)),
    dec: atan2d(ze, Math.sqrt(xe * xe + ye * ye)),
    eclLon: lon, eclLat: lat, dist: r,
  };
}

// Lunar illuminated fraction + elongation from the Sun.
function moonIllumination(date) {
  const s = sunPos(date), m = moonPos(date);
  const elong = acosd(cosd(s.eclLon - m.eclLon) * cosd(m.eclLat));
  const phaseAngle = 180 - elong;            // Sun–Moon–Earth angle
  const fraction = (1 + cosd(phaseAngle)) / 2;
  // waxing if the Moon is east of the Sun in ecliptic longitude
  const waxing = norm360(m.eclLon - s.eclLon) < 180;
  return { elong, phaseAngle, fraction, waxing };
}

function moonPhaseName(frac, waxing) {
  if (frac < 0.04) return "new";
  if (frac > 0.96) return "full";
  const q = waxing ? "waxing" : "waning";
  if (frac < 0.46) return q + " crescent";
  if (frac < 0.54) return waxing ? "first quarter" : "last quarter";
  return q + " gibbous";
}

/* ---------------- spherical geometry ---------------- */
// Equatorial -> horizontal. Returns alt, az (from N, through E), hour angle [deg].
function altaz(ra, dec, lstD, lat) {
  let H = norm360(lstD - ra);
  if (H > 180) H -= 360;                      // -180..180, +west of meridian
  const sinAlt = sind(dec) * sind(lat) + cosd(dec) * cosd(lat) * cosd(H);
  const alt = asind(sinAlt);
  let A = acosd((sind(dec) - sinAlt * sind(lat)) / (cosd(alt) * cosd(lat) || 1e-9));
  if (sind(H) > 0) A = 360 - A;
  return { alt, az: norm360(A), ha: H };
}

function angularSep(ra1, dec1, ra2, dec2) {
  return acosd(sind(dec1) * sind(dec2) +
    cosd(dec1) * cosd(dec2) * cosd(ra1 - ra2));
}

// Kasten & Young (1989) relative airmass; null below the horizon.
function airmass(altDeg) {
  if (altDeg <= 0) return null;
  return 1 / (sind(altDeg) + 0.50572 * Math.pow(altDeg + 6.07995, -1.6364));
}

/* ---------------- rise / transit / set ---------------- */
// Sample altitude over a 24 h window (1-min steps), recomputing the body each
// step so the Moon's motion is captured. Crossings of h0 are linearly refined.
function riseTransitSet(posFn, lat, lon, startUT, h0) {
  const stepMs = 60 * 1000, n = 24 * 60;
  const ups = [], downs = [];
  let prevAlt = null, prevT = null, maxAlt = -999, transit = null, minAlt = 999;
  for (let k = 0; k <= n; k++) {
    const t = new Date(startUT.getTime() + k * stepMs);
    const p = posFn(t);
    const aa = altaz(p.ra, p.dec, lstDeg(t, lon), lat);
    if (aa.alt > maxAlt) { maxAlt = aa.alt; transit = t; }
    if (aa.alt < minAlt) minAlt = aa.alt;
    if (prevAlt !== null) {
      const frac = (h0 - prevAlt) / (aa.alt - prevAlt);
      if (prevAlt < h0 && aa.alt >= h0) ups.push(new Date(prevT.getTime() + frac * stepMs));
      if (prevAlt >= h0 && aa.alt < h0) downs.push(new Date(prevT.getTime() + frac * stepMs));
    }
    prevAlt = aa.alt; prevT = t;
  }
  const tt = transit ? transit.getTime() : 0;
  const rise = ups.filter((t) => t.getTime() <= tt).pop() || ups[0] || null;
  const set = downs.find((t) => t.getTime() >= tt) || downs[downs.length - 1] || null;
  return {
    rise, set, transit, maxAlt, minAlt,
    circumpolar: minAlt > h0,
    neverUp: maxAlt < h0,
  };
}

/* =====================================================================
 * UI
 * ===================================================================== */
let MANIFEST = null, ACTIVE = null, SITE = null;
let visChart = null;
const INSTRUMENT_KEY = "etc_instrument";
const HANDOFF_KEY = "etc_almanac_handoff";
const STATE_KEY = "etc_almanac_state";   // RA/Dec/format/UT, kept across page switches

const $ = (id) => document.getElementById(id);

// Persist the inputs so leaving for the calculator and coming back keeps them.
function saveAlmanacState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      ra: $("ra").value, dec: $("dec").value,
      coordfmt: $("coordfmt").value, utdt: $("utdt").value,
    }));
  } catch (e) { /* private mode */ }
}
function restoreAlmanacState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(STATE_KEY)); } catch (e) { return; }
  if (!s) return;
  if (s.coordfmt) $("coordfmt").value = s.coordfmt;
  if (s.ra != null) $("ra").value = s.ra;
  if (s.dec != null) $("dec").value = s.dec;
  if (s.utdt) $("utdt").value = s.utdt;
}

/* ---------------- coordinate + time parsing/formatting ---------------- */
function parseSexagesimal(str) {
  str = String(str).trim();
  if (str === "") return NaN;
  const sign = /^-/.test(str) ? -1 : 1;
  const parts = str.replace(/^[+-]/, "").split(/[:\s]+/).map(Number);
  if (parts.some((x) => !isFinite(x))) return NaN;
  const [a, b = 0, c = 0] = parts;
  return sign * (a + b / 60 + c / 3600);
}
// Read the RA/Dec inputs into degrees, honoring the format selector.
function readTarget() {
  const fmt = $("coordfmt").value;
  let raDeg, decDeg;
  if (fmt === "deg") {
    raDeg = parseFloat($("ra").value);
    decDeg = parseFloat($("dec").value);
  } else {
    raDeg = parseSexagesimal($("ra").value) * 15; // hours -> deg
    decDeg = parseSexagesimal($("dec").value);
  }
  if (!isFinite(raDeg) || !isFinite(decDeg)) return null;
  return { ra: norm360(raDeg), dec: Math.max(-90, Math.min(90, decDeg)) };
}

const pad2 = (x) => String(x).padStart(2, "0");
function fmtHM(date, offsetHours = 0) {
  if (!date) return "—";
  const d = new Date(date.getTime() + offsetHours * 3600000);
  return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
}
function fmtHoursHMS(h) {
  const sign = h < 0 ? "−" : "+";
  h = Math.abs(h);
  let hh = Math.floor(h), mm = Math.floor((h - hh) * 60),
    ss = Math.round((((h - hh) * 60) - mm) * 60);
  if (ss === 60) { ss = 0; mm++; } if (mm === 60) { mm = 0; hh++; }
  return `${sign}${hh}:${pad2(mm)}:${pad2(ss)}`;
}
function fmtRA(raDeg) {
  let h = raDeg / 15, hh = Math.floor(h), mm = Math.floor((h - hh) * 60),
    ss = ((h - hh) * 60 - mm) * 60;
  return `${pad2(hh)}:${pad2(mm)}:${ss.toFixed(1).padStart(4, "0")}`;
}
function fmtDec(decDeg) {
  const sign = decDeg < 0 ? "−" : "+";
  const x = Math.abs(decDeg);
  let dd = Math.floor(x), mm = Math.floor((x - dd) * 60),
    ss = Math.round(((x - dd) * 60 - mm) * 60);
  if (ss === 60) { ss = 0; mm++; } if (mm === 60) { mm = 0; dd++; }
  return `${sign}${pad2(dd)}:${pad2(mm)}:${pad2(ss)}`;
}
const deg1 = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(1) + "°";

// The <input type="datetime-local"> holds the site's *local civil time* as a
// naive wall-clock ("YYYY-MM-DDThh:mm"). We convert LCT<->UT with the site's
// civil offset (standard + EU summer time). The offset itself depends on the
// instant, so for a given wall-clock we resolve DST from a standard-offset guess
// (the transition hour is an inconsequential edge case for this tool).
function civilOffsetForWall(wallMs) {
  const std = (SITE && SITE.tz_standard_offset_hours) || 0;
  if (!SITE || !SITE.uses_eu_dst) return std;
  return euDstActive(new Date(wallMs - std * 3600000)) ? std + 1 : std;
}
function readUT() {
  const v = $("utdt").value;
  if (!v) return null;
  const m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const mo = +m[2], dd = +m[3], hh = +m[4];
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23) return null;
  const wallMs = Date.UTC(+m[1], mo - 1, dd, hh, +m[5], +(m[6] || 0)); // LCT wall
  return new Date(wallMs - civilOffsetForWall(wallMs) * 3600000);
}
function writeUT(date) {
  const off = civilOffset(date, SITE || {}).offsetHours; // SITE null -> UT
  const w = new Date(date.getTime() + off * 3600000);    // LCT wall-clock
  $("utdt").value = `${w.getUTCFullYear()}-${pad2(w.getUTCMonth() + 1)}-` +
    `${pad2(w.getUTCDate())}T${pad2(w.getUTCHours())}:${pad2(w.getUTCMinutes())}`;
}

/* ---------------- visibility window ---------------- */
// 24 h window starting at the local noon at or before the selected instant, in
// UT. Anchoring to the *preceding* noon (rather than the civil date's noon)
// keeps a single night contiguous: an after-midnight time belongs to the night
// that began the previous evening, so the selected-time marker always lands
// inside the window instead of jumping forward when LCT crosses midnight.
function visibilityWindow(date, site) {
  const co = civilOffset(date, site);
  const lc = new Date(date.getTime() + co.offsetHours * 3600000); // LCT wall-clock
  let noonWall = Date.UTC(lc.getUTCFullYear(), lc.getUTCMonth(), lc.getUTCDate(), 12, 0, 0);
  if (lc.getTime() < noonWall) noonWall -= 24 * 3600000; // before local noon -> previous day's noon
  const startUT = new Date(noonWall - co.offsetHours * 3600000);
  return { start: startUT, offsetHours: co.offsetHours, tzName: co.name };
}

/* ---------------- the main compute + render ---------------- */
function compute() {
  saveAlmanacState();
  if (!SITE) return;
  const ut = readUT();
  const tgt = readTarget();
  const warn = $("alm-warnings");
  warn.innerHTML = "";

  if (!ut) { warn.innerHTML = `<div class="input-warning">Enter a valid date and time.</div>`; return; }

  const lat = SITE.latitude_deg, lon = SITE.longitude_deg;
  const co = civilOffset(ut, SITE);
  const lst = lstDeg(ut, lon);

  // input hint: which civil timezone the wall-clock is being read as
  const tzHint = $("tz-hint");
  if (tzHint) {
    const sgn = co.offsetHours >= 0 ? "+" : "−";
    tzHint.textContent = `read as ${co.name} (UTC${sgn}${Math.abs(co.offsetHours)}), ` +
      `the site's wall-clock time`;
  }

  // time readouts (UT ⇐ the LCT you entered)
  $("out-mjd").textContent = mjdFromDate(ut).toFixed(5);
  $("out-jd").textContent = jdFromDate(ut).toFixed(5);
  $("out-lst").textContent = fmtHoursHMS(lst / 15).replace("+", "");
  $("out-lct").textContent = fmtHM(ut, 0) + " UT  (" + ut.toUTCString().slice(5, 16) + ")";

  // bodies
  const sun = sunPos(ut), moon = moonPos(ut), illum = moonIllumination(ut);
  const sunAA = altaz(sun.ra, sun.dec, lst, lat);
  const moonAA = altaz(moon.ra, moon.dec, lst, lat);

  const win = visibilityWindow(ut, SITE);
  const sunRTS = riseTransitSet(sunPos, lat, lon, win.start, -0.833);
  const moonRTS = riseTransitSet(moonPos, lat, lon, win.start, 0.125);

  // Moon facts
  const moonPhase = moonPhaseName(illum.fraction, illum.waxing);

  // Target-dependent rows
  let tgtAA = null, tgtRTS = null, moonSep = null;
  if (tgt) {
    tgtAA = altaz(tgt.ra, tgt.dec, lst, lat);
    tgtRTS = riseTransitSet(() => tgt, lat, lon, win.start, 0); // fixed body
    moonSep = angularSep(tgt.ra, tgt.dec, moon.ra, moon.dec);
    $("out-target-coords").textContent = `α ${fmtRA(tgt.ra)}  δ ${fmtDec(tgt.dec)}`;
  } else {
    $("out-target-coords").textContent = "— enter RA and Dec —";
  }

  // ---- table ----
  const amStr = (alt) => { const X = airmass(alt); return X ? X.toFixed(2) : "—"; };
  const rowsEl = $("alm-rows");
  const bodyRow = (name, aa, rts, extra) => {
    const up = aa.alt > 0;
    return `<tr>
      <td class="obj">${name}</td>
      <td>${up ? deg1(aa.alt) : `<span class="muted">${deg1(aa.alt)}</span>`}</td>
      <td>${aa.az.toFixed(1)}°</td>
      <td>${(90 - aa.alt).toFixed(1)}°</td>
      <td>${up ? amStr(aa.alt) : "—"}</td>
      <td>${fmtHoursHMS(aa.ha / 15)}</td>
      <td>${rts.circumpolar ? "circumpolar" : rts.neverUp ? "never up" : fmtHM(rts.rise)}</td>
      <td>${fmtHM(rts.transit)}</td>
      <td>${rts.circumpolar ? "—" : rts.neverUp ? "—" : fmtHM(rts.set)}</td>
      <td>${extra || ""}</td>
    </tr>`;
  };
  let html = "";
  if (tgt) html += bodyRow("Target", tgtAA, tgtRTS,
    moonSep != null ? `${moonSep.toFixed(1)}° from Moon` : "");
  html += bodyRow("Moon", moonAA, moonRTS,
    `FLI ${illum.fraction.toFixed(2)} (${moonPhase})`);
  html += bodyRow("Sun", sunAA, sunRTS, skyState(sunAA.alt).label);
  rowsEl.innerHTML = html;

  // ---- Moon / Sun summary chips ----
  $("out-moon").innerHTML =
    `illum <b>${(illum.fraction * 100).toFixed(0)}%</b> (FLI ${illum.fraction.toFixed(2)}, ${moonPhase}) · ` +
    `alt ${deg1(moonAA.alt)} · elongation ${illum.elong.toFixed(0)}°` +
    (moonSep != null ? ` · <b>${moonSep.toFixed(1)}°</b> from target` : "");
  const ss = skyState(sunAA.alt);
  $("out-sun").innerHTML = `alt ${deg1(sunAA.alt)} · <span class="${ss.cls}">${ss.label}</span>`;

  // ---- warnings ----
  const W = [];
  if (sunAA.alt > -0.833) {
    W.push(`<div class="warning">☀ <b>Daytime.</b> The Sun is ${deg1(sunAA.alt)} above the
      horizon — the target cannot be observed at this time.</div>`);
  } else if (sunAA.alt > -18) {
    W.push(`<div class="input-warning">🌆 <b>${ss.label}.</b> The Sun is ${deg1(sunAA.alt)}
      below the horizon; the sky is still bright. Photometry is degraded until the
      end of astronomical twilight (Sun below −18°).</div>`);
  }
  if (tgt && tgtAA.alt <= 0) {
    W.push(`<div class="input-warning">⤓ The target is <b>below the horizon</b>
      (alt ${deg1(tgtAA.alt)}) at this time.</div>`);
  } else if (tgt && tgtAA.alt > 0 && tgtAA.alt < 20) {
    W.push(`<div class="input-warning">⚠ The target is low (alt ${deg1(tgtAA.alt)},
      airmass ${amStr(tgtAA.alt)}); extinction and refraction are significant.</div>`);
  }
  if (tgt && moonSep != null && illum.fraction > 0.4 && moonAA.alt > 0 && moonSep < 30) {
    W.push(`<div class="input-warning">🌕 The Moon is bright (${(illum.fraction * 100).toFixed(0)}%)
      and only ${moonSep.toFixed(0)}° from the target — expect strong sky background.</div>`);
  }
  warn.innerHTML = W.join("");

  // enable hand-off + the transit jump only when a target is defined
  const canHand = !!tgt;
  $("use-in-etc").disabled = !canHand;
  $("transit-btn").disabled = !canHand;
  window.__almHandoff = canHand ? {
    // only an above-horizon target has a meaningful altitude/airmass to send;
    // Moon geometry is handed off regardless.
    altitude: tgtAA.alt > 0 ? tgtAA.alt : null,
    airmass: airmass(tgtAA.alt),
    moonillum: illum.fraction,
    moonsep: moonSep,
    instrument: ACTIVE.id,
  } : null;

  drawVisibility(win, lat, lon, tgt, ut);
}

function skyState(sunAlt) {
  if (sunAlt > -0.833) return { label: "day", cls: "st-day" };
  if (sunAlt > -6) return { label: "civil twilight", cls: "st-civil" };
  if (sunAlt > -12) return { label: "nautical twilight", cls: "st-naut" };
  if (sunAlt > -18) return { label: "astronomical twilight", cls: "st-astro" };
  return { label: "night", cls: "st-night" };
}

/* ---------------- visibility plot ---------------- */
const TWILIGHT_COLORS = {
  day: "rgba(127,178,229,0.40)",
  civil: "rgba(91,135,189,0.40)",
  naut: "rgba(58,90,138,0.45)",
  astro: "rgba(33,49,79,0.55)",
  night: "rgba(8,10,16,0.65)",
};
function bandColor(sunAlt) {
  if (sunAlt > -0.833) return TWILIGHT_COLORS.day;
  if (sunAlt > -6) return TWILIGHT_COLORS.civil;
  if (sunAlt > -12) return TWILIGHT_COLORS.naut;
  if (sunAlt > -18) return TWILIGHT_COLORS.astro;
  return TWILIGHT_COLORS.night;
}

function drawVisibility(win, lat, lon, tgt, selUT) {
  const stepMin = 5, n = (24 * 60) / stepMin;
  const xs = [], tgtAlt = [], moonAlt = [], sunAltArr = [];
  for (let k = 0; k <= n; k++) {
    const t = new Date(win.start.getTime() + k * stepMin * 60000);
    const lstD = lstDeg(t, lon);
    const sp = sunPos(t), mp = moonPos(t);
    xs.push(k * stepMin / 60); // hours from window start
    sunAltArr.push(altaz(sp.ra, sp.dec, lstD, lat).alt);
    moonAlt.push(altaz(mp.ra, mp.dec, lstD, lat).alt);
    tgtAlt.push(tgt ? altaz(tgt.ra, tgt.dec, lstD, lat).alt : null);
  }
  const selHours = (selUT.getTime() - win.start.getTime()) / 3600000;
  const startUTms = win.start.getTime();

  // background twilight bands + selected-time marker, drawn behind the lines
  const bandsPlugin = {
    id: "bands",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x } } = chart;
      for (let k = 0; k < xs.length - 1; k++) {
        const x0 = x.getPixelForValue(xs[k]);
        const x1 = x.getPixelForValue(xs[k + 1]);
        ctx.fillStyle = bandColor((sunAltArr[k] + sunAltArr[k + 1]) / 2);
        ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
      }
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x } } = chart;
      if (selHours < xs[0] || selHours > xs[xs.length - 1]) return;
      const px = Math.round(x.getPixelForValue(selHours)) + 0.5;
      ctx.save();
      // bright vertical marker at the selected UT
      ctx.strokeStyle = "#34d399"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      // pill label at the top of the line
      ctx.setLineDash([]);
      const label = fmtHM(new Date(startUTms + selHours * 3600000)) + " UT";
      ctx.font = "11px system-ui, sans-serif";
      const w = ctx.measureText(label).width + 10;
      let lx = px - w / 2;
      lx = Math.max(a.left, Math.min(a.right - w, lx)); // keep on-canvas
      ctx.fillStyle = "#34d399";
      ctx.fillRect(lx, a.top + 2, w, 16);
      ctx.fillStyle = "#06281d"; ctx.textBaseline = "middle"; ctx.textAlign = "center";
      ctx.fillText(label, lx + w / 2, a.top + 10);
      ctx.restore();
    },
  };

  const cfg = {
    type: "line",
    data: {
      labels: xs,
      datasets: [
        {
          label: "Target", data: tgtAlt, borderColor: "#ffffff",
          backgroundColor: "#ffffff", borderWidth: 2, pointRadius: 0,
          tension: 0.25, spanGaps: false,
        },
        {
          label: "Moon", data: moonAlt, borderColor: "#facc15",
          borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "linear", min: 0, max: 24,
          title: { display: true, text: "Universal Time", color: "#9aa6bf" },
          ticks: {
            color: "#9aa6bf", maxRotation: 0, autoSkip: false,
            stepSize: 2,
            callback: (v) => fmtHM(new Date(startUTms + v * 3600000)),
          },
          grid: { color: "rgba(255,255,255,0.06)" },
        },
        x2: {
          type: "linear", position: "top", min: 0, max: 24,
          title: {
            display: true, color: "#9aa6bf",
            text: "Local civil time (" + win.tzName + ")",
          },
          ticks: {
            color: "#9aa6bf", maxRotation: 0, autoSkip: false, stepSize: 2,
            callback: (v) => fmtHM(new Date(startUTms + v * 3600000), win.offsetHours),
          },
          grid: { drawOnChartArea: false },
        },
        y: {
          min: 0, max: 90,
          title: { display: true, text: "Altitude [°]", color: "#9aa6bf" },
          ticks: { color: "#9aa6bf", stepSize: 15 },
          grid: { color: "rgba(255,255,255,0.06)" },
        },
      },
      plugins: {
        legend: { labels: { color: "#e6e9f0", boxWidth: 18 } },
        tooltip: {
          callbacks: {
            title: (items) => "UT " + fmtHM(new Date(startUTms + items[0].parsed.x * 3600000)),
            label: (it) => `${it.dataset.label}: ${it.parsed.y == null ? "—" : it.parsed.y.toFixed(1) + "°"}`,
          },
        },
      },
    },
    plugins: [bandsPlugin],
  };

  if (visChart) visChart.destroy();
  visChart = new Chart($("vis-chart").getContext("2d"), cfg);
}

/* ---------------- "Tonight": jump to the start of the night ----------------
 * The start of the observable night = end of evening astronomical twilight (Sun
 * descending through −18°) for the night containing the currently-selected
 * instant. If the site has no astronomical darkness on that date (high-latitude
 * summer), fall back to solar anti-transit — the darkest moment of the night. */
function solarAntiTransit(win, site) {
  let best = 1e9, bt = win.start;
  for (let k = 0; k <= 24 * 60; k += 2) {
    const t = new Date(win.start.getTime() + k * 60000);
    const p = sunPos(t);
    const alt = altaz(p.ra, p.dec, lstDeg(t, site.longitude_deg), site.latitude_deg).alt;
    if (alt < best) { best = alt; bt = t; }
  }
  return bt;
}
function tonight() {
  if (!SITE) return;
  const base = readUT() || new Date();
  const win = visibilityWindow(base, SITE);
  const rts = riseTransitSet(sunPos, SITE.latitude_deg, SITE.longitude_deg, win.start, -18);
  const start = (rts.set && !rts.circumpolar && !rts.neverUp)
    ? rts.set                       // evening astronomical twilight ends here
    : solarAntiTransit(win, SITE);  // no true darkness -> darkest moment instead
  writeUT(start);
  compute();
}

/* ---------------- "Transit": jump to the target's culmination ----------------
 * The meridian transit (hour angle 0) is the target's highest point / lowest
 * airmass in the night containing the selected instant. Needs a valid target;
 * the button is disabled otherwise (see compute()). */
function transitJump() {
  if (!SITE) return;
  const tgt = readTarget();
  if (!tgt) return;
  const base = readUT() || new Date();
  const win = visibilityWindow(base, SITE);
  const rts = riseTransitSet(() => tgt, SITE.latitude_deg, SITE.longitude_deg, win.start, 0);
  if (rts.transit) { writeUT(rts.transit); compute(); }
}

/* ---------------- time-step buttons ---------------- */
function stepTime(dir) {
  const ut = readUT(); if (!ut) return;
  const amt = parseFloat($("stepamt").value) || 1;
  const unit = $("stepunit").value;
  const mult = unit === "min" ? 60000 : unit === "hour" ? 3600000 : 86400000;
  writeUT(new Date(ut.getTime() + dir * amt * mult));
  compute();
}

/* ---------------- object-name resolver (CDS Sesame) ---------------- */
// The one place the almanac touches the network. Sesame resolves a name to
// J2000 RA/Dec (degrees) across SIMBAD/NED/VizieR; we fill the coordinate
// inputs honoring the current format. Failures (incl. CORS on static hosts)
// surface as an inline message and never break the offline ephemeris.
function fillTarget(raDeg, decDeg) {
  if ($("coordfmt").value === "deg") {
    $("ra").value = raDeg.toFixed(5);
    $("dec").value = decDeg.toFixed(5);
  } else {
    $("ra").value = fmtRA(raDeg);
    $("dec").value = fmtDec(decDeg).replace("−", "-"); // input parser wants ASCII minus
  }
}
async function resolveName() {
  const name = $("target-name").value.trim();
  const status = $("resolve-status");
  if (!name) { status.textContent = ""; return; }
  status.textContent = "resolving…";
  status.className = "resolve-status busy";
  try {
    const url = "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?" +
      encodeURIComponent(name);
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const txt = await res.text();
    // Sesame prints "%J <ra_deg> <dec_deg> ..." for the resolved position.
    const m = txt.match(/%J\s+([+-]?\d+\.?\d*)\s+([+-]?\d+\.?\d*)/);
    if (!m) throw new Error("name not found");
    fillTarget(norm360(parseFloat(m[1])), parseFloat(m[2]));
    status.textContent = "✓ resolved " + name;
    status.className = "resolve-status ok";
    compute();
  } catch (e) {
    status.textContent = "✗ " + e.message +
      " — check the name, or the network may be blocked (CORS) on this host.";
    status.className = "resolve-status err";
  }
}

/* ---------------- hand-off to the ETC ---------------- */
function useInEtc() {
  const h = window.__almHandoff;
  if (!h) return;
  localStorage.setItem(HANDOFF_KEY, JSON.stringify({ ...h, ts: Date.now() }));
  localStorage.setItem(INSTRUMENT_KEY, ACTIVE.id);
  location.href = "index.html";
}

/* ---------------- instrument loading ---------------- */
async function loadInstrument(entry) {
  const res = await fetch(entry.file);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const c = await res.json();
  ACTIVE = entry;
  SITE = c.site || null;
  localStorage.setItem(INSTRUMENT_KEY, entry.id);

  const siteEl = $("site-info");
  if (SITE) {
    const la = SITE.latitude_deg, lo = SITE.longitude_deg;
    siteEl.textContent = `${Math.abs(la).toFixed(4)}°${la >= 0 ? "N" : "S"} ` +
      `${Math.abs(lo).toFixed(4)}°${lo >= 0 ? "E" : "W"} · ${SITE.elevation_m} m`;
    $("no-site").classList.add("hidden");
  } else {
    siteEl.textContent = "";
    $("no-site").classList.remove("hidden");
  }
  // now that SITE is known, LCT<->UT is well-defined: default an empty field.
  if (!$("utdt").value) writeUT(new Date());
  compute();
}

async function init() {
  try {
    const res = await fetch("instruments.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    MANIFEST = await res.json();
  } catch (err) {
    const el = document.createElement("div");
    el.className = "fatal-error";
    el.innerHTML = "⚠ Could not load <code>instruments.json</code> (" + err.message +
      "). Serve <code>docs/</code> over HTTP (e.g. <code>python -m http.server</code>).";
    document.body.prepend(el);
    return;
  }

  const sel = $("instrument");
  sel.innerHTML = MANIFEST.instruments
    .map((e) => `<option value="${e.id}">${e.label}</option>`).join("");
  const byId = (id) => MANIFEST.instruments.find((e) => e.id === id);
  const stored = localStorage.getItem(INSTRUMENT_KEY);
  const start = byId(stored) || byId(MANIFEST.default) || MANIFEST.instruments[0];
  sel.value = start.id;
  sel.addEventListener("change", () => loadInstrument(byId(sel.value)).catch(showErr));

  // restore previously entered RA/Dec/format/time (the default "now" is written
  // in loadInstrument, once SITE is known so LCT<->UT is correct).
  restoreAlmanacState();

  // wiring
  ["ra", "dec", "coordfmt", "utdt"].forEach((id) =>
    $(id).addEventListener("input", compute));
  $("now-btn").addEventListener("click", () => { writeUT(new Date()); compute(); });
  $("tonight-btn").addEventListener("click", tonight);
  $("transit-btn").addEventListener("click", transitJump);
  $("step-back").addEventListener("click", () => stepTime(-1));
  $("step-fwd").addEventListener("click", () => stepTime(1));
  $("use-in-etc").addEventListener("click", useInEtc);
  $("resolve-btn").addEventListener("click", resolveName);
  $("target-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); resolveName(); }
  });

  await loadInstrument(start).catch(showErr);
}

function showErr(err) {
  const el = document.createElement("div");
  el.className = "fatal-error";
  el.innerHTML = "⚠ " + (err && err.message ? err.message : err) +
    " — serve <code>docs/</code> over HTTP.";
  document.body.prepend(el);
}

init();
