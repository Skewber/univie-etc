"use strict";

// Loaded from constants.json (derived from the 2026-02-18 observing run).
let C = null;

// ---------------------------------------------------------------------------
// Core SNR math. Works on a generic triple: signal rate in the aperture
// (e-/s), number of pixels in the aperture, and peak per-pixel rate (e-/s).
// ---------------------------------------------------------------------------
// nReads = number of detector reads over the integration (1 for a single
// exposure; N for a stack of N sub-exposures, so read noise is paid N times).
function snrForTime(signalRate, t, nPix, Rsky, Rdark, Nread, nReads = 1) {
  const signal = signalRate * t;
  const noiseVar = signal + nPix * (t * (Rsky + Rdark) + nReads * Nread * Nread);
  return signal / Math.sqrt(noiseVar);
}

// Total time to reach a target SNR when the TOTAL read count is fixed at
// nReads (e.g. a single exposure, or a fixed number of subs) -> quadratic.
function timeForSnrFixedReads(signalRate, snr, nPix, Rsky, Rdark, Nread, nReads) {
  const a = signalRate * signalRate;
  const b = -(snr * snr) * (signalRate + nPix * (Rsky + Rdark));
  const c = -(snr * snr) * nPix * nReads * Nread * Nread;
  const disc = b * b - 4 * a * c;
  if (a <= 0 || disc < 0) return NaN;
  return (-b + Math.sqrt(disc)) / (2 * a);
}

// Total time to reach a target SNR when subs have a FIXED length L (so the read
// count grows as T/L). Read noise becomes a rate -> closed form linear in T.
function timeForSnrFixedSubLen(signalRate, snr, nPix, Rsky, Rdark, Nread, L) {
  return snr * snr * (signalRate + nPix * (Rsky + Rdark) +
    nPix * Nread * Nread / L) / (signalRate * signalRate);
}

function peakElectrons(peakRate, t, Rsky, Rdark) {
  return (peakRate + Rsky + Rdark) * t;
}

// Per-binned-pixel background rates (scaled from the bin-2 measurement).
// moonMult: a multiplicative factor from the moon-brightness model (>=1).
function skyRate(filter, binning, skyMult, moonMult) {
  return C.filters[filter].sky_rate_e_per_s_per_pix *
    Math.pow(binning / 2, 2) * skyMult * moonMult;
}

// Krisciunas & Schaefer (1991) moon-brightness model, simplified to a
// multiplicative factor on the V dark-sky flux. Applied uniformly to all bands
// (good approximation when moon and sky have similar broadband colors).
//   illum  : 0..1   (0 = new, 1 = full)
//   sepDeg : moon-target angular separation [deg]
//   X      : target airmass; the moon is assumed to be at the same altitude.
function moonFactor(illum, sepDeg, X) {
  const f = Math.min(1, Math.max(0, illum || 0));
  if (f <= 0) return 1;
  const alpha = Math.acos(2 * f - 1) * 180 / Math.PI;     // phase angle [deg]
  const Istar = Math.pow(10, -0.4 * (3.84 + 0.026 * Math.abs(alpha) +
                                     4e-9 * Math.pow(alpha, 4)));
  const rho = Math.max(sepDeg, 1);
  const cosr = Math.cos(rho * Math.PI / 180);
  const fRho = Math.pow(10, 5.36) * (1.06 + cosr * cosr) +
               Math.pow(10, 6.15 - rho / 40);
  const kV = (C.filters.V && C.filters.V.extinction_k) || 0.15;
  const Bmoon_nL = fRho * Istar * Math.pow(10, -0.4 * kV * X) *
                   (1 - Math.pow(10, -0.4 * kV * X));
  if (Bmoon_nL <= 0) return 1;
  const mu_moon = (20.7233 - Math.log(Bmoon_nL / 34.08)) / 0.92104; // V mag/arcsec^2

  // Dark-sky observed V surface brightness, from our measured per-pixel rate.
  // The measured sky rate is already the rate *at* the observation airmass --
  // it is not an above-atmosphere quantity -- so no extinction term here.
  const sBin2 = C.pixel_scale_arcsec_unbinned * 2; // reference binning 2
  const dark_per_arcsec2 = C.filters.V.sky_rate_e_per_s_per_pix / (sBin2 * sBin2);
  const mu_dark = C.filters.V.zeropoint_mag_1es - 2.5 * Math.log10(dark_per_arcsec2);
  return 1 + Math.pow(10, -0.4 * (mu_moon - mu_dark));
}
function darkRate(binning, tempC) {
  const cam = C.camera;
  const ref = cam.dark_ref_temp_c != null ? cam.dark_ref_temp_c : -5;
  const dbl = cam.dark_doubling_kelvin || 6.3;
  const Dref = cam["dark_current_e_per_s_at_-5C"];
  const D = Dref * Math.pow(2, (tempC - ref) / dbl);
  return D * Math.pow(binning / 2, 2);
}

