"use strict";
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const css = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();

// ---------------------------------------------------------------- canvas helper
function fit(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}
// Runs `draw` every frame only while the canvas is on screen.
function animate(canvas, draw) {
  let on = false, raf = 0, last = 0, g = fit(canvas);
  const loop = (t) => { if (!on) return; const dt = Math.min(0.05, (t - (last || t)) / 1000); last = t; draw(g, dt, t / 1000); raf = requestAnimationFrame(loop); };
  new IntersectionObserver(([e]) => { on = e.isIntersecting && !reduce; if (on) { last = 0; raf = requestAnimationFrame(loop); } else cancelAnimationFrame(raf); }).observe(canvas);
  addEventListener("resize", () => { g = fit(canvas); draw(g, 0, performance.now() / 1000); });
  draw(g, 0, 0);
}

// ---------------------------------------------------------------- soil column (shared by hero + transfer plot)
// Depth (m), Vs (m/s), unit weight (kN/m3), colour. Within (rigid-base) input at 30 m.
const LAYERS = [
  { h: 3, vs: 170, g: 18.5, c: "#e3b062", name: "Fill, sand" },
  { h: 6, vs: 110, g: 16.0, c: "#8a5530", name: "Soft clay" },
  { h: 8, vs: 200, g: 18.0, c: "#a7774a", name: "Silty clay" },
  { h: 7, vs: 270, g: 19.5, c: "#c99a5b", name: "Dense sand" },
  { h: 6, vs: 360, g: 20.0, c: "#7d6a55", name: "Gravel" },
];
const H = LAYERS.reduce((s, l) => s + l.h, 0);
const DZ = 0.5, N = Math.round(H / DZ), ZETA = 0.06;
const cellLayer = [];
{ let z = 0, k = 0; for (let i = 0; i < N; i++) { const zm = (i + 0.5) * DZ; while (zm > z + LAYERS[k].h) { z += LAYERS[k].h; k++; } cellLayer.push(k); } }

