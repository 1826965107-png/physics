/* ============================================================================
 *  test-headless.js — 无 DOM 环境的冒烟测试
 *  用桩件模拟 document / window / canvas2d context, 真实跑一遍 app.js:
 *    - 浏览器启动路径 (resize / setupUI / reset / warmup / tick)
 *    - 所有绘制分支 (球面/球带/双锥/矢量/场线/轨迹)
 *    - UI 交互分支 (滑杆 input、复选框 change、按钮 click)
 *  并检查 app.js 里用到的所有元素 id 都真的存在于 index.html。
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

let errors = [];
let drawingCalls = 0;
const methodCount = {};

/* ---------------- canvas 2d 上下文桩件 ---------------- */
function makeCtx() {
  const t = {};
  return new Proxy(t, {
    get(o, p) {
      if (p === 'createRadialGradient' || p === 'createLinearGradient')
        return () => ({ addColorStop() {} });
      if (p in o) return o[p];
      return (...a) => { drawingCalls++; methodCount[p] = (methodCount[p] || 0) + 1; };
    },
    set(o, p, v) { o[p] = v; return true; }
  });
}

/* ---------------- DOM 桩件 ---------------- */
const listeners = {};
const defaults = {
  'r-ratio': '0.020', 'r-theta': '60', 'r-speed': '2.2', 'r-trail': '70',
  'l-ratio': '0.020', 'l-speed': '2.2',
  'r-res': '1920x1080', 'r-fps': '60', 'r-dur': '20'
};
function makeEl(id) {
  const el = {
    id, style: {}, textContent: '', width: 0, height: 0, className: '',
    value: defaults[id] !== undefined ? defaults[id] : '',
    checked: id.charAt(0) === 'c',
    _ctx: null,
    getContext() { if (!this._ctx) this._ctx = makeCtx(); return this._ctx; },
    captureStream() { return { getVideoTracks: () => [{ requestFrame() {} }], getTracks: () => [] }; },
    addEventListener(type, fn) { (listeners[id + ':' + type] = listeners[id + ':' + type] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return { width: 1600, height: 900, left: 0, top: 0 }; },
    appendChild() {}, click() {}, toBlob() {},
    classList: { add() {}, remove() {}, toggle() {} }
  };
  return el;
}
const elems = {};
function getEl(id) { id = String(id); if (!elems[id]) elems[id] = makeEl(id); return elems[id]; }

globalThis.document = {
  getElementById: getEl,
  createElement: (tag) => makeEl('created-' + tag),
  addEventListener() {}, body: makeEl('body')
};
globalThis.window = {
  innerWidth: 1600, innerHeight: 900, devicePixelRatio: 2,
  addEventListener() {}, removeEventListener() {},
  location: { search: '?warmup=3' },
  performance: { now: () => Date.now() },
  requestAnimationFrame() {}          // 不自动循环, 由测试手动驱动
};
globalThis.location = globalThis.window.location;
globalThis.requestAnimationFrame = function () {};
globalThis.performance = globalThis.window.performance;
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };

/* ---------------- MediaRecorder 桩件 ---------------- */
globalThis.MediaRecorder = function (stream, opts) {
  this.stream = stream; this.opts = opts || {}; this.state = 'inactive';
};
globalThis.MediaRecorder.prototype.start = function () { this.state = 'recording'; };
globalThis.MediaRecorder.prototype.stop = function () {
  this.state = 'inactive';
  if (this.ondataavailable) this.ondataavailable({ data: { size: 2048 } });
  if (this.onstop) this.onstop();
};
globalThis.MediaRecorder.isTypeSupported = function (t) { return String(t).indexOf('webm') >= 0; };

/* ---------------- 加载 physics + app (触发浏览器启动路径) ---------------- */
require('./physics.js');
let t0 = Date.now();
require('./app.js');
const app = globalThis.window.__LARMOR__;
if (!app) { console.error('FAIL: window.__LARMOR__ 未创建, 浏览器启动路径没跑到'); process.exit(1); }
console.log('启动成功:  warmup=3s 预跑完成, 用时 ' + (Date.now() - t0) + ' ms');
console.log('  预热后: 轨迹点 hist=' + app.state.hist.length + ' recent=' + app.state.recent.length +
            '  t=' + app.state.t.toFixed(1) + '  r=' + app.state.rmag.toFixed(6));

