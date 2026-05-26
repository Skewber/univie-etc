"""Headless-browser smoke test of the ETC web app.

Serves docs/ and drives it with Playwright: checks for JS console errors,
verifies the result is computed, exercises the mode toggle and filter change,
and writes screenshots for visual inspection.
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

        # 7. bright Sersic in fixed-time mode -> saturation
        page.fill("#sersicN", "4")
        page.check('input[name="mode"][value="snr"]')
        page.select_option("#expmode", "single")
        page.fill("#exptime", "300"); page.fill("#mag", "8")
        page.wait_for_timeout(400); snap("ext_saturated")

        # 8. cooling impact (point source, fixed 60 s, single exposure)
        page.check('input[name="ttype"][value="point"]')
        page.select_option("#sed", "flat"); page.select_option("#filter", "V")
        page.check('input[name="mode"][value="snr"]')
        page.select_option("#expmode", "single")
        page.fill("#exptime", "60"); page.fill("#mag", "18")
        page.fill("#cooltemp", "-5"); page.wait_for_timeout(300); snap("cool_minus5")
        page.fill("#cooltemp", "20"); page.wait_for_timeout(300); snap("cool_plus20")
        page.fill("#cooltemp", "-5")

        # 9. SNR mode: "N subs of fixed length" (total derived)
        page.fill("#mag", "15")
        page.select_option("#expmode", "nsub_len")
        page.fill("#subexp", "60"); page.fill("#nsub", "3")
        page.wait_for_timeout(300); snap("snr_nsublen_3x60")

        # 10. SNR mode: "split total into N" (sub length derived)
        page.select_option("#expmode", "split")
        page.fill("#exptime", "300"); page.fill("#nsub", "5")
        page.wait_for_timeout(300); snap("snr_split_300_5")

        # 11. time mode + fixed sub length -> N derived
        page.check('input[name="mode"][value="time"]')
        page.fill("#snr", "100")
        page.select_option("#expmode", "nsub_len"); page.fill("#subexp", "60")
        page.wait_for_timeout(300); snap("time_nsublen")

        # 12. time mode + fixed N -> sub length derived
        page.select_option("#expmode", "split"); page.fill("#nsub", "4")
        page.wait_for_timeout(300); snap("time_split")

        # 12b. "Fixed total time" -> auto-sized subs (1 h on a bright source)
        page.fill("#mag", "12")  # bright -> saturation matters
        page.select_option("#expmode", "total")
        page.fill("#exptime", "3600"); page.fill("#satlimit", "70")
        page.wait_for_timeout(300); snap("total_1h_mag12")

        # 12c. "Fixed sub length" with too-long sub: should flag overshoot
        page.fill("#mag", "14")
        page.select_option("#expmode", "nsub_len")
        page.check('input[name="mode"][value="time"]')
        page.fill("#snr", "100"); page.fill("#subexp", "100")
        page.wait_for_timeout(300); snap("nsublen_overshoot")

        # 12d. V=4 at realistic airmass -> should be heavily saturated
        page.select_option("#expmode", "single")
        page.check('input[name="mode"][value="snr"]')
        page.select_option("#binning", "2")
        page.fill("#airmass", "1.2"); page.fill("#mag", "4"); page.fill("#exptime", "1")
        page.wait_for_timeout(300); snap("bright_v4_realistic")

        # 12e. Unphysical airmass + moon illum > 1 should fire input warnings
        page.fill("#airmass", "42"); page.fill("#moonillum", "100")
        page.wait_for_timeout(300); snap("bad_inputs_warning")
        nwarn = page.eval_on_selector_all(".input-warning", "els => els.length")
        print(f"  input-warnings shown: {nwarn}")
        assert nwarn >= 2, f"expected >=2 input warnings, got {nwarn}"
        page.fill("#airmass", "1.2"); page.fill("#moonillum", "0")

        # 13. moon: new -> full at 90 deg separation
        page.check('input[name="ttype"][value="point"]')
        page.check('input[name="mode"][value="snr"]')
        page.select_option("#expmode", "single")
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

        b.close()

    errs = [m for m in msgs if m[0] in ("error", "pageerror")]
    print("\n=== console errors:", len(errs), "===")
    for t, txt in errs:
        print(" ", t, txt[:200])


if __name__ == "__main__":
    main()