// ---------------------------------------------------------------- hero: live 1-D shear beam
(function hero() {
  const canvas = $("#sim");
  if (!canvas) return;
  const rho = cellLayer.map((k) => LAYERS[k].g / 9.81);              // t/m3
  const G = cellLayer.map((k, i) => rho[i] * LAYERS[k].vs ** 2);       // kPa
  const mass = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) { mass[i] += rho[i] * DZ / 2; mass[i + 1] += rho[i] * DZ / 2; }
  const u = new Float64Array(N + 1), v = new Float64Array(N + 1), a = new Float64Array(N + 1);
  // Rayleigh-type damping: mass-proportional on the velocity relative to the base gives ZETA at
  // the first mode (f1 ≈ Vs_avg / 4H), and a light stiffness term damps the highest mesh modes
  // while keeping the explicit step stable.
  const vsAvg = H / LAYERS.reduce((s, l) => s + l.h / l.vs, 0);
  const w1 = 2 * Math.PI * vsAvg / (4 * H), alpha = 2 * (ZETA - 0.006) * w1, eta = 1.2e-3; // ≈ ZETA at f1, 3.5–4.5 % at f2–f3
  const DT = 0.0004;
  // Random earthquake-like base motion: band-limited bursts with a smooth envelope.
  let ev = null, t = 0, tev = 0;
  function newEvent() {
    const comps = [];
    for (let k = 0; k < 48; k++) {
      const f = 0.8 * Math.pow(9 / 0.8, Math.random());
      comps.push({ w: 2 * Math.PI * f, p: Math.random() * 6.283, a: (0.5 + Math.random()) / f ** 1.3 });
    }
    const pga = 0.15 + Math.random() * 0.15;
    ev = { comps, dur: 9 + Math.random() * 3, scale: 1, pga };
    // normalise so the base acceleration peaks near pga
    let pk = 0; for (let s = 0; s < 3000; s++) pk = Math.max(pk, Math.abs(baseAcc(s * ev.dur / 3000, 1)));
    ev.scale = pga * 9.81 / pk;
  }
  // Smooth (C1) envelope: Saragoni–Hart shape with a smoothstep taper, so the numerically
  // differentiated acceleration has no spikes.
  const env = (s, d) => { if (s <= 0 || s >= d) return 0; const x = s / 3.5, q = Math.min(1, (d - s) / 2); return x * x * Math.exp(2 * (1 - x)) * q * q * (3 - 2 * q); };
  function baseDisp(s, sc = ev.scale) { let x = 0; for (const c of ev.comps) x -= c.a / (c.w * c.w) * Math.sin(c.w * s + c.p); return sc * env(s, ev.dur) * x; }
  function baseAcc(s, sc = ev.scale) { const e = 1e-3; return (baseDisp(s + e, sc) - 2 * baseDisp(s, sc) + baseDisp(s - e, sc)) / (e * e); }
  newEvent();

  const TR = 900; // trace samples kept
  const trBase = new Float32Array(TR), trSurf = new Float32Array(TR);
  let head = 0, peakB = 0, peakS = 0, shownB = 0, shownS = 0, gap = 0;
  const peakDisp = new Float64Array(N + 1);
  // grains for the soil texture
  const grains = [];
  for (let i = 0; i < 1400; i++) grains.push({ x: Math.random(), z: Math.random() * H, r: 0.6 + Math.random() * 1.6, s: Math.random() });

  function step() {
    // central difference, base node prescribed
    for (let i = 0; i < N; i++) {
      const gam = (u[i + 1] - u[i]) / DZ, gd = (v[i + 1] - v[i]) / DZ;
      const tau = G[i] * (gam + eta * gd);
      a[i] += tau / mass[i]; a[i + 1] -= tau / mass[i + 1];
    }
  }
  function advance(dt) {
    let n = Math.round(dt / DT);
    while (n-- > 0) {
      a.fill(0); step();
      for (let i = 0; i < N; i++) { a[i] -= alpha * (v[i] - v[N]); v[i] += a[i] * DT; u[i] += v[i] * DT; }
      t += DT; tev += DT;
      const ub = tev < ev.dur ? baseDisp(tev) : 0;
      v[N] = (ub - u[N]) / DT; u[N] = ub;
      if (Math.round(t / DT) % 12 === 0) {
        const ab = tev < ev.dur ? baseAcc(tev) : 0;
        const as = a[0];
        trBase[head] = ab / 9.81; trSurf[head] = as / 9.81; head = (head + 1) % TR;
        peakB = Math.max(peakB, Math.abs(ab / 9.81)); peakS = Math.max(peakS, Math.abs(as / 9.81));
        for (let i = 0; i <= N; i++) peakDisp[i] = Math.max(peakDisp[i] * 0.9995, Math.abs(u[i] - u[N]));
      }
      if (tev > ev.dur + 2.5) { shownB = peakB; shownS = peakS; peakB = peakS = 0; tev = 0; newEvent(); }
    }
  }

  animate(canvas, ({ ctx, w, h }, dt) => {
    if (dt > 0) advance(dt);
    ctx.clearRect(0, 0, w, h);
    const narrow = w < 520;
    const colW = narrow ? w * 0.62 : w * 0.44, x0 = narrow ? (w - w * 0.62) / 2 - 20 : 26, top = 70, bot = h - 44;
    const zpx = (bot - top) / H, scale = colW * 9; // exaggeration (px per m of displacement)
    const rel = (i) => (u[i] - u[N]);
    const lim = colW * 0.3, clamp = (x) => Math.max(-lim, Math.min(lim, x));
    const off = (z) => { const f = z / DZ, i = Math.min(N - 1, Math.floor(f)), r = f - i; return clamp((rel(i) * (1 - r) + rel(i + 1) * r) * scale); };
    const baseOff = clamp(u[N] * scale * 0.25);
    // bedrock
    ctx.fillStyle = "#3b4651"; ctx.fillRect(x0 - 10 + baseOff, bot, colW + 20, h - bot);
    ctx.fillStyle = "rgba(255,255,255,.05)"; for (let k = 0; k < 9; k++) ctx.fillRect(x0 + k * colW / 8 + baseOff, bot + 6 + (k % 2) * 8, 18, 3);
    // layers as deformed strips
    let z = 0;
    LAYERS.forEach((L) => {
      const z1 = z + L.h;
      ctx.beginPath();
      for (let zz = z; zz <= z1 + 1e-6; zz += 0.5) ctx.lineTo(x0 + off(zz) + baseOff, top + zz * zpx);
      for (let zz = z1; zz >= z - 1e-6; zz -= 0.5) ctx.lineTo(x0 + colW + off(zz) + baseOff, top + zz * zpx);
      ctx.closePath(); ctx.fillStyle = L.c; ctx.fill();
      z = z1;
    });
    // grains
    for (const g of grains) {
      const o = off(g.z) + baseOff;
      ctx.fillStyle = g.s > 0.5 ? "rgba(0,0,0,.16)" : "rgba(255,255,255,.12)";
      ctx.fillRect(x0 + g.x * colW + o, top + g.z * zpx, g.r, g.r);
    }
    // layer boundaries + labels
    z = 0; ctx.font = "11px Inter, sans-serif"; ctx.textBaseline = "middle";
    LAYERS.forEach((L) => {
      if (!narrow) { ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.fillText(`${L.name} · ${L.vs} m/s`, x0 + 8 + off(z + L.h / 2) + baseOff, top + (z + L.h / 2) * zpx); }
      z += L.h;
    });
    // peak displacement envelope
    ctx.strokeStyle = "rgba(111,176,255,.55)"; ctx.setLineDash([3, 4]); ctx.beginPath();
    for (let i = 0; i <= N; i++) ctx.lineTo(x0 + colW + 8 + peakDisp[i] * scale * 0.5, top + i * DZ * zpx);
    ctx.stroke(); ctx.setLineDash([]);
    // building on the surface, swaying with the ground
    const sx = x0 + colW * 0.5 + off(0) + baseOff, lean = (rel(0) - rel(2)) * scale * 0.9;
    ctx.save(); ctx.translate(sx, top); ctx.transform(1, 0, -lean / 46, 1, 0, 0);
    ctx.fillStyle = "#d9dee5"; ctx.fillRect(-20, -46, 40, 46);
    ctx.fillStyle = "#3b8bf5"; for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) ctx.fillRect(-13 + c * 16, -40 + r * 13, 10, 8);
    ctx.fillStyle = "#8f99a6"; ctx.fillRect(-23, -49, 46, 4);
    ctx.restore();
    // incoming wave pulse marker
    ctx.fillStyle = "#9aa4b0"; ctx.font = "11px Inter, sans-serif";
    ctx.fillText("bedrock", x0, bot + 22);

    // traces
    const tx = x0 + colW + (narrow ? 34 : 56), tw = w - tx - 14;
    if (!narrow && tw > 60) {
      const rows = [{ y: top + (bot - top) * 0.22, tr: trSurf, c: css("--blue2"), lab: "Surface", pk: Math.max(peakS, shownS) },
                    { y: top + (bot - top) * 0.72, tr: trBase, c: "#8f99a6", lab: "Bedrock input", pk: Math.max(peakB, shownB) }];
      const ref = Math.max(0.25, peakS, shownS * 0.8), amp = (bot - top) * 0.2 / ref;
      for (const r of rows) {
        ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.beginPath(); ctx.moveTo(tx, r.y); ctx.lineTo(tx + tw, r.y); ctx.stroke();
        ctx.strokeStyle = r.c; ctx.lineWidth = 1.4; ctx.beginPath();
        for (let k = 0; k < TR; k++) { const v = r.tr[(head + k) % TR]; ctx.lineTo(tx + tw * k / (TR - 1), r.y - Math.max(-ref, Math.min(ref, v)) * amp); }
        ctx.stroke(); ctx.lineWidth = 1;
        ctx.fillStyle = "#c7cfd8"; ctx.font = "600 12px Inter, sans-serif"; ctx.textBaseline = "alphabetic";
        ctx.fillText(narrow ? r.lab.split(" ")[0] : r.lab, tx, r.y - amp - 8);
        ctx.font = "12px JetBrains Mono, monospace"; ctx.fillStyle = r.c;
        if (narrow) ctx.fillText(`${r.pk.toFixed(2)} g`, tx, r.y + amp + 16);
        else { ctx.textAlign = "right"; ctx.fillText(`peak ${r.pk.toFixed(2)} g`, tx + tw, r.y - amp - 8); ctx.textAlign = "left"; }
      }
      const pb = Math.max(peakB, shownB), ps = Math.max(peakS, shownS);
      if (pb > 0.02) {
        ctx.fillStyle = "#e9edf2"; ctx.font = "700 22px Inter, sans-serif";
        ctx.fillText(`×${(ps / pb).toFixed(1)}`, tx, bot + 12);
        ctx.fillStyle = "#7a8490"; ctx.font = "12px Inter, sans-serif";
        ctx.fillText("peak acceleration ratio", tx + 56, bot + 8);
      }
    }
    ctx.textBaseline = "alphabetic";
    if (narrow) {
      const pb = Math.max(peakB, shownB), ps = Math.max(peakS, shownS);
      if (pb > 0.02) { ctx.fillStyle = "#e9edf2"; ctx.font = "700 18px Inter, sans-serif"; ctx.fillText(`×${(ps / pb).toFixed(1)}`, w - 62, 34);
        ctx.fillStyle = "#7a8490"; ctx.font = "11px Inter, sans-serif"; ctx.fillText("PGA ratio", w - 62, 50); }
    }
  });
})();

