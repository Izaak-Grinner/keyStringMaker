import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RichEditor } from './editor.js';
import { FontRegistry, GROUP_LABELS } from './fonts.js';
import { ColorPicker } from './color-picker.js';
import { DEFAULTS } from '../lib/defaults.mjs';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'keychain-gui';

// スライダーで調整する数値 (key は lib/core.mjs の DEFAULTS と同じ)
const SLIDERS = {
  sizeFields: [
    { key: 'size', label: '文字の大きさ', unit: 'mm', min: 5, max: 60, step: 0.5 },
    { key: 'bold', label: '文字の太さ', unit: 'mm', min: -0.5, max: 1.5, step: 0.05, hint: '＋で太く / −で細く' },
    { key: 'spacing', label: '文字の間隔', unit: 'mm', min: -5, max: 10, step: 0.1 },
    { key: 'lineHeight', label: '行の間隔 (2 行のとき)', unit: '倍', min: 0.7, max: 2, step: 0.05 },
  ],
  thicknessFields: [
    { key: 'textHeight', label: '文字の高さ', unit: 'mm', min: 0.2, max: 6, step: 0.1 },
    { key: 'baseHeight', label: '土台の厚さ', unit: 'mm', min: 0.6, max: 10, step: 0.1 },
  ],
  plateFields: [
    { key: 'border', label: 'フチの幅', unit: 'mm', min: 0.5, max: 15, step: 0.1 },
    { key: 'corner', label: '角の丸み', unit: 'mm', min: 0, max: 20, step: 0.5, only: () => state.plate === 'rect' },
    { key: 'smooth', label: '外周のなめらかさ', unit: '', min: 0, max: 0.5, step: 0.05, hint: '0 で文字の形に近く', only: () => state.plate === 'outline' },
  ],
  ringFields: [
    { key: 'ringHole', label: '穴の直径', unit: 'mm', min: 2, max: 10, step: 0.5 },
    { key: 'ringWall', label: 'リングの肉厚', unit: 'mm', min: 1, max: 6, step: 0.5 },
    { key: 'ringFillet', label: '付け根の丸み', unit: 'mm', min: 0, max: 5, step: 0.5, only: () => state.plate !== 'capsule' },
  ],
};

const PALETTE = ['#e0464d', '#f08a24', '#f2c230', '#3aa757', '#2f6fde', '#8e5bd6', '#ff7eb6', '#222222', '#ffffff'];
const MIXED = '__mixed';

const DEFAULT_FONT = 'b:MochiyPopOne_400Regular.ttf';
const MAX_FONTS = 6; // 1 つのキーホルダーで使えるフォントの種類 (メモリを食うため)

let state = {};
let editor;
let textPicker;
const fonts = new FontRegistry(document.getElementById('fontFaces'));

// ---------------------------------------------------------------------------
// 設定の保存 (このブラウザだけ)
// ---------------------------------------------------------------------------

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 保存できなくても動作には影響しない */ }
}

// ---------------------------------------------------------------------------
// 入力欄
// ---------------------------------------------------------------------------

function renderSliders() {
  for (const [container, fields] of Object.entries(SLIDERS)) {
    $(container).innerHTML = '';
    for (const f of fields) {
      const label = document.createElement('label');
      label.className = 'field';
      label.dataset.key = f.key;
      label.innerHTML = `
        <div class="field-head"><span>${f.label}</span><small>${[f.hint, f.unit].filter(Boolean).join(' · ')}</small></div>
        <div class="slider">
          <input type="range" min="${f.min}" max="${f.max}" step="${f.step}">
          <input type="number" step="${f.step}">
        </div>`;
      const [range, num] = label.querySelectorAll('input');
      range.value = num.value = state[f.key];
      range.oninput = () => { num.value = range.value; set(f.key, Number(range.value)); };
      num.onchange = () => {
        const v = Number(num.value);
        if (!Number.isFinite(v)) { num.value = state[f.key]; return; }
        range.value = v;
        set(f.key, v);
      };
      $(container).append(label);
    }
  }
  updateVisibility();
}

