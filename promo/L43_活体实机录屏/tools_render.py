#!/usr/bin/env python3
"""逐帧渲染 90s 成片 + 导出音频，调 ffmpeg 合成 mp4。"""
import asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
URL = "http://127.0.0.1:8123/promo/L43_%E6%B4%BB%E4%BD%93%E5%AE%9E%E6%9C%BA%E5%BD%95%E5%B1%8F/dist/index.html"
FFMPEG = "/Users/mimi/.local/lib/python3.12/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-x86_64-v9.0.2"
FRAMES = "render/frames"
FPS, TOTAL = 30, 90

async def main():
    os.makedirs(FRAMES, exist_ok=True)
    t0 = time.time()
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=True, args=["--force-device-scale-factor=1", "--hide-scrollbars"])
        page = await browser.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1, accept_downloads=True)
        await page.goto(URL, wait_until="networkidle")
        await page.evaluate("async () => { await document.fonts.ready; return !!window.FILM; }")
        ok = await page.evaluate("() => !!(window.FILM && window.FILM.engine && document.querySelector('#pixelLayer'))")
        if not ok:
            raise SystemExit("FILM not ready")
        # 关键：先暂停自动播放，否则 seek 会被播放循环覆盖
        await page.evaluate("() => window.FILM.engine.pause()")
        n = FPS * TOTAL
        for i in range(n):
            await page.evaluate(f"() => window.FILM.engine.seek({i / FPS:.4f})")
            await page.screenshot(path=f"{FRAMES}/f{i:05d}.jpg", type="jpeg", quality=92)
            if i % 150 == 0:
                print(f"frame {i}/{n}  {time.time()-t0:.0f}s", flush=True)
        # 音频：OfflineAudioContext 渲染 → WAV → 浏览器下载
        async with page.expect_download(timeout=180000) as dl:
            await page.evaluate("""async () => {
          const buf = await window.FILM.renderAudio(90);
          const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
          const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
          const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
          w(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
          data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
          data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true);
          data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, len * ch * 2, true);
          let off = 44;
          const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
          for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
            let v = Math.max(-1, Math.min(1, chans[c][i]));
            data.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true); off += 2;
          }
          const blob = new Blob([data], { type: 'audio/wav' });
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'audio.wav';
          document.body.appendChild(a); a.click();
        }""")
        download = await dl.value
        await download.save_as("render/audio.wav")
        await browser.close()
    print(f"captured {n} frames in {time.time()-t0:.0f}s", flush=True)
    subprocess.run([FFMPEG, "-y", "-framerate", str(FPS), "-i", f"{FRAMES}/f%05d.jpg", "-i", "render/audio.wav",
                    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
                    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart", "-shortest", "render/小方上岗记_L43_90s.mp4"], check=True)
    print("mp4 done", flush=True)

asyncio.run(main())