// ---------------------------------------------------------------- hysteresis loops (MKZ + Masing)
(function loops() {
  const canvas = $("#loop");
  if (!canvas) return;
  const gr = 0.05, s = 0.92; // reference strain (%) and curvature, Darendeli-like sand
  const bb = (g) => g / (1 + Math.pow(Math.abs(g) / gr, s)); // τ/Gmax (in % units)
  const branch = (g, gRev, tRev, dir) => tRev + dir * 2 * bb((dir * (g - gRev)) / 2);
  const AMPS = [0.01, 0.03, 0.1, 0.3, 1.0];
  const damping = (ga) => { // Masing damping from the loop area
    const n = 400; let area = 0;
    for (let k = 0; k < n; k++) { const g1 = -ga + 2 * ga * k / n, g2 = -ga + 2 * ga * (k + 1) / n;
      const up = (g) => branch(g, -ga, -bb(ga), 1), dn = (g) => branch(g, ga, bb(ga), -1);
      area += ((up(g1) + up(g2)) / 2 - (dn(g1) + dn(g2)) / 2) * (g2 - g1); }
    return area / (4 * Math.PI * 0.5 * ga * bb(ga)) * 100;
  };
  const D = AMPS.map(damping);
  let phase = 0, idx = 0, zoom = AMPS[0];
  const cols = ["#6fb0ff", "#22b07d", "#e3b062", "#f07a3a", "#e85d75"];
  animate(canvas, ({ ctx, w, h }, dt) => {
    phase += dt * 0.55;
    if (phase >= 1.25) { phase = 0; idx = (idx + 1) % AMPS.length; if (idx === 0) zoom = AMPS[0]; }
    const ga = AMPS[idx];
    zoom += (ga * 1.12 - zoom) * Math.min(1, dt * 2.5);
    const tz = bb(zoom) * 1.15;
    const pad = 38, cx = w / 2, cy = h / 2 - 6, sx = (w / 2 - pad) / zoom, sy = (h / 2 - pad) / tz;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.beginPath(); ctx.moveTo(pad - 10, cy); ctx.lineTo(w - pad + 10, cy); ctx.moveTo(cx, 18); ctx.lineTo(cx, h - 40); ctx.stroke();
    ctx.fillStyle = "#7a8490"; ctx.font = "11px Inter, sans-serif";
    ctx.fillText("shear strain γ", w - pad - 70, cy + 16); ctx.fillText("stress τ", cx + 6, 26);
    // backbone
    ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.setLineDash([4, 4]); ctx.beginPath();
    for (let k = -100; k <= 100; k++) { const g = zoom * k / 100; ctx.lineTo(cx + g * sx, cy - bb(g) * sy); }
    ctx.stroke(); ctx.setLineDash([]);
    // previous loops
    for (let j = 0; j <= idx; j++) {
      const A = AMPS[j], frac = j < idx ? 1 : Math.min(1, phase);
      ctx.strokeStyle = cols[j]; ctx.globalAlpha = j < idx ? 0.45 : 1; ctx.lineWidth = j < idx ? 1.2 : 2.2; ctx.beginPath();
      const n = 160, m = Math.floor(n * frac);
      for (let k = 0; k <= m; k++) {
        const q = k / n, g = A * Math.cos(Math.PI * 2 * q);
        const t = q < 0.5 ? branch(g, A, bb(A), -1) : branch(g, -A, -bb(A), 1);
        ctx.lineTo(cx + g * sx, cy - t * sy);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.lineWidth = 1;
    // read-out
    const gg = 1 / (1 + Math.pow(ga / gr, s));
    ctx.font = "600 13px Inter, sans-serif"; ctx.fillStyle = cols[idx];
    ctx.fillText(`γ = ${ga} %`, pad - 10, h - 16);
    ctx.fillStyle = "#c7cfd8"; ctx.font = "13px JetBrains Mono, monospace";
    ctx.fillText(`G/Gmax ${gg.toFixed(2)}   Masing D ${D[idx].toFixed(1)} %`, pad + 76, h - 16);
  });
})();

// ---------------------------------------------------------------- transfer function of the hero column (SHAKE recursion)
(function transfer() {
  const canvas = $("#spec");
  if (!canvas) return;
  const F = [], A = [];
  const NF = 500, fmax = 15;
  for (let k = 1; k <= NF; k++) {
    const f = fmax * k / NF, w = 2 * Math.PI * f;
    // complex helpers
    let Ar = 1, Ai = 0, Br = 1, Bi = 0;
    for (let m = 0; m < LAYERS.length; m++) {
      const L = LAYERS[m], rho = L.g / 9.81, D = ZETA;
      // complex Vs* = Vs (1 + iD) approximately
      const vr = L.vs, vi = L.vs * D;
      const kr = w * vr / (vr * vr + vi * vi), ki = -w * vi / (vr * vr + vi * vi); // k* = ω / Vs*
      const nx = m + 1 < LAYERS.length ? LAYERS[m + 1] : { g: 21, vs: 760 };
      const r2 = nx.g / 9.81, v2r = nx.vs, v2i = nx.vs * (m + 1 < LAYERS.length ? D : 0.01);
      // α* = ρm Vs*m / (ρm+1 Vs*m+1)
      const nr = rho * vr, ni = rho * vi, dr = r2 * v2r, di = r2 * v2i, dd = dr * dr + di * di;
      const ar = (nr * dr + ni * di) / dd, ai = (ni * dr - nr * di) / dd;
      // e^{i k h}
      const er = Math.exp(-ki * L.h) * Math.cos(kr * L.h), ei = Math.exp(-ki * L.h) * Math.sin(kr * L.h);
      const fr = Math.exp(ki * L.h) * Math.cos(-kr * L.h), fi = Math.exp(ki * L.h) * Math.sin(-kr * L.h);
      const mul = (a, b, c, d) => [a * c - b * d, a * d + b * c];
      const [p1r, p1i] = mul(Ar, Ai, er, ei), [p2r, p2i] = mul(Br, Bi, fr, fi);
      const [q1r, q1i] = mul(p1r, p1i, 1 + ar, ai), [q2r, q2i] = mul(p2r, p2i, 1 - ar, -ai);
      const [s1r, s1i] = mul(p1r, p1i, 1 - ar, -ai), [s2r, s2i] = mul(p2r, p2i, 1 + ar, ai);
      Ar = (q1r + q2r) / 2; Ai = (q1i + q2i) / 2; Br = (s1r + s2r) / 2; Bi = (s1i + s2i) / 2;
    }
    // within (rigid base) motion: |2 / (A_N + B_N)|
    const sr = Ar + Br, si = Ai + Bi;
    F.push(f); A.push(2 / Math.hypot(sr, si));
  }
  const peaks = [];
  for (let k = 1; k < NF - 1; k++) if (A[k] > A[k - 1] && A[k] > A[k + 1] && A[k] > 1.5) peaks.push(k);
  let prog = 0, hold = 0;
  animate(canvas, ({ ctx, w, h }, dt) => {
    if (prog < 1) prog = Math.min(1, prog + dt * 0.35); else if ((hold += dt) > 4) { prog = 0; hold = 0; }
    const pad = 40, x = (f) => pad + (f / fmax) * (w - pad - 34), amax = Math.max(...A) * 1.12;
    const y = (a) => h - 34 - (a / amax) * (h - 64);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.fillStyle = "#7a8490"; ctx.font = "11px Inter, sans-serif";
    for (let a = 0; a <= amax; a += 2) { ctx.beginPath(); ctx.moveTo(pad, y(a)); ctx.lineTo(w - 14, y(a)); ctx.stroke(); ctx.fillText(a, pad - 16, y(a) + 4); }
    for (let f = 0; f <= fmax; f += 5) ctx.fillText(`${f} Hz`, x(f) - 12, h - 14);
    ctx.fillText("|surface / bedrock|", pad, 16);
    const m = Math.floor(NF * prog);
    const grad = ctx.createLinearGradient(0, y(amax), 0, y(0));
    grad.addColorStop(0, "rgba(59,139,245,.35)"); grad.addColorStop(1, "rgba(59,139,245,0)");
    ctx.beginPath(); ctx.moveTo(x(F[0]), y(0));
    for (let k = 0; k < m; k++) ctx.lineTo(x(F[k]), y(A[k]));
    if (m > 0) ctx.lineTo(x(F[m - 1]), y(0));
    ctx.fillStyle = grad; ctx.fill();
    ctx.strokeStyle = "#6fb0ff"; ctx.lineWidth = 2; ctx.beginPath();
    for (let k = 0; k < m; k++) ctx.lineTo(x(F[k]), y(A[k]));
    ctx.stroke(); ctx.lineWidth = 1;
    peaks.forEach((k, j) => {
      if (k >= m || j > 2) return;
      ctx.fillStyle = "#e9edf2"; ctx.beginPath(); ctx.arc(x(F[k]), y(A[k]), 3.5, 0, 7); ctx.fill();
      ctx.font = "12px JetBrains Mono, monospace"; ctx.fillText(`f${j + 1} ${F[k].toFixed(2)} Hz`, x(F[k]) + 7, y(A[k]) - 6);
    });
  });
})();

// ---------------------------------------------------------------- scroll reveal, counters, bars
const nav = $(".nav");
addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true });
const io = new IntersectionObserver((es) => es.forEach((e) => {
  if (!e.isIntersecting) return;
  e.target.classList.add("in"); io.unobserve(e.target);
  $$(".vbar i", e.target).forEach((b) => (b.style.width = Math.min(100, (parseFloat(b.dataset.w) / 5) * 100) + "%"));
}), { threshold: 0.15 });
$$(".reveal").forEach((el) => io.observe(el));
const cio = new IntersectionObserver((es) => es.forEach((e) => {
  if (!e.isIntersecting) return; cio.unobserve(e.target);
  const end = +e.target.dataset.count, t0 = performance.now();
  const tick = (t) => { const p = reduce ? 1 : Math.min(1, (t - t0) / 1400); e.target.textContent = Math.round(end * (1 - (1 - p) ** 3)); if (p < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}), { threshold: 0.6 });
$$("[data-count]").forEach((el) => cio.observe(el));

// ---------------------------------------------------------------- screenshot tabs
const shotAlt = { spectra: "response spectra", profiles: "peak profiles with depth", loops: "stress–strain loops", curves: "modulus-reduction and damping curves", motion: "the input motion" };
$$(".tab").forEach((b) => b.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.toggle("on", x === b));
  const img = $("#shot"); img.classList.add("fade");
  setTimeout(() => { img.src = `img/${b.dataset.shot}.jpg`; img.alt = `Motus window showing ${shotAlt[b.dataset.shot]}`; img.onload = () => img.classList.remove("fade"); }, 200);
}));

