"use strict";

// C holds the ACTIVE instrument's constants (same shape as a single
// constants.json). MANIFEST is the instruments.json registry and ACTIVE is the
// selected manifest entry {id, label, type, file}. Switching instruments swaps
// C; all the physics below is instrument-agnostic and reads only from C.
let C = null;
let MANIFEST = null;
let ACTIVE = null;

// Shared with almanac.js: persisted instrument choice and the one-shot
// airmass/Moon hand-off ("Use in ETC").
const INSTRUMENT_KEY = "etc_instrument";
const HANDOFF_KEY = "etc_almanac_handoff";

// S/N threshold used for the reported limiting magnitude.
const SIGMA_LIM = 5;

// Binned pixel scale [arcsec/pix] for the active instrument.
const binnedScale = (binning) => C.pixel_scale_arcsec_unbinned * binning;

// Airmass X <-> altitude a [deg]:  X = sec(90 deg - a).
const airmassToAltitude = (X) => 90 - Math.acos(Math.min(1, 1 / X)) * 180 / Math.PI;
const altitudeToAirmass = (a) => 1 / Math.cos((90 - a) * Math.PI / 180);

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
  const refBin = C.reference_binning || 2;
  return C.filters[filter].sky_rate_e_per_s_per_pix *
    Math.pow(binning / refBin, 2) * skyMult * moonMult;
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
  const refBin = C.reference_binning || 2;
  const sBinRef = binnedScale(refBin); // sky rate's reference binning
  const dark_per_arcsec2 = C.filters.V.sky_rate_e_per_s_per_pix / (sBinRef * sBinRef);
  const mu_dark = C.filters.V.zeropoint_mag_1es - 2.5 * Math.log10(dark_per_arcsec2);
  return 1 + Math.pow(10, -0.4 * (mu_moon - mu_dark));
}
function darkRate(binning, tempC) {
  const cam = C.camera;
  const ref = cam.dark_ref_temp_c != null ? cam.dark_ref_temp_c : -5;
  const dbl = cam.dark_doubling_kelvin || 6.3;
  const Dref = cam["dark_current_e_per_s_at_-5C"];
  const D = Dref * Math.pow(2, (tempC - ref) / dbl);
  const refBin = C.reference_binning || 2;
  return D * Math.pow(binning / refBin, 2);
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
  const sBinned = binnedScale(binning);
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
  const sBinned = binnedScale(inp.binning);
  const sigmaPx = (inp.seeing / sBinned) / 2.3548;
  return {
    signalRate: Rstar, nPix: nPixPoint(inp.seeing, inp.binning, inp.aperture),
    peakRate: Rstar / (2 * Math.PI * sigmaPx * sigmaPx),
  };
}

