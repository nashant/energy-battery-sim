#!/usr/bin/env python3
"""
Real browser end-to-end test: drives the served page with Playwright, checks the rendered
figures against the known-good totals, exercises the day explorer and the animation, and
fails on any console error or page exception.

  python3 test/browser.py [url] [usage_csv]
"""
import re
import os
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8099"
CSV = sys.argv[2] if len(sys.argv) > 2 else "/home/anthonynash/Downloads/octopus-usage.csv"

fails = []


def check(ok, label, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {label}{('  ' + detail) if detail else ''}")
    if not ok:
        fails.append(label)


def money(text):
    """Pull the £ figures out of a block of rendered text."""
    return [float(x.replace(",", "")) for x in re.findall(r"£([\d,]+\.\d{2})", text)]


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1500, "height": 1100})
    errors, console = [], []
    page.on("console", lambda m: (console.append(f"{m.type}: {m.text}"),
                                  errors.append(m.text) if m.type == "error" else None))
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    page.goto(URL, wait_until="load")
    check(page.title() == "Battery & tariff simulator", "page loads", page.title())
    check(page.locator("#region option").count() == 14, "14 DNO regions populated")
    check(page.locator("#importTariff option").count() == 4, "4 import tariffs populated")
    check(page.locator("#run").is_disabled(), "Run disabled before any CSV is loaded")

    # --- upload usage CSV ---
    page.set_input_files("#fileUsage", CSV)
    # selector waits, not wait_for_function: string predicates are eval'd inside the page,
    # which the site's CSP (script-src 'self', no unsafe-eval) correctly blocks
    page.wait_for_selector("#usageInfo:has-text('slots')", timeout=20000)
    info = page.inner_text("#usageInfo")
    check("17,474 slots" in info, "usage CSV parsed in-browser", info.split("\n")[1])
    check(not page.locator("#run").is_disabled(), "Run enabled after upload")

    # --- scenario 1: Agile + Agile Outgoing, 10 kW ---
    page.select_option("#region", "J")
    page.select_option("#importTariff", "agile")
    page.select_option("#exportTariff", "agile-outgoing")
    page.fill("#inverterKw", "10")
    page.fill("#capacity", "32")
    page.click("#run")
    page.wait_for_selector("#status:text-is('done')",
                           timeout=180000)
    vals = money(page.inner_text("#cards"))
    check(any(abs(v - 1726.82) < 0.02 for v in vals), "current tariff = £1,726.82", str(vals))
    check(any(abs(v - 716.95) < 0.02 for v in vals),
          "defaults (contiguous + adaptive, 10% floor) 10kW = £716.95", str(vals))
    check(any(abs(v - 1488.09) < 0.02 for v in vals), "Agile no battery = £1,488.09")

    stats = page.inner_text("#statsNote")
    check("7228" in stats.replace(",", "") or "7,228" in stats,
          "throughput reported (7,228 kWh/yr)", stats.split("·")[-1].strip()[:60])
    check("carried across window boundaries" in stats, "carried-energy stat reported")

    # --- payback card (battery cost defaults to £3,500) ---
    cards_text = page.inner_text("#cards")
    check("Payback" in cards_text.upper() or "PAYBACK" in cards_text.upper(),
          "payback card rendered", cards_text[-120:])
    m = re.search(r"([\d.]+) yrs", cards_text)
    saving = 1726.82 - 716.95                        # saving vs current tariff
    expect_yrs = 3500 / (saving * 365 / (17474 / 48))
    check(m is not None and abs(float(m.group(1)) - expect_yrs) < 0.06,
          f"payback ≈ {expect_yrs:.1f} yrs (vs current) from £3,500 battery",
          m.group(0) if m else "no years found")
    # all three cost fields feed the total
    page.fill("#inverterCost", "1500")
    page.fill("#installCost", "1000")
    page.click("#run")
    page.wait_for_selector("#status:text-is('done')",
                           timeout=180000)
    cards_text = page.inner_text("#cards")
    m = re.search(r"([\d.]+) yrs", cards_text)
    expect_yrs = 6000 / (saving * 365 / (17474 / 48))
    check(m is not None and abs(float(m.group(1)) - expect_yrs) < 0.06,
          f"payback ≈ {expect_yrs:.1f} yrs from £6,000 total",
          m.group(0) if m else "no years found")
    page.fill("#inverterCost", "")
    page.fill("#installCost", "")

    # --- escalated payback (Task 4: "prices rising N%/yr" card segment) ---
    page.fill("#escPct", "3")
    page.click("#run")
    page.wait_for_selector("#status:text-is('done')", timeout=180000)
    cards_text = page.inner_text("#cards")
    check("rising 3%/yr" in cards_text, "escalation shown on payback card",
          cards_text[-160:])
    before_esc_cards = cards_text

    # --- sensitivity sweeps (Task 6): progress, two tables, .cur row, saving parity ---
    check(not page.locator("#sensSection").is_hidden(), "sensitivity panel visible after a run")
    page.click("#runSweeps")
    page.wait_for_selector("#sweepCapTable", timeout=300000)
    cap_rows = page.locator("#sweepCapTable tbody tr").count()
    inv_rows = page.locator("#sweepInvTable tbody tr").count()
    check(cap_rows == 7, "capacity sweep has 7 rows", str(cap_rows))
    check(inv_rows >= 6, "inverter sweep has >=6 rows", str(inv_rows))
    check(page.locator("#sweepCapTable tr.cur").count() == 1,
          "current capacity row highlighted (.cur)")
    check(page.locator("#sweepInvTable tr.cur").count() == 1,
          "current inverter row highlighted (.cur)")
    cur_saving = page.inner_text("#sweepCapTable tr.cur td:nth-child(3)").strip()
    check(cur_saving in before_esc_cards,
          "current sweep row's Saving cell matches the 'Saving vs current' card",
          cur_saving)

    # --- sweep row correctness (Important #5): the .cur row only proves column
    # indexing (it reuses withBat verbatim) -- prove a solver-computed row is right
    # by re-running directly at that capacity and comparing the "With battery" total.
    sweep_cap_rows = page.locator("#sweepCapTable tbody tr").all()
    other_cap, other_total = None, None
    for r in sweep_cap_rows:
        cells = r.locator("td").all_inner_texts()
        if cells[0] == "24":
            other_cap, other_total = cells[0], cells[1].strip()
            break
    check(other_total is not None, "found a non-current (24 kWh) sweep row",
          str(other_total))
    page.fill("#capacity", other_cap or "24")
    page.click("#run")
    page.wait_for_selector("#status:text-is('done')", timeout=180000)
    direct_total = page.locator("#cards .card").nth(2).locator(".v").inner_text().strip()
    check(other_total is not None and direct_total == other_total,
          "24 kWh sweep row's Total matches a direct Run at capacity=24",
          f"sweep={other_total} direct={direct_total}")
    page.fill("#capacity", "32")
    page.click("#run")
    page.wait_for_selector("#status:text-is('done')", timeout=180000)

    # --- reset: blanking escalation reproduces the old (non-escalated) card ---
    page.fill("#escPct", "")
    page.click("#run")
    page.wait_for_selector("#status:text-is('done')", timeout=180000)
    cards_text = page.inner_text("#cards")
    check("rising" not in cards_text, "no escalation text once escPct is blank again",
          cards_text[-160:])
    vals = money(cards_text)
    check(any(abs(v - 716.95) < 0.02 for v in vals),
          "resetting escPct reproduces the original £716.95 card", str(vals))

    # --- heat-pump full ledger from a real gas CSV (skipped when the file is absent) ---
    GAS_CSV = os.path.expanduser("~/Downloads/download.csv")
    if os.path.exists(GAS_CSV):
        page.set_input_files("#fileGas", GAS_CSV)
        page.wait_for_selector("#gasInfo:has-text('implied')", timeout=20000)
        check("p/kWh" in page.inner_text("#gasInfo"),
              "gas CSV implies a unit rate", page.inner_text("#gasInfo")[-60:])
        check(page.input_value("#gasUnitRate") == "6.24"
              and page.input_value("#gasScPerDay") == "29.95",
              "implied prices populate the section-6 inputs",
              f"rate={page.input_value('#gasUnitRate')} sc={page.input_value('#gasScPerDay')}")
        # loadGas auto-selects gas mode; add a HP cost, leave gas prices blank (implied)
        page.fill("#hpCost", "5000")
        page.click("#run")
        page.wait_for_selector("#status:text-is('done')", timeout=180000)
        cards_text = page.inner_text("#cards")
        check("heat pump" in cards_text, "payback card splits out the heat pump cost",
              cards_text[-200:])
        check("gas bill removed" in cards_text,
              "gas bill credit appears from implied rates alone", cards_text[-200:])
        warn_text = page.inner_text("#warnings")
        check("Gas CSV covers" in warn_text,
              "short gas CSV raises the coverage warning", warn_text[:120])
        # reset: HP off again must reproduce the default card exactly
        page.fill("#hpCost", "")           # clear while still visible (none-mode hides them)
        page.fill("#gasUnitRate", "")
        page.fill("#gasScPerDay", "")
        page.select_option("#hpMode", "none")
        page.click("#run")
        page.wait_for_selector("#status:text-is('done')", timeout=180000)
        vals = money(page.inner_text("#cards"))
        check(any(abs(v - 716.95) < 0.02 for v in vals),
              "disabling the heat pump restores the £716.95 card", str(vals))
    else:
        print("SKIP  gas-CSV ledger checks (no ~/Downloads/download.csv)")

    # --- day explorer always shows calendar days, whatever the strategy solved on ---
    labels = page.locator("#daySelect option").all_inner_texts()
    dates = [l.split(" — ")[0] for l in labels]
    check(len(dates) == 365 and all(re.match(r"^\d{4}-\d{2}-\d{2}$", d) for d in dates),
          "365 calendar days in the picker under cycle strategy",
          f"{len(dates)} options, first {dates[0] if dates else '—'}")
    page.select_option("#daySelect", dates[10])
    check(page.locator("#slotSelect option").count() == 48,
          "48 half-hour slots per day under cycle strategy")

    # --- non-default strategy: scattered + end-of-day ---
    page.select_option("#cycle", "scattered")
    page.select_option("#boundary", "midnight")
    page.click("#run")
    page.wait_for_selector("#status:text-is('done')",
                           timeout=180000)
    vals = money(page.inner_text("#cards"))
    check(any(abs(v - 708.05) < 0.02 for v in vals),
          "scattered + end-of-day = £708.05", str(vals))

    # --- day explorer ---
    check(page.locator("#daySelect option").count() == 365, "365 days in the day picker",
          str(page.locator("#daySelect option").count()))
    page.select_option("#dayPreset", "best")
    day = page.input_value("#daySelect")
    note = page.inner_text("#dayNote")
    check("saved" in note, f"biggest-saving day selected ({day})", note[:80])

    # flow diagram must render live edges and a state-of-charge bar
    page.fill("#slotSlider", "2")
    page.dispatch_event("#slotSlider", "input")
    active = page.locator("#flow .flow-live.active").count()
    check(active >= 1, "flow diagram has active edges", f"{active} active")
    soc_w = page.get_attribute("#flow .soc-fill", "width")
    check(soc_w is not None, "state-of-charge bar rendered", f"width={soc_w}")
    check(page.locator("#slotTable tr").count() >= 9, "slot detail table populated")
    check(page.locator("#dayChart path").count() >= 3, "day chart drawn")

    # scrub to a slot that exports, and confirm the export edge lights up
    exporting = page.evaluate("""() => {
        const s = document.getElementById('slotSlider');
        return null; }""")
    found_export = False
    for i in range(0, int(page.get_attribute("#slotSlider", "max")) + 1):
        page.fill("#slotSlider", str(i))
        page.dispatch_event("#slotSlider", "input")
        if page.locator("#flow .flow-live.export.active").count() > 0:
            found_export = True
            break
    check(found_export, "export flow animates on an exporting slot")

    # --- animation actually advances the slot ---
    page.fill("#slotSlider", "0")
    page.dispatch_event("#slotSlider", "input")
    t0 = page.inner_text("#slotTime")
    page.click("#play")
    page.wait_for_timeout(1400)
    t1 = page.inner_text("#slotTime")
    page.click("#play")
    check(t0 != t1, "Play advances the half-hour slider", f"{t0} -> {t1}")

    # --- play rolls over into the next day ---
    first = page.locator("#daySelect option").nth(0).get_attribute("value")
    second = page.locator("#daySelect option").nth(1).get_attribute("value")
    page.select_option("#daySelect", first)
    page.fill("#slotSlider", page.get_attribute("#slotSlider", "max"))
    page.dispatch_event("#slotSlider", "input")
    page.click("#play")
    page.wait_for_timeout(1200)
    page.click("#play")
    check(page.input_value("#daySelect") == second,
          "play rolls over to the next day", f"{first} -> {page.input_value('#daySelect')}")

    # --- time dropdown drives the slot and stays in sync with the slider ---
    check(page.locator("#slotSelect option").count() == 48,
          "time dropdown holds 48 slots", str(page.locator("#slotSelect option").count()))
    page.select_option("#slotSelect", "24")
    check(page.inner_text("#slotTime") == "12:00",
          "picking 12:00 in the time dropdown shows that slot", page.inner_text("#slotTime"))
    check(page.input_value("#slotSlider") == "24", "slider follows the time dropdown")
    page.fill("#slotSlider", "6")
    page.dispatch_event("#slotSlider", "input")
    check(page.input_value("#slotSelect") == "6", "time dropdown follows the slider")

    check(page.locator("#monthTable tbody tr").count() == 13,
          "monthly table has 13 rows", str(page.locator("#monthTable tbody tr").count()))

    # --- scenario 2: G100 export limit control ---
    page.fill("#exportLimitKw", "5")
    page.click("#run")
    page.wait_for_selector("#status:text-is('done')",
                           timeout=180000)
    vals = money(page.inner_text("#cards"))
    check(any(abs(v - 757.30) < 0.02 for v in vals),
          "G100 export limit 5kW = £757.30", str(vals))
    check("G100 limit" in page.inner_text("#statsNote"), "G100 limit reported in stats")

    # --- heat pump control ---
    page.fill("#exportLimitKw", "")
    page.select_option("#hpMode", "synthetic")
    page.fill("#hpKwh", "4000")
    page.click("#run")
    page.wait_for_selector("#status:text-is('done')",
                           timeout=180000)
    vals = money(page.inner_text("#cards"))
    check(any(abs(v - 1400.70) < 0.05 for v in vals),
          "heat pump +4000 kWh = £1,400.70", str(vals))
    check("heat pump" in page.inner_text("#statsNote"), "heat pump kWh reported")

    # --- discharge-by-next-charge-cycle boundary ---
    page.select_option("#hpMode", "none")
    page.select_option("#boundary", "cycle")
    page.click("#run")
    page.wait_for_selector("#status:text-is('done')",
                           timeout=180000)
    vals = money(page.inner_text("#cards"))
    check(any(abs(v - 705.59) < 0.02 for v in vals),
          "discharge by next charge cycle = £705.59", str(vals))
    check("cycles" in page.inner_text("#statsNote"),
          "stats note counts cycles, not days")
    page.select_option("#boundary", "midnight")

    page.screenshot(path="test/screenshot-full.png", full_page=True)
    page.locator("#flow").screenshot(path="test/screenshot-flow.png")
    print("\nwrote test/screenshot-full.png and test/screenshot-flow.png")

    # --- uploaded CSV is cached in the browser across reloads ---
    page.reload(wait_until="load")
    page.wait_for_selector("#usageInfo:has-text('slots')", timeout=20000)
    check("17,474 slots" in page.inner_text("#usageInfo"),
          "usage restored from cache after reload", page.inner_text("#usageInfo")[:70])
    check("restored from this browser" in page.inner_text("#usageInfo"),
          "restored state labelled as cached")
    check(not page.locator("#run").is_disabled(), "Run enabled from cached usage")
    page.click("#clearCache")
    page.wait_for_selector("#status:text-is('cached rates & data cleared')", timeout=20000)
    page.reload(wait_until="load")
    page.wait_for_timeout(800)
    check(page.locator("#run").is_disabled(), "clearing cache forgets the CSV again")

    real_errors = [e for e in errors if "favicon" not in e.lower()]
    check(not real_errors, "no console errors or page exceptions",
          "; ".join(real_errors[:3]) if real_errors else f"{len(console)} console messages")

    browser.close()

print(f"\n{len(fails)} check(s) FAILED: {fails}" if fails else "\nall browser checks passed")
sys.exit(1 if fails else 0)
