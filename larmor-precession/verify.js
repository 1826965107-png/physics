/* ============================================================================
 *  verify.js — 数值验证 (node verify.js)
 *
 *  1) 实测 L 绕 B 的进动角速度, 与拉莫尔理论 omega_L = eB/2m = B/2 对比
 *     并验证偏差是 O(B^2) —— 拉莫尔定理的"一阶精确"含义
 *  2) 能量守恒 (磁场不做功 => E 必须严格守恒) 、|L| 漂移、轨道半径
 *  3) 拉莫尔定理直接检验: 把数值轨迹变换到"以 omega_L 绕 B 旋转"的参考系,
 *     应当与 B = 0 的解析圆轨道重合
 * ==========================================================================*/
'use strict';
const P = require('./physics.js');

function measure(rw, thetaDeg, periods, stepsPerOrbit) {
  const B = 2 * rw;                  // omega_L = B/2 = rw
  const theta = thetaDeg * Math.PI / 180;
  const s = P.createState(1, theta, B);   // 磁场中一阶圆轨道初值
  const Bv = [0, 0, B];
  const wL = B / 2;
  const dt = 2 * Math.PI / stepsPerOrbit;
  const Tend = periods * (2 * Math.PI / wL);
  const nSteps = Math.round(Tend / dt);

  const ct = Math.cos(theta), st = Math.sin(theta);
  const e1 = [ct, 0, -st], e2 = [0, 1, 0];

  const sampleEvery = Math.max(1, Math.round(stepsPerOrbit / 24));  // 24 采样/圈
  let t = 0, phiPrev = null, phiTot = 0;
  const ts = [], phis = [];
  let E0 = P.energy(s);
  const L0mag = P.nrm(P.angularMomentum(s));
  let dEmax = 0, dLmax = 0, rmin = Infinity, rmax = 0, emax = 0;
  let lamSum = 0, lamMax = 0, lamN = 0, lamRms2 = 0;

  for (let i = 1; i <= nSteps; i++) {
    P.step(s, dt, Bv);
    t += dt;

    const dE = Math.abs((P.energy(s) - E0) / E0);
    if (dE > dEmax) dEmax = dE;
    const L = P.angularMomentum(s);
    const dL = Math.abs(P.nrm(L) - L0mag) / L0mag;
    if (dL > dLmax) dLmax = dL;
    const r = P.radius(s);
    if (r < rmin) rmin = r;
    if (r > rmax) rmax = r;
    const e = P.eccentricity(s);
    if (e > emax) emax = e;

    /* --- 拉莫尔定理: 转到以 wL 绕 z 旋转的参考系, 与解析 B=0 圆轨道比较 ---
     * 注意检验窗口必须固定为"固定圈数"而不是"固定进动周期数"：
     * 频率误差是 O(B^2), 位置误差 ~ (频率误差)*t, 若窗口 t ∝ 1/B 就会把
     * O(B^2) 放大成 O(B)。这里固定 50 圈公转。 */
    if (t <= 50 * 2 * Math.PI) {
      const ph = wL * t, cp = Math.cos(ph), sp = Math.sin(ph);
      const rx = s.r[0] * cp + s.r[1] * sp;      // Rz(-ph) * r_num
      const ry = -s.r[0] * sp + s.r[1] * cp;
      const rz = s.r[2];
      const ax = Math.cos(t) * e1[0] + Math.sin(t) * e2[0];
      const ay = Math.cos(t) * e1[1] + Math.sin(t) * e2[1];
      const az = Math.cos(t) * e1[2] + Math.sin(t) * e2[2];
      const dev = Math.hypot(rx - ax, ry - ay, rz - az);
      lamSum += dev; lamRms2 += dev * dev; if (dev > lamMax) lamMax = dev; lamN++;
    }

    /* --- 进动相位采样 --- */
    if (i % sampleEvery === 0) {
      const p = P.larmorPhase(L);
      if (phiPrev !== null) phiTot += P.unwrap(phiPrev, p);
      phiPrev = p;
      ts.push(t); phis.push(phiTot);
    }
  }

  /* 最小二乘拟合 phi = w*t + c */
  const N = ts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < N; i++) { sx += ts[i]; sy += phis[i]; sxx += ts[i] * ts[i]; sxy += ts[i] * phis[i]; }
  const slope = (N * sxy - sx * sy) / (N * sxx - sx * sx);

  return {
    rw, B, wL, thetaDeg, orbitsPerTurn: 2 / B,
    wMeas: slope, relErr: (slope - wL) / wL, dAbs: slope - wL,
    dOverW2: (slope - wL) / (wL * wL),
    dE: dEmax, dL: dLmax, rmin, rmax, emax,
    lamRms: Math.sqrt(lamRms2 / lamN), lamMax
  };
}