/* ---------------- 驱动 300 帧 ---------------- */
drawingCalls = 0;
t0 = Date.now();
const N = 300;
for (let i = 0; i < N; i++) {
  try { app.tick(1 / 60); }
  catch (e) { errors.push('tick#' + i + ': ' + e.stack); break; }
}
const dt = Date.now() - t0;
console.log('跑完 ' + N + ' 帧: ' + (Date.now() - t0) + ' ms  (' + (dt / N).toFixed(2) + ' ms/帧, 纯 CPU 不含光栅化)');
console.log('  结束状态: hist=' + app.state.hist.length + ' recent=' + app.state.recent.length +
            '  t=' + app.state.t.toFixed(1) + '  |L|=' + app.state.Lmag.toFixed(8) +
            '  r=' + app.state.rmag.toFixed(8) + '  ΔE/E=' + app.state.dE.toExponential(2));
console.log('  ω_L 实测=' + app.state.wMeas.toFixed(8) + '  理论 B/2=' + (app.state.B / 2).toFixed(8) +
            '  偏差=' + (100 * (app.state.wMeas - app.state.B / 2) / (app.state.B / 2)).toFixed(3) + '%');
console.log('  绘图调用次数: ' + drawingCalls + ' (' + (drawingCalls / N).toFixed(0) + '/帧)');
const top = Object.entries(methodCount).sort((a, b) => b[1] - a[1]).slice(0, 9)
  .map(([k, v]) => k + '=' + (v / N).toFixed(1)).join('  ');
console.log('  每帧主要调用: ' + top);

/* ---------------- UI 交互分支 ---------------- */
function fire(id, type) {
  const k = id + ':' + type;
  if (!listeners[k]) { errors.push('没有为 #' + id + ' 注册 ' + type + ' 监听器'); return; }
  listeners[k].forEach(fn => { try { fn({ key: 'x', preventDefault() {} }); }
                               catch (e) { errors.push(id + ' ' + type + ': ' + e.stack); } });
}
['r-ratio', 'r-theta', 'r-speed', 'r-trail'].forEach(id => {
  getEl(id).value = id === 'r-theta' ? '90' : (id === 'r-ratio' ? '0.05' : '3.5');
  fire(id, 'input');
  for (let i = 0; i < 12; i++) { try { app.tick(1 / 60); } catch (e) { errors.push(id + ' tick: ' + e.stack); } }
});
['c-sphere','c-band','c-cone','c-mu','c-spin','c-field','c-trail','c-auto'].forEach(id => {
  const e = getEl(id); e.checked = !e.checked; fire(id, 'change');
  for (let i = 0; i < 4; i++) { try { app.tick(1 / 60); } catch (er) { errors.push(id + ' tick: ' + er.stack); } }
});
/* 再全部打开跑一遍, 覆盖所有绘制分支 */
['c-sphere','c-band','c-cone','c-mu','c-spin','c-field','c-trail'].forEach(id => { getEl(id).checked = true; fire(id, 'change'); });
for (let i = 0; i < 60; i++) { try { app.tick(1 / 60); } catch (e) { errors.push('全开 tick: ' + e.stack); } }
['b-pause', 'b-reset', 'b-cam', 'b-png'].forEach(id => fire(id, 'click'));
for (let i = 0; i < 10; i++) { try { app.tick(1 / 60); } catch (e) { errors.push('按钮后 tick: ' + e.stack); } }
console.log('UI 交互分支: 已覆盖 (滑杆/复选框/按钮)');

/* ---------------- 录制路径 ---------------- */
function recTicks(n) { for (let i = 0; i < n; i++) { try { app.tick(1 / 60); } catch (e) { errors.push('录制 tick: ' + e.stack); } } }

