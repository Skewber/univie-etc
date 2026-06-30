# ETC data acquisition checklist

The exposure time calculator under `docs/` runs on instrumental constants
derived by the reduction pipeline in `reduction/` (driven by `run_all.py`).
Several of those constants are still *literature substitutes* or *single-point
assumptions* — the calculator works, but its numbers are provisional until they
are replaced with proper measurements. This document lists what to capture, and
how each item feeds back into the calculator.

The reduction pipeline expects FITS frames under
`data/<run-date>/<frame-type>/`. After acquiring the data, drop the folder in
place and re-run `python reduction/run_all.py`.

---

## Status of the current constants

The values below are what currently sits in `docs/constants.json`.

| Constant | Current source | Quality |
| --- | --- | --- |
| Read noise (per readout mode) | Bias frames from the 2026-02-18 run | Measured. Re-take only if cooler/firmware changes. |
| Gain (per readout mode) | Flat-pair PTC from the 2026-02-18 run | Measured for one readout mode; extend to the other. |
| Full-well saturation (ADU) | Assumed | **Not measured.** Drives the saturation warning. |
| Dark current at T = −5 °C | Long darks from the 2026-02-18 run | Measured (one temperature only). |
| Dark doubling temperature ΔT | Literature value (6.3 K) | **Assumed.** Drives the cooler-temperature impact. |
| Readout time per (mode, binning) | Hard-coded {8 MHz: 1.0 s, 1 MHz: 8.0 s} | **Assumed.** |
| B, V, R, I zero points | M67 anchor + literature extinction | Provisional — depends on the assumed `k`. |
| B, V, R, I extinction `k` | Literature typical values | **Assumed** (the run had insufficient airmass range). |
| OIII, Hα, SII zero points & extinction | — | **Not characterised.** Narrowband filters are not yet usable in the ETC. |
| Sky rate (B, V, R, I) | Blank-sky frames from the 2026-02-18 run | Measured (single night). |
| Sky rate (OIII, Hα, SII) | — | **Not measured.** |
| Pixel scale | astrometry.net plate solve | Measured. |

---

## A. Detector characterisation

*Closed dome / calibration room. One session is enough.*

| Capture | Purpose | Notes |
| --- | --- | --- |
| ~50 bias frames per readout mode (8 MHz, 1 MHz) and per binning of interest | Read noise per (mode, binning) **and** readout-time per (mode, binning) | The per-frame wall-clock penalty falls out of `(DATE-OBS[N] − DATE-OBS[1]) / (N − 1)` across the bias series, so no separate timing run is needed. |
| 5 flats at each of ~12 exposure-time levels spanning ~5 % to ~110 % full well, per readout mode (vary **exposure time**, keep the lamp fixed) | Gain via the photon-transfer curve **and** full-well + non-linearity knee — one acquisition, two analyses | Stable lamp + dome screen. Pair adjacent frames (1-2, 2-3, 3-4, 4-5) when computing the PTC variance so any slow lamp drift is kept out of the shot-noise estimate. Push the ramp past saturation to pin the linearity knee. |
| Dark frames at multiple cooler set-points, e.g. T ∈ {−25, −15, −5, +5, +15} °C, ≥5 long exposures (≥300 s) per temperature | Dark current at a reference T **and** the doubling temperature ΔT | One readout mode is enough — dark accumulates during exposure, not during readout. Let the cooler stabilise ~10 min at each set-point before exposing. |

## B. Photometric calibration

*On-sky, photometric night. Plan one trip per opportunity.*

| Capture | Purpose | Notes |
| --- | --- | --- |
| Bouguer sequence: a well-calibrated field imaged repeatedly through one night, in **every filter**, with airmass spanning at least 1.0 → 2.5 | Zero point `ZP_m1es` **and** extinction `k` per filter | Track the same field from low to high airmass (e.g. setting, or rising → meridian → setting). 8–10 visits per filter is comfortable. |
| Catalog photometry of the chosen field | Reference magnitudes for the Bouguer fit | Open clusters with APASS DR9 coverage are the easiest path — the pipeline already does the APASS cross-match via Vizier. Landolt or Stetson standards work too. |
| For OIII, Hα, SII: image an emission-line standard (a bright planetary nebula with tabulated line fluxes) or a spectrophotometric standard with a known SED | Narrowband zero points | Extinction for narrowband can be measured the same way as for broadband, or borrowed from the closest broadband if airmass coverage is limited. |

