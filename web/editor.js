// 文字ごとにフォント・色を持てる簡易リッチテキスト入力欄 (contenteditable)
//
//   モデル: chars = [{ ch, font, color }]   ch は 1 コードポイント (改行は '\n')、font / color は null で既定
//   DOM は表示用で、編集のたびにモデルから描き直す。日本語入力 (IME) の変換中だけはブラウザに任せ、
//   変換が確定したら DOM を読み取ってモデルに反映する。
//
//   new RichEditor(el, { styleOf, onChange, onSelect })
//     styleOf(char) → { fontFamily, color }  表示用のスタイル
//     onChange()                            文字・書式が変わった
//     onSelect()                            選択範囲が変わった

const sameStyle = (a, b) => a.font === b.font && a.color === b.color;

export class RichEditor {
  constructor(el, { styleOf, onChange, onSelect }) {
    this.el = el;
    this.styleOf = styleOf;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.chars = [];
    this.sel = [0, 0];        // 最後に入力欄の中にあった選択範囲 (コードポイント単位)
    this.composing = false;
    this.undoStack = [];
    this.redoStack = [];
    this.lastEdit = { kind: null, time: 0 };

    el.addEventListener('beforeinput', (e) => this.handleBeforeInput(e));
    el.addEventListener('input', (e) => { if (!e.isComposing && !this.composing) this.syncFromDom(); });
    el.addEventListener('compositionstart', () => { this.composing = true; this.snapshot('ime'); });
    el.addEventListener('compositionend', () => { this.composing = false; this.syncFromDom(); });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      this.sel = this.readSelection() || this.sel;
      this.replaceSelection((e.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n'), 'paste');
    });
    el.addEventListener('drop', (e) => e.preventDefault());
    el.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || this.composing) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); }
    });
    // 選択範囲を覚えておく (ツールバーの操作でフォーカスが外れても使えるように)
    const track = () => {
      const s = this.readSelection();
      if (s && (s[0] !== this.sel[0] || s[1] !== this.sel[1])) { this.sel = s; this.onSelect?.(); }
    };
    document.addEventListener('selectionchange', () => {
      // フォーカスがほかの入力欄へ移るとき、ブラウザは選択を一瞬つぶすので、入力欄にフォーカスがある間だけ追う
      if (document.activeElement === this.el) track();
    });
    // selectionchange は遅れて届くので、キー・マウス操作の直後とフォーカスが外れる瞬間にも読む
    el.addEventListener('keyup', track);
    el.addEventListener('mouseup', track);
    el.addEventListener('blur', track);
  }

  // ---- モデル ----

  get text() { return this.chars.map((c) => c.ch).join(''); }

  setContent(text, fonts = [], colors = []) {
    this.chars = [...text].map((ch, i) => ({ ch, font: fonts[i] || null, color: colors[i] || null }));
    this.sel = [this.chars.length, this.chars.length];
    this.render();
  }

  // 選択範囲。何も選択していないときは全体を返す
  targetRange() {
    const [s, e] = this.sel;
    return s === e ? [0, this.chars.length] : [s, e];
  }

  // 選択範囲 (なければ全体) の書式を変える。patch: { font?, color? }
  // kind が 'picker' (色のドラッグ) なら、続けて変えた分は 1 回の取り消しでまとめて戻す
  applyStyle(patch, kind = 'style') {
    const [s, e] = this.targetRange();
    if (s === e) return;
    this.snapshot(kind);
    this.chars = this.chars.map((c, i) => (i >= s && i < e ? { ...c, ...patch } : c));
    this.render();
    this.restoreSelection();
    this.onChange?.();
  }

  // 全文字の書式を変える (既定値に戻すときなど)
  mapChars(fn, kind = 'style') {
    this.snapshot(kind);
    this.chars = this.chars.map(fn);
    this.render();
    this.onChange?.();
  }

  // 新しく入力された文字の書式: 選択範囲の先頭の文字、なければ直前の文字、なければ直後の文字を引き継ぐ (Word と同じ)
  inheritAt(s, e) {
    const src = (e > s ? this.chars[s] : this.chars[s - 1]) || this.chars[e];
    return src ? { font: src.font, color: src.color } : { font: null, color: null };
  }

  replaceSelection(str, kind = 'typing') {
    const [s, e] = this.sel;
    const style = this.inheritAt(s, e);
    this.snapshot(kind);
    const inserted = [...str].map((ch) => ({ ch, ...style }));
    this.chars.splice(s, e - s, ...inserted);
    this.sel = [s + inserted.length, s + inserted.length];
    this.render();
    this.restoreSelection();
    this.onChange?.();
  }

  deleteRange(s, e) {
    if (s === e) return;
    this.snapshot('delete');
    this.chars.splice(s, e - s);
    this.sel = [s, s];
    this.render();
    this.restoreSelection();
    this.onChange?.();
  }

  // DOM の文字列を読み、変わっていない先頭・末尾以外を新しく入力された文字として扱う
  syncFromDom() {
    const text = [...this.parse(this.el)];
    const old = this.chars;
    let p = 0;
    while (p < old.length && p < text.length && old[p].ch === text[p]) p++;
    let q = 0;
    while (q < old.length - p && q < text.length - p && old[old.length - 1 - q].ch === text[text.length - 1 - q]) q++;
    const sel = this.readSelection() || this.sel;
    if (p === old.length && p === text.length) return;
    const style = this.inheritAt(p, old.length - q);
    this.chars = [
      ...old.slice(0, p),
      ...text.slice(p, text.length - q).map((ch) => ({ ch, ...style })),
      ...old.slice(old.length - q),
    ];
    this.sel = sel;
    this.render();
    this.restoreSelection();
    this.onChange?.();
  }

  // ---- 取り消し / やり直し ----

  snapshot(kind) {
    // 続けて打った文字・続けてドラッグした色は 1 回の取り消しでまとめて戻す
    const now = Date.now();
    const merge = (kind === 'typing' || kind === 'picker') && this.lastEdit.kind === kind && now - this.lastEdit.time < 1000;
    this.lastEdit = { kind, time: now };
    if (merge) return;
    this.undoStack.push({ chars: this.chars.slice(), sel: this.sel.slice() });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() { this.travel(this.undoStack, this.redoStack); }
  redo() { this.travel(this.redoStack, this.undoStack); }

  travel(from, to) {
    const snap = from.pop();
    if (!snap) return;
    to.push({ chars: this.chars.slice(), sel: this.sel.slice() });
    this.chars = snap.chars;
    this.sel = snap.sel;
    this.lastEdit = { kind: null, time: 0 };
    this.render();
    this.restoreSelection();
    this.onChange?.();
  }

  // ---- 入力イベント ----

  handleBeforeInput(e) {
    if (e.isComposing || this.composing || e.inputType === 'insertCompositionText') return; // IME 変換中はブラウザに任せる
    // selectionchange は遅れて届くので、編集の直前に今の選択範囲を読み直す
    this.sel = this.readSelection() || this.sel;
    const t = e.inputType;
    if (t === 'insertText' && e.data != null) {
      e.preventDefault();
      this.replaceSelection(e.data);
    } else if (t === 'insertParagraph' || t === 'insertLineBreak') {
      e.preventDefault();
      this.replaceSelection('\n');
    } else if (t.startsWith('delete')) {
      const range = e.getTargetRanges?.()[0];
      if (!range) return; // 範囲が取れないときはブラウザに任せ、input で読み直す
      e.preventDefault();
      const s = this.indexAt(range.startContainer, range.startOffset);
      const end = this.indexAt(range.endContainer, range.endOffset);
      this.deleteRange(Math.min(s, end), Math.max(s, end));
    } else if (t === 'historyUndo' || t === 'historyRedo') {
      e.preventDefault();
      if (t === 'historyUndo') this.undo(); else this.redo();
    }
  }

  // ---- DOM ----

  render() {
    const el = this.el;
    el.textContent = '';
    for (let i = 0; i < this.chars.length;) {
      let j = i + 1;
      while (j < this.chars.length && sameStyle(this.chars[i], this.chars[j])) j++;
      const span = document.createElement('span');
      span.textContent = this.chars.slice(i, j).map((c) => c.ch).join('');
      const { fontFamily, color } = this.styleOf(this.chars[i]);
      span.style.fontFamily = fontFamily;
      span.style.color = color;
      el.append(span);
      i = j;
    }
    // 末尾が改行のとき、空の最終行にカーソルを置けるようにする
    if (this.chars.at(-1)?.ch === '\n') {
      const br = document.createElement('br');
      br.dataset.filler = '1';
      el.append(br);
    }
  }

  // DOM (またはその断片) から文字列を読む
  parse(root) {
    let out = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) out += node.data;
      else if (node.nodeName === 'BR') { if (!node.dataset?.filler) out += '\n'; }
      else {
        const block = node !== root && /^(DIV|P)$/.test(node.nodeName);
        if (block && out && !out.endsWith('\n')) out += '\n';
        node.childNodes.forEach(walk);
      }
    };
    walk(root);
    return out;
  }

  // DOM 上の位置 → 文字の番号
  indexAt(container, offset) {
    const r = document.createRange();
    r.setStart(this.el, 0);
    r.setEnd(container, offset);
    return [...this.parse(r.cloneContents())].length;
  }

  // 文字の番号 → DOM 上の位置
  locate(k) {
    let count = 0;
    const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        const cps = [...node.data];
        if (count + cps.length >= k) return [node, cps.slice(0, k - count).join('').length];
        count += cps.length;
      } else if (node.nodeName === 'BR' && !node.dataset.filler) {
        if (count === k) return [node.parentNode, [...node.parentNode.childNodes].indexOf(node)];
        count++;
      }
    }
    const filler = this.el.lastChild?.dataset?.filler ? 1 : 0;
    return [this.el, this.el.childNodes.length - filler];
  }

  readSelection() {
    const s = document.getSelection();
    if (!s || !s.rangeCount || !this.el.contains(s.anchorNode) || !this.el.contains(s.focusNode)) return null;
    const a = this.indexAt(s.anchorNode, s.anchorOffset);
    const b = this.indexAt(s.focusNode, s.focusOffset);
    return [Math.min(a, b), Math.max(a, b)];
  }

  restoreSelection() {
    const [s, e] = this.sel.map((v) => Math.min(v, this.chars.length));
    const r = document.createRange();
    r.setStart(...this.locate(s));
    r.setEnd(...this.locate(e));
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  focus() {
    this.el.focus();
    this.restoreSelection();
  }
}