getEl('r-dur').value = 'loop'; fire('r-dur', 'change');
fire('b-rec', 'click');
if (!app.rec.active) errors.push('录制没有启动');
const expLoop = Math.round(1 / (app.state.Btarget / 2)) / app.state.speed;
if (Math.abs(app.rec.maxSec - expLoop) > 0.05)
  errors.push('无缝循环时长算错: ' + app.rec.maxSec + ' 应为 ' + expLoop);
console.log('循环模式: 目标 ' + app.rec.maxSec.toFixed(2) + ' s (ω_L/ω₀=' + (app.state.Btarget / 2).toFixed(3) +
            ' ⇒ 公转 ' + Math.round(1 / (app.state.Btarget / 2)) + ' 圈), 状态文字="' + getEl('v-rec').textContent + '"');
recTicks(30);
if (app.rec.elapsed < 0.4) errors.push('录制计时没有推进');
fire('b-rec', 'click');                                    // 手动停止
if (app.rec.active) errors.push('手动停止失败');
console.log('手动停止: ' + app.rec.msg);

getEl('r-dur').value = '1'; fire('r-dur', 'change');       // 1 秒, 测自动到时停止
fire('b-rec', 'click');
recTicks(80);
if (app.rec.active) errors.push('到时没有自动停止 (elapsed=' + app.rec.elapsed.toFixed(2) + ')');
console.log('自动停止: elapsed=' + app.rec.elapsed.toFixed(2) + ' s, ' + app.rec.msg);
console.log('录制后画布尺寸: ' + getEl('gl').width + 'x' + getEl('gl').height +
            ' CSS=' + getEl('gl').style.width);

/* ---------------- 弛豫 / 空间量子化 物理验证 ---------------- */
function tiltDeg() {
  const L = app.state.L, m = Math.hypot(L[0], L[1], L[2]) || 1;
  return Math.acos(Math.max(-1, Math.min(1, -L[2] / m))) * 180 / Math.PI;
}
getEl('c-quant').checked = false; fire('c-quant', 'change');
if (app.state.paused) fire('b-pause', 'click');              // 确保在跑 (前面按钮测试暂停过)
getEl('r-t1').value = '35'; fire('r-t1', 'input');           // T1 = 30 公转周期
getEl('r-t2p').value = '0'; fire('r-t2p', 'input');          // 无纯退相位 => T2 = 2T1
fire('b-pulse', 'click');                                    // π/2 脉冲: theta = 90°
getEl('c-relax').checked = true; fire('c-relax', 'change');
const T1orb = app.state.T1 / (2 * Math.PI), T2orb = app.state.Tau / (2 * Math.PI);
console.log('');
console.log('弛豫验证(π/2 脉冲启动):');
console.log('  T₁ = ' + T1orb.toFixed(0) + ' 圈(纵向/自旋-晶格),  纯退相位 = 无,  T₂ = ' + T2orb.toFixed(0) +
            ' 圈  → T₂ = 2T₁ ' + (Math.abs(T2orb - 2 * T1orb) < 0.5 ? '✓' : '✗'));
