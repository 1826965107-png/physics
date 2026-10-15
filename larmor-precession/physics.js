/* ============================================================================
 *  physics.js  —  拉莫尔进动的精确经典动力学
 * ============================================================================
 *  原子单位 (a.u.):  m_e = e = hbar = 1,  核电荷 Z = 1,  1/(4*pi*eps0) = 1
 *
 *  取 Bohr 半径 a0 为长度单位、电子质量为质量单位时:
 *      圆轨道 r = 1  ==>  v = 1,  omega0 = 1,  周期 T0 = 2*pi,  E = -0.5
 *      1 a.u. 频率 = E_h/hbar   = 4.1341373335e16 rad/s
 *      1 a.u. 磁场 = hbar/(e a0^2) = 2.3505175676e5 T
 *
 *  运动方程 (电子电荷 q = -1，核在原点):
 *      dr/dt = v
 *      dv/dt = -r/|r|^3  -  v x B          <-- 精确洛伦兹力 + 库仑力
 *
 *  *** 这里对 B 不做任何展开、不做任何近似 ***
 *  拉莫尔进动 (omega_L = eB/2m = B/2) 是从积分结果里"涌现"的，
 *  不是被硬塞进去的。因此可以拿它反过来检验拉莫尔定理。
 * ==========================================================================*/
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LarmorPhysics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- 单位换算常数 ---------------- */
  var AU_FREQ          = 4.1341373335e16;   // rad/s   : a.u. 角频率 -> SI
  var AU_BFIELD        = 2.3505175676e5;    // T       : a.u. 磁感应强度 -> SI
  var GHZ_PER_T_ORB    = 13.99624;          // GHz/T   : omega_L/2pi = (e/2m)B
  var GHZ_PER_T_SPIN   = 27.99249;          // GHz/T   : g/2 * (e/m) B,  g=2.0023
  var G_SPIN           = 2.00231930436;     // 电子自旋 g 因子
  var BOHR_MU_EV_PER_T = 5.7883818012e-5;   // eV/T    : mu_B

  /* ---------------- 向量小工具 ---------------- */
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function nrm(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var l = nrm(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  /* ---------------- 加速度场 ---------------- */
  /* a = -r/|r|^3 - v x B   (库仑 + 洛伦兹, 电子电荷 -1) */
  function accel(rx, ry, rz, vx, vy, vz, Bx, By, Bz, out) {
    var r2 = rx * rx + ry * ry + rz * rz;
    var inv3 = 1 / (r2 * Math.sqrt(r2));
    out[0] = -rx * inv3 - (vy * Bz - vz * By);
    out[1] = -ry * inv3 - (vz * Bx - vx * Bz);
    out[2] = -rz * inv3 - (vx * By - vy * Bx);
    return out;
  }

  /* ---------------- 初值: 磁场中一阶圆轨道 ----------------
   * B 沿 +z。轨道面法线 n = (sin t, 0, cos t)，即 L 与 B 夹角为 theta。
   * 轨道面内正交基:  e1 = (cos t, 0, -sin t)   e2 = n x e1 = (0,1,0)
   * 取 r = r0*e1,  v = v0*e2  ==>  L = r x v = r0*v0*n  (沿 +z 侧, theta 处)
   *
   * v0 的选取很关键。在 r = r0 处做径向力平衡:
   *      向心 v0^2/r0 = 库仑 1/r0^2 + 磁场内向分量 v0*B*cos(theta)
   *   => v0 = 1/sqrt(r0) + B*cos(theta)/2
   * 这个 + (B/2)cos(theta) 正好等于"轨道角频率的塞曼平移" Δω = ω_L*cos(theta)。
   * 若取零场圆轨道速度 (v0 = 1/sqrt(r0))，由于 B 使公转变频，轨道会变成一个
   * O(B) 偏心率的进动椭圆 (物理同样正确, 但不符合"圆轨道刚性进动"的教科书图像)。
   * 这里取一阶精确的圆轨道初值，于是整条轨道以 omega_L 刚性进动,
   * 且旋转系中与零场轨道的偏差只有 O(B^2) —— 这正是拉莫尔定理的内容。
   */
  function createState(r0, theta, Bmag) {
    r0 = (r0 === undefined) ? 1 : r0;
    theta = theta || 0;
    Bmag = Bmag || 0;
    var ct = Math.cos(theta), st = Math.sin(theta);
    var v0 = 1 / Math.sqrt(r0) + 0.5 * Bmag * ct;
    return {
      r: [r0 * ct, 0, -r0 * st],
      v: [0, v0, 0]
    };
  }

  function cloneState(s) { return { r: s.r.slice(), v: s.v.slice() }; }

  /* ---------------- RK4 积分器 (预分配 scratch, 无 GC 压力) ---------------- */
  var a1 = [0, 0, 0], a2 = [0, 0, 0], a3 = [0, 0, 0], a4 = [0, 0, 0];
  var r2 = [0, 0, 0], r3 = [0, 0, 0], r4 = [0, 0, 0];
  var v2 = [0, 0, 0], v3 = [0, 0, 0], v4 = [0, 0, 0];

  function step(s, dt, B) {
    var r = s.r, v = s.v, h = dt, h2 = h * 0.5;
    var Bx = B[0], By = B[1], Bz = B[2], i;

    /* k1 */
    accel(r[0], r[1], r[2], v[0], v[1], v[2], Bx, By, Bz, a1);

    /* k2 */
    for (i = 0; i < 3; i++) { r2[i] = r[i] + h2 * v[i]; v2[i] = v[i] + h2 * a1[i]; }
    accel(r2[0], r2[1], r2[2], v2[0], v2[1], v2[2], Bx, By, Bz, a2);

    /* k3 */
    for (i = 0; i < 3; i++) { r3[i] = r[i] + h2 * v2[i]; v3[i] = v[i] + h2 * a2[i]; }
    accel(r3[0], r3[1], r3[2], v3[0], v3[1], v3[2], Bx, By, Bz, a3);

    /* k4 */
    for (i = 0; i < 3; i++) { r4[i] = r[i] + h * v3[i]; v4[i] = v[i] + h * a3[i]; }
    accel(r4[0], r4[1], r4[2], v4[0], v4[1], v4[2], Bx, By, Bz, a4);

    /* 组合 */
    var h6 = h / 6;
    for (i = 0; i < 3; i++) {
      r[i] += h6 * (v[i] + 2 * v2[i] + 2 * v3[i] + v4[i]);
      v[i] += h6 * (a1[i] + 2 * a2[i] + 2 * a3[i] + a4[i]);
    }
    return s;
  }

  /* ---------------- 可观测量 ---------------- */
  function angularMomentum(s) { return cross(s.r, s.v); }          // 单位: hbar
  function radius(s) { return nrm(s.r); }
  function energy(s) {                                             // 磁场不做功 => 守恒
    return 0.5 * dot(s.v, s.v) - 1 / nrm(s.r);
  }
  function speed(s) { return nrm(s.v); }
  /* 密切轨道偏心率矢量 (纯库仑假设):  e = v x L - r_hat ,  |e| = 偏心率 */
  function eccVec(s) {
    var L = cross(s.r, s.v), vxL = cross(s.v, L), rh = unit(s.r);
    return [vxL[0] - rh[0], vxL[1] - rh[1], vxL[2] - rh[2]];
  }
  function eccentricity(s) { return nrm(eccVec(s)); }

  /* L 绕 B 的方位角 (用于实测进动角速度) */
  function larmorPhase(L) { return Math.atan2(L[1], L[0]); }

  /* 理论拉莫尔角频率 (a.u.):  omega_L = (e/2m) B = B/2 */
  function larmorOmega(Bmag) { return Bmag / 2; }

  /* 把 L 的方位角差解开 2*pi 缠绕 */
  function unwrap(prev, next) {
    var d = next - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  return {
    AU_FREQ: AU_FREQ, AU_BFIELD: AU_BFIELD,
    GHZ_PER_T_ORB: GHZ_PER_T_ORB, GHZ_PER_T_SPIN: GHZ_PER_T_SPIN,
    G_SPIN: G_SPIN, BOHR_MU_EV_PER_T: BOHR_MU_EV_PER_T,
    accel: accel, createState: createState, cloneState: cloneState, step: step,
    angularMomentum: angularMomentum, radius: radius, energy: energy, speed: speed,
    eccVec: eccVec, eccentricity: eccentricity, larmorPhase: larmorPhase,
    larmorOmega: larmorOmega, unwrap: unwrap,
    cross: cross, dot: dot, nrm: nrm, unit: unit
  };
});
