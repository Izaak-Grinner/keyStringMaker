import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RichEditor } from './editor.js';
import { FontRegistry, GROUP_LABELS } from './fonts.js';
import { ColorPicker } from './color-picker.js';
import { DEFAULTS } from '../lib/defaults.mjs';
import {
  ALIASES, buildPrompt, buildSettingsUpdate, CHOICES, describeParams, extractJson, isSettingParam, labelOf, normalizePatch, parseQuery,
} from './ai.js';

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
    { key: 'corner', label: '角の丸み', unit: 'mm', min: 0, max: 20, step: 0.5, when: '枠が四角 (rect) のときだけ', only: () => state.plate === 'rect' },
    { key: 'smooth', label: '外周のなめらかさ', unit: '', min: 0, max: 0.5, step: 0.05, hint: '0 で文字の形に近く', when: '枠が文字の周り (outline) のときだけ', only: () => state.plate === 'outline' },
  ],
  ringFields: [
    { key: 'ringHole', label: '穴の直径', unit: 'mm', min: 2, max: 10, step: 0.5 },
    { key: 'ringWall', label: 'リングの肉厚', unit: 'mm', min: 1, max: 6, step: 0.5 },
    { key: 'ringGap', label: '穴と文字の間隔', unit: 'mm', min: 0, max: 12, step: 0.1, hint: '0 で穴が文字に触れる手前' },
    { key: 'ringFillet', label: '付け根の丸み', unit: 'mm', min: 0, max: 5, step: 0.5 },
  ],
};

const PALETTE = ['#e0464d', '#f08a24', '#f2c230', '#3aa757', '#2f6fde', '#8e5bd6', '#ff7eb6', '#222222', '#ffffff'];
const MIXED = '__mixed';

const DEFAULT_FONT = 'b:MochiyPopOne_400Regular.ttf';
const MAX_FONTS = 6; // 1 つのキーホルダーで使えるフォントの種類 (メモリを食うため)

let state = {};
let editor;
let textPicker;
let basePicker;
const fonts = new FontRegistry(document.getElementById('fontFaces'));

// ---------------------------------------------------------------------------
// 設定の保存 (このブラウザだけ)
// ---------------------------------------------------------------------------

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 保存できなくても動作には影響しない */ }
  updateAiStale();
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

