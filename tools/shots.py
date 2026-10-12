"""README screenshots for Claude Mod Pack, drawn from the mods' own output with sample data.

Runs status-band's tests, takes the trees its screenshot test prints (the band and the /mods
panel, exactly as the mod hands them to the desktop app), lays each out as HTML in the desktop
app's dark style, and photographs it with headless Edge or Chrome.

    python tools/shots.py

Writes docs/band-sample.png and docs/mods-panel.png. Needs Python 3 with Pillow, and Edge or Chrome.
"""

import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
UNIT = 8  # pixels per layout cell for gaps and padding
BG = (24, 24, 23)

CSS = """
body { margin: 0; background: rgb(24,24,23); font: 14px/1.45 "Segoe UI", system-ui, sans-serif; color: #ECEBE6; }
.frame { display: inline-block; padding: 24px; }
.card { background: #262624; border-radius: 12px; padding: 14px 16px; }
.pane { background: #262624; border-radius: 12px; padding: 14px 18px; width: 640px; }
.pane-title { font-weight: 600; margin-bottom: 12px; color: #ECEBE6; }
.box { display: flex; min-width: 0; }
.t { white-space: pre; }
.wrap { white-space: pre-wrap; }
.dim { color: #8F8E88; }
.b { font-weight: 600; }
.btn { background: #3A3A37; color: #ECEBE6; border-radius: 6px; padding: 2px 9px; white-space: nowrap; align-self: flex-start; }
.btn.plain { background: transparent; border: 1px solid #4A4A46; padding: 0 8px; font-size: 13px; color: #C9C8C2; }
"""


def cells(v):
    return f"{v * UNIT}px"


def node(n):
    if n is None:
        return ""
    if isinstance(n, str):
        return html.escape(n)
    t, p = n.get("type"), n.get("props", {})
    kids = "".join(node(c) for c in n.get("children") or [])
    if t == "Box":
        s = [f"flex-direction:{p.get('flexDirection', 'row')}"]
        if "gap" in p:
            s.append(f"gap:{cells(p['gap'])}")
        if "paddingX" in p:
            s.append(f"padding-left:{cells(p['paddingX'])};padding-right:{cells(p['paddingX'])}")
        if "marginLeft" in p:
            s.append(f"margin-left:{p['marginLeft']}ch")
        if "width" in p:
            s.append(f"width:{p['width']}ch")
        if "minWidth" in p:
            s.append(f"min-width:{p['minWidth']}ch")
        if "alignItems" in p:
            s.append(f"align-items:{p['alignItems'].replace('flex-', '')}")
        if p.get("flexWrap") == "wrap":
            s.append("flex-wrap:wrap")
        if "flexShrink" in p:
            s.append(f"flex-shrink:{p['flexShrink']}")
        if "flexGrow" in p:
            s.append(f"flex-grow:{p['flexGrow']}")
        if "backgroundColor" in p:
            s.append(f"background:{p['backgroundColor']};border-radius:6px;padding-top:4px;padding-bottom:4px")
        return f'<div class="box" style="{";".join(s)}">{kids}</div>'
    if t == "Text":
        cls = ["wrap" if p.get("wrap") == "wrap" else "t"]
        if p.get("dimColor"):
            cls.append("dim")
        if p.get("bold"):
            cls.append("b")
        style = f' style="color:{p["color"]}"' if p.get("color") else ""
        return f'<span class="{" ".join(cls)}"{style}>{kids}</span>'
    if t == "Button":
        plain = " plain" if p.get("plain") else ""
        return f'<span class="btn{plain}">{html.escape(p.get("label", ""))}</span>'
    if t == "Svg":
        src = re.sub(r"<svg\b", f'<svg width="{p.get("width")}" height="{p.get("height")}"', p["source"], count=1)
        return f'<span style="display:inline-flex">{src}</span>'
    return kids


def browser():
    for c in [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ]:
        if os.path.exists(c):
            return c
    for name in ("msedge", "google-chrome", "chromium", "chrome"):
        if shutil.which(name):
            return shutil.which(name)
    sys.exit("Needs Edge or Chrome for the screenshots.")


def shoot(body, out, width):
    page = f"<!doctype html><meta charset=utf-8><style>{CSS}</style><div class=frame>{body}</div>"
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "shot.html"
        raw = Path(tmp) / "shot.png"
        src.write_text(page, encoding="utf-8")
        subprocess.run(
            [browser(), "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
             f"--window-size={width},1400", f"--screenshot={raw}", src.as_uri()],
            check=True, capture_output=True, timeout=60,
        )
        img = Image.open(raw).convert("RGB")
    # Crop to the card plus a margin: everything that is not the page background.
    bg = Image.new("RGB", img.size, BG)
    from PIL import ImageChops
    box = ImageChops.difference(img, bg).convert("L").point(lambda v: 255 if v > 6 else 0).getbbox()
    pad = 24
    img = img.crop((max(box[0] - pad, 0), max(box[1] - pad, 0), min(box[2] + pad, img.width), min(box[3] + pad, img.height)))
    img.save(out, optimize=True)
    print(f"wrote {out.relative_to(ROOT)} {img.size[0]}x{img.size[1]}")


def main():
    run = subprocess.run(["claude", "plugin", "test", str(ROOT / "status-band")], capture_output=True, text=True, encoding="utf-8", errors="replace")
    trees = {m.group(1): json.loads(m.group(2)) for m in re.finditer(r"SHOT (\w+) (\{.*\})", run.stdout + run.stderr)}
    if set(trees) != {"band", "mods"}:
        sys.exit("status-band's screenshot test printed no trees:\n" + (run.stdout + run.stderr)[-2000:])
    DOCS.mkdir(exist_ok=True)
    shoot(f'<div class="card" style="width:1060px">{node(trees["band"])}</div>', DOCS / "band-sample.png", 1200)
    shoot(f'<div class="pane"><div class="pane-title">Mods</div>{node(trees["mods"])}</div>', DOCS / "mods-panel.png", 800)


if __name__ == "__main__":
    main()
