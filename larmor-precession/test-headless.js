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