## C. Sky brightness

*Moonless, clear night.*

| Capture | Purpose | Notes |
| --- | --- | --- |
| Several blank-sky exposures per filter at low airmass | `sky_rate_e_per_s_per_pix` per filter | Avoid the Galactic plane. Stack a few exposures per filter and take the sigma-clipped median rate. The pipeline already does this for the broadband filters. |

## D. System / PSF — nice-to-have

| Capture | Purpose | Notes |
| --- | --- | --- |
| Astrometric solution of a star-rich field at each binning | Pixel scale per binning | Already running via astrometry.net. Run a few solves to nail down the precision. |
| Per-session log of FWHM from focused star images | Build a seeing histogram for the site | Lets you replace the 2.0″ default in the ETC with a site-specific median. |

---

## Priority order

1. **Multi-temperature darks** — kills the biggest "assumed" parameter. One evening of the cooler stepping through ~5 set-points.
2. **One photometric night with a real airmass ladder** in B, V, R, I — replaces literature extinction with measured `k`. Set `USE_TYPICAL_EXTINCTION = False` in `reduction/run_all.py` once available.
3. **Linearity ramp** — turns the saturation warning from assumed into trustworthy.
4. **Narrowband Bouguer sequence + emission-line standard** — adds OIII, Hα, SII to the calculator.
5. **Readout time** — derive from the bias-frame `DATE-OBS` timestamps; no extra acquisition needed.

---

## Sequenceable checklist

One line per instruction. Numbers are stable so they can be referenced from
the observing script. Exposure times marked **t = ?** depend on the lamp
brightness or the sky brightness on the night — fill them in after a scout
exposure.

### Detector session
*Closed dome / calibration room. One long evening (~5 h with the dark ramp).*

**A. Biases — read noise + readout-time per (mode, binning).**
 1. 50× bias, 8 MHz, 1×1
 2. 50× bias, 8 MHz, 2×2
 3. 50× bias, 8 MHz, 3×3
 4. 50× bias, 8 MHz, 4×4
 5. 50× bias, 1 MHz, 1×1
 6. 50× bias, 1 MHz, 2×2
 7. 50× bias, 1 MHz, 3×3
 8. 50× bias, 1 MHz, 4×4

**B. PTC + linearity ramp — gain + full-well, in one acquisition.**
*Stable dome-flat lamp. Before starting, take one scout flat at e.g. 1 s and
read the mean signal so each "% of full well" below can be converted into a
concrete exposure time.*

 9. 5× flat, 8 MHz, 1×1, t = ?  (target ≈   5 % full well)
10. 5× flat, 8 MHz, 1×1, t = ?  (target ≈  10 %)
11. 5× flat, 8 MHz, 1×1, t = ?  (target ≈  20 %)
12. 5× flat, 8 MHz, 1×1, t = ?  (target ≈  30 %)
13. 5× flat, 8 MHz, 1×1, t = ?  (target ≈  40 %)
14. 5× flat, 8 MHz, 1×1, t = ?  (target ≈  50 %)
15. 5× flat, 8 MHz, 1×1, t = ?  (target ≈  60 %)
16. 5× flat, 8 MHz, 1×1, t = ?  (target ≈  70 %)
17. 5× flat, 8 MHz, 1×1, t = ?  (target ≈  80 %)
18. 5× flat, 8 MHz, 1×1, t = ?  (target ≈  90 %)
19. 5× flat, 8 MHz, 1×1, t = ?  (target ≈ 100 %)
20. 5× flat, 8 MHz, 1×1, t = ?  (target ≈ 110 % — saturated, pins the knee)
21. 5× flat, 1 MHz, 1×1, t = ?  (target ≈   5 %)
22. 5× flat, 1 MHz, 1×1, t = ?  (target ≈  10 %)
23. 5× flat, 1 MHz, 1×1, t = ?  (target ≈  20 %)
24. 5× flat, 1 MHz, 1×1, t = ?  (target ≈  30 %)
25. 5× flat, 1 MHz, 1×1, t = ?  (target ≈  40 %)
26. 5× flat, 1 MHz, 1×1, t = ?  (target ≈  50 %)
27. 5× flat, 1 MHz, 1×1, t = ?  (target ≈  60 %)
28. 5× flat, 1 MHz, 1×1, t = ?  (target ≈  70 %)
29. 5× flat, 1 MHz, 1×1, t = ?  (target ≈  80 %)
30. 5× flat, 1 MHz, 1×1, t = ?  (target ≈  90 %)
31. 5× flat, 1 MHz, 1×1, t = ?  (target ≈ 100 %)
32. 5× flat, 1 MHz, 1×1, t = ?  (target ≈ 110 %)