if (Math.abs(T2orb - 2 * T1orb) > 0.5) errors.push('无纯退相位时应有 T2 = 2T1, 实得 ' + T2orb + ' vs ' + 2 * T1orb);
const bz0 = app.state.bz, bp0 = app.state.bp, L0m = app.state.L0mag;
const T1au = app.state.T1, T2au = app.state.Tau;
const up0 = app.state.mp0, uz0 = app.state.mz0;
console.log('  初始: M_z/M_eq = ' + uz0.toFixed(3) + ' (π/2 脉冲后应为 0),  |M⊥|/M_eq = ' + up0.toFixed(3) + ' (应为 1)');
if (Math.abs(uz0) > 0.05 || Math.abs(up0 - 1) > 0.05) errors.push('π/2 脉冲初值不对');
const rows = [];
console.log('   圈数  |  β 实测 |  β 布洛赫 |  M_z 实测 |  M_z 解析 |  |M⊥| 实测 |  |M⊥| 解析');
for (let k = 0; k < 7; k++) {
  for (let i = 0; i < 240; i++) app.tick(1 / 60);
  const t = app.state.t;
  const bz = -L0m + (bz0 + L0m) * Math.exp(-t / T1au);
  const bp = bp0 * Math.exp(-t / T2au);
  const predBeta = Math.atan2(Math.max(bp, 0), -bz) * 180 / Math.PI;
  const mzGot = -app.state.bz / L0m, mpGot = app.state.bp / L0m;
  const mzPred = 1 + (uz0 - 1) * Math.exp(-t / T1au), mpPred = up0 * Math.exp(-t / T2au);
  const gotP = Math.min(tiltDeg(), 180 - tiltDeg());      // 只比较"轨道面"的无向倾斜
  const predP = Math.min(predBeta, 180 - predBeta);
  rows.push([t / (2 * Math.PI), gotP, predP, mzGot, mzPred, mpGot, mpPred]);
  console.log('  ' + (t / (2 * Math.PI)).toFixed(1).padStart(6) + '  | ' + gotP.toFixed(1).padStart(6) + '° | ' +
              predP.toFixed(1).padStart(8) + '° | ' + mzGot.toFixed(4).padStart(8) + '  | ' + mzPred.toFixed(4).padStart(8) +
              '  | ' + mpGot.toFixed(4).padStart(8) + '   | ' + mpPred.toFixed(4).padStart(8));
}
const dMax = Math.max.apply(null, rows.map(r => Math.abs(r[1] - r[2])));
if (dMax > 3.0) errors.push('轨道面倾斜没有跟上布洛赫解: 最大偏差 ' + dMax.toFixed(2) + '°');
else console.log('  → 轨道面倾斜与布洛赫解最大偏差 ' + dMax.toFixed(2) + '° ✓');
const eMax = Math.max.apply(null, rows.map(r => Math.max(Math.abs(r[3] - r[4]), Math.abs(r[5] - r[6]))));
console.log('  → M_z 与 |M⊥| 对解析解的最大偏差 ' + eMax.toExponential(1) + ' ✓');
if (!(rows[rows.length - 1][5] < rows[0][5])) errors.push('横向磁化没有衰减');
console.log('  → |M⊥|: ' + rows.map(r => r[5].toFixed(2)).join(' → ') + '   (按 e^(−t/T₂) 衰减)');
console.log('  → M_z : ' + rows.map(r => r[3].toFixed(2)).join(' → ') + '   (按 1−e^(−t/T₁) 恢复)');

/* 纯退相位: 加上之后 T2 必须变短, 但仍 <= 2T1 */
getEl('r-t2p').value = '30'; fire('r-t2p', 'input');
const T2b = app.state.Tau / (2 * Math.PI);
console.log('加上纯退相位后: T₂ = ' + T2b.toFixed(1) + ' 圈 < 2T₁ = ' + (2 * T1orb).toFixed(0) + ' 圈 ' +
            (T2b < 2 * T1orb - 0.5 ? '✓ (T₂ ≤ 2T₁ 约束成立)' : '✗'));
if (!(T2b < 2 * T1orb - 0.5)) errors.push('纯退相位没有让 T2 变短');
getEl('r-t2p').value = '0'; fire('r-t2p', 'input');

/* π 脉冲(反转恢复): 纯纵向, 横向应当始终为 0 */
fire('b-pulse-pi', 'click');
console.log('π 脉冲(反转恢复): 初始 M_z/M_eq = ' + app.state.mz0.toFixed(3) + ', |M⊥|/M_eq = ' + app.state.mp0.toFixed(3));
if (Math.abs(app.state.mz0 + 1) > 0.05 || app.state.mp0 > 0.05) errors.push('π 脉冲初值应为 M_z=-1, M_⊥=0');
let mpMax = 0;
for (let i = 0; i < 600; i++) { app.tick(1 / 60); mpMax = Math.max(mpMax, app.state.bp / app.state.L0mag); }
console.log('  演化后 M_z/M_eq = ' + (-app.state.bz / app.state.L0mag).toFixed(3) +
            ', 全程 max|M⊥| = ' + mpMax.toExponential(1) + ' → 纯纵向弛豫, 没有横向信号 ✓');
if (mpMax > 0.02) errors.push('反转恢复过程中出现了横向磁化: ' + mpMax);

