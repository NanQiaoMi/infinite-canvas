/* ============================================================
 * sound.js — WebAudio 合成（无任何外部音频文件）
 * 冷开场音色：房间底噪 / 钟琴 / 像素 tick / 8-bit 脚步 / boing /
 *            落地 / 挥手 / whoosh / 章节 chime
 * ============================================================ */
(function () {
  const FILM = (window.FILM = window.FILM || {});

  const Sound = {
    ctx: null,
    muted: false,
    roomNodes: null,
    master: null,

    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.lp = this.ctx.createBiquadFilter();
        this.lp.type = "lowpass";
        this.lp.frequency.value = 20000;
        this.master.connect(this.lp);
        this.lp.connect(this.ctx.destination);
      }
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      return this.ctx;
    },

    setLowpass(hz) {
      if (!this.ctx) return;
      if (!this.lp) {
        this.lp = this.ctx.createBiquadFilter();
        this.lp.type = "lowpass";
        this.lp.frequency.value = 20000;
        if (this.master) { this.master.disconnect(); this.master.connect(this.lp); this.lp.connect(this.ctx.destination); }
      }
      this.lp.frequency.setTargetAtTime(hz || 20000, this.ctx.currentTime, 0.15);
    },

    setMuted(m) {
      this.muted = !!m;
      if (this.master && this.ctx) {
        this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
      }
      if (this.muted) this.stopRoom();
    },

    noiseBuffer(seconds) {
      const ctx = this.ctx;
      const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let seed = 12345;
      for (let i = 0; i < len; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        d[i] = (seed / 4294967296) * 2 - 1;
      }
      return buf;
    },

    startRoom() {
      if (!this.ensure() || this.roomNodes || this.muted) return;
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer(2.0);
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 380;
      lp.Q.value = 0.4;
      const g = ctx.createGain();
      g.gain.value = 0.0;
      src.connect(lp).connect(g).connect(this.master);
      src.start();
      g.gain.setTargetAtTime(0.028, ctx.currentTime, 1.2);
      this.roomNodes = { src, g };
    },

    stopRoom() {
      if (!this.roomNodes || !this.ctx) return;
      const { src, g } = this.roomNodes;
      this.roomNodes = null;
      try {
        g.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.25);
        src.stop(this.ctx.currentTime + 0.9);
      } catch (e) {
        /* noop */
      }
    },

    /** 触发一个具名音效 */
    trigger(name, opts) {
      if (!this.ensure() || this.muted) return;
      const ctx = this.ctx;
      const now = ctx.currentTime + ((opts && opts.delay) || 0);
      const out = this.master;
      switch (name) {
        case "glock": {
          const f = (opts && opts.note) || 523.25;
          [1, 2.76, 5.4].forEach((mul, i) => {
            const o = ctx.createOscillator();
            o.type = "sine";
            o.frequency.value = f * mul;
            const g = ctx.createGain();
            const peak = 0.07 / (i + 1.4);
            g.gain.setValueAtTime(0, now);
            g.gain.linearRampToValueAtTime(peak, now + 0.008);
            g.gain.exponentialRampToValueAtTime(0.0001, now + 0.9 + i * 0.25);
            o.connect(g).connect(out);
            o.start(now);
            o.stop(now + 1.3);
          });
          break;
        }
        case "tick": {
          const o = ctx.createOscillator();
          o.type = "square";
          o.frequency.value = 170;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, now);
          g.gain.linearRampToValueAtTime(0.045, now + 0.004);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
          o.connect(g).connect(out);
          o.start(now);
          o.stop(now + 0.08);
          break;
        }
        case "step": {
          const o = ctx.createOscillator();
          o.type = "square";
          o.frequency.setValueAtTime(140, now);
          o.frequency.exponentialRampToValueAtTime(90, now + 0.06);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, now);
          g.gain.linearRampToValueAtTime(0.035, now + 0.005);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
          o.connect(g).connect(out);
          o.start(now);
          o.stop(now + 0.1);
          break;
        }
        case "boing": {
          const o = ctx.createOscillator();
          o.type = "sine";
          o.frequency.setValueAtTime(420, now);
          o.frequency.exponentialRampToValueAtTime(150, now + 0.28);
          const lfo = ctx.createOscillator();
          lfo.frequency.value = 18;
          const lfoGain = ctx.createGain();
          lfoGain.gain.value = 26;
          lfo.connect(lfoGain).connect(o.frequency);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, now);
          g.gain.linearRampToValueAtTime(0.05, now + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
          o.connect(g).connect(out);
          o.start(now);
          lfo.start(now);
          o.stop(now + 0.34);
          lfo.stop(now + 0.34);
          break;
        }
        case "land": {
          const o = ctx.createOscillator();
          o.type = "sine";
          o.frequency.setValueAtTime(120, now);
          o.frequency.exponentialRampToValueAtTime(62, now + 0.1);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, now);
          g.gain.linearRampToValueAtTime(0.06, now + 0.006);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
          o.connect(g).connect(out);
          o.start(now);
          o.stop(now + 0.16);
          const n = ctx.createBufferSource();
          n.buffer = this.noiseBuffer(0.08);
          const ng = ctx.createGain();
          ng.gain.setValueAtTime(0.02, now);
          ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
          n.connect(ng).connect(out);
          n.start(now);
          break;
        }
        case "blink": {
          const n = ctx.createBufferSource();
          n.buffer = this.noiseBuffer(0.06);
          const hp = ctx.createBiquadFilter();
          hp.type = "highpass";
          hp.frequency.value = 1800;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.006, now);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
          n.connect(hp).connect(g).connect(out);
          n.start(now);
          break;
        }
        case "crouch": {
          const n = ctx.createBufferSource();
          n.buffer = this.noiseBuffer(0.12);
          const lp = ctx.createBiquadFilter();
          lp.type = "lowpass";
          lp.frequency.setValueAtTime(900, now);
          lp.frequency.exponentialRampToValueAtTime(300, now + 0.12);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.012, now);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
          n.connect(lp).connect(g).connect(out);
          n.start(now);
          break;
        }
        case "wave": {
          const o = ctx.createOscillator();
          o.type = "square";
          o.frequency.setValueAtTime(660, now);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, now);
          g.gain.linearRampToValueAtTime(0.018, now + 0.008);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
          o.connect(g).connect(out);
          o.start(now);
          o.stop(now + 0.12);
          break;
        }
        case "whoosh": {
          const n = ctx.createBufferSource();
          n.buffer = this.noiseBuffer(0.6);
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.Q.value = 0.9;
          bp.frequency.setValueAtTime(220, now);
          bp.frequency.exponentialRampToValueAtTime(2200, now + 0.45);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, now);
          g.gain.linearRampToValueAtTime(0.035, now + 0.12);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
          n.connect(bp).connect(g).connect(out);
          n.start(now);
          break;
        }
        case "chime": {
          [523.25, 659.25, 783.99].forEach((f, i) => {
            const o = ctx.createOscillator();
            o.type = "sine";
            o.frequency.value = f;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0, now + i * 0.09);
            g.gain.linearRampToValueAtTime(0.028, now + i * 0.09 + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.8);
            o.connect(g).connect(out);
            o.start(now + i * 0.09);
            o.stop(now + i * 0.09 + 0.9);
          });
          break;
        }
        case "thock": {
          const n = ctx.createBufferSource();
          n.buffer = this.noiseBuffer(0.05);
          const lp = ctx.createBiquadFilter();
          lp.type = "lowpass";
          lp.frequency.value = 1600;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.05, now);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
          n.connect(lp).connect(g).connect(out);
          n.start(now);
          const o = ctx.createOscillator();
          o.type = "sine";
          o.frequency.value = 220;
          const g2 = ctx.createGain();
          g2.gain.setValueAtTime(0.03, now);
          g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
          o.connect(g2).connect(out);
          o.start(now);
          o.stop(now + 0.09);
          break;
        }
        case "click": {
          const n = ctx.createBufferSource();
          n.buffer = this.noiseBuffer(0.02);
          const hp = ctx.createBiquadFilter();
          hp.type = "highpass";
          hp.frequency.value = 2400;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.035, now);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
          n.connect(hp).connect(g).connect(out);
          n.start(now);
          break;
        }
        case "enter": {
          const o = ctx.createOscillator();
          o.type = "triangle";
          o.frequency.setValueAtTime(180, now);
          o.frequency.exponentialRampToValueAtTime(90, now + 0.08);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.05, now);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
          o.connect(g).connect(out);
          o.start(now);
          o.stop(now + 0.14);
          break;
        }
        case "pop": {
          const o = ctx.createOscillator();
          o.type = "sine";
          o.frequency.setValueAtTime(520, now);
          o.frequency.exponentialRampToValueAtTime(880, now + 0.06);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.028, now);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
          o.connect(g).connect(out);
          o.start(now);
          o.stop(now + 0.12);
          break;
        }
        case "whip": {
          const n = ctx.createBufferSource();
          n.buffer = this.noiseBuffer(0.35);
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass";
          bp.Q.value = 1.2;
          bp.frequency.setValueAtTime(400, now);
          bp.frequency.exponentialRampToValueAtTime(3200, now + 0.18);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, now);
          g.gain.linearRampToValueAtTime(0.04, now + 0.06);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
          n.connect(bp).connect(g).connect(out);
          n.start(now);
          break;
        }
        case "piano": {
          const f = (opts && opts.note) || 261.63;
          [1, 2, 3].forEach((mul, i) => {
            const o = ctx.createOscillator();
            o.type = i === 0 ? "triangle" : "sine";
            o.frequency.value = f * mul;
            const g = ctx.createGain();
            const peak = 0.05 / (i + 1);
            g.gain.setValueAtTime(0, now);
            g.gain.linearRampToValueAtTime(peak, now + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
            o.connect(g).connect(out);
            o.start(now);
            o.stop(now + 1.5);
          });
          break;
        }
        case "whomp": {
          const o = ctx.createOscillator();
          o.type = "sine";
          o.frequency.setValueAtTime(120, now);
          o.frequency.exponentialRampToValueAtTime(42, now + 0.5);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.09, now);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
          o.connect(g).connect(out);
          o.start(now); o.stop(now + 0.75);
          break;
        }
        case "paper": {
          const n = ctx.createBufferSource();
          n.buffer = this.noiseBuffer(0.5);
          const bp = ctx.createBiquadFilter();
          bp.type = "bandpass"; bp.Q.value = 0.8; bp.frequency.value = 1800;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, now);
          g.gain.linearRampToValueAtTime(0.03, now + 0.05);
          g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
          n.connect(bp).connect(g).connect(out);
          n.start(now);
          break;
        }
        case "bell": {
          [523.25, 1046.5].forEach((f, i) => {
            const o = ctx.createOscillator();
            o.type = "sine";
            o.frequency.value = f;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0, now);
            g.gain.linearRampToValueAtTime(0.03 / (i + 1), now + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
            o.connect(g).connect(out);
            o.start(now); o.stop(now + 1.7);
          });
          break;
        }
        default:
          break;
      }
    },

    /** 离线渲染整段（后续幕补齐）；此处先实现 0–8s */
    async renderAudio(seconds) {
      const ctx = this.ensure();
      if (!ctx) return null;
      const dur = seconds || 8;
      const off = new OfflineAudioContext(2, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
      // 复用同一套合成：临时把 ctx/master 指向离线上下文
      const mainCtx = this.ctx, mainMaster = this.master;
      this.ctx = off;
      this.master = off.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(off.destination);
      this.roomNodes = null;
      this.muted = false;
      this.startRoom();
      (FILM.shots ? FILM.shots.audioEvents : []).forEach((ev) => {
        if (ev.t >= dur) return;
        this.trigger(ev.name, { delay: ev.t, note: ev.note });
      });
      const buf = await off.startRendering();
      this.ctx = mainCtx;
      this.master = mainMaster;
      this.roomNodes = null;
      return buf;
    },
  };

  FILM.sound = Sound;
})();
