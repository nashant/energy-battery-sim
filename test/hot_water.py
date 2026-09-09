#!/usr/bin/env python3
"""
Real browser check of the opportunistic immersion: with a gas CSV loaded and the Hot water
panel set to displace the morning reheat, the card appears and reports a saving on Agile;
on a run window where nothing ever clears the gas-equivalent price it refuses to fire and
says so. Serves the repo itself on a spare port; needs the network (Octopus rates).

  python3 test/hot_water.py [usage_csv] [gas_csv]
"""
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright

PORT = "8433"
T = "/home/anthonynash/.local/share/Trash/files"
USE = sys.argv[1] if len(sys.argv) > 1 else f"{T}/usage-electric.csv"
GAS = sys.argv[2] if len(sys.argv) > 2 else f"{T}/usage-gas.csv"
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
srv = subprocess.Popen([sys.executable, "-m", "http.server", PORT], cwd=root,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
fails = 0


def check(n, c, x=""):
    global fails
    print(("PASS  " if c else "FAIL  ") + n + (f"  [{x}]" if x else ""))
    fails += 0 if c else 1


def run(pg):
    pg.click("#run")
    pg.wait_for_function("() => !document.getElementById('run').disabled", timeout=300000)
    return pg.inner_text("#cards"), pg.inner_text("#errBox").strip(), pg.inner_text("#warnings")


try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page()
        errs = []
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"http://localhost:{PORT}/index.html")
        pg.set_input_files("#fileUsage", USE)
        pg.set_input_files("#fileGas", GAS)
        pg.wait_for_timeout(2000)

        # dropping a gas CSV turns the heat pump on; this feature is the alternative to that
        # the gas-meter facts belong to the CSV, so they appear as soon as it lands
        check("gas rate and boiler efficiency appear with the gas CSV",
              pg.is_visible("#gasMeterWrap"))
        # dropping a gas CSV turns the heat pump on, and this feature is the alternative to
        # that, so with both on the panel has to say the immersion is inactive
        pg.select_option("#dhwMode", "gas")
        check("heat-pump-on-gas marks the immersion inactive", pg.is_visible("#dhwInertNote"))
        pg.select_option("#hpMode", "none")
        check("turning the heat pump off clears that", pg.is_hidden("#dhwInertNote"))
        check("hot water panel is revealed", pg.is_visible("#dhwWrap"))
        pg.select_option("#dhwMode", "none")
        check("and hidden again when switched off", pg.is_hidden("#dhwWrap"))
        pg.select_option("#dhwMode", "gas")
        pg.fill("#gasUnitRate", "6.238")
        pg.select_option("#importTariff", "agile")

        cards, err, _ = run(pg)
        check("no error on the run", err == "", err)
        # the card headings are upper-cased by the stylesheet
        check("hot water card is rendered", "HOT WATER" in cards.upper(), cards[:200])
        block = cards.upper().split("HOT WATER", 1)[1][:400]
        print("      card:", " ".join(block.split())[:240])
        check("it reports the breakeven price", "P/KWH" in block)
        check("it fired on some days", "ON 0 OF" not in block)

        # a run window that never goes cheap enough must refuse to fire, and say why
        pg.fill("#dhwRunFrom", "17:00")
        pg.fill("#dhwRunTo", "19:00")
        cards2, err2, _ = run(pg)
        check("no error on the peak-window run", err2 == "", err2)
        b2 = cards2.upper().split("HOT WATER", 1)[1][:400]
        print("      card:", " ".join(b2.split())[:240])
        check("peak-only window never fires", "ON 0 OF" in b2, " ".join(b2.split())[:160])
        body = pg.inner_text("body")
        check("and the page explains why", "never fired" in body.lower())

        # the auto-detected hot-water share is overridable, and the override is honoured
        pg.fill("#dhwRunFrom", "00:00")
        pg.fill("#dhwRunTo", "05:00")
        pg.fill("#dhwGasPerDay", "2")
        cards3, err3, _ = run(pg)
        check("no error with a manual hot-water figure", err3 == "", err3)
        b3 = cards3.upper().split("HOT WATER", 1)[1][:400]
        print("      card:", " ".join(b3.split())[:200])
        check("the override replaces the detected baseline", "2.0 KWH GAS/DAY" in b3,
              " ".join(b3.split())[:160])

        check("no console errors", not errs, "; ".join(errs[:3]))
        b.close()
finally:
    srv.terminate()
print(("FAILED " + str(fails)) if fails else "ALL PASS")
sys.exit(1 if fails else 0)
