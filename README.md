# Exposure Time Calculator — Vienna 0.8 m & LFOA 1.5 m

A multi-instrument exposure time calculator (ETC). The primary instrument is the
University of Vienna 0.8 m telescope (f/8.3, 6640 mm focal length, FLI CCD,
B/V/R/I filters), whose instrumental constants are **derived from real data**
taken on 2026-02-18 (three open clusters at different airmasses plus
bias/dark/flat calibration frames), not guessed. A second telescope, the **LFOA
1.5 m** (1.5 m / 12.5 m, carrying the **PICO** instrument — an Andor Zyla 4.2-P
sCMOS, Bessel V/R), is selectable from a dropdown; its constants are
**provisional estimates** from the spec sheet (no calibration data yet) and are
flagged with an on-page banner.

The calculator is a static web app in [`docs/`](docs/) that can be hosted for free
on GitHub Pages.

## Repository layout

```
docs/            static web ETC (deploy this to GitHub Pages)
  index.html
  app.js         ETC math + Chart.js plots
  almanac.html
  almanac.js     observing almanac (Sun/Moon, airmass, twilight, visibility plot)
  methods.html
  methods.js     formula/methods reference page
  style.css
  instruments.json        manifest: {default, instruments:[{id,label,type,file}]}
  instruments/
    vienna_0.8m.json      0.8 m constants (produced by the reduction pipeline)
    pico_1.5m.json        PICO constants (hand-authored, provisional)
  chart.min.js   vendored Chart.js (offline)
reduction/       Python pipeline that derives the 0.8 m constants from data/
etc.ipynb        the original reference notebook (reads reduction/constants.json)
data/            raw FITS frames (not committed — large)
```

### Adding an instrument

Each instrument is one JSON file with the same shape as `constants.json`
(`telescope`, `pixel_scale_arcsec_unbinned`, `reference_binning`, `camera`,
`filters`, `meta`). To add one, drop the file in `docs/instruments/` and add a
`{id, label, type, file}` line to `docs/instruments.json`. To swap a camera,
edit that one file. Set `meta.status_banner` to show a "provisional" notice. The
`type` field (`imager`) is the extension point for a future spectrograph mode.
Add a `site` block (`latitude_deg`, `longitude_deg`, `elevation_m`,
`tz_standard_offset_hours`, `uses_eu_dst`) so the instrument is usable from the
almanac page; without it the almanac shows a "no site" notice.

### Almanac

[`docs/almanac.html`](docs/almanac.html) is a standalone, offline observing
almanac for the selected instrument's site. Enter a target RA/Dec and a UT
instant; it computes the Sun and Moon positions, the target/Moon/Sun altitude,
azimuth, airmass and rise/transit/set times, the lunar illuminated fraction and
Moon–target separation, and a night-long visibility plot with twilight shading.
It warns in twilight and flags daytime. **Use in ETC** carries the computed
airmass and Moon illumination/separation back into the calculator.

## How the constants are derived

`reduction/run_all.py` produces `reduction/constants.json` (and writes the same
file to `docs/instruments/vienna_0.8m.json` for the web app):

| Quantity | Method |
|---|---|
| **Gain** | photon-transfer (mean–variance) on flat pairs |
| **Read noise** (8 MHz, 1 MHz) | difference of bias pairs |
| **Dark current** | sigma-clipped master dark / exptime |
| **Sky rate** per filter | sigma-clipped background of the cluster frames |
| **Zero point + extinction** per filter | aperture photometry on plate-solved cluster frames, cross-matched to APASS DR9, then a Bouguer fit (instrumental − catalog mag vs airmass) over the three clusters |

R, I catalog magnitudes come from APASS g,r,i via the Lupton (2005) SDSS→Cousins
transforms. The narrowband filters (OIII, Hα, SII) are **not** characterised — no
calibration data exists for them yet.

### Re-running the pipeline

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r reduction/requirements.txt   # Windows
# source .venv/bin/activate; pip install -r reduction/requirements.txt  # *nix

# astrometry.net key is needed only for the photometry (ZP + extinction) step
set ASTROMETRY_API_KEY=your_key_here            # Windows
# export ASTROMETRY_API_KEY=your_key_here       # *nix

cd reduction
python run_all.py   # writes reduction/constants.json AND docs/instruments/vienna_0.8m.json
```

The detector and sky steps need no internet; only the photometry step contacts
astrometry.net and Vizier.

## Hosting on GitHub Pages

1. Create a GitHub repo and push this project (the `.gitignore` keeps `data/` and
   `.venv/` out).
2. In the repo: **Settings → Pages → Build and deployment**, set
   **Source = Deploy from a branch**, **Branch = `main`**, **folder = `/docs`**.
3. After a minute the ETC is live at
   `https://<your-username>.github.io/<repo-name>/`.

To preview locally:

```bash
cd docs
python -m http.server 8000
# open http://localhost:8000
```