function updateVisibility() {
  for (const fields of Object.values(SLIDERS)) {
    for (const f of fields) {
      document.querySelector(`label[data-key="${f.key}"]`).hidden = f.only ? !f.only() : false;
    }
  }
}

function setupSegment(id) {
  const el = $(id);
  const refresh = () => { for (const b of el.children) b.classList.toggle('on', b.dataset.v === state[id]); };
  for (const b of el.children) b.onclick = () => { set(id, b.dataset.v); refresh(); updateVisibility(); };
  refresh();
}

function set(key, value) {
  state[key] = value;
  save();
  scheduleBuild();
}

// ---------------------------------------------------------------------------
// 文字の入力欄 (文字ごとのフォント・色)
//   state.text / charFonts / charColors: 文字列の i 番目 (コードポイント単位、改行も 1 文字) の
//   フォント id / 色。null は既定 (state.font / state.textColor)
// ---------------------------------------------------------------------------

const cssFontFamily = (id) => fonts.cssFamily(id);

function syncStateFromEditor() {
  state.text = editor.text;
  state.charFonts = editor.chars.map((c) => c.font);
  state.charColors = editor.chars.map((c) => c.color);
  $('filename').placeholder = defaultFilename();
  save();
  scheduleBuild();
}

// 選択範囲 (なければ全体) の文字
function targetChars() {
  const [s, e] = editor.targetRange();
  return editor.chars.slice(s, e);
}

// 選択範囲 (なければ全体) にフォント / 色を適用する。
// 全体なら既定値 (state.font / state.textColor) を変えて、文字ごとの指定を消す
function applyToTarget(key, value, focusEditor = true, kind = 'style') {
  const [s, e] = editor.targetRange();
  if (s === 0 && e === editor.chars.length) {
    state[key === 'font' ? 'font' : 'textColor'] = value;
    editor.mapChars((c) => ({ ...c, [key]: null }), kind);
  } else {
    editor.applyStyle({ [key]: value }, kind);
  }
  if (focusEditor) editor.focus();
  updateToolbar();
}

function renderPalette() {
  const el = $('palette');
  el.innerHTML = '';
  const colors = new Set(targetChars().map((c) => c.color || state.textColor));
  const current = colors.size === 1 ? [...colors][0] : null;
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === current ? ' on' : '');
    b.style.background = c;
    b.title = c;
    b.onmousedown = (e) => e.preventDefault(); // 入力欄の選択を外さない
    b.onclick = () => applyToTarget('color', c);
    el.append(b);
  }
  textPicker.show(current);
}

// ツールバーの表示を、選択範囲 (なければ全体) の書式に合わせる
function updateToolbar() {
  renderPalette();
  renderFontList();
}

// ---------------------------------------------------------------------------
// フォント選択
// ---------------------------------------------------------------------------

function renderFontList() {
  const q = $('fontSearch').value.trim().toLowerCase();
  const used = new Set(targetChars().map((c) => c.font || state.font));
  const current = used.size === 1 ? [...used][0] : MIXED;
  const select = $('font');
  select.innerHTML = '';
  if (current === MIXED) select.append(new Option('（複数のフォント）', MIXED, true, true));
  for (const [group, label] of Object.entries(GROUP_LABELS)) {
    const list = fonts.list.filter((f) => f.group === group
      && (f.id === current || !q || `${f.name} ${f.family}`.toLowerCase().includes(q)));
    if (!list.length) continue;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const f of list) {
      const o = new Option(f.name, f.id, false, f.id === current);
      // 同梱フォントは表示のためだけにダウンロードしないよう、一覧ではそのフォントで表示しない
      if (f.source !== 'bundled') o.style.fontFamily = cssFontFamily(f.id);
      og.append(o);
    }
    select.append(og);
  }
}

function note(text) {
  $('fontNote').textContent = text;
  $('fontNote').hidden = !text;
}

