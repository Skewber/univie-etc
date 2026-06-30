"""Run the full reduction and write constants.json for the ETC.

Usage (from the reduction/ directory, with the venv active):
    set ASTROMETRY_API_KEY=...    # required for the photometry step
    python run_all.py

The detector/sky steps run with no internet; the photometry (zero point +
extinction) step needs the astrometry.net key and Vizier access.
"""
from __future__ import annotations

import json
import math
import os

import fits_utils as fu
import derive_detector
import derive_sky
import derive_zp_extinction
import photometry

PIX_UM_UNBINNED = 9.0
FOCAL_MM = 6640.0
DIAM_MM = 800.0

# Clusters excluded from the Bouguer fit. M50 was observed last at only 24 deg
# altitude (X=2.43); near-horizon urban haze inflates its apparent extinction,
# so it is excluded until a cleaner data set is available.
EXCLUDE_CLUSTERS = ("M50",)

# This night's data (3 fields, each at a single airmass, short baseline) cannot
# constrain extinction reliably -- the data-derived k came out 3-10x too high
# and B was nonsensical. INTERIM: adopt typical extinction coefficients and
# re-anchor the zero point on a well-measured reference field. Flip
# USE_TYPICAL_EXTINCTION to False once a cleaner multi-airmass data set exists.
USE_TYPICAL_EXTINCTION = True
TYPICAL_K = {"B": 0.25, "V": 0.15, "R": 0.10, "I": 0.06}  # mag/airmass, typical
ANCHOR_CLUSTER = "M67"  # most stars, tightest scatter, near zenith

# Dark-current temperature dependence. The measured dark is the reference at the
# data's -5 C setpoint; dark current is assumed to double every DARK_DOUBLING_K
# degrees: D(T) = D_ref * 2^((T - T_ref)/DARK_DOUBLING_K). The doubling value is
# a typical CCD assumption -- refine by fitting darks at several temperatures.
DARK_REF_TEMP_C = -5.0
DARK_DOUBLING_K = 6.3

# Per-frame readout + download time (s), for wall-clock estimates. Estimates
# from pixels/readout-rate + USB transfer; refine by timing real frames.
READOUT_TIME_S = {"8 MHz": 1.0, "1 MHz": 8.0}

RECORDS_PATH = os.path.join(fu.HERE, "photometry_records.json")


