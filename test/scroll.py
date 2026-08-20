#!/usr/bin/env python3
"""
Rigorous scroll/overflow test across viewports.

The weak version of this test just compared scrollWidth to clientWidth. That misses the
case that actually matters: content wider than the viewport is FINE if it sits inside a
scrollable container, and BROKEN if it doesn't. So the real check walks up from every
overflowing element looking for a scrollable ancestor, and fails only when there is none.

Also verifies the page cannot be dragged sideways, that both sticky bars survive scrolling
to any depth, and that each scroll container's far edge is actually reachable.

  python3 test/scroll.py [url]
"""
import sys
import time

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8099"
CSV = "/home/anthonynash/Downloads/octopus-usage.csv"

# heights are the USABLE viewport, i.e. after Android Chrome's URL bar, not the device
# height. Testing with the full device height hides sticky bars eating the screen.
VIEWPORTS = [
    ("Android small + URL bar", 360, 510),
    ("Galaxy S21 + URL bar", 360, 670),
    ("Pixel 7 + URL bar", 412, 780),
    ("Pixel 7 fullscreen", 412, 915),
    ("Android landscape", 780, 360),
    ("tablet portrait", 768, 1024),
    ("desktop", 1500, 1100),
]

# elements genuinely wider than the viewport must have a scrollable ancestor
UNREACHABLE = """() => {
  const cw = document.documentElement.clientWidth;
  const bad = [];
  const scrollableAncestor = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ov = getComputedStyle(p).overflowX;
      if ((ov === 'auto' || ov === 'scroll') && p.scrollWidth > p.clientWidth + 1) return p;
    }
    return null;
  };
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.right <= cw + 1) return;
    if (scrollableAncestor(el)) return;                 // reachable by scrolling its box
    if (el.closest('svg')) return;                      // svg scales via viewBox
    bad.push(`${el.tagName}${el.id ? '#' + el.id : ''} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
  });
  return bad;
}"""

SCROLL_BOXES = """() => {
  const out = [];
  document.querySelectorAll('.scroll').forEach((el) => {
    if (el.scrollWidth <= el.clientWidth + 1) return;
    const before = el.scrollLeft;
    el.scrollLeft = el.scrollWidth;
    const reached = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    el.scrollLeft = before;
    out.push({ id: el.querySelector('table') ? el.querySelector('table').id : '(box)',
               scrollW: el.scrollWidth, clientW: el.clientWidth, farEdgeReachable: reached });
  });
  return out;
}"""


def poll(fn, t=300):
    end = time.time() + t
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.4)
    return False


fails = []


def check(ok, label, detail=""):
    print(f"    {'PASS' if ok else 'FAIL'}  {label}{('  ' + detail) if detail else ''}")
    if not ok:
        fails.append(label)


def run_engine(pw, engine_name):
    launcher = getattr(pw, engine_name)
    browser = launcher.launch()
    print(f"\n=== engine: {engine_name} ({browser.version}) ===")
    for label, w, h in VIEWPORTS:
        page = browser.new_page(viewport={"width": w, "height": h}, is_mobile=w < 700)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.goto(URL, wait_until="load")
        page.set_input_files("#fileUsage", CSV)
        poll(lambda: "slots" in page.inner_text("#usageInfo"))
        page.select_option("#region", "J")
        page.click("#run")
        poll(lambda: page.inner_text("#status").strip() == "done")
        # widest possible content
        page.click("#compare")
        poll(lambda: page.inner_text("#status").strip() == "done", 420)
        print(f"\n  {label} ({w}x{h})")

        # 1. the page itself must not scroll sideways, even if asked to
        page.evaluate("window.scrollTo(2000, 0)")
        sx = page.evaluate("window.scrollX")
        sw = page.evaluate("document.documentElement.scrollWidth")
        cw = page.evaluate("document.documentElement.clientWidth")
        check(sx == 0 and sw <= cw + 1, "page cannot scroll horizontally",
              f"scrollX={sx} scrollWidth={sw} clientWidth={cw}")

        # 2. nothing overflows without a way to reach it
        bad = page.evaluate(UNREACHABLE)
        check(not bad, "no unreachable overflowing content",
              f"{len(bad)} offenders: {bad[:3]}" if bad else "")

        # 3. wide tables scroll inside their own box, and the far edge is reachable
        boxes = page.evaluate(SCROLL_BOXES)
        check(all(b["farEdgeReachable"] for b in boxes), "scroll boxes reach their far edge",
              f"{len(boxes)} scrolling: " + ", ".join(
                  f"{b['id']} {b['clientW']}->{b['scrollW']}px" for b in boxes) if boxes else "none needed")

        # 4. with nothing pinned, the controls must still be REACHABLE by scrolling up
        if w < 1001:
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(60)
            st = page.evaluate("""() => {
              const s = document.getElementById('controlsSummary').getBoundingClientRect();
              const a = document.querySelector('.actions').getBoundingClientRect();
              const vh = window.innerHeight;
              return { sum: s.bottom > 0 && s.top < vh, act: a.bottom > 0 && a.top < vh };
            }""")
            check(st["sum"] and st["act"], "Settings + Run reachable by scrolling to top", str(st))

        # 4b. nothing may overlay the content on mobile -- sticky/fixed bars fight the
        # collapsing URL bar and make scrolling feel broken
        if w < 1001:
            overlays = page.evaluate("""() => {
              const bad = [];
              document.querySelectorAll('body *').forEach((el) => {
                const p = getComputedStyle(el).position;
                if (p === 'sticky' || p === 'fixed') {
                  const r = el.getBoundingClientRect();
                  if (r.height > 0) bad.push(`${el.tagName}${el.id?'#'+el.id:''}${el.className&&typeof el.className==='string'?'.'+el.className.split(' ')[0]:''} ${p} h=${Math.round(r.height)}`);
                }
              });
              return bad;
            }""")
            check(not overlays, "nothing sticky or fixed overlaying content",
                  f"{len(overlays)}: {overlays[:3]}" if overlays else "")

        # 5. the interactive bits must be usable at this width
        page.evaluate("window.scrollTo(0, 0)")
        page.fill("#slotSlider", "20")
        page.dispatch_event("#slotSlider", "input")
        flow_w = page.evaluate("document.querySelector('#flow svg').getBoundingClientRect().width")
        check(page.inner_text("#slotTime") != "" and flow_w <= cw + 1,
              "day-explorer slider works and flow diagram fits",
              f"time={page.inner_text('#slotTime')} flowWidth={flow_w:.0f}")

        check(not [e for e in errs if "favicon" not in e.lower()], "no console errors",
              str([e[:60] for e in errs][:2]))
        page.close()
    browser.close()


with sync_playwright() as pw:
    engines = ["chromium"]
    try:
        b = pw.webkit.launch(); b.close(); engines.append("webkit")
    except Exception as e:
        print(f"NOTE: webkit unavailable, Safari engine untested "
              f"({str(e).splitlines()[0][:80]})")
    for eng in engines:
        run_engine(pw, eng)

print(f"\n{len(fails)} check(s) FAILED: {sorted(set(fails))}" if fails
      else "\nall scroll/overflow checks passed")
sys.exit(1 if fails else 0)