console.log('=====================================================================');
console.log(' 拉莫尔进动 · 数值验证   精确洛伦兹力 + 库仑力, RK4 (原子单位)');
console.log(' 理论: omega_L = eB/2m = B/2 ,  圆轨道 omega_0 = 1');
console.log('=====================================================================');
console.log('');
console.log(' omega_L/omega_0 |  B(a.u.) | 进动1圈需公转 |   实测 omega_L |    理论 B/2 |   相对偏差 |  偏差/omega_L^2 |  能量漂移 |  |L|漂移');
console.log('-----------------+----------+--------------+----------------+-------------+-----------+-----------------+-----------+----------');

const rows = [];
for (const rw of [0.001, 0.002, 0.005, 0.01, 0.02, 0.04, 0.08]) {
  const m = measure(rw, 60, 2, 1200);
  rows.push(m);
  console.log(' ' + rw.toFixed(4).padStart(15) +
    ' | ' + m.B.toFixed(4).padStart(8) +
    ' | ' + m.orbitsPerTurn.toFixed(0).padStart(12) +
    ' | ' + m.wMeas.toFixed(9).padStart(14) +
    ' | ' + m.wL.toFixed(9).padStart(11) +
    ' | ' + (m.relErr * 100).toFixed(4).padStart(8) + '%' +
    ' | ' + m.dOverW2.toFixed(4).padStart(15) +
    ' | ' + m.dE.toExponential(1).padStart(9) +
    ' | ' + m.dL.toExponential(1).padStart(6));
}
console.log('');
console.log(' [解读] 相对偏差随 B 线性增长, 但 偏差/omega_L^2 近似恒定 ~0.25');
console.log('        ==> 实测 omega_L = (B/2)(1 + 0.25*B), 偏差是 O(B^2) 修正,');
console.log('            这正说明拉莫尔定理 omega_L = eB/2m 是"一阶精确"的。');
console.log('');

