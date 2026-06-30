# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multi-instrument exposure time calculator (ETC). The primary instrument is the
University of Vienna 0.8 m telescope (f/8.3, 6640 mm, FLI CCD, B/V/R/I filters);
a second, the **LFOA 1.5 m** (1.5 m / 12.5 m, carrying the **PICO** instrument —
an Andor Zyla 4.2-P sCMOS, Bessel V/R), is also selectable. Two halves that meet
at the per-instrument constants files:

- **`docs/`** — a static, dependency-free web app (the deliverable, hosted on
  GitHub Pages). All ETC physics lives here in JS.
- **`reduction/`** — an offline Python pipeline that derives the **0.8 m's**
  instrumental constants **from real FITS data** (the 2026-02-18 observing run).

### Instruments (multi-instrument layout)
`docs/instruments.json` is a manifest the app fetches first: a `default` id and a
list of `{id, label, type, file}` entries (`type` is `"imager"`; it's the
extension point for a future `"spectrograph"`). Each entry's `file` is a
constants document with the **same shape** as the 0.8 m's. Every instrument file
lives under `docs/instruments/`:
- 0.8 m → `docs/instruments/vienna_0.8m.json` (the reduction pipeline's deployed
  output; the pipeline still also writes `reduction/constants.json`, contract
  below unchanged).
- LFOA 1.5 m (PICO) → `docs/instruments/pico_1.5m.json`, hand-authored from the
  spec sheet; its zero points / sky / extinction are **provisional estimates**
  (no calibration data), flagged via `meta.status_banner` (shown as a page
  banner).

To add an instrument: drop a constants file in `docs/instruments/` and add a line
to the manifest. To swap a camera: edit that one file. The web app's `C` global
holds the **active** instrument's constants; all physics reads only from `C`, so
nothing else changes.

The reduction contract is unchanged for the 0.8 m: the pipeline writes
`reduction/constants.json` and, in the same step, the identical file to
`docs/instruments/vienna_0.8m.json` (so the two never drift). There is no build
step and no server runtime — "deployment" of new constants is that second write.
One field,
`reference_binning` (the binning at which the sky/dark
rates are stored — 2 for the 0.8 m, 1 for PICO), generalises the per-pixel rate
scaling in `skyRate`/`darkRate`/`moonFactor`.

## Commands

### Web app (no dependencies)
```bash
cd docs && python -m http.server 8000   # then open http://localhost:8000
```

### Headless smoke test (the closest thing to a test suite)
```bash
# requires playwright: pip install playwright && playwright install chromium
python reduction/verify_webapp.py        # serves docs/, drives it, writes web_*.png screenshots
```
This checks for JS console errors, verifies results compute, exercises the mode
toggle / filter change / extended-source / SED / moon / sub-exposure paths, and
dumps screenshots into `reduction/` for visual inspection. Run it after any
change to `docs/`.

### Reduction pipeline
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r reduction/requirements.txt
export ASTROMETRY_API_KEY=your_key       # only the photometry step needs it
cd reduction && python run_all.py        # writes reduction/constants.json + docs/instruments/vienna_0.8m.json
```
Needs raw FITS under `data/<run-date>/<frame-type>/` (not committed — large).
The detector and sky steps run offline; only the zero-point/extinction step
contacts astrometry.net and Vizier. `photometry_records.json` caches the
plate-solve + cross-match result — delete it to force a re-solve.

## Architecture

### Web app (`docs/`)
- **`app.js`** — the ETC engine and all UI plumbing. Core math is built on a
  generic `{signalRate, nPix, peakRate}` triple (e-/s in aperture, pixels in
  aperture, peak per-pixel rate) produced by `buildPoint` / `buildExtended`,
  then fed to `snrForTime` / `timeForSnr*`. **Read noise is paid once per sub
  and saturation is checked per sub** — `resolveExposure` turns the chosen
  exposure structure (single / N×fixed-length / split-total) into `(T, N, subLen)`
  honoring the solve mode. `compute()` is the orchestrator. `init()` loads the
  `instruments.json` manifest and populates the instrument `<select>`;
  `loadInstrument()` fetches the chosen instrument's constants into `C` and
  rebuilds the instrument-dependent UI (filter/refband/readout-mode lists,
  header subtitle, provisional banner) — the readout-mode options come from
  `Object.keys(C.camera.read_noise_e)`, not hardcoded HTML.
- **`sources.js`** — pure helpers with no dependency on the loaded constants
  (`C`): the SED color converter and the 2D extended-source profiles (uniform /
  Gaussian / Sérsic). Instrument values are passed in as arguments.
- **`methods.html` + `methods.js`** — a formula/methods reference page;
  `methods.js` injects live numbers from `instruments/vienna_0.8m.json` (it
  fetches that file directly) into `data-c="a|b|c"` spans (pipe-delimited path
  into the JSON). This page is **anchored to the 0.8 m** as its worked example (its prose hardcodes the 8 MHz/1 MHz modes and
  B/V/R/I bands); the formalism is instrument-agnostic but the live numbers shown
  are the 0.8 m's.
- **`chart.min.js`** — vendored Chart.js (offline, do not fetch from a CDN).

### Reduction pipeline (`reduction/`)
`run_all.py` orchestrates four steps and assembles `constants.json`:
1. `derive_detector.py` — gain (flat-pair photon-transfer), read noise (bias
   pair difference), dark current, saturation.
2. `derive_sky.py` — sigma-clipped sky rate per filter.
3. `photometry.py` — plate-solve + aperture photometry, APASS DR9 cross-match.
4. `derive_zp_extinction.py` — zero point + extinction via Bouguer fit.

`fits_utils.py` is the shared FITS/statistics layer (`FILTERS`, `CLUSTERS`,
paths, master-frame builders, sigma-clipped stats on central regions to dodge
vignetting). `patch_notebook.py` is the one-shot migration script that originally
rewrote the legacy `etc.ipynb` to read `constants.json`; the notebook is already
patched (its cells reference `CONST[...]`), so `patch_notebook.py` is kept only for
reference and is not part of `run_all.py`'s flow. The notebook itself is a
historical reference, not the source of truth.

## Critical context: the constants are provisional

Read `data_acquisition.md` before touching anything that consumes a constant.
The 2026-02-18 run could not constrain extinction (three fields, single airmass
each, short baseline), so the pipeline **deliberately overrides the data-derived
fit** with typical literature `k` and re-anchors the zero point on M67. This is
governed by `USE_TYPICAL_EXTINCTION = True` in `run_all.py`; the data-derived
numbers are preserved under `meta.reference_fits` for when better data arrives.
Other assumed (not measured) values: full-well saturation, dark-doubling
temperature (6.3 K), and readout times. Narrowband filters (OIII/Hα/SII) are
**not characterised and not usable** in the ETC. Don't silently "fix" these to
data-derived values — the override is intentional and documented in
`meta.notes`.