def main():
    print("[1/4] detector constants (read noise, gain, dark current) ...")
    det = derive_detector.derive()
    gain = det["gain_e_per_adu"]
    print(f"      gain={gain} e-/ADU  RN(8MHz)={det['read_noise_e']['8 MHz']} e-  "
          f"dark={det['dark_current_e_per_s_at_-5C']} e-/s")

    print("[2/4] sky background rate per filter ...")
    sky = derive_sky.derive(gain)
    print(f"      {sky}")

    print("[3/4] photometry + plate solving (needs ASTROMETRY_API_KEY) ...")
    if os.path.exists(RECORDS_PATH):
        with open(RECORDS_PATH) as f:
            records = json.load(f)
        print(f"      reusing cached {RECORDS_PATH} ({len(records)} stars). "
              "Delete it to re-solve.")
    else:
        records = photometry.run(gain)
        with open(RECORDS_PATH, "w") as f:
            json.dump(records, f, indent=2)
        print(f"      {len(records)} matched stars total")

    print("[4/4] zero point + extinction ...")
    zp_noM50 = derive_zp_extinction.derive(records, exclude_clusters=EXCLUDE_CLUSTERS)
    zp_all = derive_zp_extinction.derive(records)  # reference (all clusters)
    zp_typical = derive_zp_extinction.derive_typical(records, TYPICAL_K, ANCHOR_CLUSTER)

    if USE_TYPICAL_EXTINCTION:
        zp = zp_typical
        print(f"      using TYPICAL extinction, ZP anchored on {ANCHOR_CLUSTER}:")
    else:
        zp = zp_noM50
        print(f"      using data-derived fit (excluding {EXCLUDE_CLUSTERS}):")
    for f_, d in zp.items():
        print(f"      {f_}: ZP={d['zeropoint_mag_1es']} k={d['extinction_k']} "
              f"(n={d.get('n_stars')})")

    pixscale = math.degrees(math.atan(PIX_UM_UNBINNED * 1e-3 / FOCAL_MM)) * 3600.0

    filters = {}
    for f_ in fu.FILTERS:
        filters[f_] = {
            "zeropoint_mag_1es": zp[f_]["zeropoint_mag_1es"],
            "extinction_k": zp[f_]["extinction_k"],
            "sky_rate_e_per_s_per_pix": sky[f_],
        }

    constants = {
        "telescope": {
            "diameter_mm": DIAM_MM,
            "focal_length_mm": FOCAL_MM,
            "f_number": round(FOCAL_MM / DIAM_MM, 2),
            "pixel_size_um_unbinned": PIX_UM_UNBINNED,
        },
        "pixel_scale_arcsec_unbinned": round(pixscale, 6),
        # Sky and dark rates below are measured at binning 2 (the run's binning);
        # the web app scales them by (binning / reference_binning)^2.
        "reference_binning": 2,
        "camera": {
            "gain_e_per_adu": gain,
            "read_noise_e": det["read_noise_e"],
            "dark_current_e_per_s_at_-5C": det["dark_current_e_per_s_at_-5C"],
            "dark_ref_temp_c": DARK_REF_TEMP_C,
            "dark_doubling_kelvin": DARK_DOUBLING_K,
            "readout_time_s": READOUT_TIME_S,
            "saturation_adu": det["saturation_adu"],
        },
        "filters": filters,
        "meta": {
            "derived_from": "2026-02-18 Vienna 0.8m observing run",
            "gain_per_filter": det["gain_per_filter"],
            "read_noise_adu": det["read_noise_adu"],
            "extinction_source": (
                f"typical literature k, ZP anchored on {ANCHOR_CLUSTER} "
                f"(X={zp_typical['V'].get('anchor_airmass')})"
                if USE_TYPICAL_EXTINCTION
                else f"data-derived fit excluding {list(EXCLUDE_CLUSTERS)}"),
            "n_stars_anchor": {f_: zp[f_].get("n_stars") for f_ in fu.FILTERS},
            "reference_fits": {
                "data_derived_no_M50": {
                    f_: {"zeropoint_mag_1es": zp_noM50[f_]["zeropoint_mag_1es"],
                         "extinction_k": zp_noM50[f_]["extinction_k"],
                         "fit_rms": zp_noM50[f_]["fit_rms"]} for f_ in fu.FILTERS},
                "data_derived_all_clusters": {
                    f_: {"zeropoint_mag_1es": zp_all[f_]["zeropoint_mag_1es"],
                         "extinction_k": zp_all[f_]["extinction_k"]} for f_ in fu.FILTERS},
            },
            "notes": ("INTERIM extinction: typical literature coefficients "
                      "(B0.25/V0.15/R0.10/I0.06); the zero point is re-anchored "
                      "on M67 so the ETC reproduces the measured throughput at "
                      "that field. This night's data (3 fields, single airmass "
                      "each, short baseline; M50 at 24 deg through horizon haze) "
                      "could not constrain extinction reliably -- re-derive with "
                      "more fields/airmasses and set USE_TYPICAL_EXTINCTION=False "
                      "in run_all.py. reference_fits records what the data gave. "
                      "Narrowband (OIII/Halpha/SII) not characterised (no data). "
                      "Sky rate is representative of the night. R,I catalog mags "
                      "via Lupton (2005) SDSS->Cousins transforms. Dark current vs "
                      f"temperature assumes a {DARK_DOUBLING_K} K doubling around "
                      f"{DARK_REF_TEMP_C} C -- refine with multi-temperature darks."),
        },
    }

    # Write the pipeline output and propagate it to the web app in one step, so
    # the two never drift (docs/instruments/vienna_0.8m.json is the deployed copy).
    text = json.dumps(constants, indent=2)
    for out in (os.path.join(fu.HERE, "constants.json"),
                os.path.join(fu.HERE, "..", "docs", "instruments", "vienna_0.8m.json")):
        with open(out, "w") as f:
            f.write(text)
        print(f"\nWrote {os.path.normpath(out)}")
    return constants


if __name__ == "__main__":
    main()