// ---------------------------------------------------------------- agent replay (illustrative; tool names are the real ones)
(function term() {
  const el = $("#term");
  if (!el) return;
  const S = [
    ["c", "$ "], ["u", "claude mcp add motus -- /Applications/Motus.app/Contents/MacOS/motus --mcp\n", 1],
    ["r", "Added stdio MCP server motus\n\n"],
    ["c", "> "], ["u", "Open the example site, run equivalent-linear and nonlinear analyses and compare the surface PGA.\n\n", 1],
    ["t", "● motus.get_project()\n"], ["c", "  5 layers, 34 m over rock · motion: stochastic M 6.5 at 20 km\n"],
    ["t", "● motus.run_analysis(method: \"eql\")\n"], ["c", "  surface PGA 0.17 g · converged\n"],
    ["t", "● motus.run_analysis(method: \"nonlinear\")\n"], ["c", "  surface PGA 0.12 g\n"],
    ["t", "● motus.show(page: \"results\", view: \"spectra\")\n\n"],
    ["", "The equivalent-linear surface PGA is 0.17 g and the nonlinear one 0.12 g. Each strong cycle in the nonlinear run mobilises its own strain and damping, so its response near the site period is lower. The spectra are on screen.\n"],
  ];
  let i = 0, j = 0, started = false;
  const out = [];
  function render(cursor) { el.innerHTML = out.map(([c, s]) => `<span class="${c}">${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`).join("") + (cursor ? '<span class="cursor"></span>' : ""); el.scrollTop = el.scrollHeight; }
  function tick() {
    if (i >= S.length) { render(true); setTimeout(() => { out.length = 0; i = j = 0; tick(); }, 6000); return; }
    const [c, s, typed] = S[i];
    if (!out[i]) out[i] = [c, ""];
    if (typed && !reduce) { out[i][1] = s.slice(0, ++j); render(true); if (j < s.length) return setTimeout(tick, 18 + Math.random() * 30); }
    else out[i][1] = s;
    i++; j = 0; render(true); setTimeout(tick, typed ? 500 : c === "t" ? 650 : 250);
  }
  new IntersectionObserver(([e], o) => { if (e.isIntersecting && !started) { started = true; o.disconnect(); tick(); } }, { threshold: 0.3 }).observe(el);
})();

