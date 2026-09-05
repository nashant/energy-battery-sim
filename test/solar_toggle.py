#!/usr/bin/env python3
"""
Real browser check of the per-array "include in run" toggle: excluding the only array
removes the Solar card, re-including it brings the card back, the setting survives a
reload (saved with the inputs when Run starts), and a mixed on/off pair reports the count.
Serves the repo itself on a spare port; needs the network (postcodes.io, Open-Meteo, Octopus).

  python3 test/solar_toggle.py [usage_csv]
"""
import os, subprocess, time, sys
from playwright.sync_api import sync_playwright
PORT = "8431"
CSV = sys.argv[1] if len(sys.argv) > 1 else "/home/anthonynash/Downloads/usage-electric.csv"
srv = subprocess.Popen([sys.executable, "-m", "http.server", PORT], cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1.5)
fails = 0
def check(n, c, x=""):
    global fails; print(("PASS " if c else "FAIL ") + n + (f" [{x}]" if x and not c else "")); fails += 0 if c else 1
def run(pg):
    pg.click("#run")
    pg.wait_for_function("() => !document.getElementById('run').disabled", timeout=240000)
    return pg.inner_text("#cards").lower(), pg.inner_text("#errBox").strip()
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"http://localhost:{PORT}/", wait_until="load"); time.sleep(1)
        pg.set_input_files("#fileUsage", CSV)
        pg.wait_for_selector("#usageInfo:has-text('slots')", timeout=20000)
        pg.fill("#postcode", "RG31 6JU"); pg.click("#locate"); pg.wait_for_selector("#siteNote:has-text('51.')", timeout=15000)
        pg.click("#addArray"); pg.fill(".array [data-k=bearing]", "191"); pg.fill(".array [data-k=tilt]", "90")
        check("new row is included by default", pg.is_checked(".array [data-k=enabled]"))
        pg.select_option("#importTariff", "agile"); pg.select_option("#exportTariff", "agile-outgoing")
        cards, err = run(pg)
        check("run 1 (included): Solar card present", "spilled" in cards and "solar only" in cards, cards[:300] + err)
        # exclude the only array: no PV, no Solar card, and the row says so
        pg.uncheck(".array [data-k=enabled]")
        check("row dims and says excluded", "off" in pg.get_attribute(".array", "class") and
              "excluded from the run" in pg.inner_text(".array [data-status]"))
        check("fetch button disabled with nothing included", pg.is_disabled("#fetchPv"))
        cards, err = run(pg)
        check("run 2 (excluded): no Solar card, no error", "spilled" not in cards and "no battery" in cards and not err, cards[:300] + err)
        # the toggle is saved with the inputs when Run starts, so a reload keeps it
        pg.reload(wait_until="load"); time.sleep(2)
        check("reload: row restored still excluded", pg.locator(".array").count() == 1 and not pg.is_checked(".array [data-k=enabled]")
              and "excluded from the run" in pg.inner_text(".array [data-status]"))
        pg.check(".array [data-k=enabled]")
        check("re-included: row status leaves 'excluded'", "excluded" not in pg.inner_text(".array [data-status]"))
        cards, err = run(pg)
        check("run 3 (re-included): Solar card back", "spilled" in cards and "solar only" in cards, cards[:300] + err)
        # a second array switched off: the fetch note counts it and the first array's kWh is unchanged
        kwh1 = pg.inner_text("#pvNote")
        pg.click("#addArray"); pg.uncheck(".array:nth-of-type(2) [data-k=enabled]")
        pg.click("#fetchPv"); pg.wait_for_selector("#pvNote:has-text('excluded')", timeout=120000)
        note = pg.inner_text("#pvNote")
        check("mixed pair: note reports 1 array and 1 excluded", "across 1 array" in note and "1 excluded" in note, note)
        check("mixed pair: total unchanged by the excluded array", note.split(" ")[0] == kwh1.split(" ")[0], f"{kwh1} vs {note}")
        check("no page errors", not errs, str(errs)[:300])
        b.close()
finally: srv.terminate()
sys.exit(1 if fails else 0)