const segmentRefreshers = [];
function setupSegment(id) {
  const el = $(id);
  const refresh = () => { for (const b of el.children) b.classList.toggle('on', b.dataset.v === state[id]); };
  for (const b of el.children) b.onclick = () => { set(id, b.dataset.v); refresh(); updateVisibility(); };
  refresh();
  segmentRefreshers.push(refresh);
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
  state.lineAligns = shiftLineAligns(state.text, editor.text, state.lineAligns);
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

// ---------------------------------------------------------------------------
// 行の揃え
//   state.lineAligns: i 行目の揃え ('left' | 'center' | 'right')。null は既定 (state.align)
// ---------------------------------------------------------------------------

const lineOf = (k) => editor.chars.slice(0, k).filter((c) => c.ch === '\n').length;
const lineCount = () => lineOf(editor.chars.length) + 1;

// 文字列が変わったとき、行の揃えを行の増減に合わせてずらす。
//   変わり始めた行で改行が増えたら、新しい行はその行の揃えを引き継ぐ (Word と同じ)。減ったらその行に合わせる
function shiftLineAligns(oldText, newText, aligns) {
  const a = [...(oldText || '')], b = [...newText];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  const line = a.slice(0, p).filter((ch) => ch === '\n').length;
  const delta = b.filter((ch) => ch === '\n').length - a.filter((ch) => ch === '\n').length;
  const out = [...aligns];
  if (delta > 0) out.splice(line + 1, 0, ...Array(delta).fill(out[line] ?? null));
  else if (delta < 0) out.splice(line + 1, -delta);
  return out;
}

// 選択範囲のある行 (選択していないときは全部の行)
function targetLines() {
  const [s, e] = editor.sel;
  if (s === e) return null;
  const first = lineOf(s), last = lineOf(Math.max(s, e - 1));
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

function applyAlign(value) {
  const lines = targetLines();
  if (!lines) {
    state.align = value;
    state.lineAligns = [];
  } else {
    const aligns = [...state.lineAligns];
    for (const i of lines) aligns[i] = value;
    state.lineAligns = Array.from({ length: lineCount() }, (_, i) => aligns[i] ?? null);
  }
  save();
  scheduleBuild();
  editor.focus();
  renderAlign();
}

function renderAlign() {
  const lines = targetLines() || Array.from({ length: lineCount() }, (_, i) => i);
  const used = new Set(lines.map((i) => state.lineAligns[i] || state.align));
  const current = used.size === 1 ? [...used][0] : null;
  for (const b of $('align').children) b.classList.toggle('on', b.dataset.v === current);
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
  renderAlign();
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
  if (!fittedRadius || Math.abs(r - fittedRadius) / fittedRadius > 0.25) fitView(viewDir);
}

const VIEWS = { angle: new THREE.Vector3(0, -0.9, 1.1), top: new THREE.Vector3(0, -0.0001, 1) };
let viewDir = VIEWS.angle; // 最後に選んだ向き。モデルができる前に選ばれても (?view=top)、できたときにこの向きで合わせる

function viewOf(view) {
  if (!(view in VIEWS)) throw new Error(`view は ${Object.keys(VIEWS).map((v) => `"${v}"`).join(' か ')} にしてください ("${view}" は使えません)`);
  return VIEWS[view];
}

// 全体が収まる距離に、target を見るカメラを置く。戻り値は全体の半径
function placeCamera(cam, target, dir) {
  const r = Math.hypot(lastSize.w, lastSize.h, lastSize.t) / 2;
  const fov = THREE.MathUtils.degToRad(cam.fov);
  const dist = (r / Math.sin(Math.min(fov, fov * cam.aspect) / 2)) * 1.15;
  target.set(0, 0, lastSize.t / 2);
  cam.position.copy(dir.clone().normalize().multiplyScalar(dist)).add(target);
  cam.lookAt(target);
  return r;
}

function fitView(dir = VIEWS.angle) {
  viewDir = dir;
  if (!lastSize) return;
  fittedRadius = placeCamera(camera, controls.target, dir);
  controls.update();
}

// プレビューの画像 (PNG の data URL)。利用者の視点は動かさず、別のカメラで決まった向きから撮る
function capturePreview({ view = 'angle', width = 1024, height = 768 } = {}) {
  if (!lastSize) throw new Error('まだプレビューがありません');
  const cam = new THREE.PerspectiveCamera(camera.fov, width / height, 0.5, 5000);
  cam.up.set(0, 0, 1);
  placeCamera(cam, new THREE.Vector3(), viewOf(view));
  const ratio = renderer.getPixelRatio();
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.render(scene, cam);
  const url = canvas.toDataURL('image/png'); // 描いた直後に読む (次の描画で消えるため)
  renderer.setPixelRatio(ratio);
  resize();
  return url;
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
let building = false, dirty = false, buildTimer = null;
let lastBuild = null; // 最後の生成の結果 { size, missing, error }
let buildWaiters = [];
function scheduleBuild() {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(() => { buildTimer = null; build(); }, 60);
}

// 小型の 3D プリンター (A1 mini など) の造形範囲。これより大きいと載らない機種がある
const BED_MM = 180;

// 生成した大きさについての注意 (エージェントの set() などの warnings に足す)
function sizeWarnings(size) {
  if (!size || Math.max(size.w, size.h) <= BED_MM) return [];
  return [`大きさ (${size.w} × ${size.h} mm) が ${BED_MM}mm を超えています。小型の 3D プリンターでは造形範囲に収まりません。文字を減らすか、size を小さくしてください`];
}

// 待っている変更がすべて生成し終わったら、その結果で resolve する
function whenBuilt() {
  if (!building && buildTimer === null) return Promise.resolve(lastBuild);
  return new Promise((resolve) => buildWaiters.push(resolve));
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
    lastBuild = { size: { w: +w.toFixed(1), h: +h.toFixed(1), t: +t.toFixed(1) }, missing: data.missing, error: null };
  } catch (e) {
    $('error').textContent = e.message;
    $('error').hidden = false;
    $('download').disabled = true;
    lastBuild = { size: null, missing: [], error: e.message };
  } finally {
    building = false;
    $('busy').hidden = true;
    if (dirty) build();
    else if (buildTimer === null) {
      const waiters = buildWaiters;
      buildWaiters = [];
      for (const resolve of waiters) resolve(lastBuild);
    }
  }
}

const defaultFilename = () =>
  (state.text || '').replace(/[\\/:*?"<>|\r\n\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'keychain';

const FORMATS = ['3mf', 'stl', 'obj', 'obj-y'];

// 書き出してファイルとして保存する。choice: 画面の形式の選択肢 (obj-y は Y-up の OBJ)
async function saveModel(choice, filename) {
  if (!FORMATS.includes(choice)) throw new Error(`形式は ${FORMATS.join(' / ')} のどれかにしてください`);
  const format = choice === 'obj-y' ? 'obj' : choice;
  const { bytes } = await call('export', { params: await prepare(), format, up: choice === 'obj-y' ? 'y' : 'z' });
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filename || defaultFilename()}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return { filename: a.download, bytes: blob.size };
}

async function download() {
  const btn = $('download');
  btn.disabled = true;
  btn.textContent = '作成中…';
  try {
    await saveModel($('format').value, $('filename').value.trim());
  } catch (e) {
    $('error').textContent = e.message;
    $('error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'ダウンロード';
  }
}

// ---------------------------------------------------------------------------
// AI で調整
//   チャット型: 依頼文と画像をコピー → AI の返答を貼り付けると反映 (スマホは共有で AI のアプリへ)
//   エージェント型: window.keychain (get / set / preview / download …) か、URL の ?s=<JSON> / ?text=…
//   どれも applyParams で検証してから state に入れる
// ---------------------------------------------------------------------------

const NUMBER_FIELDS = Object.values(SLIDERS).flat();
// 設定できる項目 (URL のパラメーターの判定用)
const KNOWN_KEYS = new Set(['text', 'font', ...NUMBER_FIELDS.map((f) => f.key), ...Object.keys(CHOICES),
  'textColor', 'baseColor', 'charColors', 'charFonts', 'lineAligns']);
const TEXT_KEYS = ['text', 'charFonts', 'charColors', 'lineAligns']; // 文字数・行数に結びついているのでまとめて戻す
const AI_INTRO_KEY = 'keychain-ai-intro';

// AI で変えた記録 { keys: 変えた項目, prev: 変える前の state, next: 変えた直後の state }。新しいものが後ろ
const aiUndoStack = [];
let aiKnown = null; // AI に最後に伝えた設定 (exportSettings の JSON)。画面で変えたら「いまの設定をコピー」を促す
let aiTipShown = false;

const fontName = (id) => (id ? fonts.get(id)?.name ?? id : null);

// フォント id か名前 (完全一致 → 前方・部分一致) から id を探す
function resolveFont(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  if (fonts.has(v)) return v;
  const q = v.trim().toLowerCase();
  const hit = fonts.list.find((f) => f.name.toLowerCase() === q || f.family?.toLowerCase() === q)
    || fonts.list.find((f) => `${f.name} ${f.family}`.toLowerCase().includes(q));
  return hit?.id ?? null;
}

// AI に渡す設定。フォントは id ではなく名前にし、空の文字ごと・行ごとの指定は省く
function exportSettings() {
  const out = { text: state.text, font: fontName(state.font) };
  for (const key of Object.keys(DEFAULTS)) if (key !== 'tolerance') out[key] = state[key];
  out.charFonts = state.charFonts.map(fontName);
  for (const key of ['charFonts', 'charColors', 'lineAligns']) if (!out[key]?.some(Boolean)) delete out[key];
  return out;
}

// いまの設定を開くリンク (既定と違う項目だけ。文字ごとの指定はカンマ区切り)。
// fresh=1 を付けて、開いた側では保存されていた設定ではなく既定から始める (書いていない項目が既定になる)
function settingsLink() {
  const url = new URL(location.pathname, location.origin);
  const defaults = { ...DEFAULTS, font: fontName(DEFAULT_FONT) };
  for (const [key, v] of Object.entries(exportSettings())) {
    if (key !== 'text' && JSON.stringify(v) === JSON.stringify(defaults[key])) continue;
    url.searchParams.set(key, Array.isArray(v) ? v.map((x) => x ?? '').join(',') : v);
  }
  url.searchParams.set('fresh', '1');
  return url.href;
}

// 既定の設定に戻す patch (文字はそのまま)。文字ごと・行ごとの指定は、指定があるときだけ消す
function defaultsPatch() {
  const out = { font: fontName(DEFAULT_FONT), charFonts: [] };
  for (const key of Object.keys(DEFAULTS)) if (key !== 'tolerance') out[key] = DEFAULTS[key];
  for (const key of ['charFonts', 'charColors', 'lineAligns']) if (!state[key]?.some(Boolean)) delete out[key];
  return out;
}

// 値が同じか。文字ごと・行ごとの指定は、後ろの null の有無を区別しない
function sameValue(key, a, b) {
  if (!TEXT_KEYS.includes(key) || key === 'text') return JSON.stringify(a) === JSON.stringify(b);
  const n = Math.max(a?.length || 0, b?.length || 0);
  for (let i = 0; i < n; i++) if ((a?.[i] ?? null) !== (b?.[i] ?? null)) return false;
  return true;
}

// state を入れ替えて、画面の表示をそろえる
function replaceState(next) {
  const textChanged = ['text', 'charFonts', 'charColors'].some((k) => !sameValue(k, next[k], state[k]));
  if (textChanged) editor.snapshot('ai'); // 文字の変更は入力欄の Ctrl+Z でも戻せるように
  state = next;
  if (textChanged) editor.setContent(state.text, state.charFonts, state.charColors);
  $('filename').placeholder = defaultFilename();
  renderSliders();
  for (const refresh of segmentRefreshers) refresh();
  basePicker.show(state.baseColor);
  updateToolbar();
  save();
  scheduleBuild();
}

function applyParams(patch) {
  const { changes, applied, warnings } = normalizePatch(patch, { numbers: NUMBER_FIELDS, resolveFont, fontName, current: state });
  const keys = Object.keys(changes);
  if (keys.length) {
    const next = { ...state, ...changes };
    aiUndoStack.push({ keys, prev: structuredClone(state), next: structuredClone(next) });
    if (aiUndoStack.length > 30) aiUndoStack.shift();
    replaceState(next);
    $('aiUndo').disabled = false;
  }
  return { applied, warnings };
}

// 直前の AI の変更を取り消す。AI が変えた項目だけを戻し、そのあと画面で変えた項目はそのままにする
function undoAi() {
  const entry = aiUndoStack.pop();
  $('aiUndo').disabled = !aiUndoStack.length;
  if (!entry) return null;
  const { keys, prev, next } = entry;
  const back = {}, restored = [], skipped = [];
  if (keys.some((k) => TEXT_KEYS.includes(k))) {
    const labels = keys.filter((k) => TEXT_KEYS.includes(k)).map((k) => labelOf(k, NUMBER_FIELDS));
    if (TEXT_KEYS.every((k) => sameValue(k, state[k], next[k]))) {
      for (const k of TEXT_KEYS) back[k] = prev[k];
      restored.push(...labels);
    } else {
      skipped.push(...labels);
    }
  }
  for (const k of keys) {
    if (TEXT_KEYS.includes(k)) continue;
    if (sameValue(k, state[k], next[k])) { back[k] = prev[k]; restored.push(labelOf(k, NUMBER_FIELDS)); }
    else skipped.push(labelOf(k, NUMBER_FIELDS));
  }
  if (restored.length) replaceState({ ...state, ...structuredClone(back) });
  aiNote([
    restored.length ? `AI で変える前に戻しました: ${restored.join('、')}` : '戻す項目はありませんでした',
    ...(skipped.length ? [`AI のあとに画面で変えたので、そのままにしました: ${skipped.join('、')}`] : []),
  ].join('\n'));
  return { restored, skipped };
}

function aiNote(text, isError = false) {
  const el = $('aiResult');
  el.textContent = text;
  el.classList.toggle('err', isError);
  el.hidden = !text;
}

function showApplyResult({ applied, warnings }) {
  const tip = applied.length && !aiTipShown
    ? '次からは、同じチャットで希望を書くだけで続けられます (依頼文のコピーは不要)。画面で設定を変えたときは「いまの設定をコピー」を貼ってください'
    : null;
  if (tip) aiTipShown = true;
  aiNote([
    applied.length ? `反映しました:\n${applied.map((s) => `・${s}`).join('\n')}` : '変わった項目はありませんでした',
    ...(warnings.length ? [`注意:\n${warnings.map((s) => `・${s}`).join('\n')}`] : []),
    ...(tip ? [tip] : []),
  ].join('\n'));
}

// AI に設定を伝えた (依頼文・いまの設定をコピーした、AI の返答を反映した)
function markAiSynced() {
  aiKnown = JSON.stringify(exportSettings());
  updateAiStale();
}

// 画面で設定を変えて、AI の知っている設定とずれたら知らせる
function updateAiStale() {
  if (!editor) return;
  const stale = aiKnown !== null && JSON.stringify(exportSettings()) !== aiKnown;
  $('aiStale').hidden = !stale;
  $('aiSettings').classList.toggle('attention', stale);
}

function aiPrompt() {
  const used = new Set([state.font, ...state.charFonts.filter(Boolean)]);
  const fontNames = fonts.list.filter((f) => f.source === 'bundled' || used.has(f.id)).map((f) => f.name);
  return buildPrompt({
    settings: exportSettings(),
    params: describeParams(NUMBER_FIELDS),
    fontNames,
    moreFonts: fonts.list.some((f) => f.source === 'local'),
  });
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    markAiSynced();
    aiNote(message);
  } catch {
    aiNote('コピーできませんでした (ブラウザがクリップボードへの書き込みを許可していません)', true);
  }
}

const copyPrompt = () => copyText(aiPrompt(), '依頼文をコピーしました。AI のチャットに貼り付けて、最後に希望を書いてください');
const copySettings = () => copyText(buildSettingsUpdate({ settings: exportSettings() }),
  'いまの設定をコピーしました。同じチャットに貼り付けて、続けて希望を書いてください');

const dataUrlToBlob = (url) => fetch(url).then((r) => r.blob());

// data URL → File (共有はクリック直後に呼ぶ必要があるので、await せずに作る)
function dataUrlToFile(url, name) {
  const [head, body] = url.split(',');
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type: head.match(/data:([^;]+)/)[1] });
}

async function copyImage() {
  try {
    // Safari はクリック直後に ClipboardItem を作る必要があるので、中身は Promise で渡す
    const png = whenBuilt().then(() => dataUrlToBlob(capturePreview()));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    aiNote('プレビュー画像をコピーしました。AI のチャットに貼り付けてください');
  } catch {
    // コピーできないブラウザでは画像として保存する
    try {
      const a = document.createElement('a');
      a.href = capturePreview();
      a.download = `${defaultFilename()}-preview.png`;
      a.click();
      aiNote('画像をコピーできなかったので、ファイルとして保存しました。AI のチャットに添付してください');
    } catch (e) {
      aiNote(`画像を作れませんでした: ${e.message}`, true);
    }
  }
}

// スマホ: 依頼文とプレビュー画像を共有メニューで AI のアプリに渡す。
// アプリによっては画像だけが届くので、依頼文はクリップボードにも入れておく
const canShare = () => !!navigator.share && matchMedia('(pointer: coarse)').matches;

async function shareToAi() {
  const text = aiPrompt();
  let files = [];
  try { files = [dataUrlToFile(capturePreview(), `${defaultFilename()}-preview.png`)]; } catch { /* 画像なしで共有する */ }
  const data = files.length && navigator.canShare?.({ text, files }) ? { text, files } : { text };
  const copied = navigator.clipboard?.writeText(text).then(() => true, () => false) ?? Promise.resolve(false);
  try {
    await navigator.share(data);
    markAiSynced();
    aiNote(`AI のアプリに送りました。${await copied ? '依頼文が届いていなければ貼り付けてください (コピー済み)。' : ''}AI の返答は下の欄に貼り付けてください`);
  } catch (e) {
    if (e.name !== 'AbortError') aiNote(`共有できませんでした: ${e.message}`, true);
  }
}

function applyReply() {
  try {
    showApplyResult(applyParams(extractJson($('aiReply').value, KNOWN_KEYS)));
    markAiSynced();
  } catch (e) {
    aiNote(e.message, true);
  }
}

// 貼り付けたらすぐ反映する (元に戻せるので確認しない)。設定が見つからなければ、直して「反映」を押してもらう
function applyPasted() {
  setTimeout(() => {
    try {
      extractJson($('aiReply').value, KNOWN_KEYS);
    } catch {
      aiNote('貼り付けた文の中に設定 (JSON) が見つかりませんでした。AI の返答をそのまま貼り付けてください', true);
      return;
    }
    applyReply();
  });
}

// プレビューの「AI に相談」: サイドバーの「AI で調整」欄を出す
function openAiSection() {
  closeAiIntro();
  const section = $('aiSection');
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  section.classList.remove('flash');
  void section.offsetWidth; // アニメーションをやり直す
  section.classList.add('flash');
  $('aiPrompt').focus({ preventScroll: true });
}

// 初回だけ「AI に相談」の案内を出す
function showAiIntro() {
  try { if (localStorage.getItem(AI_INTRO_KEY)) return; } catch { return; }
  $('aiIntro').hidden = false;
}

function closeAiIntro() {
  $('aiIntro').hidden = true;
  try { localStorage.setItem(AI_INTRO_KEY, '1'); } catch { /* 次回も出るだけ */ }
}

// プレビューを画面いっぱいに出す (エージェントが自分のスクリーンショットで見るため)
function setBigPreview(on, view) {
  document.body.classList.toggle('big-preview', on);
  if (on) $('aiIntro').hidden = true;
  resize();
  if (on || view) fitView(VIEWS[view] || VIEWS.angle);
}

// エージェント型 AI 向けの入口 (このページの JavaScript から呼ぶ)
function exposeAgentApi() {
  const result = async (r) => {
    const built = await whenBuilt();
    const warnings = [...(r.warnings || []), ...sizeWarnings(built?.size)];
    return { ...r, ...built, ...(warnings.length ? { warnings } : {}) };
  };
  window.keychain = {
    help: '文字キーホルダーの設定を変える API。get() で今の設定、spec() で設定できる項目、'
      + 'set({...変更する項目}) で反映 (生成が終わるまで待って結果を返す)、preview({ view: "angle" | "top" }) で PNG の data URL、'
      + 'bigPreview(true, { view }) でプレビューを画面いっぱいに表示 (スクリーンショット用)、download("3mf" | "stl" | "obj" | "obj-y") でファイルを保存、'
      + 'undo() で直前の set を取り消し、link() でいまの設定を開く URL。詳しくは /llms.txt',
    get: () => exportSettings(),
    spec: () => describeParams(NUMBER_FIELDS),
    fonts: () => fonts.list.map((f) => f.name),
    set: (patch) => result(applyParams(patch)),
    undo: () => result({ undone: undoAi() }),
    preview: async (opts) => { await whenBuilt(); return capturePreview(opts); },
    bigPreview: async (on = true, { view } = {}) => {
      if (view !== undefined) viewOf(view); // 使えない向きはここでエラーにする
      await whenBuilt();
      setBigPreview(on, view);
      return { big: on, ...lastBuild };
    },
    download: async (format = $('format').value, { filename } = {}) => {
      const built = await whenBuilt();
      if (built?.error) throw new Error(built.error);
      return saveModel(format, filename || $('filename').value.trim());
    },
    link: () => settingsLink(),
    prompt: () => aiPrompt(),
  };
}

// URL の設定で始める (AI が返したリンクや共有リンク)
//   ?s=<JSON> / ?text=ねこ&plate=capsule (項目名か短い別名) … 設定
//   ?view=angle | top … プレビューを画面いっぱいに出す
//   &fresh=1 … 既定の設定から始める (link() の URL)。ないときは、いまの設定に URL の項目だけを上書きする
function applyUrlSettings() {
  const url = new URL(location.href);
  const view = url.searchParams.get('view');
  if (view !== null) setBigPreview(true, view);
  const names = [...new Set(url.searchParams.keys())].filter((n) => n === 'fresh' || isSettingParam(n, KNOWN_KEYS));
  if (!names.length) return;
  const params = new URLSearchParams(url.searchParams);
  for (const n of names) url.searchParams.delete(n);
  history.replaceState(null, '', url);
  try {
    let patch = parseQuery(params, KNOWN_KEYS);
    if (params.has('fresh')) {
      // 別名 (?s= の中の "bc" など) を項目名にそろえてから、既定の上に重ねる
      patch = { ...defaultsPatch(), ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [ALIASES[k] ?? k, v])) };
    }
    showApplyResult(applyParams(patch));
  } catch (e) {
    aiNote(`URL の設定を読めませんでした: ${e.message}`, true);
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
  if (!Array.isArray(state.lineAligns)) state.lineAligns = [];
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
  setupSegment('ringPos');
  for (const b of $('align').children) {
    b.onmousedown = (e) => e.preventDefault(); // 入力欄の選択を外さない
    b.onclick = () => applyAlign(b.dataset.v);
  }

  // ドラッグ中の色の変更は、取り消し 1 回分にまとめる
  textPicker = new ColorPicker($('textChip'), $('textPicker'),
    (c, { live, byEnter }) => applyToTarget('color', c, live || byEnter, live ? 'picker' : 'style'));
  basePicker = new ColorPicker($('baseChip'), $('basePicker'), (c) => set('baseColor', c));
  basePicker.show(state.baseColor);

  if (saved.format) $('format').value = saved.format;
  $('format').onchange = () => { state.format = $('format').value; save(); };
  $('download').onclick = download;
  $('viewReset').onclick = () => fitView();
  $('viewTop').onclick = () => fitView(VIEWS.top);

  $('aiPrompt').onclick = copyPrompt;
  $('aiImage').onclick = copyImage;
  $('aiSettings').onclick = copySettings;
  $('aiShare').hidden = !canShare();
  $('aiShare').onclick = shareToAi;
  $('aiReply').addEventListener('paste', applyPasted);
  $('aiApply').onclick = applyReply;
  $('aiUndo').onclick = undoAi;
  $('aiOpen').onclick = openAiSection;
  $('aiIntroClose').onclick = closeAiIntro;
  $('bigExit').onclick = () => setBigPreview(false);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('big-preview')) setBigPreview(false);
  });
  exposeAgentApi();
  console.info('AI エージェント向け: window.keychain で設定を変えられます (keychain.help / llms.txt)');

  updateToolbar();
  applyUrlSettings();
  showAiIntro();
  scheduleBuild();
}

init();
