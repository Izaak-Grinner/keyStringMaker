// 色の指定 (色の見本ボタン → 彩度・明るさの四角 + 色相のバー + 色コード)
//
//   new ColorPicker(chip, panel, onChange)
//     chip     いまの色を表示するボタン。押すと panel を開閉する
//     panel    ピッカーを入れる空の要素 (hidden で閉じる)
//     onChange(color, { live, byEnter })  色が選ばれた。live はドラッグ中、byEnter は色コード欄で Enter
//   show(color)  いまの色を表示する (null は複数の色)
//
// 四角とバーは押してもフォーカスを奪わない (文字の入力欄の選択範囲を残すため)

// 色コードを #rrggbb にそろえる。「#」なし・3 桁 (#f00) も受け付ける。不正なら null
export function parseHex(v) {
  const h = v.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) return '#' + [...h].map((c) => c + c).join('').toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(h)) return '#' + h.toLowerCase();
  return null;
}

// h: 0〜360, s・v: 0〜1
function hsvToHex({ h, s, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

// 灰色 (彩度 0) や黒 (明るさ 0) では色相が決まらないので、そのときは keepHue を使う
function hexToHsv(hex, keepHue = 0) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = keepHue;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d + 6) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h, s: max ? d / max : 0, v: max };
}

const MIXED_BG = 'repeating-linear-gradient(45deg, #ccc 0 3px, #fff 3px 6px)';
const clamp01 = (x) => Math.min(1, Math.max(0, x));

export class ColorPicker {
  constructor(chip, panel, onChange) {
    this.chip = chip;
    this.panel = panel;
    this.onChange = onChange;
    this.color = null;
    this.hsv = { h: 0, s: 1, v: 1 };

    panel.classList.add('picker');
    panel.innerHTML = `
      <div class="picker-sv" title="彩度 (左右) と明るさ (上下)"><span class="picker-thumb"></span></div>
      <div class="picker-hue" title="色相"><span class="picker-thumb"></span></div>
      <label class="picker-hex">色コード
        <span class="hex-preview"></span>
        <input type="text" maxlength="7" spellcheck="false" autocomplete="off">
      </label>`;
    this.sv = panel.querySelector('.picker-sv');
    this.hue = panel.querySelector('.picker-hue');
    this.preview = panel.querySelector('.hex-preview');
    this.input = panel.querySelector('input');

    chip.onmousedown = (e) => e.preventDefault(); // 入力欄の選択を外さない
    chip.onclick = () => this.setOpen(panel.hidden);

    this.drag(this.sv, (x, y) => ({ ...this.hsv, s: x, v: 1 - y }));
    this.drag(this.hue, (x) => ({ ...this.hsv, h: x * 360 }));
    this.setupHexInput();

    // 外側を押すか Esc で閉じる
    document.addEventListener('pointerdown', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && !chip.contains(e.target)) this.setOpen(false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) this.setOpen(false); });
  }

  setOpen(open) {
    this.panel.hidden = !open;
    this.chip.setAttribute('aria-expanded', open);
    if (open) this.show(this.color);
  }

  show(color) {
    this.color = color;
    this.chip.style.setProperty('--chip', color || MIXED_BG);
    if (this.panel.hidden) return;
    // ドラッグ中に戻ってきた色で色相が丸め誤差の分ずれないよう、違う色のときだけ読み直す
    if (color && color !== hsvToHex(this.hsv)) this.hsv = hexToHsv(color, this.hsv.h);
    this.renderPicker();
    if (document.activeElement === this.input) return;
    this.input.value = color || '';
    this.input.placeholder = color ? '' : '複数の色';
    this.input.classList.remove('invalid');
    this.preview.style.background = color || MIXED_BG;
  }

  renderPicker() {
    const { h, s, v } = this.hsv;
    this.sv.style.setProperty('--hue', `hsl(${h} 100% 50%)`);
    const [svThumb, hueThumb] = [this.sv.firstElementChild, this.hue.firstElementChild];
    svThumb.style.left = `${s * 100}%`;
    svThumb.style.top = `${(1 - v) * 100}%`;
    svThumb.style.background = hsvToHex(this.hsv);
    hueThumb.style.left = `${(h / 360) * 100}%`;
    hueThumb.style.background = `hsl(${h} 100% 50%)`;
  }

  // 四角・バーのドラッグ。toHsv(x, y) は押した位置 (0〜1) から新しい色を作る
  drag(el, toHsv) {
    const update = (e) => {
      const r = el.getBoundingClientRect();
      this.hsv = toHsv(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
      this.renderPicker();
      const c = hsvToHex(this.hsv);
      if (c === this.color) return;
      this.color = c;
      this.input.value = c;
      this.input.classList.remove('invalid');
      this.preview.style.background = c;
      this.chip.style.setProperty('--chip', c);
      this.onChange(c, { live: true });
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // フォーカスと文字の選択を動かさない
      el.setPointerCapture(e.pointerId);
      update(e);
    });
    el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) update(e); });
  }

  // 色コード欄。Enter か欄から離れたときに反映する
  setupHexInput() {
    const { input, preview } = this;
    let applied = null; // Enter で反映したあと、フォーカスが外れたときに同じ色を二重に反映しない
    input.onfocus = () => { applied = null; };
    const commit = (byEnter) => {
      const c = parseHex(input.value);
      input.classList.toggle('invalid', !c && input.value.trim() !== '');
      if (!c || c === applied) return;
      applied = c;
      input.value = c;
      this.color = c;
      this.hsv = hexToHsv(c, this.hsv.h);
      this.renderPicker();
      preview.style.background = c;
      this.chip.style.setProperty('--chip', c);
      this.onChange(c, { byEnter });
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    };
    input.onchange = () => commit(false);
    input.oninput = () => {
      const c = parseHex(input.value);
      input.classList.remove('invalid');
      if (c) preview.style.background = c; // 入力中も見本の色だけは変える
    };
  }
}
