/* ============================================================
 * shots.js — 90 秒时间轴
 * 已实现：冷开场 S01–S02（0–8s）+ 第 1 幕 S03–S09（8–28s）
 * 只描述「时间 → 画面状态」；相机/小方坐标为 window 设计坐标，
 * 光标由引擎按锚点换算成屏幕坐标。
 * ============================================================ */
(function () {
  const FILM = (window.FILM = window.FILM || {});
  const TOTAL = 90.0;

  /* ---------- 缓动 ---------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, u) => a + (b - a) * u;
  const ease = {
    linear: (u) => u,
    inOutSine: (u) => -(Math.cos(Math.PI * u) - 1) / 2,
    inOutCubic: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
    outCubic: (u) => 1 - Math.pow(1 - u, 3),
    outQuad: (u) => 1 - (1 - u) * (1 - u),
  };

  /* ---------- 相机（window 设计坐标） ---------- */
  const CAMERA = [
    { t0: 0.0, t1: 3.4, from: { z: 1.34, cx: 500, cy: 250 }, to: { z: 1.3, cx: 560, cy: 262 }, ease: "inOutSine" },
    { t0: 3.4, t1: 4.0, from: { z: 1.3, cx: 560, cy: 262 }, to: { z: 1.3, cx: 520, cy: 276 }, ease: "inOutSine" },
    { t0: 4.0, t1: 4.6, from: { z: 1.3, cx: 520, cy: 276 }, to: { z: 1.34, cx: 470, cy: 300 }, ease: "inOutCubic" },
    { t0: 4.6, t1: 5.4, from: { z: 1.34, cx: 470, cy: 300 }, to: { z: 1.4, cx: 500, cy: 312 }, ease: "inOutSine" },
    { t0: 5.4, t1: 6.2, from: { z: 1.4, cx: 500, cy: 312 }, to: { z: 1.5, cx: 860, cy: 322 }, ease: "inOutCubic" },
    { t0: 6.2, t1: 8.0, from: { z: 1.5, cx: 860, cy: 322 }, to: { z: 1.52, cx: 860, cy: 322 }, ease: "linear" },
    { t0: 8.0, t1: 8.9, from: { z: 1.5, cx: 860, cy: 322 }, to: { z: 1.0, cx: 683, cy: 384 }, ease: "outCubic" },
    { t0: 8.9, t1: 9.9, from: { z: 1.0, cx: 683, cy: 384 }, to: { z: 1.0, cx: 690, cy: 388 }, ease: "inOutSine" },
    { t0: 9.9, t1: 11.0, from: { z: 1.0, cx: 690, cy: 388 }, to: { z: 1.03, cx: 700, cy: 392 }, ease: "inOutSine" },
    { t0: 11.0, t1: 12.0, from: { z: 1.03, cx: 700, cy: 392 }, to: { z: 1.62, cx: 900, cy: 620 }, ease: "inOutCubic" },
    { t0: 12.0, t1: 13.8, from: { z: 1.62, cx: 900, cy: 620 }, to: { z: 1.66, cx: 905, cy: 626 }, ease: "linear" },
    { t0: 13.8, t1: 17.4, from: { z: 1.66, cx: 905, cy: 626 }, to: { z: 1.45, cx: 780, cy: 470 }, ease: "inOutSine" },
    { t0: 17.4, t1: 18.2, from: { z: 1.45, cx: 780, cy: 470 }, to: { z: 1.78, cx: 760, cy: 560 }, ease: "inOutCubic" },
    { t0: 18.2, t1: 20.0, from: { z: 1.78, cx: 760, cy: 560 }, to: { z: 1.76, cx: 762, cy: 562 }, ease: "linear" },
    { t0: 20.0, t1: 20.45, from: { z: 1.76, cx: 762, cy: 562 }, to: { z: 1.35, cx: 745, cy: 430 }, ease: "outCubic" },
    { t0: 20.45, t1: 22.4, from: { z: 1.35, cx: 745, cy: 430 }, to: { z: 1.38, cx: 752, cy: 434 }, ease: "linear" },
    { t0: 22.4, t1: 23.3, from: { z: 1.38, cx: 752, cy: 434 }, to: { z: 1.38, cx: 752, cy: 434 }, ease: "linear" },
    { t0: 23.3, t1: 23.8, from: { z: 1.38, cx: 752, cy: 434 }, to: { z: 1.35, cx: 780, cy: 520 }, ease: "outCubic" },
    { t0: 23.8, t1: 25.2, from: { z: 1.35, cx: 780, cy: 520 }, to: { z: 1.38, cx: 790, cy: 528 }, ease: "linear" },
    { t0: 25.2, t1: 26.0, from: { z: 1.38, cx: 790, cy: 528 }, to: { z: 1.42, cx: 683, cy: 330 }, ease: "inOutCubic" },
    { t0: 26.0, t1: 27.4, from: { z: 1.42, cx: 683, cy: 330 }, to: { z: 1.44, cx: 683, cy: 330 }, ease: "linear" },
    { t0: 27.4, t1: 28.0, from: { z: 1.44, cx: 683, cy: 330 }, to: { z: 1.42, cx: 683, cy: 384 }, ease: "inOutSine" },
    // ===== 第 2 幕 S10–S16（28–48s） =====
    { t0: 28.0, t1: 28.45, from: { z: 1.42, cx: 683, cy: 384 }, to: { z: 1.1, cx: 683, cy: 384 }, ease: "outCubic" },
    { t0: 28.45, t1: 30.6, from: { z: 1.1, cx: 683, cy: 384 }, to: { z: 1.12, cx: 686, cy: 386 }, ease: "linear" },
    { t0: 30.6, t1: 31.6, from: { z: 1.12, cx: 686, cy: 386 }, to: { z: 1.25, cx: 800, cy: 340 }, ease: "inOutCubic" },
    { t0: 31.6, t1: 32.8, from: { z: 1.25, cx: 800, cy: 340 }, to: { z: 1.28, cx: 810, cy: 344 }, ease: "linear" },
    { t0: 32.8, t1: 33.6, from: { z: 1.28, cx: 810, cy: 344 }, to: { z: 1.42, cx: 830, cy: 560 }, ease: "inOutCubic" },
    { t0: 33.6, t1: 35.8, from: { z: 1.42, cx: 830, cy: 560 }, to: { z: 1.36, cx: 860, cy: 540 }, ease: "inOutSine" },
    { t0: 35.8, t1: 36.6, from: { z: 1.3, cx: 1020, cy: 540 }, to: { z: 1.0, cx: 683, cy: 420 }, ease: "outCubic" },
    { t0: 36.6, t1: 40.2, from: { z: 1.0, cx: 683, cy: 420 }, to: { z: 1.06, cx: 690, cy: 420 }, ease: "linear" },
    { t0: 40.2, t1: 40.9, from: { z: 1.06, cx: 690, cy: 420 }, to: { z: 1.16, cx: 520, cy: 330 }, ease: "inOutCubic" },
    { t0: 40.9, t1: 41.6, from: { z: 1.16, cx: 520, cy: 330 }, to: { z: 1.3, cx: 700, cy: 380 }, ease: "inOutCubic" },
    { t0: 41.6, t1: 42.2, from: { z: 1.3, cx: 700, cy: 380 }, to: { z: 1.42, cx: 880, cy: 480 }, ease: "inOutCubic" },
    { t0: 42.2, t1: 42.8, from: { z: 1.42, cx: 880, cy: 480 }, to: { z: 1.5, cx: 950, cy: 560 }, ease: "inOutCubic" },
    { t0: 42.8, t1: 43.2, from: { z: 1.5, cx: 950, cy: 560 }, to: { z: 1.5, cx: 950, cy: 560 }, ease: "linear" },
    { t0: 43.2, t1: 43.9, from: { z: 1.5, cx: 950, cy: 560 }, to: { z: 1.85, cx: 360, cy: 620 }, ease: "inOutCubic" },
    { t0: 43.9, t1: 44.1, from: { z: 1.85, cx: 360, cy: 620 }, to: { z: 1.85, cx: 360, cy: 620 }, ease: "linear" },
    { t0: 44.1, t1: 45.2, from: { z: 1.85, cx: 360, cy: 620 }, to: { z: 1.25, cx: 820, cy: 480 }, ease: "inOutCubic" },
    { t0: 45.2, t1: 45.6, from: { z: 1.25, cx: 820, cy: 480 }, to: { z: 1.2, cx: 820, cy: 480 }, ease: "linear" },
    { t0: 45.6, t1: 46.5, from: { z: 1.2, cx: 820, cy: 480 }, to: { z: 1.0, cx: 683, cy: 384 }, ease: "outCubic" },
    { t0: 46.5, t1: 47.7, from: { z: 1.0, cx: 683, cy: 384 }, to: { z: 1.02, cx: 683, cy: 384 }, ease: "linear" },
    { t0: 47.7, t1: 48.3, from: { z: 1.02, cx: 683, cy: 384 }, to: { z: 1.02, cx: 683, cy: 384 }, ease: "linear" },
    // ===== 第 3 幕 S17–S23（48–68s） =====
    { t0: 48.0, t1: 49.2, from: { z: 1.0, cx: 683, cy: 384 }, to: { z: 1.16, cx: 860, cy: 430 }, ease: "outCubic" },
    { t0: 49.2, t1: 50.8, from: { z: 1.16, cx: 860, cy: 430 }, to: { z: 1.22, cx: 890, cy: 470 }, ease: "inOutSine" },
    { t0: 50.8, t1: 52.4, from: { z: 1.22, cx: 890, cy: 470 }, to: { z: 1.55, cx: 900, cy: 560 }, ease: "inOutCubic" },
    { t0: 52.4, t1: 53.2, from: { z: 1.55, cx: 900, cy: 560 }, to: { z: 1.58, cx: 905, cy: 565 }, ease: "linear" },
    { t0: 53.2, t1: 53.65, from: { z: 1.58, cx: 905, cy: 565 }, to: { z: 1.35, cx: 760, cy: 520 }, ease: "outCubic" },
    { t0: 53.65, t1: 56.2, from: { z: 1.35, cx: 760, cy: 520 }, to: { z: 1.42, cx: 760, cy: 520 }, ease: "inOutSine" },
    { t0: 56.2, t1: 57.4, from: { z: 1.42, cx: 760, cy: 520 }, to: { z: 1.48, cx: 760, cy: 560 }, ease: "inOutCubic" },
    { t0: 57.4, t1: 58.8, from: { z: 1.48, cx: 760, cy: 560 }, to: { z: 1.46, cx: 760, cy: 560 }, ease: "linear" },
    { t0: 58.8, t1: 58.9, from: { z: 1.46, cx: 760, cy: 560 }, to: { z: 1.46, cx: 760, cy: 560 }, ease: "linear" },
    { t0: 58.9, t1: 59.4, from: { z: 1.46, cx: 760, cy: 560 }, to: { z: 1.46, cx: 683, cy: 384 }, ease: "outCubic" },
    { t0: 59.4, t1: 60.2, from: { z: 1.46, cx: 683, cy: 384 }, to: { z: 1.32, cx: 760, cy: 520 }, ease: "inOutCubic" },
    { t0: 60.2, t1: 61.0, from: { z: 1.32, cx: 760, cy: 520 }, to: { z: 1.34, cx: 762, cy: 522 }, ease: "linear" },
    { t0: 61.0, t1: 62.0, from: { z: 1.34, cx: 762, cy: 522 }, to: { z: 1.34, cx: 762, cy: 522 }, ease: "linear" },
    { t0: 62.0, t1: 62.6, from: { z: 1.34, cx: 762, cy: 522 }, to: { z: 1.65, cx: 780, cy: 560 }, ease: "inOutCubic" },
    { t0: 62.6, t1: 64.8, from: { z: 1.65, cx: 780, cy: 560 }, to: { z: 1.68, cx: 782, cy: 562 }, ease: "linear" },
    { t0: 64.8, t1: 65.0, from: { z: 1.68, cx: 782, cy: 562 }, to: { z: 1.2, cx: 683, cy: 384 }, ease: "outCubic" },
    { t0: 65.0, t1: 66.0, from: { z: 1.2, cx: 683, cy: 384 }, to: { z: 1.55, cx: 683, cy: 384 }, ease: "inOutCubic" },
    { t0: 66.0, t1: 67.6, from: { z: 1.55, cx: 683, cy: 384 }, to: { z: 1.58, cx: 685, cy: 386 }, ease: "linear" },
    { t0: 67.6, t1: 68.0, from: { z: 1.58, cx: 685, cy: 386 }, to: { z: 1.02, cx: 683, cy: 384 }, ease: "linear" },
    // ===== 第 4 幕 + 片尾（68–90s） =====
    { t0: 68.0, t1: 68.4, from: { z: 1.02, cx: 683, cy: 384 }, to: { z: 1.0, cx: 683, cy: 384 }, ease: "linear" },
    { t0: 68.4, t1: 69.2, from: { z: 1.0, cx: 683, cy: 384 }, to: { z: 1.42, cx: 620, cy: 470 }, ease: "outCubic" },
    { t0: 69.2, t1: 70.4, from: { z: 1.42, cx: 620, cy: 470 }, to: { z: 1.45, cx: 625, cy: 475 }, ease: "linear" },
    { t0: 70.4, t1: 71.4, from: { z: 1.45, cx: 625, cy: 475 }, to: { z: 1.58, cx: 900, cy: 300 }, ease: "inOutCubic" },
    { t0: 71.4, t1: 72.6, from: { z: 1.58, cx: 900, cy: 300 }, to: { z: 1.62, cx: 905, cy: 305 }, ease: "linear" },
    { t0: 72.6, t1: 73.0, from: { z: 1.66, cx: 822, cy: 562 }, to: { z: 1.3, cx: 683, cy: 384 }, ease: "outCubic" },
    { t0: 73.0, t1: 73.6, from: { z: 1.3, cx: 683, cy: 384 }, to: { z: 1.55, cx: 960, cy: 520 }, ease: "inOutCubic" },
    { t0: 73.6, t1: 74.4, from: { z: 1.55, cx: 960, cy: 520 }, to: { z: 1.55, cx: 960, cy: 520 }, ease: "linear" },
    { t0: 74.4, t1: 75.4, from: { z: 1.55, cx: 960, cy: 520 }, to: { z: 1.4, cx: 900, cy: 420 }, ease: "inOutCubic" },
    { t0: 75.4, t1: 75.8, from: { z: 1.4, cx: 900, cy: 360 }, to: { z: 1.2, cx: 683, cy: 384 }, ease: "outCubic" },
    { t0: 75.8, t1: 76.8, from: { z: 1.2, cx: 683, cy: 384 }, to: { z: 1.55, cx: 683, cy: 400 }, ease: "inOutCubic" },
    { t0: 76.8, t1: 77.4, from: { z: 1.55, cx: 683, cy: 400 }, to: { z: 1.55, cx: 683, cy: 400 }, ease: "linear" },
    { t0: 77.4, t1: 77.8, from: { z: 1.55, cx: 683, cy: 400 }, to: { z: 1.05, cx: 683, cy: 384 }, ease: "outCubic" },
    { t0: 77.8, t1: 78.4, from: { z: 1.05, cx: 683, cy: 384 }, to: { z: 1.42, cx: 683, cy: 430 }, ease: "inOutCubic" },
    { t0: 78.4, t1: 78.6, from: { z: 1.42, cx: 683, cy: 430 }, to: { z: 1.42, cx: 683, cy: 430 }, ease: "linear" },
    { t0: 78.6, t1: 79.2, from: { z: 1.42, cx: 683, cy: 430 }, to: { z: 1.6, cx: 760, cy: 500 }, ease: "inOutCubic" },
    { t0: 79.2, t1: 79.8, from: { z: 1.6, cx: 760, cy: 500 }, to: { z: 1.6, cx: 760, cy: 500 }, ease: "linear" },
    { t0: 79.8, t1: 80.6, from: { z: 1.6, cx: 760, cy: 500 }, to: { z: 1.25, cx: 700, cy: 430 }, ease: "inOutCubic" },
    { t0: 80.6, t1: 81.0, from: { z: 1.25, cx: 700, cy: 430 }, to: { z: 1.35, cx: 683, cy: 384 }, ease: "outCubic" },
    { t0: 81.0, t1: 82.0, from: { z: 1.35, cx: 683, cy: 384 }, to: { z: 1.0, cx: 683, cy: 384 }, ease: "inOutCubic" },
    { t0: 82.0, t1: 83.6, from: { z: 1.0, cx: 683, cy: 384 }, to: { z: 1.02, cx: 683, cy: 384 }, ease: "linear" },
    { t0: 83.6, t1: 84.3, from: { z: 1.02, cx: 683, cy: 384 }, to: { z: 1.02, cx: 683, cy: 384 }, ease: "linear" },
    { t0: 84.0, t1: 85.0, from: { z: 1.02, cx: 683, cy: 384 }, to: { z: 1.12, cx: 683, cy: 384 }, ease: "inOutSine" },
    { t0: 85.0, t1: 86.4, from: { z: 1.12, cx: 683, cy: 384 }, to: { z: 1.28, cx: 900, cy: 560 }, ease: "inOutCubic" },
    { t0: 86.4, t1: 90.0, from: { z: 1.28, cx: 900, cy: 560 }, to: { z: 1.28, cx: 900, cy: 560 }, ease: "linear" },
  ];

  function cameraAt(t) {
    t = clamp(t, 0, TOTAL);
    for (let i = 0; i < CAMERA.length; i++) {
      const seg = CAMERA[i];
      if (t <= seg.t1 || i === CAMERA.length - 1) {
        const u = clamp((t - seg.t0) / (seg.t1 - seg.t0 || 1), 0, 1);
        const k = ease[seg.ease](u);
        return { zoom: lerp(seg.from.z, seg.to.z, k), cx: lerp(seg.from.cx, seg.to.cx, k), cy: lerp(seg.from.cy, seg.to.cy, k) };
      }
    }
    return { zoom: 1, cx: 683, cy: 384 };
  }

  /* ---------- 小工具 ---------- */
  function jumpPos(t, t0, t1, from, to, hop) {
    const u = clamp((t - t0) / (t1 - t0), 0, 1);
    return { x: lerp(from.x, to.x, ease.inOutSine(u)), y: lerp(from.y, to.y, u) - hop * Math.sin(Math.PI * u), u };
  }
  function standAt(a) { return a && a.top != null ? { x: a.cx, y: a.top } : { x: 683, y: 300 }; }
  function breath(t, phase) { return 1 + 0.012 * Math.sin(((t - (phase || 0)) / 0.8333) * Math.PI * 2); }
  function dustAt(t, t0, x, y, n) {
    const age = t - t0;
    if (age < 0 || age > 0.5) return null;
    const out = [];
    for (let i = 0; i < (n || 3); i++) {
      const p = age / 0.5, dir = i % 2 === 0 ? -1 : 1;
      out.push({ x: x + dir * (10 + i * 9) * ease.outCubic(p), y: y - (4 + i * 3) * p * (1 - p) * 3, size: 4 - Math.floor(p * 3), alpha: (1 - p) * 0.85 });
    }
    return out;
  }
  const A0 = (a, fb) => (a && a.top != null ? a : fb);
  const P = (a) => ({ x: a.cx, y: a.top });
  const FB = { top: 320, cx: 760, left: 700, right: 820 };

  /* ---------- 第 1 幕时间常量 ---------- */
  const PROMPT = "写一张秋天咖啡馆的海报，手绘质感";
  const EDIT_DRAFT = "把背景改成深蓝色，再暖一点";
  const DRAFT_PREFIX = "基于这张参考图修改：";
  const TYPING_START = 11.5, TYPING_STEP = 0.13, PROMPT_LEN = 16;
  const EDIT_START = 21.4, EDIT_LEN = 13;
  const CANVAS_PROMPT = "把这组海报做成 12 张的系列，排成网格";
  const CANVAS_PROMPT_LEN = 18, CANVAS_TYPING_START = 32.9, CANVAS_TYPING_STEP = 0.12;
  const canvasTypedCount = (t) => (t < CANVAS_TYPING_START ? 0 : clamp(Math.floor((t - CANVAS_TYPING_START) / CANVAS_TYPING_STEP + 1), 0, CANVAS_PROMPT_LEN));
  const typedCount = (t) => (t < TYPING_START ? 0 : clamp(Math.floor((t - TYPING_START) / TYPING_STEP + 1), 0, PROMPT_LEN));
  const editTypedCount = (t) => (t < EDIT_START ? 0 : clamp(Math.floor((t - EDIT_START) / TYPING_STEP + 1), 0, EDIT_LEN));

  /* ---------- 小方 ---------- */
  function mascotAt(t, A) {
    const titlebar = A("window-titlebar");
    const brand = A("chat-sidebar-brand");
    const badge = A("chat-welcome-badge");
    const title = A("chat-welcome-title");

    /* ===== 冷开场 ===== */
    if (t < 2.0) return null;
    if (t < 3.8) {
      const sy = breath(t, 2.0);
      let pose = "idle", sx = 1;
      if (t >= 2.6 && t < 2.72) pose = "blink";
      else if (t >= 2.8) pose = "look-right";
      if (t < 2.2) sx = 1 + (1 - ease.outCubic((t - 2.0) / 0.2)) * 0.18;
      return { x: titlebar.left + 150, y: titlebar.top, pose, flip: false, sx, sy, dust: null };
    }
    const P0 = { x: titlebar.left + 150, y: titlebar.top };
    const P1 = standAt(brand);
    const P2 = { x: badge.cx, y: badge.top };
    const P3 = { x: title.left + 22, y: title.top };
    if (t < 4.0) { const k = ease.inOutSine((t - 3.8) / 0.2); return { x: P0.x, y: P0.y, pose: "crouch", flip: false, sx: 1 + 0.1 * k, sy: 1 - 0.14 * k, dust: null }; }
    if (t < 4.4) { const p = jumpPos(t, 4.0, 4.4, P0, P1, 30); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: true, sx: 1, sy: 1, dust: null }; }
    if (t < 4.55) { const k = (t - 4.4) / 0.15; return { x: P1.x, y: P1.y, pose: "land", flip: false, sx: 1 + 0.14 * (1 - k), sy: 1 - 0.16 * (1 - k), dust: dustAt(t, 4.4, P1.x, P1.y, 2) }; }
    if (t < 4.95) { const p = jumpPos(t, 4.55, 4.95, P1, P2, 40); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 5.4) { const dust = dustAt(t, 4.95, P2.x, P2.y, 2); return { x: P2.x, y: P2.y, pose: t < 5.2 ? "land" : "look-down", flip: false, sx: 1, sy: breath(t, 4.95), dust }; }
    if (t < 5.85) { const p = jumpPos(t, 5.4, 5.85, P2, P3, 26); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: true, sx: 1, sy: 1, dust: null }; }
    if (t < 6.65) {
      const u = ease.inOutSine((t - 5.85) / 0.8);
      const stepPhase = Math.floor((t - 5.85) / 0.18) % 2;
      return { x: lerp(P3.x, title.right + 24, u), y: P3.y, pose: stepPhase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 5.85), dust: dustAt(t, 5.85, P3.x, P3.y, 3) };
    }
    if (t < 7.2) {
      const phase = Math.floor((t - 6.65) / 0.2) % 2;
      return { x: title.right + 24, y: P3.y, pose: phase === 0 ? "wave" : "wave2", flip: false, sx: 1, sy: breath(t, 6.65), dust: null };
    }
    if (t < 7.4) return { x: title.right + 24, y: P3.y, pose: "look-right", flip: false, sx: 1, sy: breath(t, 7.2), dust: null };
    if (t < 7.75) return { x: title.right + 24, y: P3.y, pose: "sit", flip: false, sx: 1, sy: 1, dust: null };
    if (t < 8.0) { const k = ease.inOutSine((t - 7.75) / 0.25); return { x: title.right + 24, y: P3.y, pose: "idle", flip: false, sx: 1, sy: 1 - 0.05 * Math.sin(Math.PI * k), dust: null }; }

    /* ===== 第 1 幕 ===== */
    const TITLE = { x: title.right + 24, y: title.top };
    const EXAMPLE = A0(A("chat-example-row-2"), { top: 424, cx: 821 });
    const COMPOSER = A0(A("chat-composer-input"), { top: 700, cx: 821 });
    const USERB = A0(A("chat-msg-user-1"), { top: 292, cx: 1055 });
    const RESULT = A0(A("chat-result-card"), { top: 380, cx: 700 });
    const ART = A0(A("chat-artifact-title"), { top: 70, cx: 1180 });
    const ART_CONT = A0(A("chat-artifact-continue"), { top: 470, cx: 1120 });
    const EDIT_TOOL = A0(A("chat-tool-edit"), { top: 400, cx: 760 });
    const PALETTE = A0(A("chat-palette"), { top: 110, cx: 683 });
    const PAL_ITEM = A0(A("chat-palette-item-image"), { top: 250, cx: 683 });
    const rightOf = (a, inset) => ({ x: a.right - (inset || 50), y: a.top });
    const COMPOSER_STAND = { x: COMPOSER.right - 90, y: COMPOSER.top };

    if (t < 8.6) { const k = ease.outCubic((t - 8.0) / 0.6); return { x: TITLE.x, y: TITLE.y, pose: t < 8.3 ? "sit" : "look-right", flip: false, sx: 1 + 0.06 * k, sy: 1 - 0.06 * k, dust: null }; }
    if (t < 9.6) {
      const u = ease.inOutSine((t - 8.6) / 1.0);
      const phase = Math.floor((t - 8.6) / 0.18) % 2;
      return { x: lerp(TITLE.x, title.left + 40, u), y: TITLE.y, pose: phase === 0 ? "walk-a" : "walk-b", flip: true, sx: 1, sy: breath(t, 8.6), dust: null };
    }
    if (t < 10.2) return { x: title.left + 40, y: TITLE.y, pose: "look-down", flip: false, sx: 1, sy: breath(t, 9.6), dust: null };
    if (t < 10.5) { const p = jumpPos(t, 10.2, 10.5, { x: title.left + 40, y: TITLE.y }, { x: EXAMPLE.cx, y: EXAMPLE.top }, 26); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 10.8) return { x: EXAMPLE.cx, y: EXAMPLE.top, pose: t < 10.64 ? "land" : "crouch", flip: false, sx: 1, sy: 1, dust: dustAt(t, 10.5, EXAMPLE.cx, EXAMPLE.top, 2) };
    if (t < 11.05) { const p = jumpPos(t, 10.8, 11.05, { x: EXAMPLE.cx, y: EXAMPLE.top }, { x: 800, y: TITLE.y }, 22); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 11.45) { const p = jumpPos(t, 11.05, 11.45, { x: 800, y: TITLE.y }, COMPOSER_STAND, 30); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: dustAt(t, 11.45, COMPOSER_STAND.x, COMPOSER_STAND.y, 2) }; }
    if (t < 13.8) {
      const n = typedCount(t);
      const lastKey = TYPING_START + Math.max(0, n - 1) * TYPING_STEP;
      const dt = t - lastKey;
      const squash = n > 0 && dt >= 0 && dt < 0.1 ? 1 - 0.05 * Math.sin((dt / 0.1) * Math.PI) : 1;
      return { x: COMPOSER_STAND.x, y: COMPOSER_STAND.y, pose: "look-down", flip: false, sx: 1, sy: breath(t, TYPING_START) * squash, dust: null };
    }
    if (t < 14.45) {
      if (t < 14.0) return { x: COMPOSER_STAND.x, y: COMPOSER_STAND.y, pose: "look-up", flip: false, sx: 1, sy: 1, dust: null };
      const p = jumpPos(t, 14.0, 14.4, COMPOSER_STAND, { x: USERB.cx, y: USERB.top }, 30);
      return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: dustAt(t, 14.4, USERB.cx, USERB.top, 2) };
    }
    if (t < 14.9) return { x: USERB.cx, y: USERB.top, pose: t < 14.55 ? "land" : "crouch", flip: false, sx: 1, sy: 1, dust: null };
    if (t < 15.3) { const p = jumpPos(t, 14.9, 15.25, { x: USERB.cx, y: USERB.top }, COMPOSER_STAND, 30); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 17.4) { const phase = Math.floor((t - 15.3) / 0.4) % 2; return { x: COMPOSER_STAND.x, y: COMPOSER_STAND.y, pose: phase === 0 ? "look-up" : "idle", flip: false, sx: 1, sy: breath(t, 15.3), dust: null }; }
    if (t < 18.2) {
      if (t < 17.6) return { x: COMPOSER_STAND.x, y: COMPOSER_STAND.y, pose: "look-up", flip: false, sx: 1, sy: 1, dust: null };
      const p = jumpPos(t, 17.6, 18.1, COMPOSER_STAND, { x: RESULT.cx + 90, y: RESULT.top }, 40);
      return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null };
    }
    if (t < 19.6) {
      const u = ease.inOutSine((t - 18.2) / 1.4);
      const phase = Math.floor((t - 18.2) / 0.18) % 2;
      return { x: lerp(RESULT.cx + 90, RESULT.cx + 240, u), y: RESULT.top, pose: phase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 18.2), dust: null };
    }
    if (t < 20.0) return { x: RESULT.cx + 240, y: RESULT.top, pose: "happy", flip: false, sx: 1, sy: breath(t, 19.6), dust: null };
    if (t < 20.5) { const p = jumpPos(t, 20.0, 20.4, { x: RESULT.cx + 240, y: RESULT.top }, rightOf(ART, 56), 34); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 20.9) return { x: ART.right - 56, y: ART.top, pose: "look-down", flip: false, sx: 1, sy: breath(t, 20.5), dust: null };
    if (t < 21.3) { const p = jumpPos(t, 20.9, 21.3, rightOf(ART, 56), { x: RESULT.cx + 200, y: RESULT.top }, 26); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 23.35) return { x: RESULT.cx + 200, y: RESULT.top, pose: "look-right", flip: false, sx: 1, sy: breath(t, 21.3), dust: null };
    if (t < 23.85) { const p = jumpPos(t, 23.35, 23.8, { x: RESULT.cx + 200, y: RESULT.top }, COMPOSER_STAND, 34); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 24.4) { const p = jumpPos(t, 23.85, 24.3, COMPOSER_STAND, rightOf(EDIT_TOOL, 52), 26); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 25.2) return { x: EDIT_TOOL.right - 52, y: EDIT_TOOL.top, pose: t < 24.9 ? "look-down" : "happy", flip: false, sx: 1, sy: breath(t, 24.4), dust: null };
    if (t < 25.55) { const p = jumpPos(t, 25.2, 25.5, rightOf(EDIT_TOOL, 52), rightOf(PALETTE, 60), 30); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 26.45) {
      const u = ease.inOutSine((t - 25.55) / 0.9);
      const phase = Math.floor((t - 25.55) / 0.18) % 2;
      return { x: lerp(PALETTE.right - 60, PAL_ITEM.cx + 40, u), y: PALETTE.top, pose: Math.abs(t - 26.4) < 0.12 ? "happy" : phase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 25.55), dust: null };
    }
    if (t < 27.0) { const p = jumpPos(t, 26.5, 26.9, { x: PAL_ITEM.cx + 40, y: PALETTE.top }, COMPOSER_STAND, 26); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 28.0) return { x: COMPOSER_STAND.x, y: COMPOSER_STAND.y, pose: "look-right", flip: false, sx: 1, sy: breath(t, 27.0), dust: null };

    /* ===== 第 2 幕 S10–S16（28–48s） ===== */
    const TB = A0(A("canvas-topbar-title"), { top: 66, cx: 300, right: 400 });
    const TBF = A0(A("canvas-toolbar-focus"), { top: 730, cx: 700, right: 760 });
    const APT = A0(A("canvas-agent-panel-title"), { top: 98, cx: 1150, right: 1340 });
    const AIN = A0(A("canvas-agent-input"), { top: 620, cx: 1150, right: 1330 });
    const AUSR = A0(A("canvas-agent-msg-user-1"), { top: 320, cx: 1150, right: 1300 });
    const N = (i) => A0(A("canvas-node-" + String(i).padStart(2, "0")), { top: 420 + Math.floor((i - 1) / 4) * 120, cx: 520 + ((i - 1) % 4) * 160, right: 600 });
    const WIN_NODE = (i) => ({ x: N(i).cx, y: N(i).top });

    if (t < 28.55) return { x: TB.cx, y: TB.top, pose: "idle", flip: false, sx: 1, sy: 1, dust: null, alpha: 0 };
    if (t < 29.0) { const u = ease.outCubic(clamp((t - 28.55) / 0.35, 0, 1)); return { x: TB.cx, y: lerp(TB.top - 90, TB.top, u), pose: u < 0.7 ? "jump-fall" : "land", flip: false, sx: 1 + (1 - u) * 0.1, sy: 1 - (1 - u) * 0.12, dust: dustAt(t, 28.9, TB.cx, TB.top, 2) }; }
    if (t < 29.6) { const u = ease.inOutSine((t - 29.0) / 0.6); const phase = Math.floor((t - 29.0) / 0.18) % 2; return { x: lerp(TB.cx, TB.cx + 80, u), y: TB.top, pose: phase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 29.0), dust: null }; }
    if (t < 30.8) {
      if (t < 29.63) return { x: TB.cx + 80, y: TB.top, pose: "crouch", flip: false, sx: 1.06, sy: 0.92, dust: null };
      const p = jumpPos(t, 29.63, 30.0, { x: TB.cx + 80, y: TB.top }, WIN_NODE(1), 26);
      const stand = t > 30.0;
      return stand ? { x: TBF.cx, y: TBF.top, pose: "look-down", flip: false, sx: 1, sy: breath(t, 30.0), dust: dustAt(t, 30.0, TBF.cx, TBF.top, 2) } : { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null };
    }
    if (t < 31.2) { const p = jumpPos(t, 30.8, 31.15, { x: TBF.cx, y: TBF.top }, { x: APT.right - 70, y: APT.top }, 30); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: true, sx: 1, sy: 1, dust: null }; }
    if (t < 31.8) { const u = ease.inOutSine((t - 31.2) / 0.6); const phase = Math.floor((t - 31.2) / 0.18) % 2; return { x: lerp(APT.right - 70, APT.right - 110, u), y: APT.top, pose: phase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 31.2), dust: dustAt(t, 31.2, APT.right - 70, APT.top, 2) }; }
    if (t < 32.8) return { x: APT.right - 110, y: APT.top, pose: "look-down", flip: false, sx: 1, sy: breath(t, 31.8), dust: null };
    if (t < 35.15) {
      const n = canvasTypedCount(t);
      const lastKey = CANVAS_TYPING_START + Math.max(0, n - 1) * CANVAS_TYPING_STEP;
      const dt = t - lastKey;
      const squash = n > 0 && dt >= 0 && dt < 0.09 ? 1 - 0.045 * Math.sin((dt / 0.09) * Math.PI) : 1;
      return { x: AIN.cx + 50, y: AIN.top, pose: "look-down", flip: false, sx: 1, sy: breath(t, 32.8) * squash, dust: null };
    }
    if (t < 35.6) { const p = jumpPos(t, 35.15, 35.55, { x: AIN.cx + 50, y: AIN.top }, { x: AUSR.cx + 60, y: AUSR.top }, 26); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 36.2) return { x: AUSR.cx + 60, y: AUSR.top, pose: "look-up", flip: false, sx: 1, sy: breath(t, 35.6), dust: dustAt(t, 35.55, AUSR.cx + 60, AUSR.top, 2) };
    if (t < 38.75) {
      const idx = clamp(Math.floor((t - 36.2) / 0.2), 0, 11);
      const nextIdx = Math.min(idx + 1, 11);
      const u = clamp((t - (36.2 + idx * 0.2)) / 0.2, 0, 1);
      const from = { x: N(idx + 1).cx, y: N(idx + 1).top };
      const to = { x: N(nextIdx + 1).cx, y: N(nextIdx + 1).top };
      const p = { x: lerp(from.x, to.x, ease.inOutSine(u)), y: lerp(from.y, to.y, u) - 30 * Math.sin(Math.PI * u) };
      return { x: p.x, y: p.y, pose: u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: dustAt(t, 36.2 + idx * 0.2 + 0.2, to.x, to.y, 1) };
    }
    if (t < 39.6) { const k = (t - 38.75) / 0.2; return { x: N(12).cx, y: N(12).top, pose: t < 38.95 ? "land" : "wide", flip: false, sx: 1 + 0.12 * (1 - Math.min(1, k)), sy: 1 - 0.14 * (1 - Math.min(1, k)), dust: dustAt(t, 38.75, N(12).cx, N(12).top, 3) }; }
    if (t < 40.2) return { x: N(12).cx, y: N(12).top, pose: "wide", flip: false, sx: 1, sy: breath(t, 39.6), dust: null };
    if (t < 42.8) {
      const pts = [1, 2, 3, 6, 9, 12];
      const times = [40.2, 40.7, 41.3, 41.8, 42.3, 42.8];
      let seg = 0;
      while (seg < times.length - 2 && t > times[seg + 1]) seg++;
      const u = clamp((t - times[seg]) / (times[seg + 1] - times[seg]), 0, 1);
      const from = WIN_NODE(pts[seg]), to = WIN_NODE(pts[seg + 1]);
      const phase = Math.floor((t - 40.2) / 0.18) % 2;
      return { x: lerp(from.x, to.x, ease.inOutSine(u)), y: lerp(from.y, to.y, u), pose: phase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 40.2), dust: dustAt(t, 40.2 + seg * 0.5, to.x, to.y, 2) };
    }
    if (t < 43.2) return { x: N(12).cx, y: N(12).top, pose: "happy", flip: false, sx: 1, sy: breath(t, 42.8), dust: null };
    if (t < 43.75) { const p = jumpPos(t, 43.2, 43.7, WIN_NODE(12), { x: TBF.cx, y: TBF.top }, 36); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 44.2) { const k = (t - 43.75) / 0.15; return { x: TBF.cx, y: TBF.top, pose: "crouch", flip: false, sx: 1 + 0.1 * (1 - Math.min(1, k)), sy: 1 - 0.16 * (1 - Math.min(1, k)), dust: dustAt(t, 43.75, TBF.cx, TBF.top, 3) }; }
    if (t < 44.6) { const p = jumpPos(t, 44.2, 44.55, { x: TBF.cx, y: TBF.top }, WIN_NODE(5), 40); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 45.8) return { x: N(5).cx, y: N(5).top, pose: "look-down", flip: false, sx: 1, sy: breath(t, 44.6), dust: dustAt(t, 44.55, N(5).cx, N(5).top, 2) };
    if (t < 46.4) { const p = jumpPos(t, 45.8, 46.35, WIN_NODE(5), WIN_NODE(12), 40); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 47.0) return { x: N(12).cx, y: N(12).top, pose: "wide", flip: false, sx: 1, sy: breath(t, 46.4), dust: dustAt(t, 46.4, N(12).cx, N(12).top, 2) };
    if (t < 47.6) { const phase = Math.floor((t - 47.0) / 0.2) % 2; return { x: N(12).cx, y: N(12).top, pose: phase === 0 ? "look-left" : "look-right", flip: false, sx: 1, sy: breath(t, 47.0), dust: null }; }
    if (t < 48.0) return { x: N(12).cx, y: N(12).top, pose: "idle", flip: false, sx: 1, sy: 1, dust: null };

    /* ===== 第 3 幕 S17–S23（48–68s） ===== */
    const GEN = A0(A("image-generate-btn"), { top: 620, cx: 620, right: 900 });
    const IC = (i) => A0(A("image-pending-card-" + i), { top: 200 + Math.floor((i - 1) / 2) * 240, cx: 900 + ((i - 1) % 2) * 260, right: 1000 });
    const WAIT = A0(A("chat-waiting-card"), { top: 420, cx: 821, right: 1000 });
    const FAIL = A0(A("chat-fail-card"), { top: 500, cx: 821, right: 1000 });
    const RES = A0(A("chat-result-card"), { top: 380, cx: 700, right: 850 });
    const RES2 = A0(A("chat-result-card-2"), { top: 380, cx: 1000, right: 1150 });
    const LOGO = A0(A("topbar-logo"), { top: 20, cx: 220, right: 300 });
    const DIAG = A0(A("chat-diagnostics-modal"), { top: 100, cx: 683, right: 1000 });
    const TREND = A0(A("chat-diagnostics-trend"), { top: 260, cx: 683, right: 990 });

    if (t < 48.3) { const u = ease.outCubic(clamp((t - 48.0) / 0.25, 0, 1)); return { x: GEN.cx, y: lerp(GEN.top - 100, GEN.top, u), pose: u < 0.75 ? "jump-fall" : "land", flip: false, sx: 1 + (1 - u) * 0.1, sy: 1 - (1 - u) * 0.12, dust: dustAt(t, 48.2, GEN.cx, GEN.top, 2) }; }
    if (t < 49.2) {
      const bounce = t >= 48.4 && t < 48.62 ? 1 - 0.05 * Math.sin(((t - 48.4) / 0.22) * Math.PI) : 1;
      return { x: GEN.cx + 40, y: GEN.top, pose: t < 48.8 ? "look-down" : "crouch", flip: false, sx: 1, sy: breath(t, 48.6) * bounce, dust: null };
    }
    if (t < 50.8) {
      const idx = clamp(Math.floor((t - 49.2) / 0.4), 0, 3);
      const u = clamp((t - (49.2 + idx * 0.4)) / 0.4, 0, 1);
      const from = { x: IC(idx + 1).cx, y: IC(idx + 1).top };
      const nextIdx = Math.min(idx + 1, 3);
      const to = { x: IC(nextIdx + 1).cx, y: IC(nextIdx + 1).top };
      const p = { x: lerp(from.x, to.x, ease.inOutSine(u)), y: lerp(from.y, to.y, u) - 22 * Math.sin(Math.PI * u) };
      const pose = u < 0.5 ? (idx < 2 ? "crouch" : "look-down") : "jump-fall";
      return { x: p.x, y: p.y, pose, flip: false, sx: 1, sy: breath(t, 49.2), dust: dustAt(t, 49.2 + idx * 0.4 + 0.4, to.x, to.y, 1) };
    }
    if (t < 52.6) {
      const idx = clamp(Math.floor((t - 50.8) / 0.45), 0, 3);
      const u = clamp((t - (50.8 + idx * 0.45)) / 0.45, 0, 1);
      const from = IC(idx + 1), to = IC(Math.min(idx + 1, 3) + 1);
      const p = { x: lerp(from.cx, to.cx, ease.inOutSine(u)), y: lerp(from.top, to.top, u) - 34 * Math.sin(Math.PI * u) };
      return { x: p.x, y: p.y, pose: u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: dustAt(t, 50.8 + idx * 0.45 + 0.45, to.cx, to.top, 2) };
    }
    if (t < 53.2) return { x: IC(2).cx, y: IC(2).top, pose: "look-down", flip: false, sx: 1, sy: breath(t, 52.6), dust: null };
    if (t < 53.6) {
      const u = ease.inOutCubic(clamp((t - 53.2) / 0.4, 0, 1));
      return { x: lerp(IC(4).cx, WAIT.cx + 180, u), y: lerp(IC(4).top, WAIT.top, u), pose: u < 0.6 ? "jump-fall" : "land", flip: false, sx: 1, sy: 1, dust: null, alpha: 1 };
    }
    if (t < 54.4) {
      const hide = t >= 53.8 && t < 54.2;
      return { x: WAIT.cx + 180, y: WAIT.top, pose: hide ? "crouch" : "look-right", flip: false, sx: hide ? 1.04 : 1, sy: hide ? 0.8 : breath(t, 53.6), dust: dustAt(t, 53.6, WAIT.cx + 180, WAIT.top, 2) };
    }
    if (t < 56.2) {
      const hop = t >= 54.4 && t < 54.6 ? -18 * Math.sin(((t - 54.4) / 0.2) * Math.PI) : 0;
      return { x: WAIT.cx + 180, y: WAIT.top + hop, pose: t < 54.7 ? "wide" : "look-down", flip: false, sx: 1, sy: breath(t, 54.6), dust: null };
    }
    if (t < 56.8) { const p = jumpPos(t, 56.2, 56.7, { x: WAIT.cx + 180, y: WAIT.top }, { x: RES2.cx + 40, y: RES2.top }, 40); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 58.4) { const u = ease.inOutSine((t - 56.8) / 1.6); const phase = Math.floor((t - 56.8) / 0.18) % 2; return { x: lerp(RES2.cx + 40, RES2.cx - 60, u), y: RES2.top, pose: t >= 58.0 ? "happy" : phase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 56.8), dust: dustAt(t, 56.7, RES2.cx + 40, RES2.top, 2) }; }
    if (t < 58.8) { const phase = Math.floor((t - 58.4) / 0.2) % 2; return { x: RES2.cx - 60, y: RES2.top, pose: phase === 0 ? "wave" : "wave2", flip: false, sx: 1, sy: breath(t, 58.4), dust: null }; }
    if (t < 59.0) return { x: RES2.cx - 60, y: RES2.top, pose: "idle", flip: false, sx: 1, sy: 1, dust: null, alpha: 0 };
    if (t < 59.4) { const u = ease.outCubic(clamp((t - 59.0) / 0.35, 0, 1)); return { x: LOGO.cx, y: lerp(LOGO.top - 70, LOGO.top, u), pose: u < 0.7 ? "jump-fall" : "land", flip: false, sx: 1, sy: 1, dust: dustAt(t, 59.35, LOGO.cx, LOGO.top, 3), alpha: 1 }; }
    if (t < 59.8) { const p = jumpPos(t, 59.4, 59.75, { x: LOGO.cx, y: LOGO.top }, { x: WAIT.cx + 180, y: WAIT.top }, 30); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 60.6) return { x: WAIT.cx + 180, y: WAIT.top, pose: "look-down", flip: false, sx: 1, sy: breath(t, 59.8), dust: dustAt(t, 59.75, WAIT.cx + 180, WAIT.top, 2) };
    if (t < 61.8) { const phase = Math.floor((t - 60.6) / 0.2) % 2; return { x: WAIT.cx + 180, y: WAIT.top, pose: phase === 0 ? "wave" : "wave2", flip: false, sx: 1, sy: breath(t, 60.6), dust: null }; }
    if (t < 62.4) { const p = jumpPos(t, 61.8, 62.3, { x: WAIT.cx + 180, y: WAIT.top }, { x: RES.cx + 60, y: RES.top }, 34); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 63.2) {
      const idx = clamp(Math.floor((t - 62.4) / 0.2), 0, 3);
      const spots = [RES, RES2, { cx: RES.cx, top: RES.top + 268 }, { cx: RES2.cx, top: RES2.top + 268 }];
      const u = clamp((t - (62.4 + idx * 0.2)) / 0.2, 0, 1);
      const from = spots[idx], to = spots[Math.min(idx + 1, 3)];
      const p = { x: lerp(from.cx, to.cx, ease.inOutSine(u)), y: lerp(from.top, to.top, u) - 26 * Math.sin(Math.PI * u) };
      return { x: p.x, y: p.y, pose: u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: dustAt(t, 62.4 + idx * 0.2 + 0.2, to.cx, to.top, 1) };
    }
    if (t < 64.2) return { x: RES2.cx, y: RES2.top, pose: "happy", flip: false, sx: 1, sy: breath(t, 63.2), dust: null };
    if (t < 64.8) return { x: RES2.cx, y: RES2.top, pose: "sit", flip: false, sx: 1, sy: 1 + 0.03 * Math.sin(((t - 64.2) / 0.6) * Math.PI * 4), dust: null };
    if (t < 65.4) { const p = jumpPos(t, 64.8, 65.35, { x: RES2.cx, y: RES2.top }, { x: DIAG.right - 90, y: DIAG.top }, 36); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: dustAt(t, 65.35, DIAG.right - 90, DIAG.top, 2) }; }
    if (t < 66.2) { const u = ease.inOutSine((t - 65.4) / 0.8); const phase = Math.floor((t - 65.4) / 0.18) % 2; return { x: lerp(DIAG.right - 90, TREND.right - 40, u), y: DIAG.top, pose: phase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 65.4), dust: null }; }
    if (t < 66.6) { const p = jumpPos(t, 66.2, 66.55, { x: TREND.right - 40, y: DIAG.top }, { x: TREND.right - 80, y: TREND.top }, 20); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 67.2) { const u = ease.inOutSine((t - 66.6) / 0.6); const phase = Math.floor((t - 66.6) / 0.16) % 2; return { x: lerp(TREND.right - 80, TREND.right - 40, u), y: TREND.top, pose: phase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 66.6), dust: null }; }
    if (t < 67.7) return { x: TREND.right - 40, y: TREND.top, pose: "happy", flip: false, sx: 1, sy: breath(t, 67.2), dust: null };
    if (t < 68.0) return { x: TREND.right - 40, y: TREND.top, pose: "happy", flip: false, sx: 1, sy: 1, dust: null };

    /* ===== 第 4 幕 + 片尾（68–90s） ===== */
    const IGIF = A0(A("image-gif-group"), { top: 520, cx: 640, right: 900 });
    const IFR = A0(A("image-gif-frames"), { top: 560, cx: 560, right: 700 });
    const IFP = A0(A("image-gif-fps"), { top: 560, cx: 760, right: 900 });
    const GIFA = A0(A("image-result-gif"), { top: 300, cx: 900, right: 1100 });
    const APP = A0(A("canvas-toolbar-appearance"), { top: 720, cx: 780, right: 850 });
    const TBAR = A0(A("canvas-toolbar"), { top: 712, cx: 700, right: 900 });
    const PRT = A0(A("prompts-title"), { top: 120, cx: 400, right: 600 });
    const PRG = A0(A("prompts-card-grid"), { top: 220, cx: 500, right: 900 });
    const ADH = A0(A("admin-header"), { top: 90, cx: 400, right: 700 });
    const ADQ = A0(A("admin-tab-quota"), { top: 200, cx: 400, right: 500 });
    const ADD = A0(A("admin-quota-daily"), { top: 260, cx: 400, right: 600 });
    const ADW = A0(A("admin-quota-weekly"), { top: 260, cx: 700, right: 900 });
    const N12 = A0(A("canvas-node-12"), { top: 420, cx: 900, right: 1000 });
    const N11 = A0(A("canvas-node-11"), { top: 420, cx: 600, right: 700 });

    if (t < 68.25) { const u = ease.outCubic(clamp((t - 68.0) / 0.25, 0, 1)); return { x: lerp(TREND.right - 40, IGIF.cx, u), y: lerp(TREND.top, IGIF.top, u), pose: "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 68.6) return { x: IGIF.cx, y: IGIF.top, pose: t < 68.4 ? "land" : "look-down", flip: false, sx: 1, sy: breath(t, 68.25), dust: dustAt(t, 68.25, IGIF.cx, IGIF.top, 2) };
    if (t < 68.9) { const u = ease.outCubic(clamp((t - 68.6) / 0.3, 0, 1)); return { x: lerp(IGIF.cx, IGIF.right - 30, u), y: IGIF.top, pose: "walk-a", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 69.2) { const bounce = t >= 68.9 && t < 69.1 ? -10 * Math.sin(((t - 68.9) / 0.2) * Math.PI) : 0; return { x: IGIF.right - 30, y: IGIF.top + bounce, pose: "wide", flip: false, sx: 1, sy: breath(t, 68.9), dust: null }; }
    if (t < 69.6) { const u = ease.outCubic(clamp((t - 69.2) / 0.25, 0, 1)); return { x: lerp(IGIF.right - 30, IFR.right - 20, u), y: lerp(IGIF.top, IFR.top, u), pose: u < 0.7 ? "jump-fall" : "look-down", flip: false, sx: 1, sy: breath(t, 69.45), dust: dustAt(t, 69.45, IFR.right - 20, IFR.top, 1) }; }
    if (t < 70.4) { const bounce = t >= 69.6 && t < 69.8 ? -8 * Math.sin(((t - 69.6) / 0.2) * Math.PI) : 0; return { x: IFR.right - 20, y: IFR.top + bounce, pose: "happy", flip: false, sx: 1, sy: breath(t, 69.6), dust: null }; }
    if (t < 70.7) { const p = jumpPos(t, 70.4, 70.65, { x: IFR.right - 20, y: IFR.top }, { x: GIFA.cx + 60, y: GIFA.top }, 30); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 72.4) {
      const beat = Math.floor((t - 70.7) / 0.2);
      const phase = (t - 70.7) % 0.2;
      const hopY = Math.sin((phase / 0.2) * Math.PI) * 16;
      return { x: GIFA.cx + 60, y: GIFA.top - hopY, pose: hopY > 6 ? "jump-up" : "look-down", flip: false, sx: 1, sy: 1, dust: null, gifBeat: beat };
    }
    if (t < 72.6) return { x: GIFA.cx + 60, y: GIFA.top, pose: "happy", flip: false, sx: 1, sy: breath(t, 72.4), dust: null };
    if (t < 73.0) { const u = ease.inOutCubic(clamp((t - 72.6) / 0.4, 0, 1)); return { x: lerp(GIFA.cx + 60, APP.right - 30, u), y: lerp(GIFA.top, TBAR.top, u), pose: u < 0.6 ? "jump-fall" : "land", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 73.4) return { x: APP.right - 30, y: TBAR.top, pose: "crouch", flip: false, sx: 1, sy: breath(t, 73.0), dust: dustAt(t, 73.0, APP.right - 30, TBAR.top, 2) };
    if (t < 73.6) return { x: APP.right - 30, y: TBAR.top, pose: "look-down", flip: false, sx: 1, sy: 1, dust: null };
    if (t < 74.2) return { x: APP.right - 30, y: TBAR.top, pose: "wide", flip: false, sx: 1, sy: 1, dust: null };
    if (t < 74.6) { const k = ease.outCubic((t - 74.2) / 0.35); return { x: APP.right - 30, y: TBAR.top, pose: "happy", flip: false, sx: 1 + 0.12 * (1 - k), sy: 1 - 0.14 * (1 - k), dust: null }; }
    if (t < 75.4) return { x: APP.right - 30, y: TBAR.top, pose: "idle", flip: false, sx: 1, sy: breath(t, 74.6), dust: null };
    if (t < 75.8) { const u = ease.inOutCubic(clamp((t - 75.4) / 0.4, 0, 1)); return { x: lerp(APP.right - 30, PRT.cx + 60, u), y: lerp(TBAR.top, PRT.top, u), pose: u < 0.6 ? "jump-fall" : "land", flip: false, sx: 1, sy: 1, dust: dustAt(t, 75.75, PRT.cx + 60, PRT.top, 2) }; }
    if (t < 76.2) { const u = ease.inOutSine((t - 75.8) / 0.4); const phase = Math.floor((t - 75.8) / 0.18) % 2; return { x: lerp(PRT.cx + 60, PRT.right - 40, u), y: PRT.top, pose: phase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 75.8), dust: null }; }
    if (t < 76.6) { const u = ease.outCubic(clamp((t - 76.2) / 0.35, 0, 1)); return { x: lerp(PRT.right - 40, PRG.cx + 40, u), y: lerp(PRT.top, PRG.top, u), pose: "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 77.4) { const tap = t >= 76.6 && t < 76.8 ? 1 - 0.05 * Math.sin(((t - 76.6) / 0.2) * Math.PI) : 1; return { x: PRG.cx + 40, y: PRG.top, pose: t < 76.9 ? "crouch" : "look-up", flip: false, sx: 1, sy: breath(t, 76.6) * tap, dust: dustAt(t, 76.6, PRG.cx + 40, PRG.top, 2) }; }
    if (t < 77.8) { const u = ease.inOutCubic(clamp((t - 77.4) / 0.4, 0, 1)); return { x: lerp(PRG.cx + 40, ADH.right - 60, u), y: lerp(PRG.top, ADH.top, u), pose: u < 0.6 ? "jump-fall" : "land", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 78.4) return { x: ADH.right - 60, y: ADH.top, pose: "look-down", flip: false, sx: 1, sy: breath(t, 77.8), dust: dustAt(t, 77.75, ADH.right - 60, ADH.top, 2) };
    if (t < 78.8) { const u = ease.inOutSine((t - 78.4) / 0.4); const phase = Math.floor((t - 78.4) / 0.18) % 2; return { x: lerp(ADH.right - 60, ADQ.cx, u), y: ADH.top, pose: phase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 78.4), dust: null }; }
    if (t < 79.2) { const u = ease.inOutSine((t - 78.8) / 0.4); return { x: lerp(ADQ.cx, ADD.cx + 40, u), y: lerp(ADH.top, ADD.top, u), pose: "look-down", flip: false, sx: 1, sy: breath(t, 78.8), dust: null }; }
    if (t < 79.8) { const u = ease.inOutSine((t - 79.2) / 0.5); return { x: lerp(ADD.cx + 40, ADW.cx + 40, u), y: lerp(ADD.top, ADW.top, u), pose: "wide", flip: false, sx: 1, sy: breath(t, 79.2), dust: null }; }
    if (t < 80.6) return { x: ADW.cx + 40, y: ADW.top, pose: "look-left", flip: false, sx: 1, sy: breath(t, 79.8), dust: null };
    if (t < 81.0) { const u = ease.inOutCubic(clamp((t - 80.6) / 0.4, 0, 1)); return { x: lerp(ADW.cx + 40, N12.cx + 60, u), y: lerp(ADW.top, N12.top, u), pose: u < 0.6 ? "jump-fall" : "land", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 82.8) { const u = ease.inOutSine((t - 81.0) / 1.8); const phase = Math.floor((t - 81.4) / 0.2) % 2; return { x: lerp(N12.cx + 60, N12.cx - 80, u), y: N12.top, pose: t < 81.4 ? "look-right" : phase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 81.0), dust: dustAt(t, 81.0, N12.cx + 60, N12.top, 2) }; }
    if (t < 83.65) return { x: N12.cx - 80, y: N12.top, pose: "sit", flip: false, sx: 1, sy: 1 + 0.02 * Math.sin(((t - 82.8) / 0.6) * Math.PI * 4), dust: null };
    if (t < 84.2) { const u = ease.inOutCubic(clamp((t - 83.65) / 0.55, 0, 1)); return { x: lerp(N12.cx - 80, N11.cx + 40, u), y: lerp(N12.top, N11.top, u), pose: "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 84.6) { const p = jumpPos(t, 84.2, 84.55, { x: N11.cx + 40, y: N11.top }, { x: N12.cx, y: N12.top }, 26); return { x: p.x, y: p.y, pose: p.u < 0.55 ? "jump-up" : "jump-fall", flip: false, sx: 1, sy: 1, dust: null }; }
    if (t < 85.0) { const u = ease.inOutSine((t - 84.6) / 0.4); const phase = Math.floor((t - 84.6) / 0.18) % 2; return { x: lerp(N12.cx, N12.cx + 40, u), y: N12.top, pose: phase === 0 ? "walk-a" : "walk-b", flip: false, sx: 1, sy: breath(t, 84.6), dust: dustAt(t, 84.55, N12.cx, N12.top, 2) }; }
    if (t < 88.4) { const zCycle = ((t - 86.0) / 0.8) % 1; return { x: N12.cx + 40, y: N12.top, pose: "sleep", flip: false, sx: 1, sy: 1 + 0.015 * Math.sin(((t - 85.0) / 2.0) * Math.PI * 2), dust: null, z: t >= 86.0 && t < 87.6 ? (zCycle < 0 ? zCycle + 1 : zCycle) : -1 }; }
    const fade = clamp((t - 88.4) / 0.4, 0, 1);
    return { x: N12.cx + 40, y: N12.top, pose: "sleep", flip: false, sx: 1, sy: 1, dust: null, alpha: 1 - fade, z: -1 };
  }

  /* ---------- S01 出生像素块 ---------- */
  function blocksAt(t) {
    if (t < 1.15 || t >= 2.04) return null;
    const originX = 22, originY = 34 + (56 - 20) / 2;
    const land = { x: 104, y: -20 };
    const out = [];
    for (let i = 0; i < 3; i++) {
      const start = 1.15 + i * 0.18;
      const end = start + 0.5;
      if (t < start) continue;
      const u = clamp((t - start) / (end - start), 0, 1);
      const k = ease.outQuad(u);
      out.push({
        x: lerp(originX + i * 6, land.x + i * 34, k),
        y: lerp(originY + (i % 2 === 0 ? 2 : 0), land.y + (i === 1 ? -6 : 0), k) - Math.sin(Math.PI * k) * 18,
        size: lerp(8, 30, k),
        alpha: 1,
      });
    }
    if (t >= 1.82) {
      const k = ease.inOutCubic(clamp((t - 1.82) / 0.18, 0, 1));
      const cx = 104 + 34 + 15;
      out.forEach((b) => { b.x = lerp(b.x, cx - 15, k); b.y = lerp(b.y, land.y, k); b.size = lerp(b.size, 32, k); if (t > 1.99) b.alpha = 1 - clamp((t - 1.99) / 0.04, 0, 1); });
    }
    return out;
  }

  /* ---------- 光标 ---------- */
  function clickPulse(t, t0) {
    const dt = t - t0;
    if (dt < 0 || dt > 0.3) return 0;
    return Math.sin((dt / 0.3) * Math.PI);
  }

  function cursorAt(t, S) {
    const at = (a, dx, dy) => (S ? S(a, dx, dy) : { x: 960, y: 540 });
    const rest1 = { x: 1520, y: 940 }, rest2 = { x: 1180, y: 760 };
    if (t < 3.3) { const u = t < 2.85 ? 0 : ease.outCubic((t - 2.85) / 0.45); return { x: lerp(2010, rest1.x, u), y: lerp(1150, rest1.y, u), opacity: u, click: 0 }; }
    if (t < 6.2) return { x: rest1.x, y: rest1.y, opacity: 1, click: 0 };
    if (t < 7.2) { const u = ease.inOutCubic((t - 6.2) / 1.0); return { x: lerp(rest1.x, rest2.x, u), y: lerp(rest1.y, rest2.y, u), opacity: 1, click: 0 }; }
    if (t < 8.2) return { x: rest2.x, y: rest2.y, opacity: 1, click: 0 };
    if (t < 9.2) { const u = ease.outCubic((t - 8.2) / 1.0); const p = at("chat-example-row-2", 0, 10); return { x: lerp(rest2.x, p.x, u), y: lerp(rest2.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 11.0) { const p = at("chat-example-row-2", 0, 10); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 14.0) { const p = at("chat-composer-input", 0, 10); return { x: p.x, y: p.y, opacity: 1, click: clickPulse(t, 11.2) }; }
    if (t < 17.9) { const pp = at("chat-composer-input", 0, 10); const p = at("chat-composer-send", 30, 40); const u = ease.inOutSine(clamp((t - 14.0) / 0.6, 0, 1)); return { x: lerp(pp.x, p.x, u), y: lerp(pp.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 19.4) { const pp = at("chat-composer-send", 30, 40); const p = at("chat-result-card", 0, 0); const u = ease.inOutCubic(clamp((t - 17.9) / 0.7, 0, 1)); return { x: lerp(pp.x, p.x, u), y: lerp(pp.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 20.1) { const p = at("chat-result-card", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: clickPulse(t, 19.4) }; }
    if (t < 21.2) { const pp = at("chat-result-card", 0, 0); const p = at("chat-artifact-continue", 0, 0); const u = ease.inOutCubic(clamp((t - 20.1) / 0.8, 0, 1)); return { x: lerp(pp.x, p.x, u), y: lerp(pp.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 23.3) { const p = at("chat-artifact-continue", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: clickPulse(t, 21.2) }; }
    if (t < 24.0) { const pp = at("chat-artifact-continue", 0, 0); const p = at("chat-artifact-continue-btn", 0, 0); const u = ease.inOutCubic(clamp((t - 23.3) / 0.35, 0, 1)); return { x: lerp(pp.x, p.x, u), y: lerp(pp.y, p.y, u), opacity: 1, click: clickPulse(t, 23.3) }; }
    if (t < 25.2) { const pp = at("chat-artifact-continue-btn", 0, 0); const p = at("chat-composer-input", 0, 10); const u = ease.inOutCubic(clamp((t - 24.0) / 0.5, 0, 1)); return { x: lerp(pp.x, p.x, u), y: lerp(pp.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 26.4) { const pp = at("chat-composer-input", 0, 10); const p = at("chat-palette-item-image", 60, 0); const u = ease.inOutCubic(clamp((t - 25.2) / 0.5, 0, 1)); return { x: lerp(pp.x, p.x, u), y: lerp(pp.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 27.0) { const p = at("chat-palette-item-image", 60, 0); return { x: p.x, y: p.y, opacity: 1, click: clickPulse(t, 26.4) }; }
    if (t < 28.0) { const p = at("chat-composer-input", 0, 10); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }

    // ===== 第 2 幕光标 =====
    if (t < 28.6) return { x: 700, y: 300, opacity: 0.7, click: clickPulse(t, 28.2) };
    if (t < 29.4) { const p = at("canvas-topbar-title", 160, 40); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 30.8) { const p = at("canvas-toolbar-focus", 0, 0); const q = at("canvas-topbar-title", 160, 40); const u = ease.inOutSine(clamp((t - 29.4) / 0.8, 0, 1)); return { x: lerp(q.x, p.x, u), y: lerp(q.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 32.9) { const p = at("canvas-agent-input", 40, 10); const q = at("canvas-toolbar-focus", 0, 0); const u = ease.inOutCubic(clamp((t - 30.8) / 0.5, 0, 1)); return { x: lerp(q.x, p.x, u), y: lerp(q.y, p.y, u), opacity: 1, click: clickPulse(t, 31.0) }; }
    if (t < 35.4) { const p = at("canvas-agent-input", 40, 10); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 36.2) { const p = at("canvas-agent-msg-user-1", -60, 30); const q = at("canvas-agent-input", 40, 10); const u = ease.inOutSine(clamp((t - 35.4) / 0.4, 0, 1)); return { x: lerp(q.x, p.x, u), y: lerp(q.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 39.6) {
      const spots = [1, 4, 8, 12];
      const idx = clamp(Math.floor((t - 36.2) / 0.8), 0, 3);
      const p = at("canvas-node-" + String(spots[idx]).padStart(2, "0"), 0, 0);
      return { x: p.x, y: p.y, opacity: 1, click: 0 };
    }
    if (t < 40.4) { const p = at("canvas-node-12", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 43.2) {
      const pts = [1, 2, 3, 6, 9, 12];
      const times = [40.4, 40.9, 41.5, 42.0, 42.5, 43.0];
      let seg = 0;
      while (seg < times.length - 2 && t > times[seg + 1]) seg++;
      const u = clamp((t - times[seg]) / (times[seg + 1] - times[seg]), 0, 1);
      const a = at("canvas-node-" + String(pts[seg]).padStart(2, "0"), 0, 0);
      const b = at("canvas-node-" + String(pts[seg + 1]).padStart(2, "0"), 0, 0);
      return { x: lerp(a.x, b.x, ease.inOutSine(u)), y: lerp(a.y, b.y, u), opacity: 1, click: 0 };
    }
    if (t < 44.2) { const p = at("canvas-toolbar-focus", 0, 0); const q = at("canvas-node-12", 0, 0); const u = ease.inOutCubic(clamp((t - 43.2) / 0.5, 0, 1)); return { x: lerp(q.x, p.x, u), y: lerp(q.y, p.y, u), opacity: 1, click: clickPulse(t, 43.8) }; }
    if (t < 45.8) { const p = at("canvas-node-05", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 47.0) { const q = at("canvas-node-05", 0, 0); const u = ease.inOutSine(clamp((t - 45.8) / 0.8, 0, 1)); return { x: lerp(q.x, 1650, u), y: lerp(q.y, 980, u), opacity: 1, click: 0 }; }
    if (t < 48.0) return { x: 1650, y: 980, opacity: 0.95, click: 0 };

    // ===== 第 3 幕光标 =====
    if (t < 48.3) { const p = at("image-generate-btn", 0, 0); return { x: p.x, y: p.y + 40, opacity: 1, click: 0 }; }
    if (t < 49.4) { const p = at("image-generate-btn", 0, 0); const q = at("image-pending-card-1", 0, 0); const u = ease.inOutSine(clamp((t - 48.5) / 0.7, 0, 1)); return { x: lerp(p.x, q.x, u), y: lerp(p.y, q.y, u), opacity: 1, click: clickPulse(t, 48.4) }; }
    if (t < 50.8) { const p = at("image-pending-card-1", 40, 20); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 52.6) { const target = t < 51.6 ? "image-pending-card-2" : "image-pending-card-4"; const prev = t < 51.6 ? "image-pending-card-1" : "image-pending-card-2"; const a = at(prev, 40, 20), b = at(target, 40, 20); const u = ease.inOutSine(((t - 50.8) % 0.8) / 0.8); return { x: lerp(a.x, b.x, Math.min(1, u)), y: lerp(a.y, b.y, Math.min(1, u)), opacity: 1, click: 0 }; }
    if (t < 53.4) { const p = at("image-pending-card-4", 40, 20); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 54.4) { const p = at("chat-fail-card", 0, 30); const q = at("chat-retry-btn", 0, 0); return { x: lerp(p.x, q.x, 0.4), y: lerp(p.y, q.y, 0.4), opacity: 1, click: clickPulse(t, 54.4) }; }
    if (t < 56.2) { const p = at("chat-retry-btn", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 57.6) { const p = at("chat-result-card-2", 0, 0); const q = at("chat-retry-btn", 0, 0); const u = ease.inOutCubic(clamp((t - 56.2) / 0.4, 0, 1)); return { x: lerp(q.x, p.x, u), y: lerp(q.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 58.8) { const p = at("chat-result-card-2", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 59.4) { const p = at("chat-result-card-2", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 60.2) { const p = at("chat-waiting-card", 60, 0); const q = at("chat-result-card-2", 0, 0); const u = ease.inOutSine(clamp((t - 59.4) / 0.5, 0, 1)); return { x: lerp(q.x, p.x, u), y: lerp(q.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 62.0) { const p = at("chat-waiting-card", 60, 0); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 63.2) { const p = at("chat-result-card-2", 0, 0); const q = at("chat-waiting-card", 60, 0); const u = ease.inOutCubic(clamp((t - 62.0) / 0.4, 0, 1)); return { x: lerp(q.x, p.x, u), y: lerp(q.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 64.8) { const p = at("chat-result-card-3", 0, 0); const q = at("chat-result-card-2", 0, 0); const u = ease.inOutCubic(clamp((t - 63.2) / 0.4, 0, 1)); return { x: lerp(q.x, p.x, u), y: lerp(q.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 65.2) { const p = at("chat-diagnostics-btn", 0, 0); const q = at("chat-result-card-3", 0, 0); const u = ease.inOutCubic(clamp((t - 64.8) / 0.35, 0, 1)); return { x: lerp(q.x, p.x, u), y: lerp(q.y, p.y, u), opacity: 1, click: clickPulse(t, 65.0) }; }
    if (t < 67.4) { const p = at("chat-diagnostics-trend", 0, 20); const q = at("chat-diagnostics-btn", 0, 0); const u = ease.inOutCubic(clamp((t - 65.2) / 0.4, 0, 1)); return { x: lerp(q.x, p.x, u), y: lerp(q.y, p.y, u), opacity: 1, click: 0 }; }
    if (t < 67.9) { const p = at("chat-diagnostics-copy", 0, 0); const q = at("chat-diagnostics-trend", 0, 20); const u = ease.inOutCubic(clamp((t - 67.4) / 0.3, 0, 1)); return { x: lerp(q.x, p.x, u), y: lerp(q.y, p.y, u), opacity: 1, click: clickPulse(t, 67.75) }; }
    if (t < 68.0) return { x: 1200, y: 900, opacity: 0.95, click: 0 };

    // ===== 第 4 幕光标 =====
    if (t < 68.4) { const p = at("image-gif-group", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 69.0) { const p = at("image-gif-group", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: clickPulse(t, 68.8) }; }
    if (t < 69.4) { const p = at("image-gif-frames", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: clickPulse(t, 69.0) }; }
    if (t < 69.8) { const p = at("image-gif-fps", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: clickPulse(t, 69.4) }; }
    if (t < 70.6) { const p = at("image-gif-fps", 0, 0); return { x: p.x + 120, y: p.y + 40, opacity: 1, click: 0 }; }
    if (t < 72.6) { const p = at("image-result-gif", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 73.2) { const p = at("canvas-toolbar-appearance", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 73.6) { const p = at("canvas-toolbar-appearance", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: clickPulse(t, 73.2) }; }
    if (t < 74.2) { const p = at("canvas-appearance-dark", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: clickPulse(t, 73.6) }; }
    if (t < 74.8) { const p = at("canvas-appearance-light", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: clickPulse(t, 74.2) }; }
    if (t < 75.6) { const p = at("canvas-appearance-light", 0, 0); return { x: p.x + 80, y: p.y + 60, opacity: 1, click: 0 }; }
    if (t < 77.4) { const p = at("prompts-card-grid", 40, 40); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 78.2) { const p = at("admin-tab-quota", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: clickPulse(t, 78.2) }; }
    if (t < 79.0) { const p = at("admin-tab-quota", 0, 0); return { x: p.x + 30, y: p.y + 40, opacity: 1, click: 0 }; }
    if (t < 79.6) { const p = at("admin-quota-daily", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 80.6) { const p = at("admin-quota-weekly", 0, 0); return { x: p.x, y: p.y, opacity: 1, click: 0 }; }
    if (t < 85.2) { const p = at("canvas-node-12", 0, 0); const u = ease.inOutSine(clamp((t - 80.6) / 0.8, 0, 1)); return { x: lerp(p.x, 1650, u), y: lerp(p.y, 980, u), opacity: 1, click: 0 }; }
    return { x: 1650, y: 980, opacity: Math.max(0, 1 - (t - 85.2) / 1.0), click: 0 };
  }

  /* ---------- 章节 / 擦除 / 字幕 / 键击 ---------- */
  const CHAPTERS = [
    { t: 8.0, num: "01", text: "它会自己接活" },
    { t: 28.0, num: "02", text: "它自己摆画布" },
    { t: 48.0, num: "03", text: "它不再炸了" },
    { t: 68.0, num: "04", text: "它是一整间工作室" },
  ];
  function chapterAt(t) {
    for (let i = 0; i < CHAPTERS.length; i++) {
      const ch = CHAPTERS[i];
      const start = ch.t - 0.25, fadeStart = ch.t + 2.2, fadeEnd = ch.t + 2.55;
      if (t >= start && t <= fadeEnd) {
        const reveal = clamp((t - start) / 0.35, 0, 1);
        const opacity = t < fadeStart ? 1 : 1 - clamp((t - fadeStart) / (fadeEnd - fadeStart), 0, 1);
        return { num: ch.num, text: ch.text, reveal: ease.outCubic(reveal), opacity };
      }
    }
    return null;
  }
  function wipeAt(t) {
    const points = [7.75, 27.7, 47.7, 67.7, 83.65];
    const durs = [0.5, 0.6, 0.6, 0.6, 0.7];
    for (let i = 0; i < points.length; i++) if (t >= points[i] && t <= points[i] + durs[i]) return { progress: (t - points[i]) / durs[i] };
    return null;
  }

  const CAPTIONS = [
    { t0: 8.6, t1: 10.9, text: "说人话，就能出图。" },
    { t0: 22.7, t1: 25.1, text: "改图，也只要一句话。" },
    { t0: 36.6, t1: 38.82, text: "十二张，一次排好。" },
    { t0: 40.6, t1: 43.18, text: "4 列 3 行，自动不重叠。" },
    { t0: 48.6, t1: 50.64, text: "排队，也不会丢。" },
    { t0: 53.5, t1: 56.08, text: "网络抖了，\n它自己重来。" },
    { t0: 59.0, t1: 60.86, text: "刷新，接着跑。" },
    { t0: 81.0, t1: 83.76, text: "一个窗口，\n一整间工作室。" },
  ];
  function captionAt(t) {
    for (const c of CAPTIONS) {
      if (t >= c.t0 && t <= c.t1) {
        const fadeIn = clamp((t - c.t0) / 0.2, 0, 1);
        const fadeOut = clamp((c.t1 - t) / 0.25, 0, 1);
        return { text: c.text, opacity: Math.min(fadeIn, fadeOut) };
      }
    }
    return null;
  }

  function keysAt(t) {
    if (t >= 11.5 && t < 13.5) { const n = typedCount(t); const s = PROMPT.slice(0, n).slice(-5); return s ? { labels: s.split("") } : null; }
    if (t >= 13.5 && t < 13.9) return { labels: ["↵ Enter"] };
    if (t >= 21.4 && t < 23.2) { const n = editTypedCount(t); const s = EDIT_DRAFT.slice(0, n).slice(-5); return s ? { labels: s.split("") } : null; }
    if (t >= 23.25 && t < 23.6) return { labels: ["↵ Enter"] };
    if (t >= 24.0 && t < 24.35) return { labels: ["↵ Enter"] };
    if (t >= 25.2 && t < 25.6) return { labels: ["⌘", "K"] };
    if (t >= 25.6 && t < 26.4) return { labels: ["↓", "↓"] };
    if (t >= 26.4 && t < 26.8) return { labels: ["↵"] };
    if (t >= 32.9 && t < 35.1) { const n = canvasTypedCount(t); const str = CANVAS_PROMPT.slice(0, n).slice(-5); return str ? { labels: str.split("") } : null; }
    if (t >= 35.1 && t < 35.45) return { labels: ["↵ Enter"] };
    if (t >= 58.8 && t < 59.15) return { labels: ["⌘", "R"] };
    if (t >= 69.0 && t < 69.15) return { labels: ["9"] };
    if (t >= 69.4 && t < 69.55) return { labels: ["5"] };
    return null;
  }

  /* ---------- 状态 ---------- */
  function canvasStateAt(t) {
    const grid = [];
    for (let i = 1; i <= 12; i++) {
      const appear = 36.0 + (i - 1) * 0.2;
      const done = 38.8 + Math.floor((i - 1) / 4) * 0.35 + ((i - 1) % 4) * 0.05;
      if (t < appear) continue;
      const isDone = t >= done;
      const genStart = appear + 0.15;
      const pct = isDone ? 100 : Math.round(lerp(5, 95, clamp((t - genStart) / Math.max(0.2, done - genStart), 0, 1)));
      grid.push({ id: i, name: "系列 " + String(i).padStart(2, "0"), col: (i - 1) % 4, row: Math.floor((i - 1) / 4), state: isDone ? "done" : t < genStart ? "skeleton" : "generating", pct, tone: (i - 1) % 4 });
    }
    const demo = t < 35.8 ? [{ id: 1, name: "海报 01", col: 0, row: 0, state: "done", pct: 100, tone: 0 }, { id: 2, name: "海报 02", col: 1, row: 0, state: "done", pct: 100, tone: 1 }] : [];
    const nodes = demo.length ? demo : grid;
    let zoom = 0.4;
    if (t >= 43.8 && t < 44.4) zoom = lerp(0.4, 0.6, ease.inOutCubic((t - 43.8) / 0.6));
    else if (t >= 44.4 && t < 45.2) zoom = lerp(0.6, 0.44, ease.inOutCubic((t - 44.4) / 0.8));
    else if (t >= 45.2) zoom = 0.44;
    const viewport = { zoom, cx: 752, cy: 408 };
    const stepsOn = t >= 35.6;
    const agent = {
      history: [{ role: "user", text: "先把这 2 张并排" }, { role: "assistant", text: "已排好 2 个节点" }],
      input: t < CANVAS_TYPING_START ? "" : t < 35.15 ? CANVAS_PROMPT.slice(0, canvasTypedCount(t)) : "",
      focus: t >= 31.0,
      userMsg: t >= 35.4 ? CANVAS_PROMPT : null,
      steps: stepsOn ? { items: [
        { label: "分析创作需求，梳理画面构思", state: t >= 36.4 ? "done" : "run" },
        { label: "组织回复内容", state: t >= 37.2 ? "done" : t >= 36.4 ? "run" : "idle" },
        { label: "整理图像成果与创作建议", state: t >= 38.8 ? "done" : t >= 37.2 ? "run" : "idle" },
      ] } : null,
      tool: t >= 36.4 ? { status: t >= 39.8 ? "success" : "running", meta: t >= 39.8 ? "12 张 · 1536×864" : "" } : null,
    };
    const links = t >= 44.2 ? [[1, 2], [1, 5], [5, 9], [9, 12]] : [];
    return { title: "无限画布 1", viewport, nodes, links, focusPressed: t >= 43.8 && t < 44.3, agent };
  }



  function act4StateAt(t) {
    const canvasBase = (extra) => Object.assign({
      title: "无限画布 1",
      viewport: { zoom: 0.44, cx: 752, cy: 408 },
      nodes: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: "系列 " + String(i + 1).padStart(2, "0"), col: i % 4, row: Math.floor(i / 4), state: "done", pct: 100, tone: i % 4 })),
      links: [[1, 2], [1, 5], [5, 9], [9, 12]],
      focusPressed: false,
      agent: { history: [{ role: "user", text: "把这组海报做成 12 张的系列，排成网格" }], input: "", focus: false, userMsg: null, steps: { items: [{ label: "整理图像成果与创作建议", state: "done" }] }, tool: { status: "success", meta: "12 张 · 1536×864" } },
    }, extra || {});
    if (t < 72.6) {
      const gifOn = t >= 68.8;
      const frames = t >= 69.0 ? "9" : "";
      const fps = t >= 69.4 ? "5" : "";
      const done = t >= 70.6;
      const cards = done ? [{ id: 1, gif: true }] : [{ id: 1, state: "drawing", pct: Math.round(clamp(6 + (t - 68.8) * 22, 6, 88)) }];
      return { page: "image", image: { pressed: t >= 68.8 && t < 69.0, gifOn, frames: frames || 9, fps: fps || 5, cards, gifFrame: done ? Math.floor((t - 70.6) * 5) % 9 : 0, count: 1, records: [{ title: "咖啡海报 01" }, { title: "咖啡海报 02" }].concat(done ? [{ title: "动图 01" }] : []) }, dark: false, stageDark: false, dim: false, spot: false, endCard: null, diagnostics: null, flash: null, spinner: null, toast: null, timelapse: false };
    }
    if (t < 75.4) {
      const apOpen = t >= 73.2 && t < 74.8;
      const dark = t >= 73.6 && t < 74.2;
      return { page: "canvas", canvas: canvasBase({ appearance: { open: apOpen, selected: dark ? "dark" : "light" }, spot: false }), dark, stageDark: dark, dim: false, endCard: null };
    }
    if (t < 77.4) return { page: "prompts", prompts: { count: 42 }, dark: false, stageDark: false, dim: false, spot: false, endCard: null };
    if (t < 80.6) return { page: "admin", admin: { tab: t >= 78.2 ? "quota" : "overview" }, dark: false, stageDark: false, dim: false, spot: false, endCard: null };
    const dim = t >= 84.0;
    const spot = t >= 85.0;
    const endCard = t >= 86.4;
    return { page: "canvas", canvas: canvasBase({ appearance: { open: false, selected: "light" }, spot }), dark: false, stageDark: dim, dim, spot, endCard };
  }

  function act3StateAt(t) {
    if (t < 53.2) {
      const cards = [1, 2, 3, 4].map((id) => {
        const queued = id <= 2 && t < 52.0;
        const ahead = t >= 51.2 ? 1 : 2;
        const eta = t >= 51.2 ? 30 : 45;
        if (queued) return { id, state: "queued", ahead, eta };
        let pct = id <= 2 ? Math.round(clamp(12 + (t - 52.0) * 34, 12, 88)) : Math.round(clamp(8 + (t - 48.6) * 17, 8, 88));
        return { id, state: "drawing", pct };
      });
      return { page: "image", image: { pressed: t >= 48.4 && t < 48.7, cards, records: [{ title: "咖啡海报 01" }, { title: "咖啡海报 02" }] }, diagnostics: null, flash: null, spinner: null, toast: null, timelapse: false };
    }
    const thread = {
      user: PROMPT,
      steps: { items: [
        { label: "分析创作需求，梳理画面构思", state: "done" },
        { label: "组织回复内容", state: "done" },
        { label: "整理图像成果与创作建议", state: "done" },
      ] },
      tool: { kind: "generate", name: "生成图片", status: "success", meta: "2 张 · 1536×864" },
      results: { kind: "generate", count: 2 },
      assistant: "已生成 2 张，可以接着改。",
      editUser: `${DRAFT_PREFIX}${EDIT_DRAFT}。`,
      editTool: { kind: "edit", name: "修改图片", status: "success", meta: "2 张 · 1536×864" },
      editResults: 2,
      editAssistant: "已按参考图改好，继续要改哪里？",
    };
    let diagnostics = null, flash = null, spinner = null, toast = null, timelapse = false;
    if (t < 56.2) {
      thread.steps = { items: [
        { label: "等待重试", state: t >= 54.4 ? "done" : "run" },
        { label: "纠错重试", state: t >= 54.4 ? "run" : "idle" },
      ] };
      thread.tool = { kind: "generate", name: "生成图片", status: "running" };
      thread.waiting = { phase: t < 54.4 ? "网络异常，等待重试（1/2）" : "正在绘制细节", pct: t < 54.4 ? 44 : Math.round(lerp(44, 52, clamp((t - 54.4) / 1.0, 0, 1))) };
      thread.failCard = t >= 53.8;
      thread.assistant = null;
      thread.editResults = 0;
      thread.editTool = null;
      thread.editAssistant = null;
    } else if (t < 58.8) {
      thread.tool = null;
      thread.results = { kind: "generate", count: 2 };
      thread.assistant = "已生成 2 张，可以接着改。";
      thread.editResults = 2;
      thread.editAssistant = "背景已经改成深蓝，整体更暖了。";
    } else if (t < 62.0) {
      thread.tool = null;
      thread.waiting = { phase: "正在绘制中...", pct: Math.round(lerp(61, 78, clamp((t - 59.2) / 2.4, 0, 1))) };
      timelapse = t >= 59.0 && t < 61.4;
    } else if (t < 64.8) {
      thread.results = { kind: "generate", count: 4 };
      thread.tool = { kind: "generate", name: "生成图片", status: "success", meta: "4 张 · 1536×864" };
      thread.assistant = "4 张都好了。";
      thread.editUser = null;
      thread.editTool = null;
      thread.editResults = 0;
      thread.editAssistant = null;
      thread.user = null;
      thread.steps = null;
    } else {
      thread.results = { kind: "generate", count: 4 };
      thread.tool = { kind: "generate", name: "生成图片", status: "success", meta: "4 张 · 1536×864" };
      thread.assistant = "4 张都好了。";
      thread.user = null; thread.steps = null; thread.editUser = null; thread.editTool = null; thread.editResults = 0; thread.editAssistant = null;
      diagnostics = { open: t < 67.85, copied: t >= 67.4 };
      toast = t >= 67.4 ? { text: "诊断报告已复制", opacity: t < 67.95 ? 1 : 0 } : null;
    }
    if (t >= 58.8 && t < 59.12) {
      flash = { opacity: t < 58.84 ? 0.92 : Math.max(0, 0.92 * (1 - (t - 58.84) / 0.16)) };
      spinner = { visible: t >= 58.84, angle: (t - 58.84) * 900 };
    }
    return { page: "chat", welcome: false, sessions: [{ title: "秋天咖啡馆海报", active: true, running: t < 62 }], thread, composer: { text: "", focus: false }, artifact: null, palette: null, diagnostics, flash, spinner, toast, timelapse };
  }

  function uiStateAt(t) {
    if (t >= 68.0) return act4StateAt(t);
    if (t >= 48.0) return act3StateAt(t);
    if (t >= 28.0) return { page: "canvas", canvas: canvasStateAt(t) };
    const welcome = t < 13.8;
    const typing = typedCount(t);
    const focus = t >= 11.0 && t < 13.8;
    let composer = { text: t < 11.5 ? "" : t < 13.8 ? PROMPT.slice(0, typing) : "", focus };

    let thread = {};
    if (t >= 13.8) {
      thread.user = PROMPT;
      if (t >= 14.2) {
        thread.steps = {
          items: [
            { label: "分析创作需求，梳理画面构思", state: t >= 14.8 ? "done" : t >= 14.2 ? "run" : "idle" },
            { label: "组织回复内容", state: t >= 15.4 ? "done" : t >= 14.8 ? "run" : "idle" },
            { label: "整理图像成果与创作建议", state: t >= 16.0 ? "done" : t >= 15.4 ? "run" : "idle" },
          ],
        };
      }
      if (t >= 14.6) thread.tool = { kind: "generate", name: "生成图片", status: t >= 17.4 ? "success" : "running", meta: t >= 17.4 ? "2 张 · 1536×864" : "" };
      if (t >= 16.2 && t < 17.4) {
        let phase = "正在思考", pct = 14;
        if (t >= 16.6) { phase = "正在勾勒草图"; pct = Math.round(lerp(14, 42, clamp((t - 16.6) / 0.4, 0, 1))); }
        if (t >= 17.0) { phase = "正在绘制细节"; pct = Math.round(lerp(42, 70, clamp((t - 17.0) / 0.4, 0, 1))); }
        thread.waiting = { phase, pct };
      }
      if (t >= 17.6) thread.results = { kind: "generate", count: 2, offset: 0 };
      if (t >= 17.7) thread.assistant = "已生成 2 张，可以接着改。";
    }
    let artifact = null;
    if (t >= 20.0) {
      const openP = t < 23.3 ? ease.outCubic(clamp((t - 20.0) / 0.45, 0, 1)) : 1 - ease.outCubic(clamp((t - 23.35) / 0.35, 0, 1));
      artifact = { progress: openP, typed: t >= EDIT_START ? EDIT_DRAFT.slice(0, editTypedCount(t)) : "" };
    }
    if (t >= 23.5) {
      thread.editUser = `${DRAFT_PREFIX}${EDIT_DRAFT}。`;
      if (t >= 24.4) thread.editTool = { kind: "edit", name: "修改图片", status: t >= 25.0 ? "success" : "running", meta: t >= 25.0 ? "2 张 · 1536×864" : "" };
      if (t >= 25.0) thread.editResults = 2;
      if (t >= 25.1) thread.editAssistant = "已按参考图改好，继续要改哪里？";
    }
    if (t >= 23.5 && t < 24.1) composer = { text: `${DRAFT_PREFIX}${EDIT_DRAFT}。`, focus: true };
    if (t >= 26.4) composer = { text: "生成图片：", focus: true };
    const palette = t >= 25.2 && t < 26.4 ? { open: true, selected: t >= 25.8 ? 1 : 0 } : null;
    const sessions = t >= 17.7 ? [{ title: "秋天咖啡馆海报", active: true, running: false }] : [];
    return { page: "chat", welcome, sessions, thread, composer, artifact, palette };
  }

  /* ---------- 声音 ---------- */
  const AUDIO = [
    { t: 0.0, name: "room" }, { t: 1.0, name: "glock", note: 523.25 },
    { t: 1.2, name: "tick" }, { t: 1.45, name: "tick" }, { t: 1.7, name: "tick" }, { t: 1.9, name: "step" }, { t: 2.6, name: "blink" },
    { t: 3.8, name: "crouch" }, { t: 4.0, name: "boing" }, { t: 4.4, name: "land" }, { t: 4.9, name: "land" }, { t: 5.4, name: "land" },
    { t: 5.4, name: "glock", note: 783.99 }, { t: 5.8, name: "step" }, { t: 6.2, name: "step" }, { t: 6.6, name: "wave" }, { t: 7.0, name: "wave" },
    { t: 7.75, name: "whoosh" }, { t: 8.0, name: "chime" },
    { t: 8.6, name: "piano", note: 261.63 }, { t: 9.2, name: "step" }, { t: 9.8, name: "step" },
    { t: 10.2, name: "boing" }, { t: 10.5, name: "land" }, { t: 10.75, name: "boing" }, { t: 11.0, name: "land" },
    { t: 11.2, name: "click" }, { t: 11.45, name: "land" },
    { t: 13.5, name: "enter" }, { t: 13.8, name: "whoosh" }, { t: 14.2, name: "pop" },
    { t: 14.8, name: "tick" }, { t: 15.4, name: "tick" }, { t: 16.0, name: "tick" },
    { t: 16.2, name: "whoosh" }, { t: 17.4, name: "chime" }, { t: 17.6, name: "pop" },
    { t: 19.4, name: "click" }, { t: 20.0, name: "whip" }, { t: 20.5, name: "land" }, { t: 21.2, name: "click" },
    { t: 22.7, name: "piano", note: 329.63 }, { t: 23.3, name: "click" }, { t: 24.0, name: "enter" }, { t: 25.0, name: "chime" },
    { t: 25.2, name: "whoosh" }, { t: 25.8, name: "tick" }, { t: 26.4, name: "enter" }, { t: 27.7, name: "whip" },
  ];
  for (let i = 0; i < PROMPT_LEN; i++) AUDIO.push({ t: TYPING_START + i * TYPING_STEP, name: "thock" });
  for (let i = 0; i < EDIT_LEN; i++) AUDIO.push({ t: EDIT_START + i * TYPING_STEP, name: "thock" });
  // 第 2 幕音效
  const A2 = [
    { t: 28.0, name: "chime" }, { t: 28.3, name: "whoosh" }, { t: 28.9, name: "land" },
    { t: 29.1, name: "step" }, { t: 29.3, name: "step" }, { t: 29.5, name: "step" }, { t: 29.65, name: "boing" },
    { t: 30.0, name: "land" }, { t: 30.8, name: "boing" }, { t: 31.15, name: "land" }, { t: 31.0, name: "click" },
    { t: 31.2, name: "step" }, { t: 31.4, name: "step" },
    { t: 35.15, name: "enter" }, { t: 35.4, name: "pop" }, { t: 35.6, name: "tick" },
    { t: 36.4, name: "tick" }, { t: 37.2, name: "tick" }, { t: 38.8, name: "chime" },
    { t: 39.8, name: "pop" }, { t: 43.8, name: "click" }, { t: 44.2, name: "whoosh" },
    { t: 44.6, name: "land" }, { t: 45.8, name: "boing" }, { t: 46.4, name: "land" }, { t: 47.7, name: "whip" },
  ];
  for (let i = 0; i < CANVAS_PROMPT_LEN; i++) A2.push({ t: CANVAS_TYPING_START + i * CANVAS_TYPING_STEP, name: "thock" });
  for (let i = 0; i < 12; i++) { A2.push({ t: 36.0 + i * 0.2, name: "pop" }); A2.push({ t: 38.4 + i * 0.05, name: "tick" }); A2.push({ t: 38.8 + Math.floor(i / 4) * 0.35 + (i % 4) * 0.05, name: "blink" }); }
  AUDIO.push(...A2);
  const A3 = [
    { t: 48.0, name: "chime" }, { t: 48.2, name: "whoosh" }, { t: 48.4, name: "click" },
    { t: 48.6, name: "pop" }, { t: 48.75, name: "pop" }, { t: 48.9, name: "pop" }, { t: 49.05, name: "pop" },
    { t: 49.2, name: "land" }, { t: 53.2, name: "whoosh" }, { t: 53.6, name: "land" },
    { t: 53.8, name: "pop" }, { t: 54.4, name: "click" }, { t: 54.6, name: "tick" },
    { t: 56.2, name: "chime" }, { t: 56.8, name: "land" }, { t: 57.4, name: "chime" },
    { t: 58.8, name: "whoosh" }, { t: 58.6, name: "enter" }, { t: 59.0, name: "tick" }, { t: 59.1, name: "tick" }, { t: 59.2, name: "tick" },
    { t: 62.0, name: "chime" }, { t: 62.2, name: "pop" }, { t: 62.4, name: "pop" }, { t: 62.6, name: "pop" }, { t: 62.8, name: "pop" },
    { t: 63.2, name: "chime" }, { t: 64.8, name: "whip" }, { t: 65.0, name: "land" }, { t: 67.4, name: "click" }, { t: 67.6, name: "chime" }, { t: 67.7, name: "whip" },
  ];
  AUDIO.push(...A3);
  const A4 = [
    { t: 68.0, name: "chime" }, { t: 68.3, name: "whoosh" }, { t: 68.8, name: "click" }, { t: 68.85, name: "pop" },
    { t: 69.0, name: "tick" }, { t: 69.4, name: "tick" }, { t: 70.6, name: "pop" },
    { t: 72.6, name: "whoosh" }, { t: 73.2, name: "click" }, { t: 73.25, name: "pop" }, { t: 73.6, name: "whomp" },
    { t: 74.2, name: "click" }, { t: 74.25, name: "chime" },
    { t: 75.4, name: "whoosh" }, { t: 75.8, name: "pop" }, { t: 76.0, name: "tick" }, { t: 76.6, name: "wave" },
    { t: 77.4, name: "whoosh" }, { t: 77.8, name: "pop" }, { t: 78.2, name: "click" },
    { t: 78.8, name: "tick" }, { t: 79.0, name: "tick" }, { t: 79.2, name: "tick" }, { t: 79.4, name: "tick" }, { t: 79.6, name: "tick" },
    { t: 80.6, name: "whoosh" }, { t: 81.0, name: "whoosh" }, { t: 81.4, name: "step" }, { t: 81.6, name: "step" },
    { t: 82.8, name: "blink" }, { t: 83.65, name: "whoosh" }, { t: 84.6, name: "paper" }, { t: 85.0, name: "bell" },
    { t: 88.8, name: "chime" },
  ];
  for (let i = 0; i < 9; i++) A4.push({ t: 70.7 + i * 0.2, name: "tick" });
  AUDIO.push(...A4);
  AUDIO.sort((a, b) => a.t - b.t);

  FILM.shots = { TOTAL, cameraAt, mascotAt, blocksAt, cursorAt, chapterAt, wipeAt, captionAt, keysAt, audioEvents: AUDIO, uiStateAt, helpers: { clamp, lerp, ease, jumpPos, standAt, breath, dustAt } };
})();