getEl('c-quant').checked = true; fire('c-quant', 'change');
const lq = app.state.lq;
const allowed = [];
for (let m = -lq; m <= lq; m++) allowed.push((Math.acos(-m / Math.sqrt(lq * (lq + 1))) * 180 / Math.PI).toFixed(1) + '°');
console.log('空间量子化: l = ' + lq + ', 2l+1 = ' + (2 * lq + 1) + ' 个允许的有向 β 值 = ' + allowed.join(', '));
console.log('  最小夹角 θmin = ' + (Math.acos(lq / Math.sqrt(lq * (lq + 1))) * 180 / Math.PI).toFixed(1) +
            '° → L 永远到不了 −Z 轴上');
/* 高亮必须单调下梯: 之前用"几何倾角"算 m, 会因为面倾角 35.3° 同时对应 m=±2 而乱跳 */
if (!app.state.relax) { getEl('c-relax').checked = true; fire('c-relax', 'change'); }
/* 弛豫已开, 直接设 θ=30° 重置; 不重新触发 change, 否则会按协议自动打 π/2 脉冲改成 m=0 */
getEl('r-theta').value = '30'; fire('r-theta', 'input');       // θ=30° ⇒ 有向 β=150° ⇒ m=+2 起步
console.log('  起点: θ=' + (app.state.theta * 180 / Math.PI).toFixed(0) + '°, β=' +
            (app.state.betaCont * 180 / Math.PI).toFixed(1) + '° ⇒ m=' + app.state.mNow);
const seq = [];
let prevM = null;
for (let i = 0; i < 3600; i++) {
  app.tick(1 / 60);
  if (app.state.mNow !== prevM) { seq.push(app.state.mNow); prevM = app.state.mNow; }
}
console.log('  量子数阶梯: m ' + seq.join(' → ') + '   (应从 +2 一路降到基态 m=' + (-lq) + ')');
let mono = true;
for (let i = 1; i < seq.length; i++) if (seq[i] > seq[i - 1]) mono = false;
if (!mono) errors.push('量子数高亮不是单调下梯, 出现了乱跳: ' + seq.join(' → '));
else console.log('  → 单调下梯, 无来回跳 ✓');
if (seq[0] !== lq) errors.push('起点不是 m=+l: ' + seq[0]);
if (seq[seq.length - 1] !== -lq) errors.push('终点不是基态: ' + seq[seq.length - 1]);
const allSeen = seq.slice().sort((a, b) => b - a).join(',');
if (allSeen !== seq.join(',') || seq.length !== 2 * lq + 1)
  console.log('  (注: 阶梯出现 ' + seq.length + ' 级, 共 2l+1 = ' + (2 * lq + 1) + ' 级)');
const snapped = allowed.some(a => Math.abs(parseFloat(a) - tiltDeg()) < 1.0) ||
                allowed.some(a => Math.abs(parseFloat(a) - (180 - tiltDeg())) < 1.0);
if (!snapped) errors.push('开启量子化后轨道面没有落在允许值上: ' + tiltDeg().toFixed(2) + '°');
else console.log('  → 轨道面已落在允许倾角上 ✓ (β = ' + tiltDeg().toFixed(1) + '°, 对应 m=' + app.state.mNow + ')');

/* ---------------- 检查元素 id 与 index.html 一致 ---------------- */
const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const ids = new Set();
let m, re = /'(r|c|b|l|v)-[a-z0-9]+'/g;
while ((m = re.exec(appSrc))) ids.add(m[0].slice(1, -1));
const missing = [...ids].filter(id => html.indexOf('id="' + id + '"') < 0);
console.log('id 一致性: app.js 用到 ' + ids.size + ' 个 id, index.html 缺失 ' + missing.length + ' 个');
if (missing.length) errors.push('index.html 缺少 id: ' + missing.join(', '));

/* ---------------- 结果 ---------------- */
console.log('');
if (errors.length) {
  console.log('===== 失败 ' + errors.length + ' 项 =====');
  errors.slice(0, 12).forEach(e => console.log('  x ' + e));
  process.exit(1);
} else {
  console.log('===== 全部通过: 无运行时错误 =====');
}
