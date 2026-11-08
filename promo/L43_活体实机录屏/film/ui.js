/* ============================================================
 * ui.js — 真实产品 UI 状态层（/chat 空态 + 第 1 幕会话流 / Artifact / 命令面板）
 * 只按时间轴改状态，不负责排版。
 * ============================================================ */
(function () {
  const FILM = (window.FILM = window.FILM || {});

  const $ = (sel) => document.querySelector(sel);
  const el = {
    sessions: $("#chatSessions"),
    welcome: $("#chatWelcome"),
    stream: $("#chatStream"),
    composerInput: $('[data-anchor="chat-composer-input"]'),
    composerText: $("#composerText"),
    composerPh: $(".composer-input .ph"),
    composerBox: $("#composerBox"),
    sendBtn: $('[data-anchor="chat-composer-send"]'),
    artifact: $("#artifactPanel"),
    palette: $("#palette"),
    pageChat: $("#page-chat"),
    pageCanvas: $("#page-canvas"),
    app: document.querySelector(".app"),
    cvStage: $("#cvStage"),
    cvWorld: $("#cvWorld"),
    cvNodes: $("#cvNodes"),
    cvLinks: $("#cvLinks"),
    cvNodeList: $("#cvNodeList"),
    cvNodeCount: $("#cvNodeCount"),
    cvToolbar: $("#cvToolbar"),
    cvAgentMsgs: $("#cvAgentMsgs"),
    cvAgentInputText: $("#cvAgentInputText"),
    cvAgentBox: $('[data-anchor="canvas-agent-input"]'),
    pageImage: $("#page-image"),
    pagePrompts: $("#page-prompts"),
    pageAdmin: $("#page-admin"),
    promptsGrid: $("#promptsGrid"),
    adBody: $("#adBody"),
    adTabs: $("#adTabs"),
    cvAppearance: $("#cvAppearance"),
    endCard: $("#endCard"),
    imGif: $("#imGif"),
    imFrames: $("#imFrames"),
    imFps: $("#imFps"),
    imRecords: $("#imRecords"),
    imCards: $("#imCards"),
    imGo: $('[data-anchor="image-generate-btn"]'),
    diagModal: $("#diagModal"),
    flash: $("#flash"),
    spinner: $("#spinner"),
    toast: $("#toast"),
    timelapse: $("#timelapseTag"),
  };
  let imageSig = "";
  let canvasSig = "";

  const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>';
  const IMG_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-4.5-4.5L7 20"/></svg>';
  const PENCIL_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 4 5 5-9 9H6v-5Z"/><path d="m13 6 5 5"/></svg>';

  const IMG = (name) => `assets/img/${name}`;
  const pad2 = (n) => String(n).padStart(2, "0");
  const resultSrc = (kind, idx) => {
    if (kind === "edit") return IMG(`chat-result-blue-0${(idx % 2) + 1}.jpg`);
    if (idx < 2) return IMG(`chat-result-autumn-0${idx + 1}.jpg`);
    return IMG(`poster-autumn-${pad2(idx + 1)}.jpg`);
  };

  let signature = "";
  let lastState = null;

  function setComposer(text, opts) {
    text = text || "";
    if (el.composerText) el.composerText.textContent = text;
    if (el.composerPh) el.composerPh.style.display = text ? "none" : "";
    if (el.composerBox) el.composerBox.classList.toggle("focus", !!(opts && opts.focus));
    if (el.sendBtn) el.sendBtn.classList.toggle("disabled", !text);
  }

  function sessionHtml(list) {
    if (!list || !list.length) return '<div class="sb-empty" data-anchor="chat-sidebar-empty">暂无对话</div>';
    return list
      .map(
        (s, i) =>
          `<div class="sb-session${s.active ? " active" : ""}" data-anchor="chat-session-${i + 1}">${s.running ? '<span class="dot"></span>' : ""}<span class="title">${s.title}</span></div>`,
      )
      .join("");
  }

  function stepsHtml(steps) {
    if (!steps) return "";
    const items = steps.items
      .map((it) => `<div class="item"><span class="dot ${it.state}"></span><span>${it.label}</span>${it.state === "run" ? '<span class="tag">进行中</span>' : ""}</div>`)
      .join("");
    return `<div class="msg assistant"><div class="avatar">${SPARK}</div><div class="card steps-card" data-anchor="chat-steps"><div class="hd"><span>执行步骤</span><span>${steps.items.filter((i) => i.state === "done").length}/${steps.items.length}</span></div>${items}</div></div>`;
  }

  function toolHtml(tool) {
    if (!tool) return "";
    const ico = tool.kind === "edit" ? PENCIL_ICO : IMG_ICO;
    const anchor = tool.kind === "edit" ? "chat-tool-edit" : "chat-tool-generate";
    return `<div class="msg assistant"><div class="avatar">${SPARK}</div><div class="card tool-card" data-anchor="${anchor}"><div class="row"><span class="ico">${ico}</span><span class="name">${tool.name}</span><span class="pill">${tool.status === "success" ? "成功" : "执行中"}</span></div>${tool.meta ? `<div class="meta">${tool.meta}</div>` : ""}</div></div>`;
  }

  function waitingHtml(w) {
    if (!w) return "";
    const dots = Array.from({ length: 12 }, (_, i) => `<i class="${i < Math.round((w.pct / 100) * 12) ? "on" : ""}"></i>`).join("");
    return `<div class="msg assistant"><div class="avatar">${SPARK}</div><div class="wait-card" data-anchor="chat-waiting-card"><div class="top"><span>${w.phase}</span><span class="pct">${w.pct}%</span></div><div class="dots">${dots}</div></div></div>`;
  }

  function resultCard(kind, idx, anchor) {
    return `<div class="result-card" data-anchor="${anchor}"><div class="poster has-img"><img src="${resultSrc(kind, idx)}" alt=""><span class="meta">1536×864</span><div class="bar"><span>下载</span><span>加入我的资产</span><span>填入工作台</span></div></div></div>`;
  }

  function resultsHtml(kind, count, offset) {
    if (!count) return "";
    const tone = kind === "edit" ? "blue" : "autumn";
    const cards = Array.from({ length: count }, (_, i) => resultCard(kind, i, `chat-result-card${i === 0 ? "" : "-" + (i + 1)}`)).join("");
    return `<div class="results"${count === 4 ? ' style="grid-template-columns:1fr 1fr"' : ""} data-anchor="chat-results">${cards}</div>`;
  }

  function failCardHtml(f) {
    if (!f) return "";
    return `<div class="msg assistant"><div class="avatar">${SPARK}</div><div class="card tool-card" data-anchor="chat-fail-card"><div class="row"><span class="ico">${IMG_ICO}</span><span class="name">生成失败</span><span class="pill">失败</span></div><div class="meta">网络异常，等待重试（1/2）</div><div class="retry" data-anchor="chat-retry-btn">重试</div></div></div>`;
  }

  function threadHtml(t) {
    let html = "";
    if (t.user) html += `<div class="msg user"><div class="bubble" data-anchor="chat-msg-user-1">${t.user}</div></div>`;
    html += stepsHtml(t.steps);
    html += toolHtml(t.tool);
    html += waitingHtml(t.waiting);
    if (t.results) html += resultsHtml(t.results.kind, t.results.count, t.results.offset || 0);
    if (t.assistant) html += `<div class="msg assistant"><div class="avatar">${SPARK}</div><div class="text" data-anchor="chat-assistant">${t.assistant}</div></div>`;
    if (t.editUser) html += `<div class="msg user"><div class="bubble" data-anchor="chat-msg-user-2">${t.editUser}</div></div>`;
    html += stepsHtml(t.editSteps);
    html += toolHtml(t.editTool);
    if (t.editResults) html += resultsHtml("edit", t.editResults, 10);
    html += failCardHtml(t.failCard);
    if (t.editAssistant) html += `<div class="msg assistant"><div class="avatar">${SPARK}</div><div class="text">${t.editAssistant}</div></div>`;
    return html;
  }

  function artifactHtml(a) {
    if (!a) return "";
    const p = a.progress == null ? 1 : a.progress;
    return `
      <div class="art-hd" data-anchor="chat-artifact-title"><span class="t">生成结果</span><span class="x">×</span></div>
      <div class="art-img"><div class="poster has-img"><img src="${IMG("artifact-poster.jpg")}" alt=""></div></div>
      <div class="meta-row">
        <div class="meta-cell"><div class="k">模型</div><div class="v">gpt-image-2.6</div></div>
        <div class="meta-cell"><div class="k">尺寸</div><div class="v">1536×864</div></div>
        <div class="meta-cell"><div class="k">比例</div><div class="v">1.78</div></div>
      </div>
      <div class="fld"><div class="k">提示词</div><div class="box">秋天咖啡馆海报，手绘质感，暖色调，木质招牌，杯口热气</div></div>
      <div class="fld"><div class="k">继续修改</div>
        <div class="cont"><div class="input" data-anchor="chat-artifact-continue">${a.typed ? a.typed : "描述想改的地方，回车回到对话…"}</div><span class="btn" data-anchor="chat-artifact-continue-btn">在对话中继续</span></div>
      </div>
      <div class="acts"><span>填入生图工作台</span><span>下载</span><span>加入我的资产</span></div>`;
  }

  function paletteHtml(p) {
    const items = [
      { code: "/prompt", label: "写提示词" },
      { code: "/image", label: "生成图片" },
      { code: "/edit", label: "修改图片" },
      { code: "/model", label: "切换模型" },
      { code: "/new", label: "新建对话" },
      { code: "/help", label: "帮助" },
    ];
    const rows = items
      .map(
        (it, i) => `<div class="item${i === p.selected ? " on" : ""}" data-anchor="chat-palette-item-${it.code.slice(1)}"><span class="code">${it.code}</span><span>${it.label}</span></div>`,
      )
      .join("");
    return `<div class="search"><span>⌘K</span><span>搜索命令或对话…</span></div><div class="group">命令</div>${rows}<div class="group">最近对话</div><div class="item"><span class="code">·</span><span>秋天咖啡馆海报</span></div><div class="group">操作</div><div class="item"><span class="code">·</span><span>新建对话</span></div><div class="foot"><span>↑↓ 选择</span><span>↵ 确认</span><span>esc 关闭</span></div>`;
  }

  const TOOL_ICONS = {
    select: '<path d="M5 3l14 8-6 1.5L10 20z"/>',
    pan: '<path d="M4 12h16M12 4v16M7 8l-3 4 3 4M17 8l3 4-3 4"/>',
    focus: '<circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    text: '<path d="M5 6h14M12 6v13"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-4.5-4.5L7 20"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3"/>',
    audio: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
    config: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    group: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/><path d="M11 7h2v6"/>',
    plugin: '<path d="M9 7V4M15 7V4"/><rect x="5" y="7" width="14" height="10" rx="3"/><path d="M9 17v3M15 17v3"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3h16v-3"/>',
    theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none"/>',
    clear: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  };
  function toolbarHtml(c) {
    const items = [
      ["select", "选择"], ["pan", "移动"], ["focus", "居中聚焦"], ["text", "文本"],
      ["image", "图片"], ["video", "视频"], ["audio", "音频"], ["config", "生成配置"],
      ["group", "组"], ["plugin", "扩展节点"], ["upload", "上传资产"], ["theme", "画布外观"], ["clear", "清空画布"],
    ];
    return items.map(([k, label]) => {
      const anchor = k === "focus" ? ' data-anchor="canvas-toolbar-focus"' : k === "theme" ? ' data-anchor="canvas-toolbar-appearance"' : "";
      const pressed = k === "focus" && c.focusPressed ? " on" : "";
      return `<span class="cv-tool${pressed}"${anchor}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${TOOL_ICONS[k]}</svg>${label}</span>`;
    }).join("") + `<span class="cv-tool primary"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>导出</span>`;
  }
  function nodesHtml(nodes) {
    return (nodes || []).map((n) => {
      const x = n.col * 388, y = n.row * 288;
      const idStr = String(n.id).padStart(2, "0");
      const ring = n.state === "done" ? "" : `<div class="ring" style="--p:${n.pct || 0}"><span>${n.state === "skeleton" ? "" : (n.pct || 0) + "%"}</span></div>`;
      const thumb = n.state === "done" ? `<div class="thumb has-img"><img src="${IMG(`poster-autumn-${pad2((n.id - 1) % 12 + 1)}.jpg`)}" alt=""></div>` : `<div class="thumb"></div>`;
      return `<div class="cv-node ${n.state === "done" ? "tone-" + (n.tone % 4) : "skeleton"}" data-anchor="canvas-node-${idStr}" style="left:${x}px;top:${y}px">${thumb}${ring}<div class="name"><span>${n.name}</span><span class="badge">${n.state === "done" ? "1536×864" : "生成中"}</span></div></div>`;
    }).join("");
  }
  function linksHtml(nodes, links) {
    if (!links || !links.length) return "";
    const pos = (id) => { const n = (nodes || []).find((x) => x.id === id); return n ? { x: n.col * 388 + 170, y: n.row * 288 + 120 } : null; };
    return links.map(([a, b]) => { const p = pos(a), q = pos(b); if (!p || !q) return ""; return `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"/>`; }).join("");
  }
  function agentHtml(ag) {
    if (!ag) return "";
    let html = "";
    (ag.history || []).forEach((m) => { html += `<div class="msg ${m.role}"><div class="b">${m.text}</div></div>`; });
    if (ag.userMsg) html += `<div class="msg user"><div class="b" data-anchor="canvas-agent-msg-user-1">${ag.userMsg}</div></div>`;
    if (ag.steps) html += `<div class="msg assistant"><div class="b">${ag.steps.items.map((it) => `<div class="step"><span class="d ${it.state}"></span><span>${it.label}</span></div>`).join("")}</div></div>`;
    if (ag.tool) html += `<div class="msg assistant"><div class="b"><div class="tool"><div class="row"><span>生成图片</span><span class="pill">${ag.tool.status === "success" ? "成功" : "执行中"}</span></div>${ag.tool.meta ? `<div class="meta">${ag.tool.meta}</div>` : ""}</div></div></div>`;
    return html;
  }
  function renderImage(state) {
    const im = state.image;
    const sig = JSON.stringify(im);
    if (sig === imageSig) return;
    imageSig = sig;
    if (el.imRecords) el.imRecords.innerHTML = (im.records || []).map((r) => `<div class="im-rec"><span class="th"></span><span>${r.title}</span></div>`).join("");
    if (el.imGo) el.imGo.classList.toggle("press", !!im.pressed);
    if (el.imGif) el.imGif.classList.toggle("on", !!im.gifOn);
    if (el.imFrames) el.imFrames.textContent = String(im.frames || 9);
    if (el.imFps) el.imFps.textContent = String(im.fps || 5);
    const cnt = document.querySelector("#imCount"); if (cnt) cnt.textContent = String(im.count || 1);
    const q = document.querySelector("#imQuality"); if (q) q.textContent = im.quality || "高";
    const rc = document.querySelector("#imResultCount"); if (rc) rc.textContent = (im.count || 1) + " 张";
    if (el.imCards) {
      el.imCards.innerHTML = (im.cards || []).map((c) => {
        if (c.gif) return `<div class="im-card done" data-anchor="image-result-gif"><div class="gifwrap"><canvas class="gifcanvas" width="360" height="360"></canvas></div><span class="gifbadge">GIF</span></div>`;
        const id = c.id;
        const anchor = `image-pending-card-${id}`;
        if (c.state === "done") return `<div class="im-card done" data-anchor="${anchor}"><div class="thumb"><img src="${IMG(`image-result-0${id}.jpg`)}" alt=""></div></div>`;
        if (c.state === "drawing") return `<div class="im-card" data-anchor="${anchor}"><div class="body"><div class="ring" style="--p:${c.pct}"></div><div class="sub">正在绘制中...</div><div class="pct">${c.pct}%</div></div></div>`;
        return `<div class="im-card queued" data-anchor="${anchor}"><div class="body"><div>排队等待中</div><div class="sub">前方还有 ${c.ahead} 人</div><div class="sub">预计等待约 ${c.eta} 秒</div><div class="cancel">取消任务</div></div></div>`;
      }).join("");
      const gc = el.imCards.querySelector(".gifcanvas");
      if (gc) drawGifFrame(gc, im.gifFrame || 0);
    }
  }

  function drawGifFrame(canvas, frame) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height, k = W / 360;
    const phase = (frame % 9) / 9;
    const bob = Math.sin(phase * Math.PI * 2) * 8 * k;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#fbe8c9"); g.addColorStop(0.55, "#f2c183"); g.addColorStop(1, "#8f4a2b");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,247,232,.55)";
    ctx.beginPath(); ctx.arc(W * 0.72, H * 0.24, W * 0.2, 0, Math.PI * 2); ctx.fill();
    // 热气
    ctx.strokeStyle = "rgba(255,247,232,.75)"; ctx.lineWidth = 6 * k; ctx.lineCap = "round";
    for (let i = 0; i < 2; i++) {
      const x = W * (0.58 + i * 0.09), y0 = H * 0.46 + i * 6 * k;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.bezierCurveTo(x - 8 * k, y0 - 16 * k + Math.sin(phase * 6.28 + i) * 4 * k, x + 10 * k, y0 - 30 * k, x - 4 * k, y0 - 46 * k);
      ctx.stroke();
    }
    // 小方
    const bw = 130 * k, bh = 78 * k, bx = W * 0.34 - bw / 2, by = H * 0.62 + bob;
    ctx.fillStyle = "#e8703a";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 26 * k); else ctx.rect(bx, by, bw, bh);
    ctx.fill();
    ctx.fillStyle = "#241f1b";
    ctx.fillRect(bx + bw * 0.28, by + bh * 0.38, 12 * k, 12 * k);
    ctx.fillRect(bx + bw * 0.6, by + bh * 0.38, 12 * k, 12 * k);
    ctx.fillStyle = "#e8703a";
    ctx.fillRect(bx + bw * 0.2, by + bh, 22 * k, 14 * k);
    ctx.fillRect(bx + bw * 0.62, by + bh, 22 * k, 14 * k);
    // 咖啡杯
    ctx.fillStyle = "#f6ead6";
    ctx.fillRect(W * 0.58, H * 0.6, 84 * k, 58 * k);
    ctx.fillStyle = "#7a3f22";
    ctx.fillRect(W * 0.58 + 8 * k, H * 0.6 + 6 * k, 68 * k, 12 * k);
    // 飘叶
    ctx.fillStyle = "rgba(232,112,58,.85)";
    for (let i = 0; i < 3; i++) {
      const lx = W * (0.2 + i * 0.28) + Math.sin(phase * 6.28 + i * 2) * 10 * k;
      const ly = H * (0.2 + ((phase + i * 0.33) % 1) * 0.5);
      ctx.beginPath(); ctx.ellipse(lx, ly, 9 * k, 5 * k, phase * 6.28 + i, 0, Math.PI * 2); ctx.fill();
    }
  }

  function diagHtml(d, angle) {
    const stats = [["生成尝试", 8], ["成功", 6], ["失败", 2], ["模型错误", 1]];
    const bars = [0, 0, 25, 0, 0, 0, 0];
    const stat = `<div class="diag-stats">${stats.map(([k, v]) => `<div class="diag-stat"><div class="k2">${k}</div><div class="v">${v}</div></div>`).join("")}</div>`;
    const trend = `<div class="diag-trend" data-anchor="chat-diagnostics-trend"><div class="t"><span>最近 7 天生成失败率</span><span class="s">仅统计本浏览器记录</span></div><div class="diag-bars">${bars.map((v, i) => `<div class="diag-bar${v > 0 ? " hot" : ""}"><i style="height:${v === 0 ? 2 : Math.round(v * 2.6)}px"></i><b>${v}%</b></div>`).join("")}</div></div>`;
    return `<div class="diag-hd" data-anchor="chat-diagnostics-modal"><span>生成诊断</span><span class="x">×</span></div>${stat}${trend}<div class="diag-ft"><span class="btn" data-anchor="chat-diagnostics-copy">复制诊断报告</span></div>`;
  }

  function renderPrompts(state) {
    const pr = state.prompts || {};
    if (el.promptsGrid) {
      const tags = ["人像", "海报", "插画", "摄影", "建筑", "产品", "电影感", "国风"];
      const descs = ["柔光人像与胶片质感", "复古咖啡与秋天海报", "手绘扁平插画", "自然光与静物质感", "空间与光影构图", "干净产品棚拍", "宽银幕叙事光影", "东方留白与水墨"];
      el.promptsGrid.innerHTML = tags.map((tag, i) => `<div class="pr-card"><span class="tag">${tag}</span><div class="t">${tag} · 提示词集合</div><div class="d">${descs[i]}</div><div class="src">来源：提示词库 · 42 条中的 6 条</div></div>`).join("");
    }
  }

  function renderAdmin(state) {
    const ad = state.admin || {};
    if (el.adTabs) {
      [...el.adTabs.children].forEach((tab, i) => {
        const isQuota = tab.getAttribute("data-anchor") === "admin-tab-quota";
        tab.classList.toggle("on", isQuota ? ad.tab === "quota" : (ad.tab !== "quota" && i === 0));
      });
    }
    if (el.adBody) {
      if (ad.tab === "quota") {
        el.adBody.innerHTML = `<div class="ad-quota"><div class="fld" data-anchor="admin-quota-daily"><div class="k">每日额度</div><div class="v">100</div><div class="h">服务端模式默认值</div></div><div class="fld" data-anchor="admin-quota-weekly"><div class="k">每周额度</div><div class="v">700</div><div class="h">服务端模式默认值</div></div><div class="fld"><div class="k">每 IP 上限</div><div class="v">20</div><div class="h">演示值</div></div></div><div class="ad-hint">额度策略仅影响服务端模式；浏览器直连模式不受此限制。</div>`;
      } else {
        el.adBody.innerHTML = `<div class="ad-stats"><div class="ad-stat"><div class="k">渠道</div><div class="v">1</div></div><div class="ad-stat"><div class="k">访客总数</div><div class="v">128</div></div><div class="ad-stat"><div class="k">今日活跃</div><div class="v">24</div></div><div class="ad-stat"><div class="k">版本</div><div class="v">{{版本号}}</div></div><div class="ad-stat"><div class="k">运行时长</div><div class="v">6d 12h</div></div></div><div class="ad-hint">服务端模式 · 数据仅保存在本机数据库</div>`;
      }
    }
  }

  function renderCanvas(state) {
    const c = state.canvas;
    const sig = JSON.stringify(c);
    if (sig === canvasSig) return;
    canvasSig = sig;
    if (el.cvToolbar) el.cvToolbar.innerHTML = toolbarHtml(c);
    if (el.cvNodeList) {
      el.cvNodeList.innerHTML = (c.nodes || []).map((n) => `<div class="cv-node-item"><span class="thumb"><img src="${IMG(`poster-autumn-${pad2((n.id - 1) % 12 + 1)}.jpg`)}" alt=""></span><span>${n.name}</span></div>`).join("");
      if (!(c.nodes || []).length) el.cvNodeList.innerHTML = '<div style="padding:18px 8px;text-align:center;color:#a8a29e;font-size:11px">暂无节点</div>';
    }
    if (el.cvNodeCount) el.cvNodeCount.textContent = String((c.nodes || []).length);
    if (el.cvNodes) el.cvNodes.innerHTML = nodesHtml(c.nodes);
    if (el.cvLinks) el.cvLinks.innerHTML = linksHtml(c.nodes, c.links);
    if (el.cvAgentMsgs) el.cvAgentMsgs.innerHTML = agentHtml(c.agent);
    if (el.cvAgentInputText) el.cvAgentInputText.textContent = (c.agent && c.agent.input) || "";
    if (el.cvAgentBox) { const ph = el.cvAgentBox.querySelector(".ph"); if (ph) ph.style.display = c.agent && c.agent.input ? "none" : ""; }
    if (el.cvAgentBox) el.cvAgentBox.classList.toggle("focus", !!(c.agent && c.agent.focus));
    if (el.cvAppearance) {
      const ap = c.appearance;
      el.cvAppearance.classList.toggle("on", !!(ap && ap.open));
      if (ap && ap.open) el.cvAppearance.innerHTML = `<div class="t">画布外观</div><div class="g">主题模式</div><div class="item${ap.selected !== "dark" ? " on" : ""}" data-anchor="canvas-appearance-light">浅色</div><div class="item${ap.selected === "dark" ? " on" : ""}" data-anchor="canvas-appearance-dark">深色</div>`;
    }
    if (el.cvNodes) { const n12 = el.cvNodes.querySelector('[data-anchor="canvas-node-12"]'); if (n12) n12.classList.toggle("spot-node", !!c.spot); }
    // 产品视口（画布缩放/平移）
    if (el.cvStage && el.cvWorld) {
      const w = el.cvStage.offsetWidth || 666, h = el.cvStage.offsetHeight || 614;
      const v = c.viewport || { zoom: 0.45, cx: 752, cy: 408 };
      const panX = w / 2 - v.cx * v.zoom, panY = h / 2 - v.cy * v.zoom;
      el.cvWorld.style.transform = `translate(${panX}px, ${panY}px) scale(${v.zoom})`;
      FILM.ui.worldTransform = { panX, panY, zoom: v.zoom };
    }
  }

  function render(state) {
    if (!state) return;
    lastState = state;
    const page = state.page || "chat";
    if (el.pageChat) el.pageChat.hidden = page !== "chat";
    if (el.pageCanvas) el.pageCanvas.hidden = page !== "canvas";
    if (el.pageImage) el.pageImage.hidden = page !== "image";
    if (el.pagePrompts) el.pagePrompts.hidden = page !== "prompts";
    if (el.pageAdmin) el.pageAdmin.hidden = page !== "admin";
    if (el.app) el.app.classList.toggle("canvas-mode", page === "canvas");
    applyOverlays(state);
    if (page === "image") { renderImage(state); return; }
    if (page === "prompts") { renderPrompts(state); return; }
    if (page === "admin") { renderAdmin(state); return; }
    if (page === "canvas") { renderCanvas(state); return; }
    const sig = JSON.stringify(state);
    if (sig === signature) return;
    signature = sig;

    if (el.sessions) el.sessions.innerHTML = sessionHtml(state.sessions);
    const showWelcome = !!state.welcome;
    const inner = document.querySelector(".chat-inner");
    if (inner) inner.classList.toggle("streaming", !showWelcome);
    if (el.welcome) el.welcome.style.display = showWelcome ? "" : "none";
    if (el.stream) {
      el.stream.classList.toggle("on", !showWelcome);
      if (!showWelcome) {
        el.stream.innerHTML = threadHtml(state.thread || {});
        const sc = document.querySelector(".chat-scroll");
        if (sc) sc.scrollTop = sc.scrollHeight;
      }
    }
    setComposer(state.composer.text, { focus: state.composer.focus });

    if (el.artifact) {
      el.artifact.innerHTML = state.artifact ? artifactHtml(state.artifact) : "";
      const p = state.artifact ? (state.artifact.progress == null ? 1 : state.artifact.progress) : 0;
      el.artifact.style.transform = `translateX(${(1 - p) * 100}%)`;
    }
    if (el.palette) {
      el.palette.classList.toggle("on", !!(state.palette && state.palette.open));
      if (state.palette && state.palette.open) el.palette.innerHTML = paletteHtml(state.palette);
    }
  }

  function applyOverlays(state) {
    const win = document.querySelector("#window");
    const stage = document.querySelector("#stage");
    if (win) {
      win.classList.toggle("dark-mode", !!state.dark);
      win.classList.toggle("dim-out", !!state.dim);
      win.classList.toggle("spot", !!state.spot);
    }
    if (stage) stage.classList.toggle("dark-stage", !!state.stageDark);
    if (window.FILM && window.FILM.sound && window.FILM.sound.setLowpass) window.FILM.sound.setLowpass(state.dark ? 800 : 20000);
    if (el.endCard) {
      const ec = state.endCard;
      el.endCard.classList.toggle("on", !!ec);
      if (ec) el.endCard.innerHTML = `<svg class="logo" viewBox="0 0 64 64" fill="currentColor"><path d="M32 8L58 54H46L32 29L18 54H6L32 8Z"/><path d="M32 40L40 54H24L32 40Z"/></svg><div class="main">开源 · 免费 · MIT</div><div class="rule"></div><div class="repo">basketikun/infinite-canvas</div><div class="aux">{{版本号}} · 本次更新（开发中）</div>`;
    }
    const d = state.diagnostics;
    if (el.diagModal) {
      el.diagModal.classList.toggle("on", !!(d && d.open));
      if (d && d.open) el.diagModal.innerHTML = diagHtml(d);
    }
    if (el.flash) el.flash.style.opacity = String((state.flash && state.flash.opacity) || 0);
    if (el.spinner) {
      const sp = state.spinner;
      el.spinner.style.display = sp && sp.visible ? "block" : "none";
      el.spinner.style.transform = sp ? `rotate(${sp.angle || 0}deg)` : "";
    }
    if (el.timelapse) {
      el.timelapse.style.opacity = state.timelapse ? "1" : "0";
    }
    if (el.toast) {
      const tst = state.toast;
      el.toast.textContent = tst ? tst.text : "";
      el.toast.style.opacity = String(tst ? tst.opacity : 0);
    }
  }

  function reset() {
    signature = "";
    render({ welcome: true, sessions: [], thread: {}, composer: { text: "", focus: false }, artifact: null, palette: null });
  }

  FILM.ui = { render, reset, setComposer, el, state: () => lastState, worldTransform: null };
})();