// ---------------------------------------------------------------- copy buttons, toast
const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 3200); };
$$(".copy").forEach((b) => b.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500); }
  catch { toast("Copy failed. Select the text instead."); }
}));

// ---------------------------------------------------------------- downloads (downloads/config.js)
(function downloads() {
  const cfg = window.MOTUS_DOWNLOADS || { version: "0.1.0", files: {} };
  $$(".ver").forEach((e) => (e.textContent = cfg.version));
  const ua = navigator.userAgent;
  const mine = /Mac/.test(ua) ? "mac" : /Win/.test(ua) ? "win" : /Linux/.test(ua) ? "linux" : "";
  $$(".dcard").forEach((card) => {
    const os = card.dataset.os, f = cfg.files[os], btn = $("[data-dl]", card);
    if (os === mine) card.classList.add("mine");
    if (!f) { btn.textContent = "Coming soon"; btn.classList.add("off"); btn.removeAttribute("href"); return; }
    btn.href = f.url; btn.setAttribute("download", "");
    btn.textContent = `Download ${f.size ? "· " + f.size : ""}`.trim();
    if (f.meta) $("[data-meta]", card).textContent = f.meta;
    if (f.sha256) $("[data-hash]", card).textContent = "SHA-256 " + f.sha256;
    // same-origin files: check they exist before promising a download
    if (!/^https?:/.test(f.url) && location.protocol.startsWith("http")) {
      fetch(f.url, { method: "HEAD" }).then((r) => { if (!r.ok) throw 0; }).catch(() => {
        btn.addEventListener("click", (e) => { e.preventDefault(); toast("This build is not online yet. Please check back soon."); });
      });
    }
  });
})();
