"use strict";

// methods.js — populate live constant values into the Methods page.
// Reads docs/constants.json and substitutes the contents of every
// <span data-c="a|b|c" data-dp="N"> with the value at that path (rounded to
// N decimal places when numeric). Also builds the per-filter constants table.

function getPath(obj, path) {
  return path.split("|").reduce((o, k) => (o == null ? o : o[k]), obj);
}

function fmt(v, dp) {
  if (v == null || v === "") return "—";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "—";
    const n = Number.isInteger(parseInt(dp, 10)) ? parseInt(dp, 10) : 3;
    return v.toFixed(n);
  }
  return String(v);
}

async function init() {
  let C;
  try {
    const res = await fetch("instruments/vienna_0.8m.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    C = await res.json();
  } catch (err) {
    const el = document.createElement("div");
    el.className = "fatal-error";
    el.textContent = "Could not load constants.json — values shown as —. " +
      "Serve docs/ over HTTP (python -m http.server) and reload.";
    document.body.prepend(el);
    return;
  }

  // Inline constant substitutions.
  document.querySelectorAll("span[data-c]").forEach((el) => {
    el.textContent = fmt(getPath(C, el.dataset.c), el.dataset.dp);
  });

  // Sky-limited minimum sub length L_min = 10 * N_R^2 / R_sky (fast readout).
  // Keeps the worked example in Section 3 in sync with constants.json. Uses the
  // "8 MHz" mode when present (the 0.8 m), else the first available readout mode.
  const rn = (C.camera && C.camera.read_noise_e) || {};
  const NR8 = rn["8 MHz"] != null ? rn["8 MHz"] : rn[Object.keys(rn)[0]];
  document.querySelectorAll("span[data-lmin]").forEach((el) => {
    const filter = el.dataset.lmin;
    const Rsky = C.filters && C.filters[filter] && C.filters[filter].sky_rate_e_per_s_per_pix;
    el.textContent = (NR8 > 0 && Rsky > 0) ? (10 * NR8 * NR8 / Rsky).toFixed(0) : "—";
  });

  // Per-filter table.
  const tb = document.getElementById("filters-table");
  if (tb && C.filters) {
    tb.innerHTML = Object.entries(C.filters)
      .filter(([, f]) => f.zeropoint_mag_1es != null)
      .map(([name, f]) => `<tr>
          <td>${name}</td>
          <td>${fmt(f.zeropoint_mag_1es, 3)}</td>
          <td>${fmt(f.extinction_k, 2)} mag/X</td>
          <td>${fmt(f.sky_rate_e_per_s_per_pix, 2)} e<sup>&#8722;</sup>/s/px</td>
        </tr>`).join("");
  }
}

init();
