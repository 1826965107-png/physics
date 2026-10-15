/* ============================================================================
 *  app.js — 拉莫尔进动 3D 演示渲染器
 *  纯 Canvas2D + 自写透视投影, 零外部依赖, 可离线运行
 *  物理由 physics.js 提供 (精确洛伦兹力 + 库仑力 RK4 积分)
 * ==========================================================================*/
(function (global) {
'use strict';

var PH = global.LarmorPhysics || (typeof require === 'function' ? require('./physics.js') : null);
var TAU = Math.PI * 2, DEG = Math.PI / 180;

/* ============================ 小工具 ============================ */
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function rgba(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')'; }
var V = {
  add: function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; },
  sub: function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; },
  mul: function (a, s) { return [a[0] * s, a[1] * s, a[2] * s]; },
  dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
  cross: function (a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  },
  len: function (a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); },
  unit: function (a) { var l = V.len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
};
/* 与某轴垂直的两个正交基 */
function basis(axis) {
  var a = V.unit(axis);
  var t = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  var u = V.unit(V.cross(a, t)), w = V.cross(a, u);
  return [a, u, w];
}

/* 调色板 ------------------------------------------------------------------ */
var COL = {
  sphere: [ 62, 104, 176],
  band:   [ 92, 146, 232],
  edge:   [150, 214, 255],
  field:  [ 96, 246, 196],
  axis:   [150, 255, 222],
  L:      [255, 190,  74],
  Lc:     [255, 150,  40],
  mu:     [255,  92, 162],
  muc:    [255,  60, 130],
  spin:   [176, 138, 255],
  orbit:  [168, 232, 255],
  trailA: [ 62, 150, 255],
  trailB: [226, 248, 255],
  elec:   [255, 255, 255],
  white:  [255, 255, 255]
};

