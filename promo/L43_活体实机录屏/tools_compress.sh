#!/bin/bash
# 把 assets/raw 的 PNG 压成页面用 JPG：横图裁 16:9，方图 768。
set -e
SRC="assets/raw"; DST="assets/img"
PY=/Users/mimi/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/python/bin/python3
"$PY" - <<'PY'
from PIL import Image
import os, glob
src, dst = "assets/raw", "assets/img"
os.makedirs(dst, exist_ok=True)
for f in sorted(glob.glob(os.path.join(src, "*.png"))):
    name = os.path.splitext(os.path.basename(f))[0]
    im = Image.open(f).convert("RGB")
    w, h = im.size
    if w > h:
        target_h = int(w * 9 / 16)
        top = (h - target_h) // 2
        im = im.crop((0, top, w, top + target_h)).resize((1152, 648), Image.LANCZOS)
    else:
        s = min(w, h)
        left, top = (w - s) // 2, (h - s) // 2
        im = im.crop((left, top, left + s, top + s)).resize((768, 768), Image.LANCZOS)
    out = os.path.join(dst, name + ".jpg")
    im.save(out, "JPEG", quality=82, optimize=True, progressive=True)
    print(name, os.path.getsize(out) // 1024, "KB")
PY