/* ---- 演示默认角度 theta = 30 deg 的同样检验 ---- */
console.log(' ===== 同样的检验 @ theta = 30 deg (演示默认倾角) =====');
console.log(' omega_L/omega_0 |   实测 omega_L |    理论 B/2 |   相对偏差 |  偏差/omega_L^2 |  能量漂移');
console.log('-----------------+----------------+-------------+-----------+-----------------+----------');
const rows30 = [];
for (const rw of [0.005, 0.01, 0.02, 0.04]) {
  const m = measure(rw, 30, 2, 1200);
  rows30.push(m);
  console.log(' ' + rw.toFixed(4).padStart(15) +
    ' | ' + m.wMeas.toFixed(9).padStart(14) +
    ' | ' + m.wL.toFixed(9).padStart(11) +
    ' | ' + (m.relErr * 100).toFixed(4).padStart(8) + '%' +
    ' | ' + m.dOverW2.toFixed(4).padStart(15) +
    ' | ' + m.dE.toExponential(1).padStart(9));
}
console.log('');
console.log(' [解读] 偏差/omega_L^2 在 theta = 30 deg 时恒定在 ~0.43 (theta = 60 deg 时是 ~0.25)。');
console.log('        O(B^2) 前面的系数依赖倾角 theta, 但"偏差是 O(B^2)"这一点与 theta 无关,');
console.log('        所以拉莫尔定理 omega_L = eB/2m 在任何倾角下都是一阶精确的。');
console.log('');
console.log(' ===== 拉莫尔定理直接检验 (theta = 60 deg, 固定 50 圈公转窗口) =====');
console.log(' 旋转系(Omega = omega_L 绕 B)中, 数值轨迹 vs B=0 解析圆轨道');
console.log('');
console.log(' omega_L/omega_0 |   RMS 偏差   |   最大偏差   |  RMS偏差/omega_L^2 |  RMS偏差/omega_L');
console.log('-----------------+--------------+--------------+--------------------+----------------');
for (const m of rows) {
  console.log(' ' + m.rw.toFixed(4).padStart(15) +
    ' | ' + m.lamRms.toExponential(3).padStart(12) +
    ' | ' + m.lamMax.toExponential(3).padStart(12) +
    ' | ' + (m.lamRms / (m.rw * m.rw)).toFixed(4).padStart(18) +
    ' | ' + (m.lamRms / m.rw).toExponential(3).padStart(15));
}
console.log('');
console.log(' [解读] RMS 偏差 / omega_L^2 近似恒定 ==> 旋转系中的偏差确实是 O(B^2),');
console.log('        即"以 omega_L 旋转的参考系里, 轨道与零场圆轨道重合"成立到一阶。');
console.log('');
console.log(' ===== 轨道几何 (theta = 60 deg) =====');
console.log(' omega_L/omega_0 |   r_min   |   r_max   |  相对半径波动 | 密切偏心率(含O(B)振荡)');
console.log('-----------------+-----------+-----------+---------------+----------------------');
for (const m of rows) {
  console.log(' ' + m.rw.toFixed(4).padStart(15) +
    ' | ' + m.rmin.toFixed(7) +
    ' | ' + m.rmax.toFixed(7) +
    ' | ' + ((m.rmax - m.rmin) / (m.rmax + m.rmin)).toExponential(2).padStart(13) +
    ' | ' + m.emax.toExponential(2));
}
console.log('');
console.log(' [解读] 半径波动 ~ O(B^2): 轨道确实保持圆形 (磁场在一阶上只让它进动, 不改形状)。');
console.log('        密切偏心率含一个 O(B) 的周期性振荡 (磁场对速度的瞬时扰动), 不代表轨道变椭。');
console.log('');

/* -------- 真实量级换算 -------- */
const B_for_1T = 1 / P.AU_BFIELD;
const rw_1T = (B_for_1T / 2);
console.log(' ===== 真实量级 (氢原子 n=1 经典圆轨道, r = a0) =====');
console.log('  圆轨道角频率  omega_0 = 1 a.u. = ' + P.AU_FREQ.toExponential(4) + ' rad/s = ' +
            (P.AU_FREQ / 2 / Math.PI).toExponential(4) + ' Hz');
console.log('  原子单位磁场  B_0 = ' + P.AU_BFIELD.toExponential(4) + ' T');
console.log('  1 T 对应      B = ' + B_for_1T.toExponential(3) + ' a.u. , omega_L/omega_0 = ' + rw_1T.toExponential(3));
console.log('                即轨道面进动一圈, 电子要公转 ' + (1 / rw_1T).toExponential(3) + ' 圈');
console.log('  omega_L/2pi   = ' + P.GHZ_PER_T_ORB + ' GHz/T (轨道) , ' + P.GHZ_PER_T_SPIN + ' GHz/T (自旋, g=2.0023)');
console.log('');
console.log('  可视化放大说明: 演示里取 omega_L/omega_0 = 0.02, 对应 B = ' +
            (0.04 * P.AU_BFIELD).toExponential(3) + ' T,');
console.log('  比 1 T 放大了 ' + (0.04 * P.AU_BFIELD).toExponential(2) + ' 倍 —— 只有这样进动才看得见。');
console.log('');
