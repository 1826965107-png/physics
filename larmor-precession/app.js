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
  dial:   [186, 226, 255],
  dialA:  [104, 222, 255],
  ghost:  [132, 150, 196],
  xyz:    [122, 142, 178],
  relax:  [ 96, 255, 190],
  quant:  [255, 206, 110],
  ladder: [150, 200, 255],
  white:  [255, 255, 255]
};

/* ============================ 主程序 ============================ */
function createApp(canvas, doc, win) {
  var ctx = canvas.getContext('2d');
  var dpr = 1;

  /* ---------------- 相机 / 投影 ---------------- */
  var cam = { az: -1.02, el: 0.62, dist: 3.75, zoom: 1, auto: false, autoRate: 0.055 };
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
    /* 正交投影 (平行投影): 像素尺度与深度无关。
     * 透视会让"指向相反深度方向"的两个箭头长度失真 —— 实测 |μ|/|L| 在屏幕上
     * 会在 0.25~0.6 之间漂, 而物理上它必须精确等于 0.500 (μ = -½L)。
     * 对一张几何/矢量图来说, 正交投影才保长度比与共线性。 */
    view.scale = 0.98 * Math.min(w, h) * cam.zoom / cam.dist;
  }
  function project(p) {
    var dx = p[0] - view.eye[0], dy = p[1] - view.eye[1], dz = p[2] - view.eye[2];
    var X = dx * view.r[0] + dy * view.r[1] + dz * view.r[2];
    var Y = dx * view.u[0] + dy * view.u[1] + dz * view.u[2];
    var Z = dx * view.f[0] + dy * view.f[1] + dz * view.f[2];
    return { x: view.cx + X * view.scale, y: view.cy - Y * view.scale, z: Z, vis: true };
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
    B: 0.04, Btarget: 0.04, thetaDeg: 30, theta: 30 * DEG,
    L: [0, 0, 1], Lmag: 1, rmag: 1, L0: [0, 0, 1],
    phiPrev: null, phiAcc: 0, wMeas: 0,
    E0: -0.5, dE: 0,
    hist: [], recent: [],
    paused: false, speed: 2.2, trailFrac: 0.0, showGlow: true,
    /* --- 弛豫 (布洛赫唯象阻尼) ---
     * 两个独立的物理过程:
     *   T1  (纵向/自旋-晶格): 需要把 ħω_L 交给热库, 让 M_z 回到平衡
     *   T2' (纯退相位):        只打乱相位, 不交换能量
     * 二者合成横向弛豫:   1/T2 = 1/(2T1) + 1/T2'   ==>  T2 <= 2T1
     */
    relax: false,
    T1: 20 * TAU,                       /* 纵向弛豫时间 (a.u.) */
    rate2p: 0,                          /* 纯退相位速率 1/T2' (1/a.u.), 0 = 无 */
    Tau: 40 * TAU,                      /* 由上面两者合成的 T2 */
    bz: 0, bp: 0, L0mag: 1, mz0: 0, mp0: 1,
    betaCont: 0, betaDisp: 0,           /* 目标倾角(连续) / 实际驱动倾角 */
    /* --- 空间量子化 --- */
    quant: false, lq: 2,
    /* --- 记录 --- */
    tipTrace: [], cohHist: [], mNow: -1
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
    S.L0 = V.unit(S.L);                       /* 进动起始方向, 用于画"原轨道面"鬼影 */
    S.theta0 = S.theta;                       /* 起始倾角, FID 包络的初值 */
    S.tipTrace.length = 0; S.cohHist.length = 0;
    syncRelax();
  }

  /* ================= 弛豫 / 空间量子化 的物理 =================
   * 平衡方向: 电子 mu = -(e/2m)L, U = -mu.B = +(e/2m)L.B
   *           => 能量最低要求 L 反平行于 B, 即 L 指向 -Z, mu 指向 +Z。
   * 布洛赫唯象阻尼: 横向分量(相对 -Z)按 e^(-t/Tau) 衰减
   *           sin beta(t) = sin beta(0) * e^(-t/Tau)
   * 这个 sin beta 就是磁共振里测到的横向磁化 |M_perp| —— FID 的包络。
   */
  function tiltFromEq(L) {                    /* L 与平衡方向 -Z 的夹角 beta */
    var u = V.unit(L);
    return Math.acos(clamp(-u[2], -1, 1));
  }
  /* 空间量子化: cos(theta_m) = m/sqrt(l(l+1)), m = -l..l
   * 只有 2l+1 个允许的倾角; 最小倾角 arccos(l/sqrt(l(l+1))) > 0,
   * 也就是 L 永远不能与 -Z 完全重合。 */
  function allowedBetas(l) {
    var n = Math.sqrt(l * (l + 1)), out = [], m;
    for (m = -l; m <= l; m++) out.push(Math.acos(clamp(-m / n, -1, 1)));
    return out;
  }
  function nearestAllowed(beta, l) {
    var a = allowedBetas(l), best = a[0], bd = 1e9, i, d;
    for (i = 0; i < a.length; i++) { d = Math.abs(a[i] - beta); if (d < bd) { bd = d; best = a[i]; } }
    return best;
  }
  function mForBeta(beta, l) {
    var a = allowedBetas(l), bd = 1e9, bi = 0, i, d;
    for (i = 0; i < a.length; i++) { d = Math.abs(a[i] - beta); if (d < bd) { bd = d; bi = i; } }
    return -l + bi;                            /* allowedBetas 按 m 升序 */
  }
  function syncRelax() {
    var L = S.L, lm = V.len(L) || 1;
    S.L0mag = lm;
    S.bz = L[2];                                        /* 纵向分量 L_z */
    S.bp = Math.hypot(L[0], L[1]);                      /* 横向模 |L_⊥| */
    S.mz0 = -S.bz / lm;                                 /* 归一化纵向磁化 M_z/M_eq */
    S.mp0 = S.bp / lm;                                  /* 归一化横向磁化 */
    S.betaCont = Math.atan2(S.bp, -S.bz);               /* 有向: L 与平衡方向 -Z 的夹角 */
    S.betaDisp = Math.min(S.betaCont, Math.PI - S.betaCont);  /* 无向: 轨道面的倾角 */
    S.branch = (S.betaCont > Math.PI / 2) ? 1 : -1;
    S.mNow = S.quant ? mForBeta(S.betaCont, S.lq) : -1;
  }
  /* 由 T1 与纯退相位速率合成 T2:   1/T2 = 1/(2T1) + 1/T2' */
  function recomputeT2() {
    S.Tau = 1 / (1 / (2 * Math.max(S.T1, 1e-6)) + Math.max(S.rate2p, 0));
  }
  /* 完整布洛赫方程组 (对磁矩 mu ∝ -L 写, 所以纵向平衡是 L_z = -|L|):
   *     M_z(t)    = M_eq + (M_z(0) - M_eq) · e^(-t/T1)      T1 纵向恢复
   *     |M_⊥|(t)  = |M_⊥|(0) · e^(-t/T2)                    T2 横向退相位
   * 这个 |M_⊥| 就是磁共振测到的横向磁化, 也就是 FID 包络。 */
  function blochStep(dt) {
    var T1 = Math.max(S.T1, 1e-6), T2 = Math.max(S.Tau, 1e-6);
    S.bz = -S.L0mag + (S.bz + S.L0mag) * Math.exp(-dt / T1);
    S.bp *= Math.exp(-dt / T2);
    S.betaCont = Math.atan2(Math.max(S.bp, 0), -S.bz);  /* 与 -Z 的夹角 */
  }
  /* 把轨道面绕当前 r 方向转一个小角度, 使"轨道面的倾斜"趋近 betaDisp。
   *
   * 关键: cos(psi + delta) = A·cos(delta) + C·sin(delta), 其中 A = n̂·Ê, C = (r̂×n̂)·Ê。
   * 若只按一阶导数 C 做比例控制, 在"轨道面恰好在赤道面"时会退化成 C ≡ 0, 永远不动。
   * 所以这里直接解出到达目标所需的角度(二阶效应), 再限幅成每帧一小步。
   * 绕 r 旋转 v 时 |v| 与 |r| 都不变, 轨道形状不变, 只有轨道面在倾斜。 */
  function relaxTilt() {
    var r = S.r, v = S.v;
    var rn = V.len(r); if (rn < 1e-9) return;
    var rh = V.mul(r, 1 / rn);
    var L = V.cross(r, v), Lm = V.len(L); if (Lm < 1e-12) return;
    var nh = V.mul(L, 1 / Lm);
    var A = -nh[2];
    var C = -(V.cross(rh, nh))[2];
    var R = Math.hypot(A, C);
    if (R < 1e-6) return;
    /* 死区: 不要理会微小起伏。
     * 精确积分本身就带一个 O(B) 的章动(倾角在 ~0.6° 内起伏)。若每帧都去
     * 镇压它, 这些绕 r̂ 的修正会带有系统性方位角分量, 累积起来足以把拉莫尔
     * 进动抵消掉(实测方位角从 15.8°/s 掉到 1.5°/s)。所以只在偏差超过死区时才动。 */
    var planeNow = Math.acos(clamp(Math.abs(A), 0, 1));
    if (Math.abs(planeNow - S.betaDisp) < 0.025) return;
    var want = Math.cos(clamp(S.betaDisp, 0, Math.PI / 2));   /* 目标 |cos psi| */
    var d0 = Math.atan2(C, A), delta = 0, s, cand, i, best;
    var cur = Math.abs(A);                        /* 当前 |cos psi| */
    if (want <= R) {
      /* 目标可达: 直接解出所需角度, 在 4 个解里取 |δ| 最小的那个。
       * 已经到位时 δ=0 本身就是解之一, 所以不会再被硬推 -> 不抖。 */
      s = Math.acos(clamp(want / R, -1, 1));
      best = 1e9;
      for (i = 0; i < 4; i++) {
        cand = d0 + (i === 0 ? s : i === 1 ? -s : i === 2 ? (Math.PI - s) : -(Math.PI - s));
        cand = ((cand + Math.PI) % TAU + TAU) % TAU - Math.PI;
        if (Math.abs(cand) < best) { best = Math.abs(cand); delta = cand; }
      }
    } else {
      /* 目标当前够不到: 该相位下最多只能到 acos(R)。
       * 正确做法是"等" —— 同一个目标在轨道另一段相位(R 更大时)就能达到。
       * 若在这里硬推到极端, 就会每帧跟进动对着干, 形成极限环,
       * 表现为"箭头几乎不转、只是在抖"。 */
      delta = 0;
    }
    delta = clamp(delta, -0.03, 0.03);
    if (Math.abs(delta) < 1e-6) return;
    var vr = V.mul(rh, V.dot(v, rh));
    var vt = V.sub(v, vr);
    var cd = Math.cos(delta), sd = Math.sin(delta);
    var rxvt = V.cross(rh, vt);
    v[0] = vr[0] + vt[0] * cd + rxvt[0] * sd;
    v[1] = vr[1] + vt[1] * cd + rxvt[1] * sd;
    v[2] = vr[2] + vt[2] * cd + rxvt[2] * sd;
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

    /* ---- 弛豫 / 空间量子化 对"轨道面取向"的约束 ---- */
    if (S.relax && S.Tau > 0) blochStep(dtSim);
    else S.betaCont = tiltFromEq(S.L);

    var pNow = Math.min(S.betaCont, Math.PI - S.betaCont);   /* 无向的面倾角 */
    var pTgt, br;

    if (S.quant) {
      /* 量子数 m 只在弛豫时演化, 而且只由"与驱动器无关"的布洛赫解决定。
       * 不弛豫时把它锁住 —— 若用被驱动过的几何倾角反推 m, 会形成
       * "驱动→改变倾角→改变 m→改变目标→再驱动" 的正反馈, 状态会自己往上爬。 */
      if (S.relax || S.mNow < 0) S.mNow = mForBeta(S.betaCont, S.lq);
      var pb = allowedBetas(S.lq)[clamp(S.mNow + S.lq, 0, 2 * S.lq)];
      pTgt = Math.min(pb, Math.PI - pb);
      br = (pb > Math.PI / 2) ? 1 : -1;
    } else {
      pTgt = pNow;
      br = (S.betaCont > Math.PI / 2) ? 1 : -1;
    }

    if (S.relax && S.Tau > 0) {
      S.betaDisp += (pTgt - S.betaDisp) * clamp(dtWall / 0.10, 0, 1);  /* 量子跃迁 0.1s 过渡 */
      relaxTilt();
    } else if (S.quant) {
      S.betaDisp = pTgt;              /* 只开量子化: 轨道面被约束在允许的锥上 */
      relaxTilt();
    } else {
      S.betaDisp = pNow;              /* 都不开: 保持精确积分, 不动轨道面 */
    }
    S.branch = br;

    /* 观测量 */
    var L = PH.angularMomentum(S);
    var phi = Math.atan2(L[1], L[0]);
    if (S.phiPrev === null) S.phiPrev = phi;
    S.phiAcc += PH.unwrap(S.phiPrev, phi);
    S.phiPrev = phi;
    S.L = L; S.Lmag = V.len(L); S.rmag = PH.radius(S);
    S.thetaNow = Math.acos(clamp(V.unit(L)[2], -1, 1));   /* 当前真实倾角 ∠(L, +Z) */
    /* 绘制用矢量 S.Ldraw —— 它同时决定"箭头方向"和"轨道面法线", 二者必须共用同一个
     * 法线, 否则画出来的 μ 就不垂直于画出来的轨道面 (μ = -L/2 是严格反平行的)。
     * 方向由(可能已被量子化 snap 的)面倾角 + 有向分支重建; 长度 ∝ |⟨L⟩|,
     * 所以反转恢复时箭头会缩成一个点再反向长出来。 */
    S.mag = 1;
    if (S.relax || S.quant) {
      /* betaCont 是"与 -Z 的夹角", 而绘制方向要的是"与 +Z 的夹角":
       *   branch=+1 (L 在 +Z 侧, beta>90): 与 +Z 夹角 = 面倾角
       *   branch=-1 (L 在 -Z 侧, beta<90): 与 +Z 夹角 = 180 - 面倾角
       * 两者在 beta=90 处连续对接, 分支切换不会有跳变。 */
      var gam = (S.branch > 0) ? S.betaDisp : (Math.PI - S.betaDisp);
      var azd = Math.atan2(L[1], L[0]);
      S.Ldraw = [Math.sin(gam) * Math.cos(azd), Math.sin(gam) * Math.sin(azd), Math.cos(gam)];
      S.mag = S.relax ? Math.hypot(S.bp, S.bz) / (S.L0mag || 1) : 1;
    } else {
      S.Ldraw = V.unit(L);
    }
    S.dE = Math.abs((PH.energy(S) - S.E0) / S.E0);
    S.wMeas = S.t > 4 ? S.phiAcc / S.t : S.B / 2;

    /* ---- 记录: L 矢端轨迹(弛豫时画出内收螺线) 与 横向相干曲线(FID 包络) ---- */
    if (S.relax || S.quant) {
      var Ud = S.Ldraw || V.unit(L);
      var mL2 = 1.55 * (S.mag === undefined ? 1 : S.mag);
      var tp = V.mul(Ud, mL2);
      S.tipTrace.push(tp);
      if (S.tipTrace.length > 3000) S.tipTrace.splice(0, S.tipTrace.length - 3000);
    } else if (S.tipTrace.length) {
      S.tipTrace.length = 0;
    }
    /* 记录: 纵向磁化 M_z 与横向磁化 |M⊥|, 两条曲线各有自己的时间常数 */
    S.cohHist.push([S.t, clamp(-S.bz / (S.L0mag || 1), -1, 1), clamp(S.bp / (S.L0mag || 1), 0, 1)]);
    if (S.cohHist.length > 1400) S.cohHist.splice(0, S.cohHist.length - 1400);
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

    /* 球面带: 电子轨迹的极角包络 [90-theta, 90+theta]。theta 必须用当前倾角,
     * 否则弛豫时带子不跟着变。 */
    if (ui.band) {
      var thB = (S.thetaNow === undefined) ? S.theta : S.thetaNow;
      var th1 = Math.PI / 2 - thB, th2 = Math.PI / 2 + thB;
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
    /* B 轴箭头 + 标签 (显式标出这就是 Z 轴) */
    var pt = project([0, 0, 2.05]);
    if (pt.vis) {
      sprite(pt.x, pt.y, 22, COL.axis, 0.42);
      text('Z', pt.x + 15, pt.y - 12, 21, rgba(COL.axis, 0.98), 'left', true);
      text('B \u2225 Z', pt.x + 15, pt.y + 10, 14, rgba(COL.axis, 0.75), 'left', false);
    }
    /* 坐标轴 X / Y (赤道面内), 给"绕 Z 转"一个绝对参考 */
    if (ui.axes) {
      var LA = 1.40, k2, ax = [[[-LA, 0, 0], [LA, 0, 0], 'X'], [[0, -LA, 0], [0, LA, 0], 'Y']];
      for (k2 = 0; k2 < 2; k2++) {
        polyAll(ax[k2], COL.xyz, 0.22, 1);
        var q = project(ax[k2][1]);
        if (q.vis) text(ax[k2][2], q.x + 7, q.y - 7, 14, rgba(COL.xyz, 0.78), 'left', false);
      }
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
        strokeRange(S.hist, i0, i1, decC, COL.trailA, 0.012 + 0.40 * Math.pow(age, 3.2), 0.35 + 1.2 * age);
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

  /* ============ 空间量子化: 2l+1 个允许的进动锥 ============ */
  function drawAllowedCones() {
    if (!S.quant || !ui.quant) return;
    var l = S.lq, n = Math.sqrt(l * (l + 1)), len = 1.55, N = 72, i, ph, m;
    for (m = -l; m <= l; m++) {
      var ct = m / n, st = Math.sqrt(Math.max(0, 1 - ct * ct));
      var zz = len * ct, rr = len * st, pts = [];
      for (i = 0; i <= N; i++) { ph = i / N * TAU; pts.push([rr * Math.cos(ph), rr * Math.sin(ph), zz]); }
      var cur = (m === S.mNow);
      if (ctx.setLineDash) ctx.setLineDash([5, 7]);
      polyAll(pts, COL.quant, cur ? 0.62 : 0.16, cur ? 1.7 : 1);
      if (ctx.setLineDash) ctx.setLineDash([]);
      if (cur) polyAll(pts, COL.quant, 0.10, 7);
      var p = project([rr, 0, zz]);
      if (p.vis) text('m=' + (m > 0 ? '+' : '') + m, p.x + 6, p.y - 7, 12,
                      rgba(COL.quant, cur ? 0.98 : 0.45), 'left', cur);
    }
  }

  /* 原轨道面鬼影: 让"相对于开始转过了多少"看得见 */
  function drawGhostOrbit() {
    if (!ui.ghost) return;
    var b = basis(S.L0), u = b[1], w = b[2];
    var R = S.rmag, pts = [], i, a2;
    for (i = 0; i <= 72; i++) { a2 = i / 72 * TAU; pts.push(V.add(V.mul(u, R * Math.cos(a2)), V.mul(w, R * Math.sin(a2)))); }
    if (ctx.setLineDash) ctx.setLineDash([6, 8]);
    polyAll(pts, COL.ghost, 0.40, 1.3);
    if (ctx.setLineDash) ctx.setLineDash([]);
  }

  /* ============ 进动相位盘: 让"绕 Z 轴匀速转动"成为画面最明确的信息 ============ */
  function drawPrecessionDial() {
    if (!ui.dial) return;
    var a = S.Ldraw || V.unit(S.L), len = 1.55 * (S.mag === undefined ? 1 : S.mag);
    var zL = len * a[2];
    var rL = Math.hypot(len * a[0], len * a[1]);
    if (rL < 0.02) return;
    var i, N = 96, pts = [], ph;

    /* L 矢端的水平轨迹圆 (= 进动锥的边沿) */
    for (i = 0; i <= N; i++) { ph = i / N * TAU; pts.push([rL * Math.cos(ph), rL * Math.sin(ph), zL]); }
    polyAll(pts, COL.dial, 0.34, 1.2);
    polyAll(pts, COL.dial, 0.055, 8);

    /* 残影弧: 从当前相位往回 1.5π, 分 4 段渐隐 —— 直接读出转向和快慢 */
    var ph0 = Math.atan2(a[1], a[0]), seg, K = 14;
    for (seg = 0; seg < 4; seg++) {
      var f0 = seg / 4, f1 = (seg + 1) / 4, arc = [];
      for (i = 0; i <= K; i++) {
        var f = f0 + (f1 - f0) * i / K;
        var p2 = ph0 - f * Math.PI * 1.5;
        arc.push([rL * Math.cos(p2), rL * Math.sin(p2), zL]);
      }
      arc.reverse();
      polyAll(arc, COL.dialA, 0.60 * (1 - seg / 4.6), 2.8 - seg * 0.55);
    }

    /* 相位半径: 从 Z 轴上的一点拉到 L 矢端 */
    var tip = V.mul(a, len);
    polyAll([[0, 0, zL], tip], COL.dial, 0.40, 1.2);

    /* L 矢端的历史轨迹: 弛豫时它就是那条"向内收的对数螺线" */
    var tt = S.tipTrace, nt = tt.length;
    if (nt > 3) {
      var nb = 6, bk2;
      for (bk2 = 0; bk2 < nb; bk2++) {
        var j0 = Math.floor(nt * bk2 / nb), j1 = Math.floor(nt * (bk2 + 1) / nb);
        var ag = (bk2 + 0.5) / nb;
        strokeRange(tt, j0, j1, nt > 900 ? 2 : 1, COL.relax, 0.10 + 0.75 * ag * ag, 0.8 + 2.4 * ag);
      }
    }

    /* 切向箭头 + ω_L 标签, 指明绕 Z 的转向 */
    var phA = ph0 + 0.50;
    var pa = [rL * Math.cos(phA), rL * Math.sin(phA), zL];
    var pb = V.add(pa, [-0.20 * Math.sin(phA), 0.20 * Math.cos(phA), 0]);
    var pA = project(pa), pB = project(pb);
    if (pA.vis && pB.vis) {
      var dx = pB.x - pA.x, dy = pB.y - pA.y, dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      ctx.beginPath();
      ctx.moveTo(pA.x + dx * 9, pA.y + dy * 9);
      ctx.lineTo(pA.x - dx * 3 - dy * 5.5, pA.y - dy * 3 + dx * 5.5);
      ctx.lineTo(pA.x - dx * 3 + dy * 5.5, pA.y - dy * 3 - dx * 5.5);
      ctx.closePath(); ctx.fillStyle = rgba(COL.dialA, 0.95); ctx.fill();
      text('\u03c9_L', pA.x + dx * 18 + 2, pA.y + dy * 18 - 8, 15, rgba(COL.dialA, 0.95), 'left', true);
    }

    var pt = project(tip);
    if (pt.vis) sprite(pt.x, pt.y, 20, COL.dialA, 0.5);
  }

  /* ============================ 角标图 (弛豫 / 量子化) ============================ */
  function panel(x, y, w, h) {
    ctx.beginPath();
    var r = 10;
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(6,12,24,0.68)'; ctx.fill();
    ctx.strokeStyle = 'rgba(120,170,255,0.22)'; ctx.lineWidth = 1; ctx.stroke();
  }

  /* 纵向 M_z 与横向 |M⊥| 两条曲线, 各有自己的时间常数 T1 / T2 */
  function drawCohInset(x, y, w, h) {
    panel(x, y, w, h);
    text('\u78c1\u5316\u5f3a\u5ea6  M_z \u4e0e |M\u22a5|', x + 12, y + 15, 12, 'rgba(170,205,240,0.92)', 'left', false);
    text('T\u2081 ' + (S.T1 / TAU).toFixed(0) + ' \u5708   T\u2082 ' + (S.Tau / TAU).toFixed(0) + ' \u5708',
         x + w - 12, y + 15, 11.5, 'rgba(170,205,240,0.9)', 'right', false);
    var pad = 12, gx = x + pad + 26, gy = y + 28, gw = w - pad * 2 - 34, gh = h - 28 - 22;
    /* 纵轴: +1 (平衡) .. -1 (反转) */
    ctx.strokeStyle = 'rgba(120,170,255,0.18)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx, gy + gh); ctx.lineTo(gx + gw, gy + gh); ctx.stroke();
    var y0 = gy + gh * 0.5;                       /* 零线 */
    ctx.beginPath(); ctx.moveTo(gx, y0); ctx.lineTo(gx + gw, y0);
    ctx.strokeStyle = 'rgba(120,170,255,0.13)'; ctx.stroke();
    text('+1', gx - 6, gy + 4, 9.5, 'rgba(140,170,205,0.75)', 'right', false);
    text('0', gx - 6, y0, 9.5, 'rgba(140,170,205,0.75)', 'right', false);
    text('\u22121', gx - 6, gy + gh - 4, 9.5, 'rgba(140,170,205,0.75)', 'right', false);

    var n = S.cohHist.length;
    if (n < 3) return;
    var i, t0 = S.cohHist[0][0], t1 = S.cohHist[n - 1][0], dt = Math.max(t1 - t0, 1e-6);
    var px = function (t) { return gx + gw * (t - t0) / dt; };
    var py = function (v) { return y0 - gh * 0.5 * clamp(v, -1, 1); };

    if (S.relax) {                                 /* 解析参考(虚线) */
      if (ctx.setLineDash) ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(180,210,255,0.42)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (i = 0; i < n; i++) {
        var t3 = S.cohHist[i][0] - t0;
        var a1 = 1 + (S.mz0 - 1) * Math.exp(-t3 / S.T1);
        if (i === 0) ctx.moveTo(px(S.cohHist[i][0]), py(a1)); else ctx.lineTo(px(S.cohHist[i][0]), py(a1));
      }
      ctx.stroke();
      ctx.beginPath();
      for (i = 0; i < n; i++) {
        var t4 = S.cohHist[i][0] - t0;
        var a2 = S.mp0 * Math.exp(-t4 / S.Tau);
        if (i === 0) ctx.moveTo(px(S.cohHist[i][0]), py(a2)); else ctx.lineTo(px(S.cohHist[i][0]), py(a2));
      }
      ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);
    }
    /* 实测: M_z (琥珀) 与 |M⊥| (绿) */
    ctx.beginPath();
    for (i = 0; i < n; i++) {
      var X = px(S.cohHist[i][0]), Y = py(S.cohHist[i][1]);
      if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.strokeStyle = rgba(COL.quant, 0.95); ctx.lineWidth = 1.8; ctx.stroke();
    ctx.beginPath();
    for (i = 0; i < n; i++) {
      var X2 = px(S.cohHist[i][0]), Y2 = py(S.cohHist[i][2]);
      if (i === 0) ctx.moveTo(X2, Y2); else ctx.lineTo(X2, Y2);
    }
    ctx.strokeStyle = rgba(COL.relax, 0.96); ctx.lineWidth = 1.8; ctx.stroke();
    /* 图例 */
    ctx.fillStyle = rgba(COL.quant, 0.95); ctx.fillRect(x + 12, y + h - 11, 10, 3);
    text('M_z', x + 26, y + h - 9, 10, rgba(COL.quant, 0.9), 'left', false);
    ctx.fillStyle = rgba(COL.relax, 0.95); ctx.fillRect(x + 62, y + h - 11, 10, 3);
    text('|M\u22a5|', x + 76, y + h - 9, 10, rgba(COL.relax, 0.9), 'left', false);
  }

  /* m 能级梯: E_m = m·omega_L, 基态 m = -l, 只有 dm = ±1 的磁偶极跃迁 */
  function drawLadderInset(x, y, w, h) {
    panel(x, y, w, h);
    var l = S.lq;
    text('m \u80fd\u7ea7\u68af   l = ' + l + '   (2l+1 = ' + (2 * l + 1) + ')', x + 12, y + 15, 12, 'rgba(170,205,240,0.92)', 'left', false);
    text('\u0394E = \u0127\u03c9_L', x + w - 12, y + 15, 11, 'rgba(150,180,215,0.85)', 'right', false);
    var top = y + 34, bot = y + h - 26, n2 = 2 * l, m;
    for (m = -l; m <= l; m++) {
      var f = (m + l) / Math.max(n2, 1);
      var ly = bot - f * (bot - top);
      var cur = (m === S.mNow);
      ctx.beginPath(); ctx.moveTo(x + 40, ly); ctx.lineTo(x + w - 16, ly);
      ctx.strokeStyle = rgba(cur ? COL.quant : COL.ladder, cur ? 0.98 : 0.34); ctx.lineWidth = cur ? 2.2 : 1;
      ctx.stroke();
      if (m === -l) text('\u57fa\u6001', x + w - 16, ly + 9, 9.5, 'rgba(150,180,215,0.6)', 'right', false);
      if (cur) {
        ctx.fillStyle = rgba(COL.quant, 0.95);
        ctx.beginPath(); ctx.arc(x + 40, ly, 3.6, 0, TAU); ctx.fill();
      }
      text((m > 0 ? '+' : '') + m, x + 32, ly, 11, rgba(cur ? COL.quant : COL.ladder, cur ? 0.98 : 0.55), 'right', cur);
    }
    text('\u0394m = \u00b11 \u2192 \u78c1\u5076\u6781\u8dc3\u8fc1', x + 12, y + h - 9, 10.5, 'rgba(150,180,215,0.8)', 'left', false);
    text('\u5f53\u524d m = ' + (S.mNow > 0 ? '+' : '') + S.mNow, x + w - 12, y + h - 9, 10.5, rgba(COL.quant, 0.9), 'right', false);
  }

  function drawInsets() {
    var s = Math.max(0.55, Math.min(view.w / 1500, view.h / 900));
    var both = (S.relax && S.quant && ui.relaxPanel && ui.quantPanel);
    var w = 330 * s, h = 132 * s, y = 22 * s;
    if (both) {
      drawCohInset(view.cx - w - 8 * s, y, w, h);
      drawLadderInset(view.cx + 8 * s, y, w, h);
    } else if (S.relax && ui.relaxPanel) {
      drawCohInset(view.cx - w / 2, y, w, h);
    } else if (S.quant && ui.quantPanel) {
      drawLadderInset(view.cx - w / 2, y, w, h);
    }
  }

  function drawOrbit() {
    /* 法线必须与 drawVectors 画箭头用的是同一个 (S.Ldraw),
     * 否则 μ 看起来不垂直于轨道面。 */
    var n = V.unit(S.Ldraw || S.L), b = basis(n), u = b[1], w = b[2];
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

  /* 在圆锥边沿挑一个屏幕位置最靠边的点, 标出这个锥是谁的 */
  function coneTag(axis, half, len, label, col) {
    var ab = basis(axis), a = ab[0], u = ab[1], w = ab[2];
    var ca = Math.cos(half), sa = Math.sin(half);
    var best = null, bx = -1e9, i, ph, d, p;
    for (i = 0; i < 12; i++) {
      ph = i / 12 * TAU;
      d = [ca * a[0] + sa * (Math.cos(ph) * u[0] + Math.sin(ph) * w[0]),
           ca * a[1] + sa * (Math.cos(ph) * u[1] + Math.sin(ph) * w[1]),
           ca * a[2] + sa * (Math.cos(ph) * u[2] + Math.sin(ph) * w[2])];
      p = project(V.mul(d, len * 1.06));
      if (p.vis && p.x > bx) { bx = p.x; best = p; }
    }
    if (best) text(label, best.x + 8, best.y, 13, rgba(col, 0.92), 'left', true);
  }

  var spinDir = [0, 0, 1];
  function updateSpin() {
    var th = (S.thetaNow === undefined) ? S.theta : S.thetaNow;
    var az = S.t * (PH.G_SPIN * S.B / 2);
    var ca = Math.cos(az), sa = Math.sin(az);
    var x = Math.sin(th) * 0, y = Math.sin(th) * 1, z = Math.cos(th);
    spinDir = [x * ca - y * sa, x * sa + y * ca, z];
  }

  function drawVectors() {
    /* --- 对顶双锥 ---
     * 方向用绘制用矢量 U (= 系综平均 ⟨L⟩ 的方向), 斜高乘 |⟨L⟩| —— 退相干时整个锥塌掉。 */
    var U = S.Ldraw || V.unit(S.L);
    var mLen = 1.55 * (S.mag === undefined ? 1 : S.mag);
    if (mLen < 0.004) mLen = 0.004;
    var thU = Math.acos(clamp(U[2], -1, 1));
    if (ui.cone) {
      var h = Math.min(thU, Math.PI - thU);
      var lax = (thU <= Math.PI / 2) ? [0, 0, 1] : [0, 0, -1];
      var max2 = (thU <= Math.PI / 2) ? [0, 0, -1] : [0, 0, 1];
      if (h > 0.006) {
        drawCone(lax, h, mLen, COL.L, ui.coneA);
        drawCone(max2, h, mLen * 0.5, COL.mu, ui.coneA);
        /* 在锥的边沿直接标出归属。量子化打开时, 这对进动锥会和某两根
         * 允许的 m 锥精确重合(同一个曲面), 不标清楚就极易看错谁是谁。 */
        coneTag(lax, h, mLen, 'L \u8fdb\u52a8\u9525', COL.L);
        if (ui.mu) coneTag(max2, h, mLen * 0.5, '\u03bc \u8fdb\u52a8\u9525', COL.mu);
      }
    }
    /* --- 角动量 ⟨L⟩ --- */
    drawArrow(U, mLen, COL.L, [255, 250, 235], 'L', 1);
    /* --- 磁矩 ⟨μ⟩ = -⟨L⟩/2 (原子单位的真实比例) --- */
    if (ui.mu) drawArrow(V.mul(U, -1), mLen * 0.5, COL.mu, [255, 235, 245], '\u03bc', 1);
    /* --- 自旋 S --- */
    if (ui.spin) {
      updateSpin();
      drawArrow(spinDir, 0.95, COL.spin, [245, 240, 255], 'S', 1);
      var b = basis([0, 0, 1]), u = b[1], w = b[2];
      var pts = [], i, a2, R = 0.95 * Math.sin(thU), zz = 0.95 * Math.cos(thU);
      for (i = 0; i <= 72; i++) { a2 = i / 72 * TAU; pts.push([R * Math.cos(a2), R * Math.sin(a2), zz]); }
      polyAll(pts, COL.spin, 0.20, 1);
    }
    /* --- theta 角弧 --- */
    var Lh = U;
    if (Math.abs(thU) > 0.02 && Math.abs(thU - Math.PI) > 0.02) {
      var arc = [], K = 26, T;
      for (i = 0; i <= K; i++) {
        T = i / K;
        var s1 = Math.sin((1 - T) * thU) / Math.sin(thU), s2 = Math.sin(T * thU) / Math.sin(thU);
        var d = V.add(V.mul([0, 0, 1], s1), V.mul(Lh, s2));
        arc.push(V.mul(d, 0.52));
      }
      polyAll(arc, COL.white, 0.42, 1.2);
    }
    var pm = project(V.mul(V.unit(V.add(V.mul([0, 0, 1], Math.cos(thU / 2)), V.mul(Lh, 1))), 0.60));
    if (pm.vis) text('\u03b8 = ' + (thU / DEG).toFixed(0) + '\u00b0', pm.x + 8, pm.y, 15, 'rgba(235,245,255,0.92)', 'left', false);
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
    drawGhostOrbit();
    drawTrail();
    drawOrbit();
    drawAllowedCones();
    drawVectors();
    drawPrecessionDial();
    drawElectron();
    ctx.globalCompositeOperation = 'source-over';
    drawInsets();
    if (ui.burn) drawOverlay();
  }

  /* ============================ UI ============================ */
  var ui = {
    sphere: true, band: true, cone: true, coneA: 0.85, mu: true, spin: false,
    field: true, trail: true, auto: false, burn: false,
    axes: true, dial: true, ghost: true,
    quant: true, relaxPanel: true, quantPanel: true
  };
  var el = {};
  function need(id) { var e = doc.getElementById(id); if (!e) throw new Error('missing element #' + id); return e; }
  function num(id) { var e = el[id]; return e ? parseFloat(e.value) : 0; }
  function chk(id) { var e = el[id]; return e ? !!e.checked : false; }

  function setupUI() {
    ['r-ratio', 'r-theta', 'r-speed', 'r-trail',
     'c-sphere', 'c-band', 'c-cone', 'c-mu', 'c-spin', 'c-field', 'c-trail', 'c-auto',
     'b-pause', 'b-reset', 'b-cam', 'b-png', 'l-ratio', 'l-speed',
     'r-res', 'r-fps', 'r-dur', 'c-reset', 'c-burn', 'b-rec', 'v-rec', 'v-recbar',
     'c-axes', 'c-dial', 'c-ghost', 'b-v1', 'b-v2', 'b-v3',
     'c-relax', 'r-t1', 'r-t2p', 'c-quant', 'r-l', 'l-t1', 'l-t2p', 'l-t2', 'l-l',
     'c-panels', 'b-pulse', 'b-pulse-pi'
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
    bindChk('c-axes', 'axes'); bindChk('c-dial', 'dial'); bindChk('c-ghost', 'ghost');
    el['c-panels'].addEventListener('change', function () {
      ui.relaxPanel = ui.quantPanel = !!el['c-panels'].checked;
    });
    ui.relaxPanel = ui.quantPanel = !!el['c-panels'].checked;

    /* --- 弛豫 / 空间量子化 --- */
    /* T1: 纵向(自旋-晶格)弛豫时间, 4 .. 1200 公转周期 (对数) */
    function t1FromSlider(v) { return 4 * Math.pow(10, v / 40) * TAU; }
    /* 纯退相位速率 1/T2', 0 = 无纯退相位 (此时 T2 = 2T1) */
    function rate2pFromSlider(v) { return v / 100 * 0.5 / TAU; }
    function relLabels() {
      if (el['l-t1']) el['l-t1'].textContent = (S.T1 / TAU).toFixed(0) + ' \u5708';
      var r = S.rate2p;
      if (el['l-t2p']) el['l-t2p'].textContent = r <= 0 ? '\u65e0\uff08T\u2082 = 2T\u2081\uff09' : (1 / r / TAU).toFixed(0) + ' \u5708';
      if (el['l-t2']) el['l-t2'].textContent = (S.Tau / TAU).toFixed(0) + ' \u5708';
    }
    /* π/2 脉冲: 把磁矩扳到横向平面 (FID / T2 的起点) */
    function pulse(thetaDeg) {
      S.thetaDeg = thetaDeg; S.theta = thetaDeg * Math.PI / 180;
      if (el['r-theta']) el['r-theta'].value = String(thetaDeg);
      reset();
    }
    el['b-pulse'].addEventListener('click', function () { pulse(90); });
    el['b-pulse-pi'].addEventListener('click', function () { pulse(0); });   /* π 脉冲: 反转, 看 T1 */
    el['c-relax'].addEventListener('change', function () {
      S.relax = !!el['c-relax'].checked;
      if (S.relax) {
        /* 按 FID 协议: 开启弛豫时自动打一个 π/2 脉冲 (θ -> 90°), 锥才是单调收口的。
         * 但如果 URL 显式给了 theta, 就尊重它 (例如 ?theta=0 做反转恢复)。 */
        if (!S.noPulse && Math.abs(S.theta - Math.PI / 2) > 0.25) pulse(90);
        syncRelax(); S.cohHist.length = 0; S.tipTrace.length = 0;
      }
      ui.relaxPanel = S.relax;
    });
    el['r-t1'].addEventListener('input', function () { S.T1 = t1FromSlider(parseFloat(el['r-t1'].value)); recomputeT2(); relLabels(); });
    el['r-t2p'].addEventListener('input', function () { S.rate2p = rate2pFromSlider(parseFloat(el['r-t2p'].value)); recomputeT2(); relLabels(); });
    S.T1 = t1FromSlider(parseFloat(el['r-t1'].value));
    S.rate2p = rate2pFromSlider(parseFloat(el['r-t2p'].value));
    recomputeT2(); relLabels();

    el['c-quant'].addEventListener('change', function () {
      S.quant = !!el['c-quant'].checked;
      if (S.quant) { syncRelax(); S.tipTrace.length = 0; }
      ui.quantPanel = S.quant;
    });
    el['r-l'].addEventListener('input', function () {
      S.lq = Math.max(1, Math.min(6, parseInt(el['r-l'].value, 10) || 2));
      if (el['l-l']) el['l-l'].textContent = 'l = ' + S.lq + '  (' + (2 * S.lq + 1) + ' \u4e2a\u9525)';
      syncRelax(); S.tipTrace.length = 0;
    });
    S.quant = !!el['c-quant'].checked;
    S.relax = !!el['c-relax'].checked;
    ui.relaxPanel = S.relax;
    S.lq = Math.max(1, Math.min(6, parseInt(el['r-l'].value, 10) || 2));
    if (el['l-l']) el['l-l'].textContent = 'l = ' + S.lq + '  (' + (2 * S.lq + 1) + ' \u4e2a\u9525)';

    /* 视角预设: 侧视 / 45° 俯视 / 沿 Z 俯视 */
    function setCam(az, el2, zm) {
      cam.az = az; cam.el = el2; if (zm) cam.zoom = zm;
      ui.auto = false; if (el['c-auto']) el['c-auto'].checked = false;
    }
    el['b-v1'].addEventListener('click', function () { setCam(-1.02, 0.10, 1); });
    el['b-v2'].addEventListener('click', function () { setCam(-1.02, 0.62, 1); });
    el['b-v3'].addEventListener('click', function () { setCam(-1.02, 1.32, 1); });

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
    hud('v-theta', ((S.thetaNow === undefined ? S.theta : S.thetaNow) / DEG).toFixed(1) + '\u00b0');
    hud('v-Lmag', S.Lmag.toFixed(6));
    hud('v-rmag', S.rmag.toFixed(6));
    hud('v-dE', S.dE.toExponential(1));
    hud('v-wmeas', S.wMeas.toFixed(8));
    hud('v-wtheo', wL.toFixed(8));
    hud('v-werr', S.relax ? '\u2014' : (werr * 100).toFixed(3) + '%');
    hud('v-werr2', S.relax
      ? '\u5f1b\u8c6b\u4e2d L \u5411 \u2212Z \u6536\u62e2\uff0c\u8fdb\u52a8\u9891\u7387\u6d4b\u91cf\u4e0d\u518d\u9002\u7528'
      : 'O(B\u00b2) \u4fee\u6b63: ' + ((S.wMeas - wL) / (wL * wL)).toFixed(3) + ' \u00d7 \u03c9_L\u00b2  (\u5b9a\u7406\u53ea\u4fdd\u8bc1\u4e00\u9636)');
    hud('v-bre', Breal.toExponential(2) + ' T');
    hud('v-bghz', (wLreal / TAU / 1e9).toFixed(1) + ' GHz');
    hud('v-zeeman', (Breal * PH.BOHR_MU_EV_PER_T).toExponential(3) + ' eV');
    hud('v-optrun', orbitsPerTurn.toFixed(0) + ' 圈');
    var B1 = 1 / PH.AU_BFIELD;
    hud('v-1T', (B1 / 2).toExponential(2) + ' / ' + (1 / (B1 / 2)).toExponential(2) + ' 圈');
    hud('v-mag', (Breal / 9.402e3).toFixed(0) + ' \u00d7');
    hud('v-fps', fps.toFixed(0));

    /* --- 弛豫 / 量子化 读数 --- */
    var psi = tiltFromEq(S.L);
    var mz = clamp(-S.bz / (S.L0mag || 1), -1, 1), mp = clamp(S.bp / (S.L0mag || 1), 0, 1);
    hud('v-beta', (psi / DEG).toFixed(1) + '\u00b0');
    hud('v-sinb', S.relax ? mp.toFixed(4) : '\u2014');
    hud('v-sinb-ref', S.relax ? (S.mp0 * Math.exp(-S.t / S.Tau)).toFixed(4) : '\u2014');
    hud('v-mz', S.relax ? mz.toFixed(4) : '\u2014');
    hud('v-mz-ref', S.relax ? (1 + (S.mz0 - 1) * Math.exp(-S.t / S.T1)).toFixed(4) : '\u2014');
    hud('v-t1', (S.T1 / TAU).toFixed(1) + ' \u5708');
    hud('v-t2p', S.rate2p <= 0 ? '\u221e (\u65e0\u7eaf\u9000\u76f8\u4f4d)' : (1 / S.rate2p / TAU).toFixed(1) + ' \u5708');
    hud('v-tau', (S.Tau / TAU).toFixed(1) + ' \u5708');
    hud('v-t2bound', '2T\u2081 = ' + (2 * S.T1 / TAU).toFixed(0) + ' \u5708  \u2265 T\u2082 \u2713');
    hud('v-lq', 'l = ' + S.lq);
    hud('v-ncone', String(2 * S.lq + 1));
    hud('v-mina', S.quant ? (Math.acos(clamp(S.lq / Math.sqrt(S.lq * (S.lq + 1)), -1, 1)) / DEG).toFixed(1) + '\u00b0' : '\u2014');
    hud('v-m', S.quant ? ('m = ' + (S.mNow > 0 ? '+' : '') + S.mNow) : '\u2014');
    /* 绘制方向与物理轨道法线的夹角: 量化/弛豫开启时的跟踪误差(死区内 <~1.5°) */
    var uL = V.unit(S.Ldraw || S.L), uP = V.unit(S.L);
    var dp = Math.abs(uL[0] * uP[0] + uL[1] * uP[1] + uL[2] * uP[2]);
    hud('v-lm', (Math.acos(clamp(dp, -1, 1)) * 180 / Math.PI).toFixed(2) + '\u00b0');
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
    /* 这三个必须在 setupUI() 之前设置, 否则状态不会同步 */
    if (P.burn === '1') { var cb0 = document.getElementById('c-burn'); if (cb0) cb0.checked = true; }
    if (P.relax === '1') { var cr0 = document.getElementById('c-relax'); if (cr0) cr0.checked = true; }
    if (P.quant === '1') { var cq0 = document.getElementById('c-quant'); if (cq0) cq0.checked = true; }
    if (P.panels === '0') { var cp0 = document.getElementById('c-panels'); if (cp0) cp0.checked = false; }
    if (P.theta !== undefined) { app.state.thetaDeg = parseFloat(P.theta); app.state.theta = app.state.thetaDeg * Math.PI / 180; app.state.noPulse = 1; }
    if (P.ratio !== undefined) { app.state.Btarget = 2 * parseFloat(P.ratio); app.state.B = app.state.Btarget; }
    if (P.trail !== undefined) app.state.trailFrac = Math.max(0, Math.min(1, parseFloat(P.trail) / 100));
    if (P.l !== undefined) app.state.lq = Math.max(1, Math.min(6, parseInt(P.l, 10) || 2));

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
    if (P.burn === '1') app.ui.burn = true;
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
    }    var last = (window.performance && performance.now) ? performance.now() : Date.now();
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