// Flux (e-/s) for a magnitude (or surface-brightness, per arcsec^2) in a band.
function fluxFor(mag, filter, airmass) {
  const f = C.filters[filter];
  return Math.pow(10, 0.4 * (f.zeropoint_mag_1es - (mag + f.extinction_k * airmass)));
}
// Inverse: flux (e-/s) -> magnitude in that band at this airmass.
function magFor(flux, filter, airmass) {
  const f = C.filters[filter];
  return f.zeropoint_mag_1es - f.extinction_k * airmass - 2.5 * Math.log10(flux);
}

// Number of pixels in a seeing-matched point-source aperture.
function nPixPoint(fwhm, binning, apDiam) {
  const sBinned = C.pixel_scale_arcsec_unbinned * binning;
  const r = (apDiam / 2) * fwhm / sBinned;
  return Math.PI * r * r;
}

// Observing-filter brightness after the (approximate) SED color conversion.
// Extended sources use object-class templates (galaxy / nebula / Hα region).
function obsBrightness(inp) {
  if (inp.sed.mode === "flat") return inp.mag;
  return SED.bandMag(inp.mag, inp.refband, inp.filter, inp.sed).mObs;
}

// Populate the #spectype <select> with the right list for point vs extended.
function populateSpectype(kind) {
  const sel = document.getElementById("spectype");
  if (sel.dataset.kind === kind) return;
  const types = kind === "extended" ? SED.extTypes : SED.pointTypes;
  const def = kind === "extended" ? "Spiral galaxy" : "G2 (Sun)";
  sel.innerHTML = types.map((t) =>
    `<option value="${t}"${t === def ? " selected" : ""}>${t}</option>`).join("");
  sel.dataset.kind = kind;
}

// ---------------------------------------------------------------------------
// Build the {signalRate, nPix, peakRate} triple for the current target.
// ---------------------------------------------------------------------------
function buildPoint(inp, b) {
  const Rstar = fluxFor(b, inp.filter, inp.airmass);
  const sBinned = C.pixel_scale_arcsec_unbinned * inp.binning;
  const sigmaPx = (inp.seeing / sBinned) / 2.3548;
  return {
    signalRate: Rstar, nPix: nPixPoint(inp.seeing, inp.binning, inp.aperture),
    peakRate: Rstar / (2 * Math.PI * sigmaPx * sigmaPx),
  };
}

// Radial analytic extended source. Peak SB is seeing-limited (mean SB within a
// disc of diameter = seeing FWHM, centred on the source).
function buildExtended(inp, b) {
  const sBinned = C.pixel_scale_arcsec_unbinned * inp.binning;
  const rAp = (inp.extap > 0 ? inp.extap : sBinned) / 2;
  const enc = SRC.encFracBuilder(inp.profile, inp.size, inp.sersicN);
  const rSee = Math.max(inp.seeing / 2, sBinned / 2);

  let totalFlux;
  if (inp.normmode === "sb") {                  // b = mean SB in aperture
    const sbFlux = fluxFor(b, inp.filter, inp.airmass); // e-/s per arcsec^2
    const apFlux = sbFlux * Math.PI * rAp * rAp;
    const f = enc(rAp);
    totalFlux = f > 0 ? apFlux / f : apFlux;
  } else {                                      // b = total magnitude
    totalFlux = fluxFor(b, inp.filter, inp.airmass);
  }
  const apFlux = totalFlux * enc(rAp);
  const peakSBflux = totalFlux * enc(rSee) / (Math.PI * rSee * rSee);
  const peakRate = peakSBflux * sBinned * sBinned;

  let signalRate, nPix;
  if (inp.extap > 0) {
    signalRate = apFlux;
    nPix = Math.PI * rAp * rAp / (sBinned * sBinned);
  } else {
    signalRate = peakRate; nPix = 1;            // per-pixel SNR
  }
  return { signalRate, nPix, peakRate, totalFlux };
}