// Radial analytic extended source. Peak SB is seeing-limited (mean SB within a
// disc of diameter = seeing FWHM, centred on the source).
function buildExtended(inp, b) {
  const sBinned = binnedScale(inp.binning);
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

// Resolve the chosen observing mode into total time T, sub count N, and the
// SNR, plus `solvedFor` (which quantity was the output) and an optional `err`
// message when the inputs are over/under-determined or the target is
// unreachable. `src` is the {signalRate, nPix, peakRate} triple.
//
// Three modes:
//   single   — time given, N=1            -> SNR
//   snr      — SNR given, N=1             -> exposure time
//   strategy — {time, N, SNR}, leave one blank; the blank one is solved. The
//              `timebasis` toggle makes the time field a per-sub length or the
//              total integration. `nauto` sizes N from the saturation limit.
function resolveExposure(inp, src, Rsky, Rdark, Nread, gain) {
  const S = src.signalRate, nPix = src.nPix;
  const snrAt = (T, N) => snrForTime(S, T, nPix, Rsky, Rdark, Nread, N);
  const blocked = (err) => ({ t: NaN, nSub: 1, snr: NaN, solvedFor: null, err });

  if (inp.solvemode === "single") {
    const T = Math.max(0.01, inp.exptime || 0);
    return { t: T, nSub: 1, snr: snrAt(T, 1), solvedFor: "snr" };
  }
  if (inp.solvemode === "snr") {
    const target = inp.snr;
    if (target == null || !(target > 0)) return blocked("Enter a positive target SNR.");
    const T = timeForSnrFixedReads(S, target, nPix, Rsky, Rdark, Nread, 1);
    return { t: T, nSub: 1, snr: snrAt(T, 1), solvedFor: "exptime" };
  }

  // ---- strategy ----
  const total = inp.timebasis === "total";
  const haveTime = inp.exptime != null && isFinite(inp.exptime);
  const haveSnr = inp.snr != null && isFinite(inp.snr);

  // Auto sub-count: N comes from the saturation limit (needs a total time), so
  // the SNR must be the blank/solved field. This reproduces the old
  // "fixed total time, auto-size subs" workflow.
  if (inp.nauto) {
    if (!haveTime) return blocked("Auto sub-count needs a total exposure time.");
    if (haveSnr)   return blocked("Overdetermined: with Auto sub-count, leave the Target SNR blank.");
    const T = Math.max(0.01, inp.exptime);
    const satFrac = Math.min(1, Math.max(0.05, (inp.satlimit || 70) / 100));
    const satE = C.camera.saturation_adu * gain * satFrac;
    const peakPerSec = src.peakRate + Rsky + Rdark;
    const tSubMax = peakPerSec > 0 ? satE / peakPerSec : T;
    const N = Math.max(1, Math.ceil(T / tSubMax));
    return { t: T, nSub: N, snr: snrAt(T, N), solvedFor: "snr" };
  }

  const haveN = inp.nsub != null && isFinite(inp.nsub);
  const blanks = [!haveTime, !haveN, !haveSnr].filter(Boolean).length;
  if (blanks === 0) return blocked("Overdetermined: clear one of time / N / SNR so it can be solved.");
  if (blanks > 1)   return blocked("Underdetermined: leave exactly one of time / N / SNR blank.");

  // blank SNR — forward compute from (time, N)
  if (!haveSnr) {
    const N = Math.max(1, Math.round(inp.nsub));
    const T = total ? Math.max(0.01, inp.exptime) : N * Math.max(0.01, inp.exptime);
    return { t: T, nSub: N, snr: snrAt(T, N), solvedFor: "snr" };
  }
  // blank exposure time — solve total T for the target SNR with N reads fixed
  if (!haveTime) {
    const N = Math.max(1, Math.round(inp.nsub));
    const T = timeForSnrFixedReads(S, inp.snr, nPix, Rsky, Rdark, Nread, N);
    return { t: T, nSub: N, snr: snrAt(T, N), solvedFor: "exptime" };
  }
  // blank N — solve the sub count for the target SNR
  if (!total) {                                // per-sub length L fixed
    const L = Math.max(0.01, inp.exptime);
    let T = timeForSnrFixedSubLen(S, inp.snr, nPix, Rsky, Rdark, Nread, L);
    const N = Math.max(1, Math.ceil(T / L)); T = N * L;
    const res = { t: T, nSub: N, snr: snrAt(T, N), solvedFor: "nsub" };
    if (N === 1 && res.snr > 1.3 * inp.snr) {
      res.err = `A single ${L.toFixed(0)} s sub already overshoots S/N ${inp.snr} ` +
        `(reaches ${res.snr.toFixed(0)}). Shorten the sub length to step finer.`;
    }
    return res;
  }
  // total time fixed: most subs the total can be split into and still hit target
  const T = Math.max(0.01, inp.exptime);
  if (snrAt(T, 1) < inp.snr) {
    return { t: T, nSub: 1, snr: snrAt(T, 1), solvedFor: "nsub",
      err: `This total only reaches S/N ${snrAt(T, 1).toFixed(1)} even as a single ` +
        `exposure (target ${inp.snr}). Increase the total time or lower the target.` };
  }
  let N = 1;
  while (N < 100000 && snrAt(T, N + 1) >= inp.snr) N++;   // snrForTime ↓ as N ↑
  return { t: T, nSub: N, snr: snrAt(T, N), solvedFor: "nsub" };
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
  const sBinned = binnedScale(inp.binning);
  const peakE = peakElectrons(src.peakRate, tFrame, Rsky, Rdark);

  // Wall-clock total = N × (sub length + per-frame readout/download).
  const tRead = (C.camera.readout_time_s && C.camera.readout_time_s[inp.readmode])
                || 1.0;
  const wallTime = nSub * (tFrame + tRead);

  // Input-sanity warnings (shown in the results area; don't change the math).
  // The exposure-solve message (ex.err) is shown inside the Exposure & SNR box
  // instead — see renderExpDerived — so it's visible without scrolling.
  const warnings = [];
  if (inp.airmass > 5) {
    const alt = airmassToAltitude(inp.airmass);
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
    moonMult, tRead, wallTime, mLim, warnings, solvedFor: ex.solvedFor, err: ex.err,
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
// blank-aware numeric read: an empty field is null (not NaN/0), so the solver
// can tell "left blank to solve" from "given the value 0".
const numN = (id) => {
  const v = document.getElementById(id).value.trim();
  return v === "" ? null : parseFloat(v);
};

function readInputs() {
  const sedMode = val("sed");
  return {
    filter: val("filter"),
    ttype: document.querySelector('input[name="ttype"]:checked').value,
    mag: num("mag"),
    solvemode: val("solvemode"),
    timebasis: document.querySelector('input[name="timebasis"]:checked').value,
    nauto: document.getElementById("nauto").checked,
    snr: numN("snr"),
    exptime: numN("exptime"),
    nsub: numN("nsub"),
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
  const h = Math.floor(t / 3600);
  const m = Math.round((t - h * 3600) / 60);
  // carry a rounded-up 60 min back into the hours
  const hh = h + (m === 60 ? 1 : 0);
  const mm = m === 60 ? 0 : m;
  return `${hh}:${String(mm).padStart(2, "0")} h`;
}

function renderResults(inp, r) {
  const label = document.getElementById("headline-label");
  const value = document.getElementById("headline-value");
  if (r.solvedFor === "exptime") {
    label.textContent = `Exposure time for SNR ${inp.snr}`;
    value.textContent = fmtTime(r.t);
  } else if (r.solvedFor === "nsub") {
    label.textContent = `Subs of ${fmtTime(r.tFrame)} for SNR ${inp.snr}`;
    value.textContent = isFinite(r.nSub) ? `${r.nSub}` : "—";
  } else if (r.solvedFor === "snr") {
    label.textContent = `SNR in ${fmtTime(r.t)}`;
    value.textContent = isFinite(r.snr) ? r.snr.toFixed(1) : "—";
  } else {                                     // unsolvable / ill-posed inputs
    label.textContent = "Cannot solve — check inputs";
    value.textContent = "—";
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
// Only shown in "strategy" mode (single / snr modes have nothing complementary).
function renderExpDerived(inp, r) {
  const el = document.getElementById("exp-derived");

  // Solve/determinacy message lives next to the fields so it's seen without
  // scrolling to the results (over/under-determined, unreachable target, …).
  const warn = document.getElementById("exp-warning");
  if (r.err) { warn.classList.remove("hidden"); warn.textContent = "⚠ " + r.err; }
  else { warn.classList.add("hidden"); warn.textContent = ""; }

  if (inp.solvemode !== "strategy" || !isFinite(r.t)) {
    el.classList.add("hidden"); el.innerHTML = ""; return;
  }
  el.classList.remove("hidden");
  const L = r.tFrame, N = r.nSub, T = r.t;
  const structure = `<b>${N}</b> × <b>${L.toFixed(1)} s</b> &nbsp;→&nbsp; total <b>${fmtTime(T)}</b>`;
  let note;
  if (inp.nauto) {
    note = `<small>(N auto-sized so each sub ≤ ${inp.satlimit | 0}% of full well; ` +
      `achieved S/N ${r.snr.toFixed(1)})</small>`;
  } else if (r.solvedFor === "snr") {
    note = `<small>(achieved S/N ${r.snr.toFixed(1)})</small>`;
  } else if (r.solvedFor === "nsub") {
    note = `<small>(N from target S/N ${inp.snr})</small>`;
  } else {                                     // solvedFor === "exptime"
    note = `<small>(${inp.timebasis === "total" ? "total" : "sub length"} from target S/N ${inp.snr})</small>`;
  }
  el.innerHTML = `${structure} ${note}`;
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
  L.push((ACTIVE ? ACTIVE.label : "") + " Exposure Time Calculator");
  L.push("Generated: " + new Date().toISOString());
  L.push("Instrument: " + (ACTIVE ? `${ACTIVE.label} [${ACTIVE.id}]` : "—"));
  L.push("Constants: " + (C.meta && C.meta.derived_from || "constants.json"));
  if (C.meta && C.meta.status_banner) L.push("NOTE: " + C.meta.status_banner);
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
  const modeLabel = { single: "single exposure", snr: "target SNR",
                      strategy: "observing strategy" }[inp.solvemode];
  L.push(`Observing mode:      ${modeLabel}`);
  if (inp.solvemode === "strategy") {
    L.push(`  time basis:        ${inp.timebasis === "total" ? "total integration" : "per sub-exposure"}`);
    if (inp.nauto) L.push(`  sub-count:         auto (≤ ${inp.satlimit} % full well per sub)`);
    const solved = { snr: "SNR", exptime: "exposure time", nsub: "number of subs" }[r.solvedFor] || "—";
    L.push(`  solved for:        ${solved}`);
  }
  if (inp.snr != null && isFinite(inp.snr) && r.solvedFor !== "snr") {
    L.push(`Target SNR:          ${inp.snr}`);
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
  a.href = url;
  a.download = `etc_${ACTIVE ? ACTIVE.id + "_" : ""}${inp.filter}_${stamp}.txt`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------
const charts = {};
const COL = { line: "#6366f1", pt: "#22d3ee", grid: "#2b3040", txt: "#9aa6bf",
              panel: "#1f232f" };  // matches --panel-2; used as marker halo

function baseOpts(xlabel, ylabel) {
  // Chart title is shown in the HTML header above each canvas (so it stays
  // visible when the plot is collapsed); we don't repeat it inside the chart.
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { type: "linear", title: { display: true, text: xlabel, color: COL.txt },
           ticks: { color: COL.txt }, grid: { color: COL.grid } },
      y: { title: { display: true, text: ylabel, color: COL.txt },
           ticks: { color: COL.txt }, grid: { color: COL.grid } },
    },
    parsing: false,
  };
}

// Chart.js dataset draw order: HIGHER order = drawn FIRST (background).
// We give the marker the lowest order so it sits on top of the line, and add a
// panel-coloured halo so the line clearly stops at the marker rather than
// passing through it.
function lineChart(id, xs, ys, xlabel, ylabel, marker) {
  const datasets = [
    { data: xs.map((x, i) => ({ x, y: ys[i] })), borderColor: COL.line,
      borderWidth: 2, pointRadius: 0, tension: .2, order: 2 },
  ];
  if (marker && isFinite(marker.x) && isFinite(marker.y)) {
    datasets.push({ data: [{ x: marker.x, y: marker.y }], showLine: false,
      pointBackgroundColor: COL.pt, pointRadius: 6,
      pointBorderColor: COL.panel, pointBorderWidth: 2, order: 0 });
  }
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id),
    { type: "line", data: { datasets }, options: baseOpts(xlabel, ylabel) });
}

function updateCharts(inp, r) {
  const np = r.nPix, Rsky = r.Rsky, Rdark = r.Rdark, Nread = r.Nread, S0 = r.signalRate;
  // reads vs total time: when the sub length is the fixed quantity the read
  // count grows as T/L; otherwise the sub count stays put (1 for a single).
  const subLenFixed = inp.solvemode === "strategy" &&
    (inp.timebasis === "persub" || inp.nauto);
  const nReadsOf = (t) =>
    subLenFixed ? Math.max(1, t / r.tFrame) : Math.max(1, r.nSub);

  // SNR vs total exposure time
  const tMax = Math.max(r.t * 2.5, 5);
  const ts = lin(0.1, tMax, 80);
  lineChart("chart-time", ts,
    ts.map((t) => snrForTime(S0, t, np, Rsky, Rdark, Nread, nReadsOf(t))),
    "total exposure [s]", "SNR", { x: r.t, y: r.snr });

  // Limiting in-band magnitude (S/N = SIGMA_LIM) vs total exposure time.
  // Same setup (aperture, sub count, conditions); for an extended source the
  // line is the limiting integrated mag inside the extraction aperture.
  const limMagAt = (t, nReads) => {
    if (t <= 0) return NaN;
    const Bvar = np * (t * (Rsky + Rdark) + nReads * Nread * Nread);
    const sLim = SIGMA_LIM * SIGMA_LIM / (2 * t) *
                 (1 + Math.sqrt(1 + 4 * Bvar / (SIGMA_LIM * SIGMA_LIM)));
    return magFor(sLim, inp.filter, inp.airmass);
  };
  const limYLabel = inp.ttype === "extended"
    ? "lim integrated mag (S/N=5)" : "lim mag (S/N=5)";
  const limMark = limMagAt(r.t, r.nSub);
  lineChart("chart-mlim", ts,
    ts.map((t) => limMagAt(t, nReadsOf(t))),
    "total exposure [s]", limYLabel, { x: r.t, y: limMark });

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
      borderWidth: 2, pointRadius: 0, tension: .2, order: 2 },
    { data: [{ x: tMark, y: aduMark }], showLine: false,
      pointBackgroundColor: COL.pt, pointRadius: 6,
      pointBorderColor: COL.panel, pointBorderWidth: 2, order: 0 },
    { data: [{ x: xs[0], y: sat }, { x: xs[xs.length - 1], y: sat }],
      borderColor: "#ef4444", borderWidth: 1.5, borderDash: [6, 4],
      pointRadius: 0, order: 3 },
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

  // exposure fields, per observing mode
  const sm = inp.solvemode, strategy = sm === "strategy";
  const show = (id, on) => document.getElementById(id).classList.toggle("hidden", !on);
  // Auto sub-count only applies to the total-time basis; clear it otherwise so a
  // hidden-but-checked box can't silently drive the solve.
  const nautoBox = document.getElementById("nauto");
  if (!(strategy && inp.timebasis === "total")) nautoBox.checked = false;
  const nauto = nautoBox.checked;

  show("timebasis-row", strategy);
  show("f-exptime", sm !== "snr");             // single & strategy use a time
  show("f-nsub", strategy && !nauto);          // N only in strategy (auto hides it)
  show("nauto-row", strategy && inp.timebasis === "total");
  show("f-snr", sm !== "single");              // snr & strategy use a target SNR
  show("f-satlimit", nauto);

  // relabel the time field for its current meaning
  const timeLabel = sm === "single" ? "Exposure time [s] "
    : !strategy ? "Exposure time [s] "
    : inp.timebasis === "total" ? "Total exposure time [s] "
    : "Sub-exposure length [s] ";
  document.getElementById("f-exptime").childNodes[0].nodeValue = timeLabel;
}

function setupConditionals() {
  ["sed", "normmode", "profile", "solvemode"].forEach((id) =>
    document.getElementById(id).addEventListener("change", syncLabels));
  document.querySelectorAll('input[name="ttype"], input[name="timebasis"]').forEach((el) =>
    el.addEventListener("change", syncLabels));
  document.getElementById("nauto").addEventListener("change", syncLabels);
  // When the user switches into strategy mode with all three fields filled it is
  // overdetermined; clear the Target SNR so the default is the forward solve.
  // Switching back to a mode that needs the SNR restores a sensible default.
  document.getElementById("solvemode").addEventListener("change", (e) => {
    const sm = e.target.value, snr = document.getElementById("snr");
    if (sm === "strategy" && document.getElementById("exptime").value.trim() !== ""
        && document.getElementById("nsub").value.trim() !== "" && snr.value.trim() !== "") {
      snr.value = "";
    } else if (sm === "snr" && snr.value.trim() === "") {
      snr.value = "100";
    }
    recalc();
  });
  document.getElementById("export-btn").addEventListener("click", exportResults);
}

// Per-chart show/hide. The collapsed state is persisted in localStorage so
// the page comes back the way the user left it. When uncollapsing we trigger
// a recompute so the canvas regets its size before Chart.js redraws.
const COLLAPSE_KEY = "etc:charts-collapsed";
function loadCollapsed() {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (e) { return new Set(); }
}
function saveCollapsed(set) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); }
  catch (e) { /* private mode etc. — silently ignore */ }
}
function setupChartToggles() {
  const collapsed = loadCollapsed();
  document.querySelectorAll(".chart-box[data-chart]").forEach((box) => {
    const id = box.dataset.chart;
    const btn = box.querySelector(".chart-toggle");
    if (!btn) return;
    const apply = (isColl) => {
      box.classList.toggle("collapsed", isColl);
      btn.textContent = isColl ? "+" : "−"; // minus sign
      btn.setAttribute("aria-expanded", isColl ? "false" : "true");
    };
    apply(collapsed.has(id));
    btn.addEventListener("click", () => {
      const isColl = !box.classList.contains("collapsed");
      apply(isColl);
      const set = loadCollapsed();
      if (isColl) set.add(id); else set.delete(id);
      saveCollapsed(set);
      if (!isColl) recalc();  // canvas got its size back -> redraw
    });
  });
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
      air.value = altitudeToAirmass(a).toFixed(3);
    }
  });
  air.addEventListener("input", () => {
    const x = parseFloat(air.value);
    if (isFinite(x) && x >= 1) {
      alt.value = airmassToAltitude(x).toFixed(1);
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

// Load one instrument's constants into C and re-init everything that depends on
// the instrument (filter/refband/readout-mode lists, header, provisional banner).
async function loadInstrument(entry) {
  try {
    const res = await fetch(entry.file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    C = await res.json();
  } catch (err) {
    showFatalError(
      `Could not load <code>${entry.file}</code> (${err.message}). ` +
      `Serve the <code>docs/</code> folder over HTTP and browse it via ` +
      `<code>http://localhost:&lt;port&gt;/</code> — open a terminal in ` +
      `<code>docs/</code>, run <code>python -m http.server 8000</code>, then ` +
      `open <code>http://localhost:8000/</code>. Browsers block <code>fetch()</code> ` +
      `on <code>file://</code> URLs.`);
    return;
  }
  ACTIVE = entry;
  try { localStorage.setItem(INSTRUMENT_KEY, entry.id); } catch (e) { /* private mode */ }

  // Filter + reference-band selects, from this instrument's characterised bands.
  const bands = Object.keys(C.filters).filter((f) => C.filters[f].zeropoint_mag_1es != null);
  const bandOpts = bands.map((f) => `<option value="${f}">${f}</option>`).join("");
  const filterSel = document.getElementById("filter");
  const refbandSel = document.getElementById("refband");
  filterSel.innerHTML = bandOpts;
  filterSel.value = bands.includes("V") ? "V" : bands[0];
  refbandSel.innerHTML = bandOpts;
  refbandSel.value = bands.includes("V") ? "V" : bands[0];

  // Readout-mode select, from this camera's read_noise_e keys (1 for PICO, 2 for
  // the 0.8 m). Kept in the constants so a camera swap needs no code change.
  const modes = Object.keys(C.camera.read_noise_e || {});
  const readSel = document.getElementById("readmode");
  readSel.innerHTML = modes.map((m) => `<option value="${m}">${m}</option>`).join("");
  readSel.value = modes[0];

  // Header subtitle + provisional banner from the instrument metadata.
  const sub = [
    ACTIVE.label,
    C.telescope && C.telescope.f_number ? `f/${C.telescope.f_number}` : null,
    C.camera && C.camera.model ? C.camera.model : null,
    C.meta && C.meta.derived_from ? `constants: ${C.meta.derived_from}` : null,
  ].filter(Boolean).join(" · ");
  const subEl = document.getElementById("instrument-sub");
  if (subEl) subEl.textContent = sub;
  const banner = document.getElementById("instrument-banner");
  if (banner) {
    const msg = C.meta && C.meta.status_banner;
    banner.textContent = msg ? "⚠ " + msg : "";
    banner.classList.toggle("hidden", !msg);
  }

  populateSpectype("point");
  syncLabels();
  recalc();
}

async function init() {
  try {
    const res = await fetch("instruments.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    MANIFEST = await res.json();
  } catch (err) {
    showFatalError(
      `Could not load <code>instruments.json</code> (${err.message}). ` +
      `Serve the <code>docs/</code> folder over HTTP — open a terminal in ` +
      `<code>docs/</code>, run <code>python -m http.server 8000</code>, then ` +
      `open <code>http://localhost:8000/</code>. Browsers block <code>fetch()</code> ` +
      `on <code>file://</code> URLs.`);
    return;
  }

  // Instrument select, from the manifest.
  const instSel = document.getElementById("instrument");
  instSel.innerHTML = MANIFEST.instruments
    .map((e) => `<option value="${e.id}">${e.label}</option>`).join("");
  const byId = (id) => MANIFEST.instruments.find((e) => e.id === id);
  // A hand-off from the almanac (airmass + Moon geometry) may name an
  // instrument and a stored selection persists across pages.
  const handoff = readAlmanacHandoff();
  const stored = (() => { try { return localStorage.getItem(INSTRUMENT_KEY); } catch (e) { return null; } })();
  const start = byId(handoff && handoff.instrument) || byId(stored)
    || byId(MANIFEST.default) || MANIFEST.instruments[0];
  instSel.value = start.id;
  instSel.addEventListener("change", () => loadInstrument(byId(instSel.value)));

  // One-time wiring (independent of the active instrument).
  setupConditionals();
  setupAltitudeLink();
  setupChartToggles();
  document.querySelectorAll("input, select").forEach((el) => {
    if (el.id !== "instrument") el.addEventListener("input", recalc);
  });

  await loadInstrument(start);
  if (handoff) applyAlmanacHandoff(handoff);
}

// Read (and consume) the almanac hand-off if it is fresh (< 5 min old). The
// payload carries the target's airmass/altitude and the Moon's illumination and
// separation as computed for the chosen UT instant.
function readAlmanacHandoff() {
  let raw;
  try { raw = localStorage.getItem(HANDOFF_KEY); } catch (e) { return null; }
  if (!raw) return null;
  try { localStorage.removeItem(HANDOFF_KEY); } catch (e) { /* ignore */ }
  let h;
  try { h = JSON.parse(raw); } catch (e) { return null; }
  if (!h || !h.ts || Date.now() - h.ts > 5 * 60 * 1000) return null;
  return h;
}

function applyAlmanacHandoff(h) {
  const set = (id, v) => {
    if (v == null || !isFinite(v)) return;
    const el = document.getElementById(id);
    if (el) el.value = v;
  };
  // airmass + its linked altitude (programmatic .value does not refire input)
  if (h.airmass != null && isFinite(h.airmass)) set("airmass", (+h.airmass).toFixed(3));
  if (h.altitude != null && isFinite(h.altitude)) set("altitude", (+h.altitude).toFixed(1));
  set("moonillum", Math.min(1, Math.max(0, +h.moonillum)).toFixed(2));
  set("moonsep", Math.round(Math.min(180, Math.max(0, +h.moonsep))));
  recalc();
  // positive, dedicated banner — distinct from the red provisional-instrument one
  const banner = document.getElementById("handoff-banner");
  if (banner) {
    banner.innerHTML = "✓ Imported from the almanac: airmass " +
      (h.airmass != null ? (+h.airmass).toFixed(2) : "—") +
      ", Moon illumination " + Math.round((+h.moonillum || 0) * 100) + "%" +
      (h.moonsep != null ? ", separation " + Math.round(+h.moonsep) + "°" : "") + ".";
    banner.classList.remove("hidden");
  }
}

init();