async function loadLocalFonts() {
  try {
    const n = await fonts.loadLocal();
    note(`この PC のフォントを ${n} 個読み込みました`);
  } catch (e) {
    note(e.name === 'NotAllowedError' || e.name === 'SecurityError'
      ? 'PC のフォントの使用が許可されませんでした (アドレスバーのサイト設定から許可できます)'
      : `PC のフォントを読み込めませんでした: ${e.message}`);
  }
  renderFontList();
}

// ---------------------------------------------------------------------------
// 生成処理 (worker.js) とのやりとり
// ---------------------------------------------------------------------------

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let callId = 0;
const pending = new Map();
worker.onmessage = ({ data: { id, ok, result, error } }) => {
  const p = pending.get(id);
  pending.delete(id);
  if (ok) p.resolve(result); else p.reject(new Error(error));
};

function call(type, payload = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++callId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload }, transfer);
  });
}

// worker に渡したフォント (最近使った順)。多くなったら古いものを捨てる
const loadedFonts = new Map(); // id → Promise
async function ensureFonts(ids) {
  for (const id of ids) {
    if (!loadedFonts.has(id)) {
      loadedFonts.set(id, fonts.bytes(id).then(({ buffer, postscriptName }) =>
        call('font', { fontId: id, buffer, postscriptName }, [buffer])));
      loadedFonts.get(id).catch(() => loadedFonts.delete(id));
    }
    const p = loadedFonts.get(id);
    loadedFonts.delete(id);
    loadedFonts.set(id, p);
  }
  for (const id of [...loadedFonts.keys()]) {
    if (loadedFonts.size <= 10) break;
    if (ids.includes(id)) continue;
    loadedFonts.delete(id);
    call('drop', { fontId: id });
  }
  await Promise.all(ids.map((id) => loadedFonts.get(id)));
}

// 生成に渡す値
function params() {
  const p = { text: state.text, font: state.font, charFonts: state.charFonts };
  for (const key of Object.keys(DEFAULTS)) p[key] = state[key];
  return p;
}

async function prepare() {
  const ids = [...new Set([state.font, ...state.charFonts.filter(Boolean)])];
  if (ids.length > MAX_FONTS) throw new Error(`1 つのキーホルダーで使えるフォントは ${MAX_FONTS} 種類までです`);
  await ensureFonts(ids);
  return params();
}

// ---------------------------------------------------------------------------
// 3D プレビュー
// ---------------------------------------------------------------------------

const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef0f3);

const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
camera.up.set(0, 0, 1); // スライサーと同じく Z が上
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f98, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(60, -80, 140);
scene.add(sun);

const grid = new THREE.GridHelper(300, 30, 0xc5cad3, 0xdde1e7);
grid.rotation.x = Math.PI / 2; // XY 平面 (造形テーブル)
scene.add(grid);

const model = new THREE.Group();
scene.add(model);

let lastSize = null;
let fittedRadius = 0;

function showModel({ meshes, size }) {
  for (const child of [...model.children]) {
    child.geometry.dispose();
    child.material.dispose();
    model.remove(child);
  }
  for (const { color, positions, indices } of meshes) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.6, flatShading: true });
    model.add(new THREE.Mesh(geom, material));
  }
  model.position.set(-size.w / 2, -size.h / 2, 0); // テーブルの中央に置く
  lastSize = size;
  const r = Math.hypot(size.w, size.h, size.t) / 2;
  if (!fittedRadius || Math.abs(r - fittedRadius) / fittedRadius > 0.25) fitView();
}

// 全体が収まる距離にカメラを置く
function fitView(dir = new THREE.Vector3(0, -0.9, 1.1)) {
  if (!lastSize) return;
  const r = Math.hypot(lastSize.w, lastSize.h, lastSize.t) / 2;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (r / Math.sin(Math.min(fov, fov * camera.aspect) / 2)) * 1.15;
  controls.target.set(0, 0, lastSize.t / 2);
  camera.position.copy(dir.normalize().multiplyScalar(dist)).add(controls.target);
  controls.update();
  fittedRadius = r;
}

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas.parentElement;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(canvas.parentElement);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