// Resolve the exposure structure into total time T, sub count N, and per-sub
// (frame) time, honouring the solve mode (time vs snr) and exposure structure.
// `src` is the {signalRate, nPix, peakRate} triple from buildPoint/buildExtended.
function resolveExposure(inp, src, Rsky, Rdark, Nread, gain) {
  const S = src.signalRate, nPix = src.nPix;
  const em = inp.expmode;
  const N0 = Math.max(1, Math.round(inp.nsub || 1));
  const L0 = inp.subexp > 0 ? inp.subexp : 1;

  // "Fixed total time": total is given, N is the smallest integer such that
  // each sub stays below the saturation safety threshold. Solve mode is ignored
  // here because the total is already specified.
  if (em === "total") {
    const T = Math.max(0.01, inp.exptime);
    const satFrac = Math.min(1, Math.max(0.05, (inp.satlimit || 70) / 100));
    const satE = C.camera.saturation_adu * gain * satFrac;
    const peakPerSec = src.peakRate + Rsky + Rdark;
    const tSubMax = peakPerSec > 0 ? satE / peakPerSec : T;
    const N = Math.max(1, Math.ceil(T / tSubMax));
    return { t: T, nSub: N,
             snr: snrForTime(S, T, nPix, Rsky, Rdark, Nread, N),
             tSubMax };
  }

  if (inp.mode === "snr") {                    // exposure given -> compute SNR
    let T, N;
    if (em === "nsub_len") { N = N0; T = N * L0; }
    else if (em === "split") { N = N0; T = inp.exptime; }
    else { N = 1; T = inp.exptime; }
    return { t: T, nSub: N, snr: snrForTime(S, T, nPix, Rsky, Rdark, Nread, N) };
  }

  // time mode: solve total T for the target SNR
  let T, N;
  if (em === "nsub_len") {                     // fixed sub length, N derived
    T = timeForSnrFixedSubLen(S, inp.snr, nPix, Rsky, Rdark, Nread, L0);
    N = Math.max(1, Math.ceil(T / L0)); T = N * L0;
  } else if (em === "split") {                 // fixed N, sub length derived
    N = N0; T = timeForSnrFixedReads(S, inp.snr, nPix, Rsky, Rdark, Nread, N);
  } else {                                     // single exposure
    N = 1; T = timeForSnrFixedReads(S, inp.snr, nPix, Rsky, Rdark, Nread, 1);
  }
  return { t: T, nSub: N, snr: snrForTime(S, T, nPix, Rsky, Rdark, Nread, N) };
}

function compute(inp) {
  const moonMult = moonFactor(inp.moonillum, inp.moonsep, inp.airmass);
  const Rsky = skyRate(inp.filter, inp.binning, inp.skymult, moonMult);
  const Rdark = darkRate(inp.binning, inp.cooltemp);
  const Nread = C.camera.read_noise_e[inp.readmode];
  const b = obsBrightness(inp);
  const src = inp.ttype === "extended" ? buildExtended(inp, b) : buildPoint(inp, b);

  const gain = C.camera.gain_e_per_adu;
  const ex = resolveExposure(inp, src, Rsky, Rdark, Nread, gain);
  const t = ex.t, snr = ex.snr, nSub = ex.nSub;
  const tFrame = nSub > 1 ? t / nSub : t;      // per-frame time (saturation)
  const sBinned = C.pixel_scale_arcsec_unbinned * inp.binning;
  const peakE = peakElectrons(src.peakRate, tFrame, Rsky, Rdark);

  // Wall-clock total = N × (sub length + per-frame readout/download).
  const tRead = (C.camera.readout_time_s && C.camera.readout_time_s[inp.readmode])
                || 1.0;
  const wallTime = nSub * (tFrame + tRead);

  // Input-sanity warnings (shown to the user; don't change the math).
  const warnings = [];
  if (inp.airmass > 5) {
    const alt = 90 - Math.acos(Math.min(1, 1 / inp.airmass)) * 180 / Math.PI;
    warnings.push(
      `High airmass: X=${inp.airmass.toFixed(2)} corresponds to altitude ≈ ` +
      `${alt.toFixed(1)}°. Extinction at this X dims the source by ` +
      `${(C.filters[inp.filter].extinction_k * inp.airmass).toFixed(1)} mag in ` +
      `${inp.filter} — typical observing uses X = 1–2.5.`);
  }
  if (inp.moonillum_raw > 1) {
    warnings.push(
      `Moon illumination ${inp.moonillum_raw} is outside the physical 0–1 ` +
      `range; clamped to 1.0 (full moon). Use a fraction, not a percentage.`);
  }

  // Limiting in-band magnitude at S/N = SIGMA_LIM, for the same setup
  // (aperture, t, sub count, conditions). Defined for point sources;
  // for an extended source the analogue would be a limiting surface brightness,
  // which depends on the profile choice, so we report it only for points.
  const SIGMA_LIM = 5;
  const Bvar = src.nPix * (t * (Rsky + Rdark) + nSub * Nread * Nread);
  const sLim = SIGMA_LIM * SIGMA_LIM / (2 * t) *
               (1 + Math.sqrt(1 + 4 * Bvar / (SIGMA_LIM * SIGMA_LIM)));
  const mLim = inp.ttype === "point"
    ? C.filters[inp.filter].zeropoint_mag_1es
      - C.filters[inp.filter].extinction_k * inp.airmass
      - 2.5 * Math.log10(sLim)
    : null;

  return {
    ...src, b, Rsky, Rdark, Nread, gain, t, snr, nSub, tFrame, sBinned, peakE,
    moonMult, tRead, wallTime, mLim, warnings,
    peakADU: peakE / gain,
    satPct: peakE / gain / C.camera.saturation_adu * 100,
    fwhmSampling: inp.seeing / sBinned,
    signalE: src.signalRate * t,
    skyPerPixE: Rsky * t,
    k: C.filters[inp.filter].extinction_k,
    noise: {
      star: src.signalRate * t, sky: src.nPix * Rsky * t,
      dark: src.nPix * Rdark * t, read: src.nPix * nSub * Nread * Nread,
    },
  };
}

