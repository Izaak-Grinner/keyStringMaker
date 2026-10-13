// フォントの一覧と読み込み (画面側)
//
//   id の形式:
//     b:<ファイル名>     同梱フォント (dist/fonts/)
//     l:<PostScript名>   この PC にインストールされたフォント (Chrome / Edge の Local Font Access)
//
//   entry: { id, source: 'bundled' | 'local', name, family, group }

export const GROUP_LABELS = {
  ja: '同梱フォント (日本語)',
  latin: '同梱フォント (英数字のみ)',
  local: 'この PC のフォント',
};

export class FontRegistry {
  constructor(styleEl) {
    this.list = [];
    this.byId = new Map();
    this.styleEl = styleEl; // @font-face を書き足す <style>
    this.faces = new Set();
  }

  add(entry) {
    if (this.byId.has(entry.id)) return;
    this.list.push(entry);
    this.byId.set(entry.id, entry);
  }

  has(id) { return this.byId.has(id); }
  get(id) { return this.byId.get(id); }

  async loadBundled() {
    const list = await (await fetch('fonts/fonts.json')).json();
    for (const f of list) {
      this.add({ id: `b:${f.file}`, source: 'bundled', name: f.name, family: f.family, group: f.group, url: `fonts/${f.file}` });
    }
  }

  static get localSupported() { return 'queryLocalFonts' in window; }

  // すでに許可されていれば true (ページを開き直したときに自動で読み込むため)
  static async localGranted() {
    try {
      return (await navigator.permissions.query({ name: 'local-fonts' })).state === 'granted';
    } catch {
      return false;
    }
  }

  // この PC のフォントを一覧に加える (初回はブラウザが許可を求める)
  async loadLocal() {
    const fonts = await window.queryLocalFonts();
    for (const fd of fonts) {
      this.add({ id: `l:${fd.postscriptName}`, source: 'local', group: 'local', name: fd.fullName, family: fd.family, fontData: fd });
    }
    return fonts.length;
  }

  // 形状の生成に使うフォントのデータ
  async bytes(id) {
    const e = this.byId.get(id);
    if (!e) throw new Error(`フォントが見つかりません: ${id}`);
    if (e.source === 'local') {
      return { buffer: await (await e.fontData.blob()).arrayBuffer(), postscriptName: e.fontData.postscriptName };
    }
    const res = await fetch(e.url);
    if (!res.ok) throw new Error(`フォントを取得できませんでした: ${e.name}`);
    return { buffer: await res.arrayBuffer() };
  }

  // 入力欄の表示用 CSS font-family
  cssFamily(id) {
    const e = this.byId.get(id);
    if (!e) return 'sans-serif';
    if (!this.faces.has(id)) {
      this.faces.add(id);
      const src = e.source === 'local' ? `local("${e.fontData.postscriptName.replace(/"/g, '')}")` : `url("${e.url}")`;
      this.styleEl.append(`@font-face { font-family: "kf-${this.faces.size}"; src: ${src}; font-display: block; }\n`);
      e.cssName = `kf-${this.faces.size}`;
    }
    return `"${e.cssName}", sans-serif`;
  }
}
