/* ============================================================
 * engine.js — 舞台、相机、确定性时间轴 seek(t)、HUD、播放与音频调度
 * ============================================================ */
(function () {
  const FILM = (window.FILM = window.FILM || {});

  /* ---------- 常量 ---------- */
  const FILM_W = 1920, FILM_H = 1080, FPS = 30, TOTAL = 90.0;
  const WIN_W = 1366, WIN_H = 768, U = 8;
  const WIN_SCALE = 1.125;
  const WIN_LEFT = (FILM_W - WIN_W * WIN_SCALE) / 2; // 191.625
  const WIN_TOP = (FILM_H - WIN_H * WIN_SCALE) / 2;  // 108
  const U_STAGE = U * WIN_SCALE;                      // 9
  if (FILM.mascot && FILM.mascot.setUnit) FILM.mascot.setUnit(WIN_SCALE);
  const SHOTS = FILM.shots;

  /* ---------- DOM ---------- */
  const $ = (s) => document.querySelector(s);
  const viewport = $("#viewport");
  const cameraEl = $("#camera");
  const stage = $("#stage");
  const winEl = $("#window");
  const cvWorldEl = $("#cvWorld");
  const canvas = $("#pixelLayer");
  const ctx = canvas.getContext("2d");
  const chapterPill = $("#chapterPill");
  const chapterNum = $("#chapterNum");
  const chapterText = $("#chapterText");
  const captionPill = $("#captionPill");
  const keyHud = $("#keyHud");
  const wipeEl = $("#wipe");
  const wipeBar = $("#wipeBar");
  const cursorEl = $("#cursor");
  const debugEl = $("#debug");

  /* ---------- 屏幕自适应 ---------- */
  function fit() {
    const k = Math.min(window.innerWidth / FILM_W, window.innerHeight / FILM_H);
    viewport.style.setProperty("--fit", String(k));
  }
  window.addEventListener("resize", fit);
  fit();

  /* ---------- 坐标换算 ---------- */
  const toStage = (x, y) => ({ x: WIN_LEFT + x * WIN_SCALE, y: WIN_TOP + y * WIN_SCALE });
  toStage.unit = WIN_SCALE;

  /* ---------- 锚点测量（offsetParent 链，不受 transform 影响） ---------- */
  const anchorCache = new Map();
  function measure(name) {
    if (anchorCache.has(name)) return anchorCache.get(name);
    const el = document.querySelector('[data-anchor="' + name + '"]');
    if (!el) {
      anchorCache.set(name, null);
      return null;
    }
    let x = 0, y = 0, cur = el, localWorld = null;
    while (cur && cur !== winEl) {
      if (cur === cvWorldEl && !localWorld) localWorld = { x, y };
      x += cur.offsetLeft || 0;
      y += cur.offsetTop || 0;
      cur = cur.offsetParent;
    }
    // 扣除祖先滚动偏移（聊天流滚动后锚点仍要对齐视觉位置）
    let scrollX = 0, scrollY = 0;
    for (let a = el; a && a !== winEl; a = a.parentElement) {
      scrollX += a.scrollLeft || 0;
      scrollY += a.scrollTop || 0;
    }
    let w = el.offsetWidth, h = el.offsetHeight;
    const wt = FILM.ui && FILM.ui.worldTransform;
    if (localWorld && wt) {
      // 画布节点在 #cvWorld 的产品视口变换内：把局部坐标映射到窗口坐标
      x = x - localWorld.x + wt.panX + localWorld.x * wt.zoom;
      y = y - localWorld.y + wt.panY + localWorld.y * wt.zoom;
      w *= wt.zoom;
      h *= wt.zoom;
    }
    x -= scrollX;
    y -= scrollY;
    const r = {
      left: x,
      top: y,
      w,
      h,
      cx: x + w / 2,
      right: x + w,
      bottom: y + h,
    };
    anchorCache.set(name, r);
    return r;
  }
  function A(name) {
    return measure(name) || { left: 0, top: 0, w: 0, h: 0, cx: 0, right: 0, bottom: 0 };
  }

  /* ---------- 相机 ---------- */
  function applyCamera(cam) {
    const f = toStage(cam.cx, cam.cy);
    const tx = FILM_W / 2 - f.x * cam.zoom;
    const ty = FILM_H / 2 - f.y * cam.zoom;
    cameraEl.style.transform = `translate(${tx}px, ${ty}px) scale(${cam.zoom})`;
  }

  /* ---------- 小方 / 像素层渲染 ---------- */
  function drawPixelLayer(t) {
    ctx.clearRect(0, 0, FILM_W, FILM_H);
    // 出生像素块
    const blocks = SHOTS.blocksAt(t);
    if (blocks) {
      blocks.forEach((b) => FILM.mascot.drawBlock(ctx, b, toStage));
    }
    // 小方
    const m = SHOTS.mascotAt(t, A);
    if (m) {
      FILM.mascot.draw(ctx, { ...m, u: U_STAGE }, toStage);
      if (m.dust) {
        ctx.save();
        m.dust.forEach((d) => {
          const p = toStage(d.x, d.y);
          const s = Math.max(2, Math.round(d.size * WIN_SCALE));
          ctx.globalAlpha = d.alpha;
          ctx.fillStyle = "#EFE3D2";
          ctx.fillRect(Math.round(p.x), Math.round(p.y), s, s);
        });
        ctx.restore();
      }
    }
  }

  /* ---------- 光标 ---------- */
  function applyCursor(t, cam) {
    const f = toStage(cam.cx, cam.cy);
    // 锚点中心 → 屏幕坐标（跟随相机）
    const S = (name, dx, dy) => {
      const a = A(name);
      const wx = a.cx + (dx || 0);
      const wy = a.top + a.h / 2 + (dy || 0);
      const sx = WIN_LEFT + wx * WIN_SCALE;
      const sy = WIN_TOP + wy * WIN_SCALE;
      return { x: 960 + (sx - f.x) * cam.zoom, y: 540 + (sy - f.y) * cam.zoom };
    };
    const c = SHOTS.cursorAt(t, S);
    cursorEl.style.left = c.x + "px";
    cursorEl.style.top = c.y + "px";
    cursorEl.style.opacity = String(c.opacity == null ? 1 : c.opacity);
    const ripple = $("#cursorRipple");
    if (ripple) {
      const k = c.click || 0;
      ripple.style.opacity = String(k * 0.55);
      ripple.style.transform = "scale(" + (1 + k * 0.8) + ")";
    }
  }

  /* ---------- HUD ---------- */
  function applyChapter(t) {
    const ch = SHOTS.chapterAt(t);
    if (!ch) {
      chapterPill.style.opacity = "0";
      return;
    }
    chapterNum.textContent = ch.num;
    chapterText.textContent = ch.text;
    chapterPill.style.opacity = String(ch.opacity == null ? 1 : ch.opacity);
    const r = Math.max(0, Math.min(1, ch.reveal == null ? 1 : ch.reveal));
    chapterPill.style.clipPath = `inset(0 ${(1 - r) * 100}% 0 0 round 999px)`;
  }

  function applyCaption(t) {
    const c = SHOTS.captionAt(t);
    if (!c) {
      captionPill.style.opacity = "0";
      return;
    }
    captionPill.textContent = c.text;
    captionPill.style.opacity = String(c.opacity == null ? 1 : c.opacity);
  }

  function applyKeys(t) {
    const k = SHOTS.keysAt(t);
    if (!k || !k.labels || !k.labels.length) {
      keyHud.style.opacity = "0";
      keyHud.innerHTML = "";
      return;
    }
    keyHud.style.opacity = "1";
    keyHud.innerHTML = k.labels.map((label) => `<span class="key">${label}</span>`).join("");
  }

  function applyWipe(t) {
    const w = SHOTS.wipeAt(t);
    if (!w) {
      wipeEl.style.opacity = "0";
      return;
    }
    const p = w.progress;
    wipeEl.style.opacity = String(Math.sin(Math.PI * p) * 0.55);
    wipeEl.style.transform = "none";
    wipeBar.style.left = Math.round(-240 + p * (FILM_W + 480)) + "px";
  }

  /* ---------- 主渲染入口：seek(t) 纯函数 ---------- */
  let currentT = 0;
  function seek(tRaw) {
    const t = Math.max(0, Math.min(TOTAL, tRaw));
    currentT = t;
    // 先更新 UI 状态，再测量锚点（保证新出现的卡片能被小方踩到）
    if (SHOTS.uiStateAt) FILM.ui.render(SHOTS.uiStateAt(t));
    anchorCache.clear();
    const cam = SHOTS.cameraAt(t);
    applyCamera(cam);
    drawPixelLayer(t);
    applyCursor(t, cam);
    applyChapter(t);
    applyCaption(t);
    applyKeys(t);
    applyWipe(t);
    if (debugEl && debugEl.dataset.on === "1") {
      debugEl.textContent = `t=${t.toFixed(2)}s  zoom=${cam.zoom.toFixed(3)}  focus=(${cam.cx.toFixed(0)},${cam.cy.toFixed(0)})`;
    }
  }

  /* ---------- 播放与音频 ---------- */
  const params = new URLSearchParams(location.search);
  const frozenT = params.has("t") ? parseFloat(params.get("t")) : null;
  const forcePlay = params.get("play") === "1";
  const mutedParam = params.get("mute") === "1";
  const debugParam = params.get("debug") === "1";
  if (debugEl) debugEl.dataset.on = debugParam ? "1" : "0";
  if (debugParam) debugEl.style.color = "rgba(0,0,0,0.55)";

  let playing = false;
  let rafId = 0;
  let lastTs = 0;
  let playT = 0;
  let lastAudioT = 0;
  const fired = new Set();
  let audioUnlocked = false;
  let roomOn = false;

  if (mutedParam) FILM.sound.muted = true;

  function resetAudioTo(t) {
    fired.clear();
    SHOTS.audioEvents.forEach((ev, i) => {
      if (ev.t <= t + 0.001) fired.add(i);
    });
    lastAudioT = t;
  }

  function tickAudio(prev, now) {
    if (!audioUnlocked || FILM.sound.muted) return;
    if (now < prev) resetAudioTo(now);
    SHOTS.audioEvents.forEach((ev, i) => {
      if (fired.has(i)) return;
      if (ev.t > prev && ev.t <= now + 0.001) {
        fired.add(i);
        FILM.sound.trigger(ev.name, { note: ev.note });
      }
    });
    lastAudioT = now;
  }

  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    const ctx = FILM.sound.ensure();
    if (!ctx) return;
    if (!FILM.sound.muted && !roomOn) {
      FILM.sound.startRoom();
      roomOn = true;
    }
    window.removeEventListener("pointerdown", unlockAudio);
    window.removeEventListener("keydown", unlockAudio);
  }
  window.addEventListener("pointerdown", unlockAudio);
  window.addEventListener("keydown", unlockAudio);

  function loop(ts) {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    playT += dt;
    if (playT >= TOTAL) playT = 0;
    // 音频调度
    const prev = currentT;
    seek(playT);
    tickAudio(prev, currentT);
    rafId = requestAnimationFrame(loop);
  }

  function play() {
    if (playing) return;
    playing = true;
    lastTs = 0;
    resetAudioTo(playT);
    rafId = requestAnimationFrame(loop);
  }

  function pause() {
    playing = false;
    cancelAnimationFrame(rafId);
    FILM.sound.stopRoom();
    roomOn = false;
  }

  function toggle() {
    if (frozenT !== null) {
      // 定格模式：空格切换定格前后 1 帧，便于检查
      return;
    }
    if (playing) pause();
    else play();
  }

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      toggle();
    } else if (e.key === "m" || e.key === "M") {
      FILM.sound.setMuted(!FILM.sound.muted);
    } else if (e.key === "ArrowRight") {
      pause();
      playT = Math.min(TOTAL, currentT + 1 / FPS);
      seek(playT);
    } else if (e.key === "ArrowLeft") {
      pause();
      playT = Math.max(0, currentT - 1 / FPS);
      seek(playT);
    } else if (e.key === "Home") {
      pause();
      playT = 0;
      seek(0);
    }
  });

  /* ---------- 启动 ---------- */
  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    seek(frozenT !== null ? frozenT : 0);
    if (frozenT === null || forcePlay) {
      playT = frozenT !== null ? frozenT : 0;
      play();
    }
    // 字体加载完成后重新 seek 一次，避免首次测量偏差
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        anchorCache.clear();
        seek(currentT);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
  if (document.readyState !== "loading") boot();

  /* ---------- 对外 API（调试/导出用） ---------- */
  FILM.engine = {
    seek,
    play,
    pause,
    state: () => ({ t: currentT, playing }),
    constants: { FILM_W, FILM_H, FPS, TOTAL, WIN_W, WIN_H, WIN_LEFT, WIN_TOP, WIN_SCALE, U, U_STAGE },
    anchors: () => {
      anchorCache.clear();
      const names = Array.from(document.querySelectorAll("[data-anchor]")).map((el) => el.getAttribute("data-anchor"));
      const out = {};
      names.forEach((n) => (out[n] = A(n)));
      return out;
    },
    debugSnapshot: () => {
      const m = SHOTS.mascotAt(currentT, A);
      return { t: currentT, mascot: m, chapters: FILM.shots.chapterAt(currentT) };
    },
  };

  // 供离线渲染调用
  window.FILM.renderAudio = (seconds) => FILM.sound.renderAudio(seconds);
})();