// ---------------------------------------------------------------------------
// UI plumbing
// ---------------------------------------------------------------------------
const val = (id) => document.getElementById(id).value;
const num = (id) => parseFloat(document.getElementById(id).value);

function readInputs() {
  const sedMode = val("sed");
  return {
    filter: val("filter"),
    ttype: document.querySelector('input[name="ttype"]:checked').value,
    mag: num("mag"),
    mode: document.querySelector('input[name="mode"]:checked').value,
    snr: num("snr"),
    expmode: val("expmode"),
    exptime: num("exptime"),
    subexp: num("subexp"),
    nsub: num("nsub"),
    satlimit: num("satlimit"),
    cooltemp: num("cooltemp"),
    airmass: num("airmass"),
    seeing: num("seeing"),
    skymult: num("skymult"),
    moonillum: Math.min(1, Math.max(0, num("moonillum") || 0)), // clamp to [0,1]
    moonsep: Math.min(180, Math.max(0, num("moonsep") || 0)),
    moonillum_raw: num("moonillum"),                            // for the warning
    binning: parseInt(val("binning"), 10),
    readmode: val("readmode"),
    aperture: num("aperture"),
    // extended
    profile: val("profile"),
    normmode: val("normmode"),
    size: num("size"),
    sersicN: num("sersicN"),
    extap: num("extap"),
    // SED
    sed: { mode: sedMode, T: num("bbT"), type: val("spectype") },
    refband: val("refband"),
  };
}

function fmtTime(t) {
  if (!isFinite(t) || t <= 0) return "—";
  if (t < 1) return t.toFixed(3) + " s";
  if (t < 120) return t.toFixed(1) + " s";
  if (t < 3600) return (t / 60).toFixed(1) + " min";
  return (t / 3600).toFixed(2) + " h";
}

function renderResults(inp, r) {
  const label = document.getElementById("headline-label");
  const value = document.getElementById("headline-value");
  if (inp.mode === "time") {
    label.textContent = `Exposure time for SNR ${inp.snr}`;
    value.textContent = fmtTime(r.t);
  } else {
    label.textContent = `SNR in ${fmtTime(r.t)}`;
    value.textContent = isFinite(r.snr) ? r.snr.toFixed(1) : "—";
  }

  const rows = [["Filter", inp.filter]];
  if (inp.sed.mode !== "flat") {
    const tag = inp.sed.mode === "bb" ? `${inp.sed.T} K` : inp.sed.type;
    rows.push([`Obs-band mag (≈, ${tag})`, r.b.toFixed(2)]);
  }
  if (inp.ttype === "extended") {
    const meanSBflux = r.signalRate / (r.nPix * r.sBinned * r.sBinned);
    const peakSBflux = r.peakRate / (r.sBinned * r.sBinned);
    rows.push(
      ["Profile", inp.profile],
      ["Total magnitude", magFor(r.totalFlux, inp.filter, inp.airmass).toFixed(2)],
      ["Mean SB in aper", magFor(meanSBflux, inp.filter, inp.airmass).toFixed(2) + " mag/&Prime;&sup2;"],
      ["Peak SB", magFor(peakSBflux, inp.filter, inp.airmass).toFixed(2) + " mag/&Prime;&sup2;"],
    );
  } else {
    rows.push(["Source rate", r.signalRate.toExponential(3) + " e&#8315;/s"]);
  }
  const perSub = r.nSub > 1 ? " /sub" : "";
  rows.push(["Total exposure", fmtTime(r.t)]);
  if (r.nSub > 1) rows.push(["Sub-exposures", `${r.nSub} × ${r.tFrame.toFixed(1)} s`]);
  rows.push(["Total time", `${fmtTime(r.wallTime)} ` +
    `<small style="color:#6b7488">(+ ${r.nSub} × ${r.tRead.toFixed(1)} s readout)</small>`]);
  rows.push(
    ["SNR", isFinite(r.snr) ? r.snr.toFixed(2) : "—"],
    ["Peak pixel" + perSub, `${r.peakE.toFixed(0)} e&#8315; (${r.peakADU.toFixed(0)} ADU)`],
    ["Saturation" + perSub, r.satPct.toFixed(1) + " %"],
    ["Dark current", `${r.Rdark.toFixed(3)} e&#8315;/s/px @ ${inp.cooltemp}&deg;C`],
    ["Sky &times; (moon)", `${r.moonMult.toFixed(2)} (illum ${inp.moonillum}, sep ${inp.moonsep}&deg;)`],
    ["Aperture", inp.ttype === "extended"
      ? `${r.nPix.toFixed(1)} px (${(inp.extap > 0 ? inp.extap : "1 px")}${inp.extap > 0 ? "&Prime; ⌀" : ""})`
      : `${r.nPix.toFixed(1)} px`],
    ["Signal in aperture", `${r.signalE.toFixed(0)} e&#8315; (${(r.signalE / r.gain).toFixed(0)} ADU)`],
    ["Sky / pixel", `${r.skyPerPixE.toFixed(1)} e&#8315; (${(r.skyPerPixE / r.gain).toFixed(1)} ADU)`],
  );
  if (r.mLim != null && isFinite(r.mLim)) {
    rows.push(["Limiting mag (S/N=5)", `${r.mLim.toFixed(2)} mag in ${inp.filter}`]);
  }
  document.getElementById("result-table").innerHTML =
    rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");

  const warn = document.getElementById("sat-warning");
  warn.classList.remove("hidden", "ok");
  if (r.satPct >= 100) {
    warn.textContent = `⚠ Saturated: peak ≈ ${r.peakADU.toFixed(0)} ADU exceeds the ` +
      `${C.camera.saturation_adu} ADU full well. Shorten the exposure.`;
  } else if (r.satPct >= 70) {
    warn.textContent = `⚠ Near saturation (${r.satPct.toFixed(0)} % of full well). Stay below ~70 % for linear photometry.`;
  } else {
    warn.classList.add("ok");
    warn.textContent = `✓ Peak at ${r.satPct.toFixed(0)} % of full well — safely in the linear regime.`;
  }

  renderExpDerived(inp, r);

  const warnBox = document.getElementById("input-warnings");
  if (r.warnings && r.warnings.length) {
    warnBox.innerHTML = r.warnings.map((w) =>
      `<div class="input-warning">⚠ ${w}</div>`).join("");
  } else {
    warnBox.innerHTML = "";
  }
}