// ---------------------------------------------------------------------------
// サーバーでの生成
// ---------------------------------------------------------------------------

// 生成中に入力が変わったら、終わってから最新の値でもう一度だけ生成する
let building = false, dirty = false, buildTimer;
function scheduleBuild() {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(build, 60);
}

async function build() {
  if (building) { dirty = true; return; }
  building = true;
  dirty = false;
  $('busy').hidden = false;
  try {
    const data = await call('build', { params: await prepare() });
    showModel(data);
    const { w, h, t } = data.size;
    $('size').textContent = `${w.toFixed(1)} × ${h.toFixed(1)} × ${t.toFixed(1)} mm`;
    $('warn').hidden = !data.missing.length;
    $('warn').textContent = `フォントにない文字: ${data.missing.join(' ')}`;
    $('error').hidden = true;
    $('download').disabled = false;
  } catch (e) {
    $('error').textContent = e.message;
    $('error').hidden = false;
    $('download').disabled = true;
  } finally {
    building = false;
    $('busy').hidden = true;
    if (dirty) build();
  }
}

const defaultFilename = () =>
  (state.text || '').replace(/[\\/:*?"<>|\r\n\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'keychain';

async function download() {
  const btn = $('download');
  btn.disabled = true;
  btn.textContent = '作成中…';
  try {
    const choice = $('format').value;
    const format = choice === 'obj-y' ? 'obj' : choice;
    const { bytes } = await call('export', { params: await prepare(), format, up: choice === 'obj-y' ? 'y' : 'z' });
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${$('filename').value.trim() || defaultFilename()}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) {
    $('error').textContent = e.message;
    $('error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'ダウンロード';
  }
}

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

async function init() {
  await fonts.loadBundled();
  // 以前に PC のフォントの使用を許可していれば、最初から一覧に入れる
  if (FontRegistry.localSupported && await FontRegistry.localGranted()) await loadLocalFonts();
  if (!FontRegistry.localSupported) {
    $('localFonts').disabled = true;
    $('localFonts').title = 'このブラウザでは使えません (パソコンの Chrome / Edge で使えます)';
  }

  const saved = loadSaved();
  state = { ...DEFAULTS, text: 'ハシビロコウ大好き', font: DEFAULT_FONT, ...saved };
  if (!fonts.has(state.font)) state.font = DEFAULT_FONT;
  if (!Array.isArray(state.charColors)) state.charColors = [];
  // 保存されていたフォントが今は使えない (PC のフォントの許可がないなど) 場合は既定に戻す
  state.charFonts = (Array.isArray(state.charFonts) ? state.charFonts : []).map((id) => (id && fonts.has(id) ? id : null));

  editor = new RichEditor($('editor'), {
    styleOf: (c) => ({ fontFamily: cssFontFamily(c.font || state.font), color: c.color || state.textColor }),
    onChange: () => { syncStateFromEditor(); updateToolbar(); },
    onSelect: updateToolbar,
  });
  editor.setContent(state.text, state.charFonts, state.charColors);
  $('filename').placeholder = defaultFilename();

  $('font').onchange = () => { if ($('font').value !== MIXED) applyToTarget('font', $('font').value); };
  $('fontSearch').oninput = renderFontList;
  $('localFonts').onclick = loadLocalFonts;

  renderSliders();
  setupSegment('plate');

  // ドラッグ中の色の変更は、取り消し 1 回分にまとめる
  textPicker = new ColorPicker($('textChip'), $('textPicker'),
    (c, { live, byEnter }) => applyToTarget('color', c, live || byEnter, live ? 'picker' : 'style'));
  const basePicker = new ColorPicker($('baseChip'), $('basePicker'), (c) => set('baseColor', c));
  basePicker.show(state.baseColor);

  if (saved.format) $('format').value = saved.format;
  $('format').onchange = () => { state.format = $('format').value; save(); };
  $('download').onclick = download;
  $('viewReset').onclick = () => fitView();
  $('viewTop').onclick = () => fitView(new THREE.Vector3(0, -0.0001, 1));

  updateToolbar();
  build();
}

init();
