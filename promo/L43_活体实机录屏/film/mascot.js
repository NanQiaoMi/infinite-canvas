/* ============================================================
 * mascot.js — 小方（Xiao Fang）v7 · 定稿
 * A 的身体（宽扁圆角块）+ C 的豆豆眼（1×1 点眼、无嘴、无高光）。
 * 12×12 网格；u = 8（window 设计坐标）。身体 10 宽 × 6 高。
 * ============================================================ */
(function () {
  const FILM = (window.FILM = window.FILM || {});

  const C = { O: "#E8703A", K: "#241F1B" };

  const SPRITE_ROWS = 11; // 实际占用行数（脚底对齐第 11 行下沿）
  const BODY_TOP = 4;
  const BODY_BOTTOM = 9;
  const EYE_ROW = 6;
  const BODY_WIDTHS = [8, 10, 10, 10, 10, 8];

  function blank() {
    const g = [];
    for (let y = 0; y < 12; y++) g.push(new Array(12).fill("."));
    return g;
  }

  /** A 的身体：宽扁、两级圆角 */
  function body(g, top, bottom, widths) {
    const topRow = top == null ? BODY_TOP : top;
    const bottomRow = bottom == null ? BODY_BOTTOM : bottom;
    const ws = widths || BODY_WIDTHS;
    const rows = bottomRow - topRow + 1;
    for (let i = 0; i < rows; i++) {
      const w = ws[i] || ws[ws.length - 1];
      const x0 = Math.round(5.5 - w / 2);
      for (let x = x0; x < x0 + w; x++) {
        if (x >= 0 && x < 12) g[topRow + i][x] = "O";
      }
    }
  }

  /** C 的豆豆眼：1×1；默认离得近一点（cols 4 / 7） */
  function eyes(g, dx, dy, kind) {
    const put = (x, y) => {
      if (x >= 0 && x < 12 && y >= 0 && y < 12) g[y][x] = "K";
    };
    dx = dx || 0;
    dy = dy || 0;
    const y0 = EYE_ROW + dy;
    if (kind === "blink") {
      put(4 + dx, y0 + 1);
      put(7 + dx, y0 + 1);
      return;
    }
    if (kind === "happy") {
      put(4 + dx, y0 - 1);
      put(7 + dx, y0 - 1);
      return;
    }
    if (kind === "wide") {
      [4, 5].forEach((x) => { put(x + dx, y0); put(x + dx, y0 + 1); });
      [6, 7].forEach((x) => { put(x + dx, y0); put(x + dx, y0 + 1); });
      return;
    }
    put(4 + dx, y0);
    put(7 + dx, y0);
  }

  function legs(g, kind) {
    for (let x = 0; x < 12; x++) g[10][x] = ".";
    if (kind === "tuck") {
      g[BODY_BOTTOM][3] = "O";
      g[BODY_BOTTOM][8] = "O";
      return;
    }
    if (kind === "a") {
      g[10][2] = "O"; g[10][3] = "O"; g[10][8] = "O"; g[10][9] = "O";
      return;
    }
    if (kind === "b") {
      g[10][3] = "O"; g[10][4] = "O"; g[10][7] = "O"; g[10][8] = "O";
      return;
    }
    g[10][2] = "O"; g[10][3] = "O"; g[10][8] = "O"; g[10][9] = "O";
  }

  /** 挥手：右侧伸出一只小手臂 */
  function armUp(g, high) {
    const top = high ? 4 : 5;
    g[top][11] = "O";
    g[top + 1][11] = "O";
  }

  const BUILDERS = {
    idle: (g) => { body(g); eyes(g, 0, 0); legs(g); },
    blink: (g) => { body(g); eyes(g, 0, 0, "blink"); legs(g); },
    "look-right": (g) => { body(g); eyes(g, 1, 0); legs(g); },
    "look-left": (g) => { body(g); eyes(g, -1, 0); legs(g); },
    "look-up": (g) => { body(g); eyes(g, 0, -1); legs(g); },
    "look-down": (g) => { body(g); eyes(g, 0, 1); legs(g); },
    wide: (g) => { body(g); eyes(g, 0, 0, "wide"); legs(g); },
    happy: (g) => { body(g); eyes(g, 0, 0, "happy"); legs(g); },
    "blink-happy": (g) => { body(g); eyes(g, 0, 0, "happy"); legs(g); },
    "walk-a": (g) => { body(g); eyes(g, 1, 0); legs(g, "a"); },
    "walk-b": (g) => { body(g); eyes(g, 1, 0); legs(g, "b"); },
    crouch: (g) => { body(g); eyes(g, 0, 1); legs(g); },
    "jump-up": (g) => { body(g); eyes(g, 0, -1); legs(g, "tuck"); },
    "jump-fall": (g) => { body(g); eyes(g, 0, 1); legs(g, "tuck"); },
    land: (g) => { body(g); eyes(g, 0, 0, "blink"); legs(g); },
    wave: (g) => { body(g); eyes(g, 0, 0, "happy"); legs(g); armUp(g, true); },
    wave2: (g) => { body(g); eyes(g, 0, 0, "happy"); legs(g); armUp(g, false); },
    sit: (g) => { body(g, 5, 10, [8, 10, 10, 10, 10, 8]); eyes(g, 0, 0); },
    sleep: (g) => { body(g); eyes(g, 0, 0, "blink"); legs(g, "tuck"); },
  };

  const cache = {};
  function gridFor(pose) {
    if (!cache[pose]) {
      const g = blank();
      (BUILDERS[pose] || BUILDERS.idle)(g);
      cache[pose] = g;
    }
    return cache[pose];
  }

  /**
   * 画小方。spec: { x, y, u, pose, flip, sx, sy, alpha }
   * x/y 为「脚底中心」的 window 设计坐标。
   */
  function draw(ctx, spec, toStage) {
    const pose = BUILDERS[spec.pose] ? spec.pose : "idle";
    const g = gridFor(pose);
    const u = spec.u;
    const sx = spec.sx == null ? 1 : spec.sx;
    const sy = spec.sy == null ? 1 : spec.sy;
    const alpha = spec.alpha == null ? 1 : spec.alpha;
    if (alpha <= 0.01) return;
    const p = toStage(spec.x, spec.y);
    const w = 12 * u * sx;
    const h = 12 * u * sy;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(Math.round(p.x), Math.round(p.y));
    ctx.scale(spec.flip ? -1 : 1, 1);
    const x0 = -w / 2;
    const y0 = (-h * SPRITE_ROWS) / 12;
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        const ch = g[y][x];
        if (ch === ".") continue;
        const px = Math.round(x0 + (x * w) / 12);
        const py = Math.round(y0 + (y * h) / 12);
        const px2 = Math.round(x0 + ((x + 1) * w) / 12);
        const py2 = Math.round(y0 + ((y + 1) * h) / 12);
        ctx.fillStyle = C[ch] || C.O;
        ctx.fillRect(px, py, Math.max(1, px2 - px), Math.max(1, py2 - py));
      }
    }
    // 睡觉时头顶的 2 个 Z 像素
    if (spec.z != null && spec.z >= 0 && spec.z <= 1) {
      const px = Math.round(p.x + 26);
      const py = Math.round(p.y - 62 - spec.z * 22);
      ctx.globalAlpha = alpha * (1 - spec.z * 0.8);
      ctx.fillStyle = C.O;
      ctx.fillRect(px, py, 4, 2);
      ctx.fillRect(px + 2, py + 2, 4, 2);
      ctx.fillRect(px + 6, py + 6, 4, 2);
    }
    ctx.restore();
  }

  /** 出生像素块（与主体同色，无描边） */
  function drawBlock(ctx, block, toStage) {
    const p = toStage(block.x, block.y);
    const s = Math.max(2, Math.round(block.size * WIN_UNIT));
    ctx.save();
    ctx.globalAlpha = block.alpha == null ? 1 : block.alpha;
    ctx.fillStyle = C.O;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), s, s);
    ctx.restore();
  }
  let WIN_UNIT = 1.125;
  FILM.mascot = {
    draw,
    drawBlock,
    gridFor,
    C,
    setUnit: (v) => { WIN_UNIT = v; },
  };
})();