// Inline readout of the complementary exposure quantity, next to the fields.
function renderExpDerived(inp, r) {
  const el = document.getElementById("exp-derived");
  if (inp.expmode === "single") {
    el.classList.add("hidden"); el.innerHTML = ""; return;
  }
  el.classList.remove("hidden");
  const L = r.tFrame, N = r.nSub, T = r.t;
  if (inp.expmode === "total") {
    el.innerHTML = `total <b>${fmtTime(T)}</b> &nbsp;→&nbsp; ` +
      `<b>${N}</b> sub${N > 1 ? "s" : ""} of <b>${L.toFixed(1)} s</b> ` +
      `<small>(each sub ≤ ${inp.satlimit | 0}% of full well; achieved S/N ` +
      `${r.snr.toFixed(1)})</small>`;
  } else if (inp.expmode === "nsub_len") {
    let html = `${N} × ${L.toFixed(1)} s &nbsp;→&nbsp; total <b>${fmtTime(T)}</b>` +
      (inp.mode === "time" ? " &nbsp;(N from target SNR)" : "");
    if (inp.mode === "time" && N === 1 && r.snr > 1.3 * inp.snr) {
      html += `<br><small>⚠ a single ${L.toFixed(0)} s sub already overshoots S/N ` +
        `${inp.snr} (achieved ${r.snr.toFixed(0)}). Reduce the sub length to ` +
        `step finer, or switch to "Fixed total time" to size subs by saturation.</small>`;
    }
    el.innerHTML = html;
  } else { // split
    el.innerHTML = `total <b>${fmtTime(T)}</b> ÷ ${N} &nbsp;→&nbsp; ` +
      `sub <b>${L.toFixed(1)} s</b>` + (inp.mode === "time" ? " &nbsp;(total from target SNR)" : "");
  }
}

