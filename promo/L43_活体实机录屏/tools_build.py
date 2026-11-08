#!/usr/bin/env python3
"""把开发态 index.html + film/*.js + assets 内联成单文件 dist/index.html。"""
import base64, json, os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
OUT = os.path.join("dist")
os.makedirs(OUT, exist_ok=True)

html = open("index.html", encoding="utf-8").read()

def b64(path, mime):
    with open(path, "rb") as f:
        return f"data:{mime};base64," + base64.b64encode(f.read()).decode()

# 1) 字体 → data URI
for name in ["CascadiaCode.woff2", "FZXiaoBiaoSong.woff2"]:
    p = f"assets/fonts/{name}"
    html = html.replace(f'url("assets/fonts/{name}")', f'url("{b64(p, "font/woff2")}")')

# 2) 图片映射：JS 里用 window.__IMG，CSS/HTML 里直接替换
imgs = {}
for name in sorted(os.listdir("assets/img")):
    if name.lower().endswith((".jpg", ".jpeg", ".png")):
        imgs[name] = b64(f"assets/img/{name}", "image/jpeg" if name.lower().endswith(".jpg") else "image/png")
html = html.replace('src="assets/img/image-ref.jpg"', f'src="{imgs["image-ref.jpg"]}"')

# 3) 内联脚本；把 ui.js 的 IMG() 改成优先取 __IMG
scripts = re.findall(r'<script src="film/([a-zA-Z0-9_.-]+)"></script>', html)
inline = ['<script>window.__IMG=' + json.dumps(imgs) + ';</script>']
for name in scripts:
    src = open(f"film/{name}", encoding="utf-8").read()
    if name == "ui.js":
        src = src.replace('const IMG = (name) => `assets/img/${name}`;',
                          'const IMG = (name) => (window.__IMG && window.__IMG[name]) || `assets/img/${name}`;')
    inline.append(f"<script>\n/* ---- {name} ---- */\n{src}\n</script>")
html = re.sub(r'<script src="film/[a-zA-Z0-9_.-]+"></script>\n?', "", html)
html = html.replace('</body>', "\n".join(inline) + "\n</body>")

# 4) 去掉开发期注释里的外部引用提示（视觉无关），输出
out_path = os.path.join(OUT, "index.html")
open(out_path, "w", encoding="utf-8").write(html)
size = os.path.getsize(out_path)
print(f"dist/index.html  {size/1024/1024:.2f} MB  scripts={len(scripts)}  imgs={len(imgs)}")