/* ============================ 主程序 ============================ */
function createApp(canvas, doc, win) {
  var ctx = canvas.getContext('2d');
  var dpr = 1;

  /* ---------------- 相机 / 投影 ---------------- */
  var cam = { az: -1.02, el: 0.30, dist: 3.75, zoom: 1, auto: true, autoRate: 0.055 };
  var view = { w: 1280, h: 720, cx: 640, cy: 360, focal: 800, dist: 3.75,
               eye: [0, 0, 0], f: [0, 0, -1], r: [1, 0, 0], u: [0, 1, 0] };

  function buildView(w, h) {
    var ce = Math.cos(cam.el), se = Math.sin(cam.el);
    var eye = [cam.dist * ce * Math.cos(cam.az), cam.dist * ce * Math.sin(cam.az), cam.dist * se];
    var f = V.unit(V.mul(eye, -1));
    var r = V.cross(f, [0, 0, 1]);
    if (V.len(r) < 1e-6) r = [1, 0, 0]; else r = V.unit(r);
    var u = V.cross(r, f);
    view.w = w; view.h = h; view.cx = w * 0.5; view.cy = h * 0.5;
    view.dist = cam.dist;
    view.eye = eye; view.f = f; view.r = r; view.u = u;
    view.focal = 0.98 * Math.min(w, h) * cam.zoom;
  }
  function project(p) {
    var dx = p[0] - view.eye[0], dy = p[1] - view.eye[1], dz = p[2] - view.eye[2];
    var X = dx * view.r[0] + dy * view.r[1] + dz * view.r[2];
    var Y = dx * view.u[0] + dy * view.u[1] + dz * view.u[2];
    var Z = dx * view.f[0] + dy * view.f[1] + dz * view.f[2];
    var s = view.focal / (Z > 0.15 ? Z : 0.15);
    return { x: view.cx + X * s, y: view.cy - Y * s, z: Z, vis: Z > 0.15 };
  }
  /* 深度衰减: 靠近相机的部分更亮 */
  function dA(z, base) {
    var t = clamp(0.42 + (view.dist - z) / 2.6, 0.10, 1.0);
    return base * t;
  }

  /* ---------------- 状态 ---------------- */
  var CFG = { stepsPerOrbit: 1800, histStride: 12, histMax: 12000, recentMax: 1800 };
  var S = {
    t: 0, steps: 0, r: [1, 0, 0], v: [0, 1, 0],
    B: 0.04, Btarget: 0.04, thetaDeg: 60, theta: 60 * DEG,
    L: [0, 0, 1], Lmag: 1, rmag: 1,
    phiPrev: null, phiAcc: 0, wMeas: 0,
    E0: -0.5, dE: 0,
    hist: [], recent: [],
    paused: false, speed: 2.2, trailFrac: 0.7, showGlow: true
  };
  var STAR = [];

  /* ---------------- 星场 (一次性生成) ---------------- */
  (function () {
    var seed = 20240517;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (var i = 0; i < 420; i++) {
      var u = rnd() * 2 - 1, ph = rnd() * TAU, s = Math.sqrt(1 - u * u);
      STAR.push({ dir: [s * Math.cos(ph), s * Math.sin(ph), u], a: 0.15 + rnd() * 0.55, sz: rnd() < 0.85 ? 1 : 2 });
    }
  })();

  /* ---------------- 重置 ---------------- */
  function reset() {
    var st = PH.createState(1, S.theta, S.B);
    S.r = st.r; S.v = st.v;
    S.t = 0; S.steps = 0; S.phiPrev = null; S.phiAcc = 0; S.wMeas = 0;
    S.E0 = PH.energy(st); S.dE = 0;
    S.hist.length = 0; S.recent.length = 0;
    S.L = PH.angularMomentum(st); S.Lmag = V.len(S.L); S.rmag = PH.radius(st);
  }

  /* ---------------- 推进物理 ---------------- */
  var dtStep = TAU / CFG.stepsPerOrbit;
  function advance(dtWall) {
    /* 磁场平滑趋近目标值 (准静态调场, 避免非绝热激发) */
    S.B += (S.Btarget - S.B) * clamp(dtWall / 1.2, 0, 1);
    if (Math.abs(S.Btarget - S.B) < 1e-9) S.B = S.Btarget;

    var dtSim = clamp(S.speed * TAU * dtWall, 0, 0.55);
    var n = Math.max(1, Math.min(900, Math.round(dtSim / dtStep)));
    var Bv = [0, 0, S.B], i;
    var histCap = Math.round(CFG.histMax * (0.15 + 0.85 * S.trailFrac));

    for (i = 0; i < n; i++) {
      PH.step(S, dtStep, Bv);
      S.t += dtStep; S.steps++;
      if (S.steps % CFG.histStride === 0) S.hist.push([S.r[0], S.r[1], S.r[2]]);
      S.recent.push([S.r[0], S.r[1], S.r[2]]);
    }
    /* 每帧只做一次裁剪, 避免逐步 splice 的 O(n) 开销 */
    if (S.hist.length > histCap) S.hist.splice(0, S.hist.length - histCap);
    if (S.recent.length > CFG.recentMax) S.recent.splice(0, S.recent.length - CFG.recentMax);

    /* 观测量 */
    var L = PH.angularMomentum(S);
    var phi = Math.atan2(L[1], L[0]);
    if (S.phiPrev === null) S.phiPrev = phi;
    S.phiAcc += PH.unwrap(S.phiPrev, phi);
    S.phiPrev = phi;
    S.L = L; S.Lmag = V.len(L); S.rmag = PH.radius(S);
    S.dE = Math.abs((PH.energy(S) - S.E0) / S.E0);
    S.wMeas = S.t > 4 ? S.phiAcc / S.t : S.B / 2;
  }

  /* ============================ 绘制原语 ============================ */
  function sprite(x, y, r, col, a) {
    if (r <= 0 || a <= 0) return;
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(col, a));
    g.addColorStop(0.35, rgba(col, a * 0.35));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  /* 把一批折线投影一次, 之后可反复使用 */
  function projectPoly(pts) {
    var out = new Array(pts.length), i;
    for (i = 0; i < pts.length; i++) out[i] = project(pts[i]);
    return out;
  }
  /* 一批已投影折线: 按深度分前后两遍, 每遍只一次 stroke */
  function strokeBatch(projs, col, base, width) {
    var pass, pi, pr, i, pa, pb, mid, started;
    for (pass = 0; pass < 2; pass++) {
      var back = (pass === 1);
      ctx.beginPath();
      for (pi = 0; pi < projs.length; pi++) {
        pr = projs[pi]; started = false;
        for (i = 0; i < pr.length - 1; i++) {
          pa = pr[i]; pb = pr[i + 1];
          if (!pa.vis || !pb.vis) { started = false; continue; }
          mid = (pa.z + pb.z) * 0.5;
          if ((mid > view.dist) !== back) { started = false; continue; }
          if (!started) { ctx.moveTo(pa.x, pa.y); started = true; } else ctx.lineTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
        }
      }
      ctx.strokeStyle = rgba(col, dA(back ? view.dist + 1 : view.dist - 1, base));
      ctx.lineWidth = width;
      ctx.stroke();
    }
  }
  /* 一批已投影折线, 不分深度, 一次 stroke */
  function strokeProj(projs, col, alpha, width) {
    var pi, i, pa, pb, started, pr;
    if (alpha <= 0.002) return;
    ctx.beginPath();
    for (pi = 0; pi < projs.length; pi++) {
      pr = projs[pi]; started = false;
      for (i = 0; i < pr.length - 1; i++) {
        pa = pr[i]; pb = pr[i + 1];
        if (!pa.vis || !pb.vis) { started = false; continue; }
        if (!started) { ctx.moveTo(pa.x, pa.y); started = true; } else ctx.lineTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
    }
    ctx.strokeStyle = rgba(col, alpha); ctx.lineWidth = width; ctx.stroke();
  }
  function polyAll(pts, col, alpha, width) {
    ctx.beginPath();
    var started = false, i, p;
    for (i = 0; i < pts.length; i++) {
      p = project(pts[i]);
      if (!p.vis) { started = false; continue; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = rgba(col, alpha); ctx.lineWidth = width; ctx.stroke();
  }
  function strokeRange(arr, i0, i1, dec, col, alpha, width) {
    if (i1 <= i0 || alpha <= 0.002) return;
    ctx.beginPath();
    var started = false, i, p;
    for (i = i0; i <= i1 && i < arr.length; i++) {
      if (dec > 1 && ((i - i0) % dec) !== 0) continue;
      p = project(arr[i]);
      if (!p.vis) { started = false; continue; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = rgba(col, alpha); ctx.lineWidth = width; ctx.stroke();
  }
  function text(str, x, y, size, col, align, bold) {
    ctx.font = (bold ? '600 ' : '400 ') + size + 'px ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif';
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.strokeText(str, x, y);
    ctx.fillStyle = col; ctx.fillText(str, x, y);
  }

  /* ============================ 场景 ============================ */
  function drawBackground() {
    var g = ctx.createRadialGradient(view.cx, view.cy * 0.92, 0, view.cx, view.cy, Math.max(view.w, view.h) * 0.8);
    g.addColorStop(0, 'rgba(15,26,52,1)');
    g.addColorStop(0.42, 'rgba(6,10,22,1)');
    g.addColorStop(1, 'rgba(1,2,6,1)');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = g; ctx.fillRect(0, 0, view.w, view.h);
    ctx.globalCompositeOperation = 'lighter';
    /* 星点按亮度分 3 档批量绘制 (1 次 beginPath + 3 次 fill) */
    var bk = [[], [], []], i, p, bi;
    for (i = 0; i < STAR.length; i++) {
      p = project(V.mul(STAR[i].dir, 34));
      if (!p.vis) continue;
      bi = STAR[i].a < 0.30 ? 0 : (STAR[i].a < 0.50 ? 1 : 2);
      bk[bi].push(p.x, p.y, STAR[i].sz);
    }
    for (i = 0; i < 3; i++) {
      if (!bk[i].length) continue;
      ctx.beginPath();
      for (var k = 0; k < bk[i].length; k += 3) ctx.rect(bk[i][k], bk[i][k + 1], bk[i][k + 2], bk[i][k + 2]);
      ctx.fillStyle = 'rgba(198,220,255,' + (0.24 + 0.23 * i).toFixed(2) + ')';
      ctx.fill();
    }
  }

  function drawSphereAndBand() {
    var R = 1.0, i, j, pts, ph, a;
    var grid = [];
    /* 经线 */
    for (j = 0; j < 8; j++) {
      a = j * Math.PI / 4; pts = [];
      for (i = 0; i <= 40; i++) { ph = i / 40 * TAU; pts.push([R * Math.cos(ph) * Math.cos(a), R * Math.cos(ph) * Math.sin(a), R * Math.sin(ph)]); }
      grid.push(projectPoly(pts));
    }
    /* 纬线 */
    for (j = -4; j <= 4; j++) {
      var th = j * Math.PI / 10, rr = R * Math.cos(th), zz = R * Math.sin(th); pts = [];
      for (i = 0; i <= 56; i++) { ph = i / 56 * TAU; pts.push([rr * Math.cos(ph), rr * Math.sin(ph), zz]); }
      grid.push(projectPoly(pts));
    }
    strokeBatch(grid, COL.sphere, 0.105, 1);

    /* 球面带: 电子轨迹的极角包络 [90-theta, 90+theta] */
    if (ui.band) {
      var th1 = Math.PI / 2 - S.theta, th2 = Math.PI / 2 + S.theta;
      var rings = [], edges = [], k;
      for (k = 0; k <= 14; k++) {
        var tt = th1 + (th2 - th1) * k / 14;
        var rr2 = R * Math.sin(tt), zz2 = R * Math.cos(tt);
        pts = [];
        for (i = 0; i <= 72; i++) { ph = i / 72 * TAU; pts.push([rr2 * Math.cos(ph), rr2 * Math.sin(ph), zz2]); }
        (k === 0 || k === 14 ? edges : rings).push(projectPoly(pts));
      }
      strokeBatch(rings, COL.band, 0.155, 1);
      strokeBatch(edges, COL.edge, 0.62, 1.7);
    }
  }

  function drawField() {
    if (!ui.field) return;
    strokeBatch([projectPoly([[0, 0, -2.0], [0, 0, 2.05]])], COL.axis, 0.55, 1.6);
    strokeBatch([projectPoly([[0, 0, -2.0], [0, 0, 2.05]])], COL.axis, 0.10, 9);
    /* 平行场线 + 漂移箭头 */
    var nf = 8, i, k, lines = [], chev = [[], [], []];
    for (k = 0; k < nf; k++) {
      var a = k / nf * TAU, R = 1.52;
      var x = R * Math.cos(a), y = R * Math.sin(a);
      lines.push(projectPoly([[x, y, -1.95], [x, y, 1.95]]));
      for (i = 0; i < 3; i++) {
        var zz = ((S.t * 0.28 + i * 0.333 + k * 0.03) % 1) * 3.9 - 1.95;
        var p0 = project([x, y, zz]), p1 = project([x, y, zz + 0.085]);
        if (!p0.vis || !p1.vis) continue;
        var dx = p1.x - p0.x, dy = p1.y - p0.y, L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
        var s = 3.4;
        var b = clamp(Math.floor((view.dist + 1.6 - p0.z) / 1.4), 0, 2);
        chev[b].push([p1.x, p1.y, p0.x - dy * s * 0.62, p0.y + dx * s * 0.62, p0.x + dy * s * 0.62, p0.y - dx * s * 0.62]);
      }
    }
    strokeBatch(lines, COL.field, 0.20, 1);
    for (i = 0; i < 3; i++) {           /* 箭头按深度分 3 档批量填充 */
      if (!chev[i].length) continue;
      ctx.beginPath();
      for (k = 0; k < chev[i].length; k++) {
        var c = chev[i][k];
        ctx.moveTo(c[0], c[1]); ctx.lineTo(c[2], c[3]); ctx.lineTo(c[4], c[5]); ctx.closePath();
      }
      ctx.fillStyle = rgba(COL.field, 0.14 + 0.09 * i); ctx.fill();
    }
    /* B 轴箭头 + 标签 */
    var pt = project([0, 0, 2.05]);
    if (pt.vis) {
      sprite(pt.x, pt.y, 22, COL.axis, 0.42);
      text('B', pt.x + 16, pt.y - 14, 20, rgba(COL.axis, 0.95), 'left', true);
    }
  }

  function drawTrail() {
    if (!ui.trail) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    var n = S.hist.length, b, i0, i1, age, glow = S.showGlow ? 1 : 0, NB = 12;
    if (n > 3) {
      var decG = n > 3000 ? 4 : 2, decC = n > 3000 ? 2 : 1;
      for (b = 0; b < NB; b++) {           /* 外发光: 只给较新的部分, 提高对比度 */
        i0 = Math.floor(n * b / NB); i1 = Math.floor(n * (b + 1) / NB);
        age = (b + 0.5) / NB;
        if (age < 0.38) continue;
        strokeRange(S.hist, i0, i1, decG, COL.trailA, (0.010 + 0.10 * age * age) * glow, 1.0 + 4.0 * age);
      }
      for (b = 0; b < NB; b++) {           /* 亮芯 */
        i0 = Math.floor(n * b / NB); i1 = Math.floor(n * (b + 1) / NB);
        age = (b + 0.5) / NB;
        strokeRange(S.hist, i0, i1, decC, COL.trailA, 0.022 + 0.32 * Math.pow(age, 2.8), 0.35 + 1.1 * age);
        if (b >= NB - 4) strokeRange(S.hist, i0, i1, 1, COL.trailB, 0.09 + 0.20 * (b - NB + 4) / 4, 0.25 + 0.5 * age);
      }
    }
    var m = S.recent.length;
    if (m > 3) {                            /* 最近一圈: 白热, 这是"当前轨道" */
      if (glow) strokeRange(S.recent, 0, m, 1, COL.trailA, 0.16, 11);
      if (glow) strokeRange(S.recent, 0, m, 1, COL.trailB, 0.30, 4.2);
      strokeRange(S.recent, 0, m, 1, COL.trailB, 0.62, 2.1);
      strokeRange(S.recent, 0, m, 1, COL.white, 0.95, 1.0);
    }
  }

  function drawOrbit() {
    var n = V.unit(S.L), b = basis(n), u = b[1], w = b[2];
    var R = S.rmag, pts = [], i, a2;
    for (i = 0; i <= 96; i++) { a2 = i / 96 * TAU; pts.push(V.add(V.mul(u, R * Math.cos(a2)), V.mul(w, R * Math.sin(a2)))); }
    /* 极淡的轨道面 */
    ctx.beginPath();
    var st = false;
    for (i = 0; i < pts.length; i++) { var p = project(pts[i]); if (!p.vis) { st = false; continue; } if (!st) { ctx.moveTo(p.x, p.y); st = true; } else ctx.lineTo(p.x, p.y); }
    ctx.closePath();
    ctx.fillStyle = rgba(COL.orbit, 0.028); ctx.fill();
    polyAll(pts, COL.orbit, 0.12, 7);
    polyAll(pts, COL.orbit, 0.50, 1.5);
  }

  /* 圆锥面: 顶点在原点, 轴 axis, 半顶角 half, 斜高 len */
  function drawCone(axis, half, len, col, alpha) {
    var ab = basis(axis), a = ab[0], u = ab[1], w = ab[2];
    var N = 44, rim = [], i, ph;
    var ca = Math.cos(half), sa = Math.sin(half);
    for (i = 0; i <= N; i++) {
      ph = i / N * TAU;
      var d = [ca * a[0] + sa * (Math.cos(ph) * u[0] + Math.sin(ph) * w[0]),
               ca * a[1] + sa * (Math.cos(ph) * u[1] + Math.sin(ph) * w[1]),
               ca * a[2] + sa * (Math.cos(ph) * u[2] + Math.sin(ph) * w[2])];
      rim.push(V.mul(d, len));
    }
    var p0 = project([0, 0, 0]);
    ctx.globalAlpha = 1;
    for (i = 0; i < N; i++) {
      var p1 = project(rim[i]), p2 = project(rim[i + 1]);
      if (!p1.vis || !p2.vis || !p0.vis) continue;
      var zc = (p1.z + p2.z) * 0.5;
      var aa = alpha * (0.045 + 0.10 * clamp((view.dist - zc) / 2.4 + 0.5, 0, 1));
      ctx.fillStyle = rgba(col, aa);
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.closePath(); ctx.fill();
    }
    /* 母线: 一次 beginPath 批量描边 */
    ctx.beginPath();
    for (i = 0; i < 8; i++) {
      ph = i / 8 * TAU;
      var dd = [ca * a[0] + sa * (Math.cos(ph) * u[0] + Math.sin(ph) * w[0]),
                ca * a[1] + sa * (Math.cos(ph) * u[1] + Math.sin(ph) * w[1]),
                ca * a[2] + sa * (Math.cos(ph) * u[2] + Math.sin(ph) * w[2])];
      var q = V.mul(dd, len), pa = project([0, 0, 0]), pb = project(q);
      if (!pa.vis || !pb.vis) continue;
      ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
    }
    ctx.strokeStyle = rgba(col, alpha * 0.14); ctx.lineWidth = 0.7; ctx.stroke();
    rim.push(rim[0]);
    polyAll(rim, col, alpha * 0.85, 1.6);
    polyAll(rim, col, alpha * 0.18, 8);
    /* 顶点亮点 */
    if (p0.vis) sprite(p0.x, p0.y, 14, col, 0.35);
  }

  function drawArrow(dir, len, col, colCore, label, glow) {
    var tip = V.mul(V.unit(dir), len);
    var p0 = project([0, 0, 0]), p1 = project(tip);
    if (!p0.vis || !p1.vis) return null;
    if (glow !== 0) {
      ctx.strokeStyle = rgba(col, 0.09); ctx.lineWidth = 13; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    }
    ctx.strokeStyle = rgba(col, 0.62); ctx.lineWidth = 3.4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    ctx.strokeStyle = rgba(colCore, 0.85); ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();

    var dx = p1.x - p0.x, dy = p1.y - p0.y, L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    var hl = 15, hw = 6.2;
    ctx.beginPath();
    ctx.moveTo(p1.x + dx * 3, p1.y + dy * 3);
    ctx.lineTo(p1.x - dx * hl - dy * hw, p1.y - dy * hl + dx * hw);
    ctx.lineTo(p1.x - dx * hl + dy * hw, p1.y - dy * hl - dx * hw);
    ctx.closePath(); ctx.fillStyle = rgba(col, 0.96); ctx.fill();
    if (glow !== 0) sprite(p1.x, p1.y, 20, col, 0.45);
    if (label) text(label, p1.x + dx * 18 + 6, p1.y + dy * 18, 19, rgba(col, 0.98), 'left', true);
    return p1;
  }

  var spinDir = [0, 0, 1];
  function updateSpin() {
    var th = S.theta, az = S.t * (PH.G_SPIN * S.B / 2);
    var ca = Math.cos(az), sa = Math.sin(az);
    var x = Math.sin(th) * 0, y = Math.sin(th) * 1, z = Math.cos(th);
    spinDir = [x * ca - y * sa, x * sa + y * ca, z];
  }

  function drawVectors() {
    /* --- 对顶双锥 --- */
    if (ui.cone) {
      drawCone([0, 0, 1], S.theta, 1.55, COL.L, ui.coneA);
      drawCone([0, 0, -1], S.theta, 0.775, COL.mu, ui.coneA);
    }
    /* --- 角动量 L --- */
    drawArrow(S.L, 1.55, COL.L, [255, 250, 235], 'L', 1);
    /* --- 磁矩 mu = -L/2 (原子单位的真实比例) --- */
    if (ui.mu) drawArrow(V.mul(S.L, -1), 0.775, COL.mu, [255, 235, 245], '\u03bc', 1);
    /* --- 自旋 S --- */
    if (ui.spin) {
      updateSpin();
      drawArrow(spinDir, 0.95, COL.spin, [245, 240, 255], 'S', 1);
      var b = basis([0, 0, 1]), u = b[1], w = b[2];
      var pts = [], i, a2, R = 0.95 * Math.sin(S.theta), zz = 0.95 * Math.cos(S.theta);
      for (i = 0; i <= 72; i++) { a2 = i / 72 * TAU; pts.push([R * Math.cos(a2), R * Math.sin(a2), zz]); }
      polyAll(pts, COL.spin, 0.20, 1);
    }
    /* --- theta 角弧 --- */
    var Lh = V.unit(S.L);
    if (Math.abs(S.theta) > 0.02) {
      var arc = [], K = 26, T;
      for (i = 0; i <= K; i++) {
        T = i / K;
        var s1 = Math.sin((1 - T) * S.theta) / Math.sin(S.theta), s2 = Math.sin(T * S.theta) / Math.sin(S.theta);
        var d = V.add(V.mul([0, 0, 1], s1), V.mul(Lh, s2));
        arc.push(V.mul(d, 0.52));
      }
      polyAll(arc, COL.white, 0.42, 1.2);
      var pm = project(V.mul(V.unit(V.add(V.mul([0, 0, 1], Math.cos(S.theta / 2)), V.mul(Lh, 1))), 0.60));
      if (pm.vis) text('\u03b8 = ' + S.thetaDeg.toFixed(0) + '\u00b0', pm.x + 8, pm.y, 15, 'rgba(235,245,255,0.92)', 'left', false);
    }
  }

  function drawElectron() {
    var p = project(S.r);
    if (!p.vis) return;
    var m = S.recent.length, tail = [], i, k, a, b2;
    for (i = Math.max(0, m - 46); i < m; i += 2) tail.push(project(S.recent[i]));
    if (tail.length > 1) {
      var NB = 3, seg = Math.ceil((tail.length - 1) / NB);
      for (k = 0; k < NB; k++) {
        var i0 = k * seg, i1 = Math.min(tail.length - 1, i0 + seg);
        if (i1 <= i0) continue;
        ctx.beginPath();
        for (i = i0; i < i1; i++) {
          a = tail[i]; b2 = tail[i + 1];
          if (!a.vis || !b2.vis) continue;
          ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y);
        }
        var t = (k + 0.5) / NB;
        ctx.strokeStyle = rgba(COL.trailB, 0.75 * t * t); ctx.lineWidth = 3.4 * t + 0.3;
        ctx.lineCap = 'round'; ctx.stroke();
      }
    }
    sprite(p.x, p.y, 32, COL.trailA, 0.60);
    sprite(p.x, p.y, 14, COL.white, 0.98);
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 3.1, 0, TAU); ctx.fill();
  }

  /* ============================ 主循环 ============================ */
  function render() {
    buildView(view.w, view.h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackground();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    if (ui.sphere) drawSphereAndBand();
    drawField();
    drawTrail();
    drawOrbit();
    drawVectors();
    drawElectron();
    ctx.globalCompositeOperation = 'source-over';
    if (ui.burn) drawOverlay();
  }

  /* ============================ UI ============================ */
  var ui = {
    sphere: true, band: true, cone: true, coneA: 0.85, mu: true, spin: false,
    field: true, trail: true, auto: true, burn: false
  };
  var el = {};
  function need(id) { var e = doc.getElementById(id); if (!e) throw new Error('missing element #' + id); return e; }
  function num(id) { var e = el[id]; return e ? parseFloat(e.value) : 0; }
  function chk(id) { var e = el[id]; return e ? !!e.checked : false; }

  function setupUI() {
    ['r-ratio', 'r-theta', 'r-speed', 'r-trail',
     'c-sphere', 'c-band', 'c-cone', 'c-mu', 'c-spin', 'c-field', 'c-trail', 'c-auto',
     'b-pause', 'b-reset', 'b-cam', 'b-png', 'l-ratio', 'l-speed',
     'r-res', 'r-fps', 'r-dur', 'c-reset', 'c-burn', 'b-rec', 'v-rec', 'v-recbar'
    ].forEach(function (id) { el[id] = need(id); });

    el['r-ratio'].value = (S.Btarget / 2).toFixed(3);
    el['r-theta'].value = S.thetaDeg;
    el['r-speed'].value = S.speed;
    el['r-trail'].value = Math.round(S.trailFrac * 100);

    el['r-ratio'].addEventListener('input', function () {
      S.Btarget = parseFloat(el['r-ratio'].value) * 2;
      el['l-ratio'].textContent = parseFloat(el['r-ratio'].value).toFixed(3);
    });
    el['r-theta'].addEventListener('input', function () {
      S.thetaDeg = parseFloat(el['r-theta'].value); S.theta = S.thetaDeg * DEG; reset();
    });
    el['r-speed'].addEventListener('input', function () {
      S.speed = parseFloat(el['r-speed'].value);
      if (el['l-speed']) el['l-speed'].textContent = S.speed.toFixed(1);
    });
    el['r-trail'].addEventListener('input', function () { S.trailFrac = parseFloat(el['r-trail'].value) / 100; });

    function bindChk(id, key) {
      el[id].addEventListener('change', function () { ui[key] = !!el[id].checked; });
      ui[key] = !!el[id].checked;
    }
    bindChk('c-sphere', 'sphere'); bindChk('c-band', 'band'); bindChk('c-cone', 'cone');
    bindChk('c-mu', 'mu'); bindChk('c-spin', 'spin'); bindChk('c-field', 'field');
    bindChk('c-trail', 'trail'); bindChk('c-auto', 'auto');

    el['b-pause'].addEventListener('click', function () {
      S.paused = !S.paused;
      el['b-pause'].textContent = S.paused ? '继续 ▶' : '暂停 ⏸';
    });
    el['b-reset'].addEventListener('click', function () { reset(); });
    el['b-cam'].addEventListener('click', function () { cam.az = -1.02; cam.el = 0.30; cam.zoom = 1; });
    el['b-png'].addEventListener('click', function () {
      if (canvas.toBlob) canvas.toBlob(function (b) {
        var url = URL.createObjectURL(b), a = doc.createElement('a');
        a.href = url; a.download = 'larmor-precession.png'; a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      });
    });

    /* --- 录制 --- */
    el['b-rec'].addEventListener('click', function () {
      if (rec.active) stopRecording(); else startRecording();
    });
    el['c-burn'].addEventListener('change', function () { ui.burn = !!el['c-burn'].checked; });
    ui.burn = !!el['c-burn'].checked;
    if (el['r-dur']) el['r-dur'].addEventListener('change', updateRecUI);
    if (el['r-ratio']) el['r-ratio'].addEventListener('input', updateRecUI);
    updateRecUI();

    /* 鼠标交互 */
    var dragging = false, lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', function (e) { dragging = true; lx = e.clientX; ly = e.clientY; ui.auto = false; if (el['c-auto']) el['c-auto'].checked = false; });
    win.addEventListener('pointerup', function () { dragging = false; });
    win.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      cam.az -= (e.clientX - lx) * 0.0062;
      cam.el = clamp(cam.el + (e.clientY - ly) * 0.0050, -1.45, 1.45);
      lx = e.clientX; ly = e.clientY;
    });
    canvas.addEventListener('wheel', function (e) {
      if (e.preventDefault) e.preventDefault();
      cam.zoom = clamp(cam.zoom * (e.deltaY > 0 ? 0.93 : 1.075), 0.45, 3.2);
    }, { passive: false });
    win.addEventListener('keydown', function (e) {
      if (e.key === ' ') { el['b-pause'].click(); if (e.preventDefault) e.preventDefault(); }
      else if (e.key === 'r' || e.key === 'R') reset();
    });
  }

  /* ---------------- HUD 读数 ---------------- */
  function hud(id, v) { var e = doc.getElementById(id); if (e) e.textContent = v; }
  var hudAcc = 0, fps = 60;
  function updateHUD(dtWall) {
    if (dtWall > 0) fps = fps * 0.9 + (1 / dtWall) * 0.1;
    hudAcc += dtWall;
    if (hudAcc < 0.08) return;
    hudAcc = 0;
    var B = S.B, wL = B / 2;
    var Breal = B * PH.AU_BFIELD;
    var wLreal = wL * PH.AU_FREQ;                 // rad/s
    var ratio = wL;                               // wL/omega0
    var orbitsPerTurn = 1 / Math.max(ratio, 1e-12);
    var precessDeg = Math.abs(S.phiAcc) / DEG;
    var werr = (S.wMeas - wL) / wL;

    hud('v-ratio', ratio.toFixed(6));
    hud('v-orbits', (S.t / TAU).toFixed(2));
    hud('v-precess', precessDeg.toFixed(1) + '\u00b0');
    hud('v-theta', S.thetaDeg.toFixed(0) + '\u00b0');
    hud('v-Lmag', S.Lmag.toFixed(6));
    hud('v-rmag', S.rmag.toFixed(6));
    hud('v-dE', S.dE.toExponential(1));
    hud('v-wmeas', S.wMeas.toFixed(8));
    hud('v-wtheo', wL.toFixed(8));
    hud('v-werr', (werr * 100).toFixed(3) + '%');
    hud('v-werr2', 'O(B\u00b2) 修正: ' + ((S.wMeas - wL) / (wL * wL)).toFixed(3) + ' \u00d7 \u03c9_L\u00b2  (\u5b9a\u7406\u53ea\u4fdd\u8bc1\u4e00\u9636)');
    hud('v-bre', Breal.toExponential(2) + ' T');
    hud('v-bghz', (wLreal / TAU / 1e9).toFixed(1) + ' GHz');
    hud('v-zeeman', (Breal * PH.BOHR_MU_EV_PER_T).toExponential(3) + ' eV');
    hud('v-optrun', orbitsPerTurn.toFixed(0) + ' 圈');
    var B1 = 1 / PH.AU_BFIELD;
    hud('v-1T', (B1 / 2).toExponential(2) + ' / ' + (1 / (B1 / 2)).toExponential(2) + ' 圈');
    hud('v-mag', (Breal / 9.402e3).toFixed(0) + ' \u00d7');
    hud('v-fps', fps.toFixed(0));
  }

  /* ============================ 画面烧录 (录视频用) ============================ */
  function drawOverlay() {
    var w = view.w, h = view.h;
    var s = Math.max(0.5, Math.min(w / 1600, h / 900));
    ctx.globalCompositeOperation = 'source-over';
    var pad = 36 * s;

    var g = ctx.createLinearGradient(0, 0, 0, 140 * s);
    g.addColorStop(0, 'rgba(2,4,10,0.74)'); g.addColorStop(1, 'rgba(2,4,10,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, 140 * s);
    var g2 = ctx.createLinearGradient(0, h - 160 * s, 0, h);
    g2.addColorStop(0, 'rgba(2,4,10,0)'); g2.addColorStop(1, 'rgba(2,4,10,0.80)');
    ctx.fillStyle = g2; ctx.fillRect(0, h - 160 * s, w, 160 * s);

    text('\u62c9\u83ab\u5c14\u8fdb\u52a8 \u00b7 Larmor Precession', pad, 46 * s, 32 * s, '#eaf3ff', 'left', true);
    text('\u03c9_L = (e/2m)\u00b7B  =  B/2        (\u539f\u5b50\u5355\u4f4d)', pad, 84 * s, 22 * s, 'rgba(255,190,74,0.96)', 'left', false);
    text('\u7cbe\u786e\u6d1b\u4f26\u5179\u529b + \u5e93\u4ed1\u529b\u6570\u503c\u79ef\u5206 (RK4)\uff0c\u5bf9 B \u4e0d\u505a\u4efb\u4f55\u5c55\u5f00', pad, 112 * s, 15 * s, 'rgba(150,172,204,0.88)', 'left', false);

    /* 数据条 */
    var ratio = S.B / 2, Breal = S.B * PH.AU_BFIELD;
    var y0 = h - 74 * s;
    text('\u03c9_L/\u03c9\u2080 = ' + ratio.toFixed(4), pad, y0, 17 * s, 'rgba(122,190,255,0.96)', 'left', true);
    text('\u03b8 = ' + S.thetaDeg.toFixed(0) + '\u00b0', pad + 200 * s, y0, 17 * s, 'rgba(230,240,255,0.92)', 'left', false);
    text('\u5df2\u516c\u8f6c ' + (S.t / TAU).toFixed(1) + ' \u5708', pad + 310 * s, y0, 17 * s, 'rgba(230,240,255,0.92)', 'left', false);
    text('L \u5df2\u8fdb\u52a8 ' + (Math.abs(S.phiAcc) / DEG).toFixed(0) + '\u00b0', pad + 480 * s, y0, 17 * s, 'rgba(255,190,74,0.96)', 'left', true);
    text('B = ' + Breal.toExponential(2) + ' T', pad + 680 * s, y0, 17 * s, 'rgba(150,246,196,0.96)', 'left', true);
    text('\u771f\u5b9e 1 T \u65f6 \u03c9_L/\u03c9\u2080 = 2.1\u00d710\u207b\u2076\uff0c\u8fdb\u52a8 1 \u5708\u9700\u516c\u8f6c 4.7\u00d710\u2075 \u5708 \u2014\u2014 \u6f14\u793a\u4e3a\u53ef\u89c6\u5316\u5df2\u653e\u5927\u78c1\u573a',
         pad, h - 42 * s, 14 * s, 'rgba(150,172,204,0.85)', 'left', false);

    /* 图例 */
    var L = [['L \u89d2\u52a8\u91cf', COL.L], ['\u03bc \u78c1\u77e9', COL.mu], ['B \u78c1\u573a', COL.field],
             ['\u7535\u5b50\u8f68\u8ff9', [90, 170, 255]], ['\u7403\u9762\u5e26\u5305\u7edc', COL.edge]];
    var lx = w - pad, i;
    for (i = L.length - 1; i >= 0; i--) {
      var label = L[i][0], c = L[i][1];
      ctx.font = '600 ' + (15 * s) + 'px ui-sans-serif,sans-serif';
      var wt = label.length * 15 * s;
      try { var mm = ctx.measureText(label); if (mm && mm.width) wt = mm.width; } catch (e) {}
      lx -= wt;
      text(label, lx, y0, 15 * s, 'rgba(196,214,238,0.92)', 'left', false);
      lx -= 22 * s;
      ctx.fillStyle = rgba(c, 0.95);
      ctx.fillRect(lx, y0 - 5 * s, 13 * s, 10 * s);
      lx -= 26 * s;
    }
  }

  /* ============================ 录制 ============================ */
  var rec = { active: false, elapsed: 0, maxSec: 20, mr: null, stream: null, chunks: [],
              mime: '', saved: null, msg: '', sizeMB: 0 };

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    var c = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9',
             'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < c.length; i++) {
      try { if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(c[i])) return c[i]; } catch (e) {}
    }
    return '';
  }
  /* 录制时按目标分辨率出图, CSS 尺寸单独缩放显示 */
  function setSize(w, h, cssW, cssH) {
    dpr = 1;
    canvas.width = Math.max(2, Math.round(w));
    canvas.height = Math.max(2, Math.round(h));
    if (canvas.style) {
      canvas.style.width = (cssW || w) + 'px';
      canvas.style.height = (cssH || h) + 'px';
      canvas.style.left = '50%'; canvas.style.top = '50%';
      canvas.style.right = 'auto'; canvas.style.bottom = 'auto';
      canvas.style.transform = 'translate(-50%,-50%)';
    }
    buildView(w, h);
  }
  function recRatio() { return S.Btarget / 2; }
  /* "1 个进动周期"模式: 公转整数圈, 使首尾可以无缝对接 */
  function recLoopSec() {
    var r = recRatio();
    var n = Math.max(1, Math.round(1 / r));
    return n / Math.max(S.speed, 0.01);
  }
  function recSeamless() {
    var n = 1 / recRatio();
    return Math.abs(n - Math.round(n)) < 1e-6;
  }
  function recDuration() {
    var v = el['r-dur'] ? String(el['r-dur'].value) : '20';
    return v === 'loop' ? recLoopSec() : (parseFloat(v) || 20);
  }

  function startRecording() {
    if (rec.active) return;
    if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
      rec.msg = '\u6b64\u6d4f\u89c8\u5668\u4e0d\u652f\u6301 MediaRecorder \u5f55\u5236'; return;
    }
    var rr = String(el['r-res'].value || '1920x1080').split('x');
    var W = parseInt(rr[0], 10) || 1920, H = parseInt(rr[1], 10) || 1080;
    var fps = parseInt(el['r-fps'].value, 10) || 60;
    var vw = win.innerWidth || 1600, vh = win.innerHeight || 900;
    var sc = Math.min(vw * 0.94 / W, vh * 0.94 / H);
    rec.saved = [vw, vh];
    setSize(W, H, W * sc, H * sc);

    if (el['c-reset'] && el['c-reset'].checked) reset();
    ui.burn = !!(el['c-burn'] && el['c-burn'].checked);

    rec.mime = pickMime();
    try { rec.stream = canvas.captureStream(fps); }
    catch (e) { rec.msg = 'captureStream \u5931\u8d25: ' + e.message; return; }
    try {
      rec.mr = new MediaRecorder(rec.stream, rec.mime
        ? { mimeType: rec.mime, videoBitsPerSecond: Math.round(W * H * fps * 0.11) } : {});
    } catch (e) {
      try { rec.mr = new MediaRecorder(rec.stream); }
      catch (e2) { rec.msg = 'MediaRecorder \u521b\u5efa\u5931\u8d25: ' + e2.message; return; }
    }
    rec.chunks = [];
    rec.mr.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data); };
    rec.mr.onstop = function () {
      var type = (rec.mime || 'video/webm').split(';')[0];
      var blob = new Blob(rec.chunks, { type: type });
      rec.sizeMB = blob.size / 1048576;
      var ext = type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
      var name = 'larmor-' + W + 'x' + H + '-' + fps + 'fps.' + ext;
      try {
        var url = URL.createObjectURL(blob);
        var a = doc.createElement('a');
        a.href = url; a.download = name; a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        rec.msg = '\u5df2\u4fdd\u5b58 ' + name + '\uff08' + rec.sizeMB.toFixed(1) + ' MB, ' + type + '\uff09';
      } catch (e) { rec.msg = '\u4e0b\u8f7d\u5931\u8d25: ' + e.message; }
      if (rec.saved) resize(rec.saved[0], rec.saved[1]);
      rec.active = false; rec.stream = null;
      if (el['b-rec']) { el['b-rec'].textContent = '\u25cf \u5f00\u59cb\u5f55\u5236'; el['b-rec'].className = ''; }
    };
    try { rec.mr.start(250); } catch (e) { rec.msg = 'start \u5931\u8d25: ' + e.message; return; }
    rec.active = true; rec.elapsed = 0; rec.msg = '';
    rec.maxSec = recDuration();
    if (el['b-rec']) { el['b-rec'].textContent = '\u25a0 \u505c\u6b62\u5f55\u5236'; el['b-rec'].className = 'recording'; }
  }

  function stopRecording() {
    if (!rec.active || !rec.mr) return;
    try { rec.mr.stop(); } catch (e) { rec.active = false; }
  }

  function updateRecUI() {
    var bar = el['v-recbar'];
    if (bar && bar.style) bar.style.width = (rec.active ? Math.min(100, rec.elapsed / rec.maxSec * 100) : 0) + '%';
    var st = el['v-rec'];
    if (!st) return;
    if (rec.active) {
      st.textContent = '\u25cf \u5f55\u5236\u4e2d  ' + rec.elapsed.toFixed(1) + ' / ' + rec.maxSec.toFixed(1) + ' s';
      st.style.color = '#ff6b8a';
    } else if (rec.msg) {
      st.textContent = rec.msg; st.style.color = '#7fe6b0';
    } else {
      var v = el['r-dur'] ? String(el['r-dur'].value) : '20';
      if (v === 'loop' && el['v-rec']) {
        st.textContent = '\u5373\u5c06\u5f55\u5236 ' + recLoopSec().toFixed(1) + ' s\uff08\u516c\u8f6c ' +
          Math.round(1 / recRatio()) + ' \u5708\uff09' + (recSeamless() ? '\uff0c\u53ef\u65e0\u7f1d\u5faa\u73af \u2713' : '\uff0c\u9996\u5c3e\u6709\u5c0f\u7f3a\u53e3');
        st.style.color = recSeamless() ? '#7fe6b0' : '#ffc46b';
      } else {
        st.textContent = ''; st.style.color = '#8ea3c4';
      }
    }
  }

  /* ---------------- 对外接口 ---------------- */
  function tick(dtWall) {
    if (!S.paused) advance(dtWall);
    if (ui.auto) cam.az += dtWall * cam.autoRate;
    render();
    updateHUD(dtWall);
    if (rec.active) {
      rec.elapsed += dtWall;
      if (rec.elapsed >= rec.maxSec) stopRecording();
    }
    updateRecUI();
  }
  function resize(w, h) {
    var W = w || (win.innerWidth || 1280), H = h || (win.innerHeight || 720);
    dpr = Math.min(win.devicePixelRatio || 1, 2);
    canvas.width = Math.max(2, Math.round(W * dpr));
    canvas.height = Math.max(2, Math.round(H * dpr));
    if (canvas.style) {
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      canvas.style.left = '0'; canvas.style.top = '0';
      canvas.style.right = 'auto'; canvas.style.bottom = 'auto';
      canvas.style.transform = 'none';
    }
    buildView(W, H);
  }

  return {
    state: S, cam: cam, ui: ui, reset: reset, advance: advance, render: render,
    tick: tick, resize: resize, setSize: setSize, updateHUD: updateHUD, setupUI: setupUI,
    view: view, rec: rec, startRecording: startRecording, stopRecording: stopRecording,
    updateRecUI: updateRecUI
  };
}