// ---------------------------------------------------------------------------
// Export results as a plain-text file
// ---------------------------------------------------------------------------
function exportResults() {
  if (!LAST) return;
  const { inp, r } = LAST;
  const total = r.noise.star + r.noise.sky + r.noise.dark + r.noise.read;
  const pct = (v) => (100 * v / Math.max(total, 1e-30)).toFixed(1).padStart(5) + " %";
  const L = [];
  L.push("Vienna 0.8m Exposure Time Calculator");
  L.push("Generated: " + new Date().toISOString());
  L.push("Constants: " + (C.meta && C.meta.derived_from || "constants.json"));
  L.push("");
  L.push("=== INPUTS ===");
  L.push(`Filter (observing):  ${inp.filter}`);
  L.push(`Target type:         ${inp.ttype}`);
  if (inp.sed.mode !== "flat") {
    const tag = inp.sed.mode === "bb" ? `blackbody ${inp.sed.T} K` : `spectral type ${inp.sed.type}`;
    L.push(`Source spectrum:     ${tag} (mag given in ${inp.refband})`);
  }
  if (inp.ttype === "extended") {
    L.push(`  profile:           ${inp.profile}` +
           (inp.profile === "sersic" ? ` (n = ${inp.sersicN})` : ""));
    L.push(`  angular size:      ${inp.size}"  (${SRC.SIZE_HINT[inp.profile]})`);
    L.push(`  brightness mode:   ${inp.normmode === "sb" ? "surface brightness" : "total magnitude"}`);
    L.push(`  brightness value:  ${inp.mag}${inp.normmode === "sb" ? " mag/arcsec^2" : " mag"}`);
    L.push(`  extraction ap:     ${inp.extap > 0 ? inp.extap + '"' : "1 pixel (peak)"}`);
  } else {
    L.push(`Magnitude:           ${inp.mag} (in ${inp.sed.mode === "flat" ? inp.filter : inp.refband})`);
  }
  L.push(`Airmass:             ${inp.airmass}`);
  L.push(`Seeing FWHM:         ${inp.seeing}"`);
  L.push(`Sky brightness x:    ${inp.skymult}`);
  L.push(`Moon illumination:   ${inp.moonillum}    separation: ${inp.moonsep} deg`);
  L.push(`Binning:             ${inp.binning} x ${inp.binning}`);
  L.push(`Readout mode:        ${inp.readmode}`);
  L.push(`Cooler temperature:  ${inp.cooltemp} C`);
  if (inp.ttype !== "extended") L.push(`Aperture:            ${inp.aperture} x FWHM`);
  L.push(`Exposure structure:  ${inp.expmode}`);
  if (inp.expmode === "total") {
    L.push(`  total time:        ${inp.exptime} s`);
    L.push(`  saturation limit:  ${inp.satlimit} %  (per sub)`);
  } else {
    L.push(`Solve mode:          ${inp.mode === "time" ? "exposure-from-SNR" : "SNR-from-exposure"}`);
    if (inp.mode === "time") L.push(`Target SNR:          ${inp.snr}`);
  }
  L.push("");
  L.push("=== RESULTS ===");
  L.push(`Total exposure:      ${fmtTime(r.t)}  (${r.t.toFixed(2)} s)`);
  if (r.nSub > 1) L.push(`Sub-exposures:       ${r.nSub} x ${r.tFrame.toFixed(2)} s`);
  L.push(`Total time:          ${fmtTime(r.wallTime)}  (${r.wallTime.toFixed(1)} s, ` +
         `incl. ${r.nSub} x ${r.tRead} s readout/download)`);
  L.push(`SNR achieved:        ${r.snr.toFixed(2)}`);
  L.push(`Source rate:         ${r.signalRate.toExponential(3)} e-/s   (in extraction aperture)`);
  L.push(`Signal in aperture:  ${r.signalE.toFixed(0)} e-  (${(r.signalE / r.gain).toFixed(0)} ADU)`);
  L.push(`Peak pixel${r.nSub > 1 ? " /sub" : "       "}:  ${r.peakE.toFixed(0)} e-  (${r.peakADU.toFixed(0)} ADU)`);
  L.push(`Saturation${r.nSub > 1 ? " /sub" : "       "}: ${r.satPct.toFixed(1)} %`);
  L.push(`Dark current:        ${r.Rdark.toFixed(3)} e-/s/px @ ${inp.cooltemp} C`);
  L.push(`Sky rate:            ${r.Rsky.toFixed(3)} e-/s/px  (moon factor ${r.moonMult.toFixed(2)})`);
  L.push(`Sky / pixel total:   ${r.skyPerPixE.toFixed(1)} e-`);
  L.push(`Aperture pixels:     ${r.nPix.toFixed(1)} binned px`);
  if (r.mLim != null && isFinite(r.mLim)) {
    L.push(`Limiting mag (S/N=5): ${r.mLim.toFixed(2)} mag in ${inp.filter}`);
  }
  L.push("");
  L.push("=== NOISE BREAKDOWN (variance %) ===");
  L.push(`Source (Poisson):    ${pct(r.noise.star)}`);
  L.push(`Sky:                 ${pct(r.noise.sky)}`);
  L.push(`Dark current:        ${pct(r.noise.dark)}`);
  L.push(`Read noise:          ${pct(r.noise.read)}`);
  L.push("");

  const blob = new Blob([L.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url; a.download = `etc_${inp.filter}_${stamp}.txt`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------
const charts = {};
const COL = { line: "#6366f1", pt: "#22d3ee", grid: "#2b3040", txt: "#9aa6bf" };

function baseOpts(xlabel, ylabel) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false },
      title: { display: true, color: COL.txt, text: `${ylabel} vs ${xlabel}` } },
    scales: {
      x: { type: "linear", title: { display: true, text: xlabel, color: COL.txt },
           ticks: { color: COL.txt }, grid: { color: COL.grid } },
      y: { title: { display: true, text: ylabel, color: COL.txt },
           ticks: { color: COL.txt }, grid: { color: COL.grid } },
    },
    parsing: false,
  };
}

function lineChart(id, xs, ys, xlabel, ylabel, marker) {
  const datasets = [
    { data: xs.map((x, i) => ({ x, y: ys[i] })), borderColor: COL.line,
      borderWidth: 2, pointRadius: 0, tension: .2 },
  ];
  if (marker && isFinite(marker.x) && isFinite(marker.y)) {
    datasets.push({ data: [{ x: marker.x, y: marker.y }], showLine: false,
      pointBackgroundColor: COL.pt, pointRadius: 5 });
  }
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id),
    { type: "line", data: { datasets }, options: baseOpts(xlabel, ylabel) });
}

