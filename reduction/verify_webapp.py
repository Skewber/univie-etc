"""Headless-browser smoke test of the ETC web app.

Serves docs/ and drives it with Playwright: checks for JS console errors,
verifies the result is computed, exercises the instrument switch, the three
observing modes (single / target SNR / strategy) and filter change, and writes
screenshots for visual inspection.
"""
import functools
import http.server
import os
import socketserver
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
PORT = 8231


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DOCS)
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    serve()
    msgs = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1280, "height": 1000})
        page.on("console", lambda m: msgs.append((m.type, m.text)))
        page.on("pageerror", lambda e: msgs.append(("pageerror", str(e))))
        page.goto(f"http://127.0.0.1:{PORT}/index.html")
        page.wait_for_timeout(1500)

        def snap(name):
            head = page.inner_text("#headline-value")
            rows = page.inner_text("#result-table")
            warn = page.inner_text("#sat-warning")
            charted = page.evaluate(
                "Array.from(document.querySelectorAll('canvas'))"
                ".filter(c => c.width > 0 && c.height > 0).length")
            # is the source preview actually painted?
            prev = page.evaluate("""() => {
                const c = document.getElementById('source-preview');
                if (!c || !c.width) return 0;
                const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                let s = 0; for (let i=0;i<d.length;i+=4) s += d[i]+d[i+1]+d[i+2];
                return s; }""")
            deriv = page.inner_text("#exp-derived")
            print(f"\n[{name}] headline={head!r}  charts={charted}  preview_sum={prev}")
            print("  derived:", deriv)
            print("  rows:", " | ".join(rows.split(chr(10))[:12]))
            page.screenshot(path=os.path.join(ROOT, "reduction", f"web_{name}.png"),
                            full_page=True)

        # 1. default point source (regression: expect ~21.8 s)
        snap("point_default")

        # 1b. instrument switch -> LFOA 1.5 m (PICO/Zyla): provisional banner
        # shows, only the two Bessel filters (V, R) are offered, and the single
        # Zyla readout mode repopulates the readout-mode select.
        page.select_option("#instrument", "lfoa_1.5m")
        page.wait_for_timeout(600)
        lfoa_filters = page.eval_on_selector_all("#filter option", "els => els.map(e => e.value)")
        lfoa_modes = page.eval_on_selector_all("#readmode option", "els => els.length")
        banner_vis = page.locator("#instrument-banner").is_visible()
        print(f"\n[instrument] LFOA filters={lfoa_filters}  readout_modes={lfoa_modes}  "
              f"banner={banner_vis}")
        assert lfoa_filters == ["V", "R"], f"LFOA filters {lfoa_filters} (expected ['V','R'])"
        assert lfoa_modes == 1, f"LFOA readout modes {lfoa_modes} (expected 1)"
        assert banner_vis, "LFOA provisional banner should be visible"
        snap("instrument_lfoa")

        # back to the 0.8 m for the remaining checks: two readout modes, no banner.
        page.select_option("#instrument", "vienna_0.8m")
        page.wait_for_timeout(600)
        modes_08 = page.eval_on_selector_all("#readmode option", "els => els.length")
        banner_08 = page.locator("#instrument-banner").is_visible()
        print(f"[instrument] 0.8 m readout_modes={modes_08}  banner={banner_08}")
        assert modes_08 == 2, f"0.8 m readout modes {modes_08} (expected 2)"
        assert not banner_08, "0.8 m should show no provisional banner"
        page.select_option("#filter", "V")

        # 2. SED color helper: V=14, M0 star, observed in I
        page.select_option("#filter", "I")
        page.select_option("#sed", "spec")
        page.select_option("#spectype", "M0")
        page.select_option("#refband", "V")
        page.fill("#mag", "14"); page.wait_for_timeout(400)
        snap("point_sed_M0_V_to_I")

        # 2b. SN Ia at max as a point spectral template
        page.select_option("#spectype", "SN Ia (max)")
        page.wait_for_timeout(300); snap("point_sed_SNIa")

        # reset SED + filter
        page.select_option("#sed", "flat")
        page.select_option("#filter", "V")

        # 3. extended uniform disk by surface brightness
        page.check('input[name="ttype"][value="extended"]')
        page.select_option("#profile", "uniform")
        page.select_option("#normmode", "sb")
        page.fill("#mag", "21"); page.fill("#size", "30"); page.fill("#extap", "20")
        page.wait_for_timeout(400); snap("ext_uniform_sb")

        # 4. gaussian, total magnitude
        page.select_option("#profile", "gaussian")
        page.select_option("#normmode", "mag")
        page.fill("#mag", "12"); page.fill("#size", "8")
        page.wait_for_timeout(400); snap("ext_gaussian")

        # 5. Sersic n=4 (de Vaucouleurs), total magnitude
        page.select_option("#profile", "sersic")
        page.fill("#sersicN", "4"); page.fill("#size", "30")
        page.wait_for_timeout(400); snap("ext_sersic4")

        # 6. Sersic n=1 (exponential disk)
        page.fill("#sersicN", "1")
        page.wait_for_timeout(400); snap("ext_sersic1")

        # 7. bright Sersic, single-exposure mode (time given -> SNR) -> saturation
        page.fill("#sersicN", "4")
        page.select_option("#solvemode", "single")
        page.fill("#exptime", "300"); page.fill("#mag", "8")
        page.wait_for_timeout(400); snap("ext_saturated")

        # 8. cooling impact (point source, fixed 60 s, single exposure)
        page.check('input[name="ttype"][value="point"]')
        page.select_option("#sed", "flat"); page.select_option("#filter", "V")
        page.select_option("#solvemode", "single")
        page.fill("#exptime", "60"); page.fill("#mag", "18")
        page.fill("#cooltemp", "-5"); page.wait_for_timeout(300); snap("cool_minus5")
        page.fill("#cooltemp", "20"); page.wait_for_timeout(300); snap("cool_plus20")
        page.fill("#cooltemp", "-5")

        # 9. Target SNR mode: single exposure time solved from desired SNR
        page.fill("#mag", "15")
        page.select_option("#solvemode", "snr")
        page.fill("#snr", "100")
        page.wait_for_timeout(300); snap("target_snr_single")

        # 10. Strategy, per-sub basis, blank SNR: N subs of fixed length -> SNR
        page.select_option("#solvemode", "strategy")
        page.check('input[name="timebasis"][value="persub"]')
        page.fill("#exptime", "60"); page.fill("#nsub", "3"); page.fill("#snr", "")
        page.wait_for_timeout(300); snap("strategy_persub_3x60_snr")

        # 11. Strategy, total basis, blank SNR: split a total into N -> SNR
        page.check('input[name="timebasis"][value="total"]')
        page.fill("#exptime", "300"); page.fill("#nsub", "5"); page.fill("#snr", "")
        page.wait_for_timeout(300); snap("strategy_total_300_5_snr")

        # 12. Strategy, per-sub basis, blank N: fixed sub length -> N from SNR
        page.check('input[name="timebasis"][value="persub"]')
        page.fill("#exptime", "60"); page.fill("#snr", "100"); page.fill("#nsub", "")
        page.wait_for_timeout(300); snap("strategy_blank_n")

        # 12. Strategy, total basis, blank time: fixed N + SNR -> total time
        page.check('input[name="timebasis"][value="total"]')
        page.fill("#nsub", "4"); page.fill("#snr", "100"); page.fill("#exptime", "")
        page.wait_for_timeout(300); snap("strategy_blank_time")

        # 12b. Strategy, Auto sub-count (size by saturation), 1 h on a bright source
        page.fill("#mag", "12")  # bright -> saturation matters
        page.check('input[name="timebasis"][value="total"]')
        page.check("#nauto")
        page.fill("#exptime", "3600"); page.fill("#snr", ""); page.fill("#satlimit", "70")
        page.wait_for_timeout(300); snap("strategy_auto_1h_mag12")
        page.uncheck("#nauto")

        # 12c. Strategy, per-sub blank N with too-long sub: should flag overshoot
        page.fill("#mag", "14")
        page.check('input[name="timebasis"][value="persub"]')
        page.fill("#exptime", "100"); page.fill("#snr", "100"); page.fill("#nsub", "")
        page.wait_for_timeout(300); snap("strategy_overshoot")

        # 12d. Over/under-determined strategy inputs should warn (and not solve)
        page.fill("#exptime", "60"); page.fill("#nsub", "5"); page.fill("#snr", "100")
        page.wait_for_timeout(300)
        over = page.inner_text("#input-warnings")
        assert "Overdetermined" in over, f"expected overdetermined warning, got: {over!r}"
        page.fill("#nsub", ""); page.fill("#snr", "")   # only time given -> 2 blanks
        page.wait_for_timeout(300)
        under = page.inner_text("#input-warnings")
        assert "Underdetermined" in under, f"expected underdetermined warning, got: {under!r}"
        print("  strategy over/under-determined warnings OK")

        # 12e. V=4 at realistic airmass -> should be heavily saturated
        page.select_option("#solvemode", "single")
        page.select_option("#binning", "2")
        page.fill("#airmass", "1.2"); page.fill("#mag", "4"); page.fill("#exptime", "1")
        page.wait_for_timeout(300); snap("bright_v4_realistic")

        # 12f. Unphysical airmass + moon illum > 1 should fire input warnings
        page.fill("#airmass", "42"); page.fill("#moonillum", "100")
        page.wait_for_timeout(300); snap("bad_inputs_warning")
        nwarn = page.eval_on_selector_all(".input-warning", "els => els.length")
        print(f"  input-warnings shown: {nwarn}")
        assert nwarn >= 2, f"expected >=2 input warnings, got {nwarn}"
        page.fill("#airmass", "1.2"); page.fill("#moonillum", "0")

        # 13. moon: new -> full at 90 deg separation
        page.check('input[name="ttype"][value="point"]')
        page.select_option("#solvemode", "single")
        page.fill("#mag", "18"); page.fill("#exptime", "60")
        page.fill("#moonillum", "0"); page.fill("#moonsep", "90")
        page.wait_for_timeout(300); snap("moon_new")
        page.fill("#moonillum", "1.0"); page.fill("#moonsep", "30")
        page.wait_for_timeout(300); snap("moon_full_30")

        # extended SED uses extended-object templates (galaxy, nebula, HII)
        page.check('input[name="ttype"][value="extended"]')
        page.select_option("#profile", "uniform")
        page.select_option("#normmode", "mag")
        page.fill("#mag", "13"); page.fill("#size", "30"); page.fill("#extap", "20")
        page.select_option("#sed", "spec")
        page.wait_for_timeout(200)
        assert page.locator("#sed-label").is_visible(), "SED block should show for extended"
        page.select_option("#spectype", "HII region (Hα)")
        page.wait_for_timeout(300); snap("ext_sed_HII")
        page.select_option("#sed", "flat")
        page.check('input[name="ttype"][value="point"]')

        # bidirectional airmass <-> altitude
        page.fill("#airmass", "2.0"); page.wait_for_timeout(100)
        alt_value = float(page.input_value("#altitude"))
        print(f"\n[link] X=2.0 -> alt={alt_value:.2f} deg  (expect ~30)")
        assert abs(alt_value - 30.0) < 0.1
        page.fill("#altitude", "60"); page.wait_for_timeout(100)
        air_value = float(page.input_value("#airmass"))
        print(f"[link] alt=60 -> X={air_value:.3f}  (expect ~1.155)")
        assert abs(air_value - 1.155) < 0.01
        page.fill("#airmass", "1.2"); page.wait_for_timeout(100)

        # 13b. plot collapse: height collapses, no resize loop (chart-box stays
        # under the original chart height; previously a flex+Chart.js feedback
        # made the box grow without bound).
        box_sel = "[data-chart='chart-time']"
        page.click(f"{box_sel} .chart-toggle")
        page.wait_for_timeout(400)
        h_collapsed = page.evaluate(
            f"document.querySelector(\"{box_sel}\").getBoundingClientRect().height")
        assert h_collapsed < 80, f"collapsed chart-box height = {h_collapsed} (should be header-only)"
        page.click(f"{box_sel} .chart-toggle")
        page.wait_for_timeout(400)
        h_expanded = page.evaluate(
            f"document.querySelector(\"{box_sel}\").getBoundingClientRect().height")
        assert 240 < h_expanded < 320, f"expanded chart-box height = {h_expanded} (should be ~260)"
        print(f"\n[collapse] chart-box: collapsed={h_collapsed:.0f}  expanded={h_expanded:.0f}")

        # 14. export button -> save .txt and read it back
        page.fill("#moonillum", "0")
        with page.expect_download() as dl_info:
            page.click("#export-btn")
        dl = dl_info.value
        outpath = os.path.join(ROOT, "reduction", "etc_export_test.txt")
        dl.save_as(outpath)
        with open(outpath, encoding="utf-8") as f:
            txt = f.read()
        print("\n[export] first 8 lines of the downloaded file:")
        for line in txt.splitlines()[:8]:
            print("   ", line)
        assert "NOISE BREAKDOWN" in txt and "%" in txt, "export missing noise section"
        os.remove(outpath)

        # 15. methods page: loads, has no JS errors, constants populated, KaTeX rendered
        page.goto(f"http://127.0.0.1:{PORT}/methods.html")
        page.wait_for_timeout(2500)  # KaTeX auto-render runs after script load
        n_const = page.eval_on_selector_all(
            "span[data-c]", "els => els.filter(e => e.textContent.trim() && e.textContent !== '—').length")
        n_math = page.eval_on_selector_all(".katex", "els => els.length")
        n_filters = page.eval_on_selector_all("#filters-table tr", "els => els.length")
        nav_target = page.eval_on_selector(".nav-row a", "el => el.getAttribute('href')")
        print(f"\n[methods] constants_filled={n_const}  katex_nodes={n_math}  "
              f"filter_rows={n_filters}  nav_back={nav_target!r}")
        assert n_const >= 10, f"only {n_const} live constants populated"
        assert n_math >= 20, f"only {n_math} KaTeX nodes -- math may not have rendered"
        assert n_filters >= 4, f"only {n_filters} filter rows (expected >=4 broadband)"
        page.screenshot(path=os.path.join(ROOT, "reduction", "web_methods.png"),
                        full_page=True)

        # 16. almanac page: site loads, ephemeris table + visibility plot compute,
        # twilight/day warnings fire, and "Use in ETC" hands airmass + Moon
        # geometry back to the calculator.
        page.goto(f"http://127.0.0.1:{PORT}/almanac.html")
        page.wait_for_timeout(800)
        site = page.inner_text("#site-info")
        n_rows = page.eval_on_selector_all("#alm-rows tr", "els => els.length")
        vis_painted = page.evaluate(
            "(() => { const c = document.getElementById('vis-chart');"
            " return c && c.width > 0 && c.height > 0; })()")
        print(f"\n[almanac] site={site[:40]!r}  rows={n_rows}  vis_painted={vis_painted}")
        assert "48.2316" in site, f"expected Vienna coordinates, got {site!r}"
        assert n_rows == 3, f"expected 3 ephemeris rows (Target/Moon/Sun), got {n_rows}"
        assert vis_painted, "visibility chart canvas not painted"

        # instrument switch updates the site
        page.select_option("#instrument", "lfoa_1.5m")
        page.wait_for_timeout(400)
        site_lfoa = page.inner_text("#site-info")
        assert "48.0817" in site_lfoa, f"LFOA coordinates not shown: {site_lfoa!r}"
        page.select_option("#instrument", "vienna_0.8m")
        page.wait_for_timeout(400)

        # object-name resolver (CDS Sesame): network-dependent, so we only assert
        # the path runs and reports a status (✓ or an error) without a JS crash.
        # On a host where the network / CORS blocks it, the error branch is fine.
        page.fill("#target-name", "M42")
        page.click("#resolve-btn")
        page.wait_for_timeout(3000)
        rstat = page.inner_text("#resolve-status")
        print(f"[almanac] name-resolve status: {rstat!r}")
        assert rstat.strip() != "", "resolver produced no status text"

        # "Tonight" jumps to the start of the observable night — never daylight.
        page.click("#tonight-btn")
        page.wait_for_timeout(400)
        tonight_warn = page.inner_text("#alm-warnings")
        assert "Daytime" not in tonight_warn, f"'Tonight' landed in daylight: {tonight_warn!r}"
        print(f"[almanac] tonight -> {page.input_value('#utdt')!r}")

        # daytime should raise a hard (red) warning. #utdt is now a
        # datetime-local read as the site's LOCAL CIVIL time (Vienna CEST=+2 in
        # June, so 12:00 local = 10:00 UT — still full daylight).
        page.fill("#utdt", "2026-06-21T12:00")
        page.wait_for_timeout(300)
        day_warn = page.inner_text("#alm-warnings")
        assert "Daytime" in day_warn, f"expected daytime warning, got {day_warn!r}"

        # circumpolar target on a winter night -> above horizon, valid airmass,
        # Sun down (no day error). Then hand off to the ETC.
        page.select_option("#coordfmt", "sexa")
        page.fill("#ra", "12:00:00")
        page.fill("#dec", "+60:00:00")
        page.fill("#utdt", "2026-01-15T23:00")
        page.wait_for_timeout(400)
        rows_txt = page.inner_text("#alm-rows")
        assert not page.locator("#use-in-etc").is_disabled(), "Use-in-ETC should be enabled"
        print("  almanac ephemeris rows:", " | ".join(rows_txt.split(chr(10))[:6]))

        # "Transit" jumps the target to its culmination -> hour angle ~ 0.
        assert not page.locator("#transit-btn").is_disabled(), "Transit should be enabled with a target"
        page.click("#transit-btn")
        page.wait_for_timeout(400)
        ha = page.inner_text("#alm-rows tr:first-child td:nth-child(6)").strip()
        print("  transit hour angle:", ha)
        assert ha[1:].startswith("0:0"), f"|hour angle| should be ~0 at transit, got {ha!r}"
        page.screenshot(path=os.path.join(ROOT, "reduction", "web_almanac.png"),
                        full_page=True)

        # "Use in ETC" navigates to the calculator and applies the values
        page.click("#use-in-etc")
        page.wait_for_url(f"http://127.0.0.1:{PORT}/index.html")
        page.wait_for_timeout(900)
        applied_air = float(page.input_value("#airmass"))
        banner = page.inner_text("#handoff-banner")
        print(f"[almanac->ETC] airmass={applied_air}  banner={banner[:60]!r}")
        assert 1.0 <= applied_air < 4.0, f"handed-off airmass implausible: {applied_air}"
        assert "almanac" in banner.lower(), f"hand-off banner missing: {banner!r}"

        b.close()

    errs = [m for m in msgs if m[0] in ("error", "pageerror")]
    print("\n=== console errors:", len(errs), "===")
    for t, txt in errs:
        print(" ", t, txt[:200])


if __name__ == "__main__":
    main()