global.LarmorApp = { createApp: createApp };
if (typeof module === 'object' && module.exports) module.exports = { createApp: createApp };

/* ============================ 浏览器启动 ============================ */
if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById && document.getElementById('gl')) {
  (function () {
    var canvas = document.getElementById('gl');
    var app = createApp(canvas, document, window);

    /* URL 参数:
     *   ?warmup=25            预跑 25 秒 (便于截图)
     *   ?off=cone,field       关闭某些图层
     *   ?on=spin              打开某些图层
     *   ?theta=75&ratio=0.03  设定初值
     *   ?az=-1.02&el=0.30&dist=3.6&zoom=1.2   设定相机
     *   ?auto=0&paused=1      关自动旋转 / 开局暂停
     */
    var qs = (window.location && window.location.search) || '';
    var P = {};
    qs.replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      P[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
    });
    var MAP = { sphere: 'c-sphere', band: 'c-band', cone: 'c-cone', mu: 'c-mu',
                spin: 'c-spin', field: 'c-field', trail: 'c-trail', auto: 'c-auto' };
    function setChk(list, val) {
      (list || '').split(',').forEach(function (k) {
        k = k.trim(); if (!k || !MAP[k]) return;
        var e = document.getElementById(MAP[k]); if (e) e.checked = val;
      });
    }
    setChk(P.on, true);
    setChk(P.off, false);
    if (P.theta !== undefined) { app.state.thetaDeg = parseFloat(P.theta); app.state.theta = app.state.thetaDeg * Math.PI / 180; }
    if (P.ratio !== undefined) { app.state.Btarget = 2 * parseFloat(P.ratio); app.state.B = app.state.Btarget; }

    function fit() { app.resize(window.innerWidth, window.innerHeight); }
    window.addEventListener('resize', fit);
    fit();
    app.setupUI();
    app.reset();

    if (P.az !== undefined) app.cam.az = parseFloat(P.az);
    if (P.el !== undefined) app.cam.el = parseFloat(P.el);
    if (P.dist !== undefined) app.cam.dist = parseFloat(P.dist);
    if (P.zoom !== undefined) app.cam.zoom = parseFloat(P.zoom);
    if (P.auto === '0') app.ui.auto = false;
    if (P.burn === '1') { app.ui.burn = true; var cb = document.getElementById('c-burn'); if (cb) cb.checked = true; }
    if (P.paused === '1') { app.state.paused = true; var bp = document.getElementById('b-pause'); if (bp) bp.textContent = '继续 ▶'; }
    if (P.hud === '0') {
      ['left', 'right', 'legend', 'hint'].forEach(function (id) {
        var e = document.getElementById(id); if (e && e.style) e.style.display = 'none';
      });
    }

    if (P.warmup !== undefined) {
      var n = Math.round(parseFloat(P.warmup) * 60), i;
      for (i = 0; i < n; i++) app.advance(1 / 60);
      app.updateHUD(1 / 60);
    }
    var last = (window.performance && performance.now) ? performance.now() : Date.now();
    function loop() {
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      var dt = Math.min(0.05, (now - last) / 1000); last = now;
      app.tick(dt);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    window.__LARMOR__ = app;
  })();
}
})(typeof globalThis !== 'undefined' ? globalThis : this);