function updateCharts(inp, r) {
  const np = r.nPix, Rsky = r.Rsky, Rdark = r.Rdark, Nread = r.Nread, S0 = r.signalRate;
  // reads vs total time: grows as T/L for fixed-length subs; constant N for a
  // fixed split; 1 for a single exposure.
  const nReadsOf = (t) => {
    if (inp.expmode === "nsub_len") return Math.max(1, t / r.tFrame);
    if (inp.expmode === "split") return r.nSub;
    return 1;
  };

  // SNR vs total exposure time
  const tMax = Math.max(r.t * 2.5, 5);
  const ts = lin(0.1, tMax, 80);
  lineChart("chart-time", ts,
    ts.map((t) => snrForTime(S0, t, np, Rsky, Rdark, Nread, nReadsOf(t))),
    "total exposure [s]", "SNR", { x: r.t, y: r.snr });

  // SNR vs brightness (signal scales as 10^(0.4 (b0 - b)); fixed time & sub count)
  const blabel = inp.ttype === "extended"
    ? (inp.normmode === "sb" ? "surface brightness" : "total magnitude") : "magnitude";
  const bs = lin(r.b - 4, r.b + 4, 80);
  lineChart("chart-mag", bs,
    bs.map((b) => snrForTime(S0 * Math.pow(10, 0.4 * (r.b - b)), r.t, np, Rsky, Rdark, Nread, r.nSub)),
    blabel, "SNR", { x: r.b, y: r.snr });

  // SNR vs airmass (signal scales as 10^(0.4 k (X0 - X)))
  const ams = lin(1.0, 2.5, 60);
  lineChart("chart-airmass", ams,
    ams.map((X) => snrForTime(S0 * Math.pow(10, 0.4 * r.k * (inp.airmass - X)), r.t, np, Rsky, Rdark, Nread, r.nSub)),
    "airmass", "SNR", { x: inp.airmass, y: r.snr });

  // Peak ADU vs single-frame exposure (saturation)
  const tfMax = Math.max(r.tFrame * 2.5, 5);
  const tfs = lin(0.1, tfMax, 80);
  const adus = tfs.map((tf) => peakElectrons(r.peakRate, tf, Rsky, Rdark) / r.gain);
  satChart("chart-sat", tfs, adus, r.tFrame, r.peakADU,
    r.nSub > 1 ? "sub-exposure [s]" : "exposure time [s]");

  // Noise breakdown
  noiseChart("chart-noise", r.noise);
}

function satChart(id, xs, ys, tMark, aduMark, xlabel) {
  const opts = baseOpts(xlabel, "peak [ADU]");
  const sat = C.camera.saturation_adu;
  const data = { datasets: [
    { data: xs.map((x, i) => ({ x, y: ys[i] })), borderColor: COL.line,
      borderWidth: 2, pointRadius: 0, tension: .2 },
    { data: [{ x: tMark, y: aduMark }], showLine: false,
      pointBackgroundColor: COL.pt, pointRadius: 5 },
    { data: [{ x: xs[0], y: sat }, { x: xs[xs.length - 1], y: sat }],
      borderColor: "#ef4444", borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0 },
  ] };
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), { type: "line", data, options: opts });
}

function noiseChart(id, noise) {
  const vals = [noise.star, noise.sky, noise.dark, noise.read];
  const total = vals.reduce((a, v) => a + v, 0) || 1;
  const colors = ["#6366f1", "#9aa6bf", "#f59e0b", "#ef4444"];
  const labels = ["Source (Poisson)", "Sky", "Dark current", "Read noise"];
  const opts = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: "right", labels: {
        color: COL.txt, boxWidth: 12,
        generateLabels: (chart) => labels.map((lab, i) => ({
          text: `${lab} (${(100 * vals[i] / total).toFixed(0)} %)`,
          fillStyle: colors[i], strokeStyle: colors[i], index: i,
        })),
      } },
      title: { display: true, color: COL.txt, text: "Noise breakdown (variance %)" },
      tooltip: { callbacks: { label: (ctx) =>
        `${ctx.label}: ${(100 * ctx.parsed / total).toFixed(1)} %` } },
    },
  };
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), {
    type: "doughnut",
    data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderWidth: 0 }] },
    options: opts,
  });
}