## Using the calculator

Pick a filter and enter the target brightness. Choose whether to solve for the
**exposure time** needed to reach a target SNR, or the **SNR** reached in a given
exposure time. Set airmass (or altitude), seeing, binning, readout mode and a sky
brightness multiplier (1 = the derived night; raise it for moonlight). The app
reports the result, peak pixel / saturation, and diagnostic plots.

### Target options

- **Point source** (default): enter the magnitude in the observing filter; the
  aperture is set by the seeing.
- **Extended source** (galaxies / nebulae): choose a *light profile* — **uniform
  disk**, **Gaussian**, or **Sérsic** (with adjustable index n; n=1 ≈ exponential
  disk, n=4 ≈ de Vaucouleurs elliptical) — plus an angular size (arcsec). The
  size's meaning depends on the profile (diameter for uniform, FWHM for Gaussian,
  half-light diameter for Sérsic; shown inline). Brightness is given as a **total
  magnitude** or **mean surface brightness** (mag/arcsec²) over a circular
  **extraction aperture** (diameter in arcsec, or 0 for a single peak pixel).
  Profiles are evaluated analytically; the peak surface brightness is
  seeing-limited (mean flux within a seeing-FWHM disc).
- **Source spectrum** (optional): pick a *blackbody* temperature (point sources
  only) or a *template* and the band your magnitude is given in; the app converts
  it to the observing filter using approximate colors. Templates available:
  - **Point**: stellar main-sequence O5…M5, plus *SN Ia (max)*, *SN II (peak)*,
    *White dwarf (DA)*, *AGN / quasar*.
  - **Extended**: *Elliptical / Spiral / Irregular galaxy*, *Reflection nebula*,
    *Planetary nebula*, *HII region (Hα)*.

  This is **approximate** — a cross-band color helper, not a true
  synthetic-photometry integration (we have no per-filter throughput curves), and
  emission-line nebula colors in broadband filters are particularly rough. For an
  in-filter magnitude with no conversion, leave it on *Flat (none)*.

- **Limiting magnitude (S/N = 5)**: shown for point sources — the faintest
  in-band magnitude detectable at S/N = 5 in the same exposure / sub structure /
  conditions you've set. Solved from `S² = (Rt)² / (Rt + n_pix(t(R_S+R_D) +
  N·N_R²))`. Useful for "what's the deepest I can go tonight?".

### Sub-exposures, cooling, and the noise breakdown

- **Observing mode**: pick how the exposure is specified —
  - *Single exposure*: enter a time → get the SNR.
  - *Target SNR*: enter a desired SNR → get the single exposure time.
  - *Observing strategy*: the three fields {exposure time, number of subs N,
    target SNR} are all shown; **leave exactly one blank** and it is solved from
    the other two. A toggle sets whether the time field means a per-sub length or
    the total integration (then `total = N × sub`). An **Auto sub-count** option
    (total-time basis) instead sizes N so each sub stays below the saturation
    limit, leaving the SNR as the solved field.

  In strategy mode the resulting structure is shown inline under the fields.
  Leaving two fields blank (under-determined) or filling all three
  (over-determined) shows a warning instead of a result. Read noise is paid once
  per sub (`N·N_read²`) and **saturation is checked per sub** — the relevant limit
  for stacking.
- **Cooler temperature**: scales the dark current with
  `D(T) = D_ref · 2^((T − T_ref)/ΔT_double)`, with `D_ref` the measured dark at the
  −5 °C setpoint and `ΔT_double` a **provisional 6.3 K** doubling
  (`camera.dark_doubling_kelvin` in `constants.json`). Replace it by fitting darks
  taken at several temperatures.
- **Noise breakdown chart**: the four slices are the source-Poisson, sky, dark,
  and read-noise variance contributions, shown as **percentages** of the total
  noise variance (the term under √ in the SNR formula). Whichever dominates tells
  you what helps: source → photon-limited; sky → sky-limited; read → use longer
  subs / 1 MHz / binning; dark → cool the camera.
- **Moon contribution**: enter the moon illumination (0=new … 1=full) and the
  moon–target separation (deg). The app applies a Krisciunas & Schaefer (1991)
  V-band model to scale up the sky rate; the result is shown as `Sky × (moon)` in
  the results table. (Approximate — assumes moon at the same altitude as the
  target and uses the V-band factor for all bands.)
- **Wall-clock total**: the results also report the wall-clock time including
  per-frame readout + download (`camera.readout_time_s` in `constants.json`,
  estimated 1.0 s at 8 MHz and 8.0 s at 1 MHz — refine by timing real frames).
  Useful when planning many short subs: e.g. 100 × 5 s science integration with
  1 s readout each = 600 s on the clock, 50 % overhead.
- **Export .txt**: click *Export .txt* in the Results header to download a plain-
  text file with all inputs, the headline results, and the noise breakdown in %.