**C. Dark current vs temperature.**
*One readout mode is enough; dark current is independent of readout speed.*

33. Set cooler set-point to −25 °C; wait ~10 min for stabilisation.
34. 5× dark, 8 MHz, 1×1, 300 s  (at T = −25 °C)
35. Set cooler set-point to −15 °C; wait ~10 min.
36. 5× dark, 8 MHz, 1×1, 300 s  (at T = −15 °C)
37. Set cooler set-point to  −5 °C; wait ~10 min.
38. 5× dark, 8 MHz, 1×1, 300 s  (at T =  −5 °C)
39. Set cooler set-point to  +5 °C; wait ~10 min.
40. 5× dark, 8 MHz, 1×1, 300 s  (at T =  +5 °C)
41. Set cooler set-point to +15 °C; wait ~10 min.
42. 5× dark, 8 MHz, 1×1, 300 s  (at T = +15 °C)
43. Return cooler set-point to the normal operating value (e.g. −5 °C).

### Photometric night
*Clear, photometric night, ideally moonless. Plan around one well-calibrated
open cluster you can track from low to high airmass through the night
(e.g. M67 in spring, NGC 7790 in autumn). The sequencer needs to repeat the
"visit" block below across the night so the cluster's airmass spans
~1.0 → ~2.5.*

Define one **visit** = seven exposures at the current airmass:

 1. 3× target cluster, B,    t = ?  (scout to ~30000 ADU peak in catalog stars)
 2. 3× target cluster, V,    t = ?
 3. 3× target cluster, R,    t = ?
 4. 3× target cluster, I,    t = ?
 5. 3× target cluster, OIII, t = ?
 6. 3× target cluster, Hα,   t = ?
 7. 3× target cluster, SII,  t = ?

Run **5 visits** through the night (instructions 1-7 looped). Distribute them
so the airmass values are roughly even between 1.0 and 2.5.

Additionally, once near transit, image an emission-line standard for
narrowband zero points:

 8. 3× planetary nebula (e.g. NGC 7027), OIII, t = ?
 9. 3× planetary nebula,                  Hα,   t = ?
10. 3× planetary nebula,                  SII,  t = ?

And take twilight sky-flats (one set is enough; sequence at dusk or dawn):

11. 7× sky-flat, B,    twilight (aim for ~30000 ADU peak)
12. 7× sky-flat, V,    twilight
13. 7× sky-flat, R,    twilight
14. 7× sky-flat, I,    twilight
15. 7× sky-flat, OIII, twilight
16. 7× sky-flat, Hα,   twilight
17. 7× sky-flat, SII,  twilight

### Sky-brightness night
*Moonless, clear. Point at a blank field away from the Galactic plane.*

 1. 3× blank sky, B,    60 s
 2. 3× blank sky, V,    60 s
 3. 3× blank sky, R,    60 s
 4. 3× blank sky, I,    60 s
 5. 3× blank sky, OIII, 300 s
 6. 3× blank sky, Hα,   300 s
 7. 3× blank sky, SII,  300 s
