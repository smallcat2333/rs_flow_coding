// 使用说明视频的配乐：100 BPM 合成器背景乐（Am–F–C–G）加与画面事件对齐的音效，全部由代码合成，不依赖音频素材。
// 输出 44.1 kHz 立体声 16 位 WAV。render.mjs 导出视频时自动调用；也可单独运行：node music.mjs [输出.wav]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BAR, DURATION, MUSIC, SFX } from './timeline.mjs';

const SR = 44100;
const BEAT = BAR / 4;
const TAU = Math.PI * 2;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (t, a, b) => clamp((t - a) / (b - a));
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** RBJ 双二阶滤波器：lp 低通 / hp 高通 / bp 带通。 */
class Biquad {
  constructor(type, f, q = .707) { this.type = type; this.z1 = 0; this.z2 = 0; this.set(f, q); }
  set(f, q = this.q) {
    this.q = q;
    const w = TAU * clamp(f, 10, SR * .45) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (this.type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (this.type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else { b0 = al; b1 = 0; b2 = -al; }
    const a0 = 1 + al;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}
/** PolyBLEP 修正，消除锯齿波跳变处的混叠。 */
function blep(p, d) {
  if (p < d) { p /= d; return p + p - p * p - 1; }
  if (p > 1 - d) { p = (p - 1) / d; return p * p + p + p + 1; }
  return 0;
}
function saw(f, phase = 0) {
  let p = phase;
  const d = f / SR;
  return () => { p += d; if (p >= 1) p -= 1; return 2 * p - 1 - blep(p, d); };
}

/** 和弦进行 Am–F–C–G：pad 四音排列，tri 琶音三和弦，bass 低音根音。 */
const CHORDS = [
  { pad: [57, 60, 64, 69], tri: [57, 60, 64], bass: 45 },
  { pad: [53, 57, 60, 65], tri: [53, 57, 60], bass: 41 },
  { pad: [55, 60, 64, 67], tri: [55, 60, 64], bass: 48 },
  { pad: [55, 59, 62, 67], tri: [55, 59, 62], bass: 43 },
];
/** 主旋律：每小节若干 [八分音符位置, 音高, 时值(八分音符数)]，A、B 两句各四小节交替。 */
const LEAD = [
  [[0, 76, 2], [2, 72, 1], [3, 74, 1], [4, 76, 3], [7, 79, 1]],
  [[0, 81, 2], [2, 79, 1], [3, 77, 1], [4, 76, 4]],
  [[0, 79, 2], [2, 76, 1], [3, 72, 1], [4, 74, 1], [5, 76, 3]],
  [[0, 74, 3], [3, 71, 1], [4, 74, 2], [6, 67, 2]],
  [[0, 76, 2], [2, 72, 1], [3, 74, 1], [4, 76, 3], [7, 81, 1]],
  [[0, 84, 2], [2, 83, 1], [3, 81, 1], [4, 77, 4]],
  [[0, 79, 2], [2, 81, 1], [3, 79, 1], [4, 76, 2], [6, 74, 2]],
  [[0, 71, 2], [2, 74, 2], [4, 76, 4]],
];
const ARP = [0, 2, 4, 1, 3, 5, 2, 4, 0, 2, 4, 1, 3, 5, 4, 2];

export function buildMusic(file) {
  const N = Math.ceil(DURATION * SR);
  const L = new Float32Array(N), R = new Float32Array(N);    // 干声
  const RL = new Float32Array(N), RR = new Float32Array(N);  // 混响发送
  const DL = new Float32Array(N), DR = new Float32Array(N);  // 延迟发送
  const DUCK = new Float32Array(N).fill(1);                  // 侧链：底鼓处压低 pad、贝斯、琶音
  const BARS = Math.round(DURATION / BAR);
  const parts = Array.from({ length: BARS }, (_, b) => new Set(MUSIC.find((m) => b >= m.from && b < m.to)?.parts || []));
  const has = (b, p) => b >= 0 && b < BARS && parts[b].has(p);
  const rnd = rng(17);
  const wn = () => rnd() * 2 - 1;

  /** 把 fn(dt, k) 生成的单声道信号按声像写入总线；pan 可为 -1..1 的常数或随时间变化的函数。 */
  function put(t0, len, fn, { pan = 0, gain = 1, rev = 0, dly = 0, duck = false } = {}) {
    const i0 = Math.round(t0 * SR), n = Math.round(len * SR), pf = typeof pan === 'function' ? pan : null;
    let a = ((pf ? pf(0) : pan) + 1) * Math.PI / 4, gl = Math.cos(a), gr = Math.sin(a);
    for (let k = 0; k < n; k++) {
      const i = i0 + k;
      if (i < 0) continue;
      if (i >= N) break;
      const dt = k / SR;
      if (pf && (k & 63) === 0) { a = (pf(dt) + 1) * Math.PI / 4; gl = Math.cos(a); gr = Math.sin(a); }
      let v = fn(dt, k) * gain;
      if (duck) v *= DUCK[i];
      const l = v * gl, r = v * gr;
      L[i] += l; R[i] += r;
      if (rev) { RL[i] += l * rev; RR[i] += r * rev; }
      if (dly) { DL[i] += l * dly; DR[i] += r * dly; }
    }
  }
  /** 噪声经可变带通：f(p) 给出中心频率（p 为 0..1 进度）。 */
  function noiseSweep(len, f, q, env) {
    const bp = new Biquad('bp', f(0), q);
    return (dt, k) => {
      const p = dt / len;
      if ((k & 31) === 0) bp.set(f(p), q);
      return bp.run(wn()) * env(p);
    };
  }

  /* ---------- 鼓组 ---------- */
  for (let b = 0; b < BARS; b++) {
    // 底鼓重新进入的小节加一记镲片
    if (has(b, 'kick') && !has(b - 1, 'kick')) {
      const hp = new Biquad('hp', 5000, .7);
      put(b * BAR, 2.8, (dt) => hp.run(wn()) * Math.exp(-dt * 1.5), { gain: .09, rev: .35, pan: -.15 });
    }
    for (let q = 0; q < 4; q++) {
      const t = b * BAR + q * BEAT;
      if (has(b, 'kick')) {
        const i0 = Math.round(t * SR);
        for (let k = 0; k < .55 * SR && i0 + k < N; k++) {
          const dt = k / SR;
          DUCK[i0 + k] = Math.min(DUCK[i0 + k], 1 - .55 * Math.exp(-dt * 7) * Math.min(1, dt / .004));
        }
        let ph = 0;
        put(t, .5, (dt) => {
          ph += TAU * (44 + 120 * Math.exp(-dt * 30)) / SR;
          return Math.sin(ph) * Math.exp(-dt * 7) * Math.min(1, dt / .001) + wn() * Math.exp(-dt * 700) * .2;
        }, { gain: .48 });
      }
      if (has(b, 'clap') && (q === 1 || q === 3)) {
        const bp = new Biquad('bp', 1400, 1.1);
        put(t, .4, (dt) => bp.run(wn()) * (dt < .033 ? Math.exp(-(dt % .011) * 260) : Math.exp(-(dt - .033) * 13) * .8) * 2.4, { gain: .2, rev: .3, pan: .05 });
      }
      if (has(b, 'hat')) {
        for (let s = 0; s < 4; s++) {
          const hp = new Biquad('hp', 7500, .7), off = s === 2;
          put(t + s * BEAT / 4, .1, (dt) => hp.run(wn()) * Math.exp(-dt * (off ? 42 : 75)), { gain: off ? .12 : s === 0 ? .03 : .055, pan: .25, rev: .08 });
        }
      }
    }
  }

  /* ---------- Pad：每小节一个和弦，三把微失谐锯齿波左右展开，低通随段落开合 ---------- */
  const padCut = (t) => {
    const b = t / BAR;
    let c = 1300;
    if (b < 5) c = 260 + 1040 * seg(b, 0, 4.5);
    else if (b >= 44 && b < 51) c = 820;
    else if (b >= 28 && b < 44) c = 1750;
    else if (b >= 76) c = 1300 - 700 * seg(b, 77, 81);
    return c * (1 + .18 * Math.sin(t * .7));
  };
  for (let b = 0; b < BARS; b++) {
    const t0 = b * BAR, len = BAR + 1.2, i0 = Math.round(t0 * SR), n = Math.round(len * SR);
    for (const m of CHORDS[b % 4].pad) {
      const f = mtof(m);
      const o0 = saw(f * Math.pow(2, -9 / 1200), rnd()), o1 = saw(f, rnd()), o2 = saw(f * Math.pow(2, 9 / 1200), rnd());
      const fl = new Biquad('lp', 800, .8), fr = new Biquad('lp', 800, .8);
      for (let k = 0; k < n; k++) {
        const i = i0 + k;
        if (i >= N) break;
        const s = k / SR;
        if ((k & 63) === 0) { const c = padCut(t0 + s); fl.set(c); fr.set(c); }
        const env = Math.min(1, s / .5) * (s < BAR ? 1 : .5 + .5 * Math.cos(Math.PI * Math.min(1, (s - BAR) / 1.2)));
        const v = env * .04 * DUCK[i];
        const s1 = o1() * .45;
        const l = fl.run(o0() * .8 + s1) * v, r = fr.run(o2() * .8 + s1) * v;
        L[i] += l; R[i] += r; RL[i] += l * .6; RR[i] += r * .6;
      }
    }
  }

  /* ---------- 琶音：十六分音符拨弦，左右交替，送乒乓延迟 ---------- */
  for (let b = 0; b < BARS; b++) {
    if (!has(b, 'arp')) continue;
    const tri = CHORDS[b % 4].tri.map((m) => m + 12), tones = [...tri, ...tri.map((m) => m + 12)];
    const fade = b < 10 ? .35 + .65 * seg(b, 5, 9) : 1;
    for (let s = 0; s < 16; s++) {
      const f = mtof(tones[ARP[s]]), osc = saw(f), lp = new Biquad('lp', 3000, .9);
      let ph = 0;
      put(b * BAR + s * BEAT / 4, .34, (dt, k) => {
        if ((k & 31) === 0) lp.set(700 + 4200 * Math.exp(-dt * 18));
        ph += TAU * f / SR;
        return (lp.run(osc()) * .8 + Math.sin(ph) * .4) * Math.min(1, dt / .002) * Math.exp(-dt * 11);
      }, { gain: .065 * (s % 4 === 0 ? 1 : .72) * fade, pan: s % 2 ? .35 : -.35, rev: .3, dly: .4, duck: true });
    }
  }

  /* ---------- 贝斯：八分音符根音 + 低八度正弦 ---------- */
  for (let b = 0; b < BARS; b++) {
    if (!has(b, 'bass')) continue;
    const root = CHORDS[b % 4].bass;
    for (let e = 0; e < 8; e++) {
      const m = root + (e === 6 ? 12 : 0), f = mtof(m), osc = saw(f), lp = new Biquad('lp', 600, 1.1);
      let ph = 0;
      put(b * BAR + e * BEAT / 2, .3, (dt, k) => {
        if ((k & 31) === 0) lp.set(240 + 1300 * Math.exp(-dt * 14));
        ph += TAU * f / 2 / SR;
        return (lp.run(osc()) * .75 + Math.sin(ph) * .55) * Math.min(1, dt / .004) * (dt < .24 ? 1 : Math.max(0, 1 - (dt - .24) / .05));
      }, { gain: .13, duck: true });
    }
  }

  /* ---------- 主旋律：协作循环段落 ---------- */
  const lead0 = parts.findIndex((p) => p.has('lead'));
  for (let b = 0; b < BARS; b++) {
    if (!has(b, 'lead')) continue;
    for (const [slot, m, n8] of LEAD[(b - lead0) % LEAD.length]) {
      const f0 = mtof(m), dur = n8 * BEAT / 2, lp = new Biquad('lp', 2600, .7);
      let p = 0, ph = 0;
      put(b * BAR + slot * BEAT / 2, dur + .2, (dt) => {
        const f = f0 * Math.pow(2, .2 * Math.sin(TAU * 5.5 * dt) * seg(dt, .18, .4) / 12), d = f / SR;
        p += d; if (p >= 1) p -= 1;
        ph += TAU * f / 2 / SR;
        const env = Math.min(1, dt / .015) * (dt < dur ? 1 - .25 * dt / dur : Math.max(0, .75 * (1 - (dt - dur) / .18)));
        return (lp.run(2 * p - 1 - blep(p, d)) * .7 + Math.sin(ph) * .35) * env;
      }, { gain: .055, rev: .38, dly: .24, pan: .08 });
    }
  }

  /* ---------- 音效 ---------- */
  const SYN = {
    riser({ t, len = 2, gain = 1 }) {
      let ph = 0;
      const sw = noiseSweep(len, (p) => 300 + 6000 * p * p, 3, (p) => Math.pow(p, 2.2));
      put(t, len, (dt, k) => {
        const p = dt / len;
        ph += TAU * (180 + 520 * p * p) / SR;
        return (sw(dt, k) * 1.6 + Math.sin(ph) * .12 * p * p) * (p < .985 ? 1 : (1 - p) / .015);
      }, { gain: .34 * gain, rev: .45, pan: (dt) => Math.sin(dt * 3) * .3 });
    },
    impact({ t, gain = 1 }) {
      let ph = 0;
      const lp = new Biquad('lp', 900, .8), hp = new Biquad('hp', 3000, .7);
      put(t, 2.6, (dt) => {
        ph += TAU * (36 + 80 * Math.exp(-dt * 9)) / SR;
        return Math.sin(ph) * Math.exp(-dt * 2.3) + lp.run(wn()) * Math.exp(-dt * 6) * .8 + hp.run(wn()) * Math.exp(-dt * 35) * .5;
      }, { gain: .75 * gain, rev: .6 });
    },
    whoosh({ t, gain = 1 }) {
      const len = .95;
      put(t, len, noiseSweep(len, (p) => 380 + 2600 * Math.sin(Math.PI * p), .9, (p) => Math.pow(Math.sin(Math.PI * p), 2) * 2.2), { gain: .3 * gain, rev: .3, pan: (dt) => -.6 + 1.2 * dt / len });
    },
    swish({ t, len = .5, gain = 1 }) {
      put(t, len, noiseSweep(len, (p) => 900 + 5200 * p, 1.4, (p) => p * p * (1 - seg(p, .9, 1)) * 2.4), { gain: .24 * gain, rev: .3, pan: (dt) => .5 - dt / len * .6 });
    },
    pop({ t, gain = 1 }) {
      let ph = 0;
      put(t, .16, (dt) => { ph += TAU * (420 + 640 * seg(dt, 0, .06)) / SR; return Math.sin(ph) * Math.exp(-dt * 28) * Math.min(1, dt / .002); }, { gain: .3 * gain, rev: .25 });
    },
    zap({ t, gain = 1, pan = 0 }) {
      let ph = 0;
      put(t, .4, (dt) => { ph += TAU * (180 + 2400 * Math.exp(-dt * 12)) / SR; return Math.sin(ph + Math.sin(ph * 2.01) * .8 * Math.exp(-dt * 8)) * Math.exp(-dt * 9); }, { gain: .17 * gain, rev: .3, pan: pan * .6 });
    },
    tick({ t, gain = 1, pitch = 1 }) {
      let ph = 0;
      const hp = new Biquad('hp', 5000, .7);
      put(t, .035, (dt) => { ph += TAU * 2600 * pitch / SR; return Math.sin(ph) * Math.exp(-dt * 180) + hp.run(wn()) * Math.exp(-dt * 420) * .35; }, { gain: .22 * gain, rev: .12, pan: .2 });
    },
    click({ t, gain = 1 }) {
      let ph = 0;
      const bp = new Biquad('bp', 3200, 1.2);
      put(t, .07, (dt) => { ph += TAU * 1500 / SR; return bp.run(wn()) * Math.exp(-dt * 300) * 2 + Math.sin(ph) * Math.exp(-dt * 90) * .5; }, { gain: .32 * gain, rev: .15 });
    },
    sweep({ t, gain = 1 }) {
      put(t, 1, noiseSweep(1, (p) => 1000 + 7000 * p, 2, (p) => Math.sin(Math.PI * p) * 1.6), { gain: .17 * gain, rev: .45, pan: (dt) => -.4 + .8 * dt });
    },
    chime({ t, note = 81, gain = 1 }) {
      const f = mtof(note), H = [[1, 1, 2.2], [2, .5, 3.6], [3.01, .22, 5], [4.07, .12, 7]];
      put(t, 2.4, (dt) => {
        let v = 0;
        for (const [r, a, d] of H) v += Math.sin(TAU * f * r * dt) * a * Math.exp(-dt * d);
        return v * Math.min(1, dt / .002);
      }, { gain: .14 * gain, rev: .55, dly: .25, pan: ((note % 7) - 3) * .08 });
    },
    drop({ t, gain = 1 }) {
      let ph = 0;
      const lp = new Biquad('lp', 400, .8);
      put(t, 1, (dt) => { ph += TAU * (48 + 260 * Math.exp(-dt * 6)) / SR; return Math.sin(ph) * Math.exp(-dt * 3.4) + lp.run(wn()) * Math.exp(-dt * 9) * .4; }, { gain: .5 * gain, rev: .35 });
    },
    shatter({ t, gain = 1 }) {
      const r = rng(Math.round(t * 100));
      const grains = Array.from({ length: 80 }, () => ({ s: Math.pow(r(), 2) * .7, f: 2400 + r() * 5200, d: 25 + r() * 40, a: .3 + r() * .7, side: r() < .5 }));
      for (const side of [false, true]) {
        const gs = grains.filter((g) => g.side === side), hp = new Biquad('hp', 4000, .7);
        put(t, 1.3, (dt) => {
          let v = 0;
          for (const g of gs) if (dt >= g.s) v += Math.sin(TAU * g.f * (dt - g.s)) * g.a * Math.exp(-(dt - g.s) * g.d);
          return v * .25 + hp.run(wn()) * Math.exp(-dt * 6) * .3;
        }, { gain: .3 * gain, rev: .5, pan: side ? .55 : -.55 });
      }
      SYN.drop({ t, gain: .45 * gain });
    },
    lock({ t, gain = 1 }) {
      const bp = new Biquad('bp', 2000, 1.5);
      put(t, .6, (dt) => {
        const c1 = bp.run(wn()) * Math.exp(-dt * 250) * 2 + Math.sin(TAU * 900 * dt) * Math.exp(-dt * 60) * .6;
        const d2 = dt - .07;
        const c2 = d2 > 0 ? Math.sin(TAU * 1300 * d2) * Math.exp(-d2 * 70) * .6 + (Math.sin(TAU * 2200 * d2) + Math.sin(TAU * 3300 * d2) * .6) * Math.exp(-d2 * 9) * .12 : 0;
        return c1 + c2;
      }, { gain: .38 * gain, rev: .3 });
    },
  };
  for (const e of SFX) SYN[e.type](e);

  /* ---------- 乒乓延迟（附点八分音符） ---------- */
  const D = Math.round(BEAT * .75 * SR), bl = new Float32Array(D), br = new Float32Array(D);
  let lpl = 0, lpr = 0;
  for (let i = 0, j = 0; i < N; i++) {
    const ol = bl[j], or = br[j];
    lpl += .35 * (ol - lpl); lpr += .35 * (or - lpr);
    bl[j] = (DL[i] + DR[i]) * .5 + lpr * .42;
    br[j] = lpl * .42;
    L[i] += ol * .8; R[i] += or * .8;
    RL[i] += ol * .2; RR[i] += or * .2;
    if (++j >= D) j = 0;
  }

  /* ---------- Freeverb 混响 ---------- */
  const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], APS = [556, 441, 341, 225];
  for (const [inp, out, sp] of [[RL, L, 0], [RR, R, 23]]) {
    const cb = COMBS.map((n) => ({ buf: new Float32Array(n + sp), i: 0, f: 0 }));
    const ab = APS.map((n) => ({ buf: new Float32Array(n + sp), i: 0 }));
    for (let s = 0; s < N; s++) {
      const x = inp[s] * .015;
      let y = 0;
      for (const c of cb) {
        const o = c.buf[c.i];
        c.f = o * .75 + c.f * .25;
        c.buf[c.i] = x + c.f * .86;
        if (++c.i >= c.buf.length) c.i = 0;
        y += o;
      }
      for (const a of ab) {
        const o = a.buf[a.i];
        a.buf[a.i] = y + o * .5;
        y = o - y;
        if (++a.i >= a.buf.length) a.i = 0;
      }
      out[s] += y * 2.2;
    }
  }

  /* ---------- 母带：去直流、首尾淡入淡出、按响度归一后软限幅 ---------- */
  const hpl = new Biquad('hp', 28, .707), hpr = new Biquad('hp', 28, .707);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, g = Math.min(1, t / .05) * clamp((DURATION - .2 - t) / 3.2);
    L[i] = hpl.run(L[i]) * g; R[i] = hpr.run(R[i]) * g;
    sum += L[i] * L[i] + R[i] * R[i];
  }
  // 目标约 -18 LUFS（应用内背景播放不宜太响），软限幅上限 0.85，避免真峰值过 0 dBFS
  const rms = Math.sqrt(sum / (2 * N)), gain = Math.pow(10, -19.5 / 20) / rms;
  let peak = 0, over = 0;
  const lim = (x) => {
    const a = Math.abs(x);
    peak = Math.max(peak, a);
    if (a <= .58) return x;
    over++;
    return Math.sign(x) * (.58 + .27 * Math.tanh((a - .58) / .27));
  };
  const buf = Buffer.alloc(44 + N * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
  const q = (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  for (let i = 0; i < N; i++) {
    buf.writeInt16LE(q(lim(L[i] * gain)), 44 + i * 4);
    buf.writeInt16LE(q(lim(R[i] * gain)), 46 + i * 4);
  }
  writeFileSync(file, buf);
  return { seconds: N / SR, peak: +peak.toFixed(3), limited: +(over / (2 * N) * 100).toFixed(3) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] || 'guide_music.wav');
  console.log(buildMusic(out), out);
}