function lin(a, b, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(a + (b - a) * i / (n - 1));
  return out;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
let LAST = null; // most recent {inp, r}, for the Export button
function recalc() {
  if (!C) return;
  const inp = readInputs();
  const r = compute(inp);
  LAST = { inp, r };
  renderResults(inp, r);
  updateCharts(inp, r);
}

function syncLabels() {
  const inp = readInputs();
  const ext = inp.ttype === "extended";
  document.getElementById("ext-controls").classList.toggle("hidden", !ext);
  const magLabel = document.getElementById("mag-label");
  const txt = ext
    ? (inp.normmode === "sb" ? "Surface brightness [mag/″²]" : "Total magnitude")
    : "Magnitude";
  // keep the <input> child, replace only the leading text node
  magLabel.childNodes[0].nodeValue = txt + " ";

  // SED block: shown for both point and extended, but with kind-appropriate
  // templates. Blackbody is hidden for extended sources (poor fit). The
  // #spectype list switches between stellar and extended-object templates.
  populateSpectype(ext ? "extended" : "point");
  const sedSel = document.getElementById("sed");
  const bbOpt = sedSel.querySelector('option[value="bb"]');
  bbOpt.hidden = ext;
  if (ext && sedSel.value === "bb") sedSel.value = "flat";
  const sed = sedSel.value;
  document.getElementById("sed-label").classList.remove("hidden");
  document.getElementById("bb-label").classList.toggle("hidden", ext || sed !== "bb");
  document.getElementById("spec-label").classList.toggle("hidden", sed !== "spec");
  document.getElementById("refband-label").classList.toggle("hidden", sed === "flat");

  // Sérsic n input + size-hint label depend on the chosen profile
  document.getElementById("sersic-n-label").classList.toggle(
    "hidden", val("profile") !== "sersic");
  document.getElementById("size-hint").textContent =
    SRC.SIZE_HINT[val("profile")] || "diameter";

  // exposure-structure fields, per (solve mode, exposure structure)
  const mode = inp.mode, em = inp.expmode;
  const show = (id, on) => document.getElementById(id).classList.toggle("hidden", !on);
  show("f-satlimit", em === "total");

  if (em === "total") {
    // total is user-given; N is derived from saturation; solve-mode is ignored.
    show("snr-input", false);
    show("f-total", true);
    show("f-sublen", false);
    show("f-nsub", false);
  } else {
    show("snr-input", mode === "time");
    if (mode === "time") {                       // total is solved -> hide it
      show("f-total", false);
      show("f-sublen", em === "nsub_len");
      show("f-nsub", em === "split");
    } else {                                     // exposure given -> compute SNR
      show("f-total", em !== "nsub_len");
      show("f-sublen", em === "nsub_len");
      show("f-nsub", em !== "single");
    }
  }
  document.getElementById("f-total").childNodes[0].nodeValue =
    (em === "single" ? "Exposure time [s] " : "Total exposure time [s] ");
}

function setupConditionals() {
  ["sed", "normmode", "expmode", "profile"].forEach((id) =>
    document.getElementById(id).addEventListener("change", syncLabels));
  document.querySelectorAll('input[name="ttype"], input[name="mode"]').forEach((el) =>
    el.addEventListener("change", syncLabels));
  document.getElementById("export-btn").addEventListener("click", exportResults);
}

function setupAltitudeLink() {
  // Live two-way link between airmass X and altitude a:  X = sec(90° - a).
  // Assigning .value programmatically does not refire the input event, so the
  // two listeners cannot create a loop.
  const alt = document.getElementById("altitude");
  const air = document.getElementById("airmass");
  alt.addEventListener("input", () => {
    const a = parseFloat(alt.value);
    if (isFinite(a) && a > 0 && a <= 90) {
      air.value = (1 / Math.cos((90 - a) * Math.PI / 180)).toFixed(3);
    }
  });
  air.addEventListener("input", () => {
    const x = parseFloat(air.value);
    if (isFinite(x) && x >= 1) {
      alt.value = (90 - Math.acos(Math.min(1, 1 / x)) * 180 / Math.PI).toFixed(1);
    }
  });
}

function showFatalError(msg) {
  const el = document.createElement("div");
  el.className = "fatal-error";
  el.innerHTML = "⚠ " + msg;
  document.body.prepend(el);
  console.error(msg);
}

async function init() {
  try {
    const res = await fetch("constants.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    C = await res.json();
  } catch (err) {
    showFatalError(
      `Could not load <code>constants.json</code> (${err.message}). ` +
      `Serve the <code>docs/</code> folder over HTTP and browse it via ` +
      `<code>http://localhost:&lt;port&gt;/</code> — open a terminal in ` +
      `<code>docs/</code>, run <code>python -m http.server 8000</code>, then ` +
      `open <code>http://localhost:8000/</code>. Browsers block <code>fetch()</code> ` +
      `on <code>file://</code> URLs.`);
    return;
  }
  const bands = Object.keys(C.filters).filter((f) => C.filters[f].zeropoint_mag_1es != null);

  const opts = bands.map((f) => `<option value="${f}">${f}</option>`).join("");
  document.getElementById("filter").innerHTML = opts;
  document.getElementById("filter").value = bands.includes("V") ? "V" : bands[0];
  document.getElementById("refband").innerHTML = opts;
  document.getElementById("refband").value = bands.includes("V") ? "V" : bands[0];
  populateSpectype("point");

  setupConditionals();
  setupAltitudeLink();
  syncLabels();
  document.querySelectorAll("input, select").forEach((el) =>
    el.addEventListener("input", recalc));
  recalc();
}

init();
