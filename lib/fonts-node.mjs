// Node 用: PC にインストールされたフォントを探して開く (コマンドライン版で使う)

import fs from 'node:fs';
import path from 'node:path';
import * as fontkit from 'fontkit';
import { KeychainError } from './geometry.mjs';

// ---------------------------------------------------------------------------
// フォント
// ---------------------------------------------------------------------------

function fontDirs() {
  const dirs = [];
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  } else if (process.platform === 'darwin') {
    dirs.push('/System/Library/Fonts', '/Library/Fonts', path.join(process.env.HOME || '', 'Library/Fonts'));
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(process.env.HOME || '', '.fonts'),
      path.join(process.env.HOME || '', '.local/share/fonts'));
  }
  return dirs.filter((d) => fs.existsSync(d));
}

function listFontFiles() {
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ttf|otf|ttc|otc)$/i.test(ent.name)) files.push(p);
    }
  };
  for (const d of fontDirs()) walk(d);
  return files;
}

// TTC なら中の全フォント、単体ならそのフォントを返す
export function openFontFile(file) {
  const f = fontkit.openSync(file);
  return f.fonts ? f.fonts : [f];
}

// name テーブルから全言語のファミリー名・フルネーム・PostScript 名を集める
function fontNames(font) {
  const names = new Set([font.postscriptName, font.familyName, font.fullName]);
  const records = font.name?.records || {};
  for (const key of ['fontFamily', 'fullName', 'preferredFamily', 'postscriptName']) {
    const rec = records[key];
    if (rec && typeof rec === 'object') for (const v of Object.values(rec)) names.add(v);
  }
  return [...names].filter((n) => typeof n === 'string' && n);
}

// パス、ファイル名、フォント名 (日本語名・PostScript 名を含む) のいずれかでフォントを探す
export function resolveFont(spec, fontIndex) {
  if (!spec) throw new KeychainError('フォントを指定してください');

  const pick = (fonts, idx = 0) => {
    if (idx < 0 || idx >= fonts.length) throw new KeychainError(`フォント番号は 0〜${fonts.length - 1} です`);
    return fonts[idx];
  };

  if (fs.existsSync(spec)) return pick(openFontFile(spec), fontIndex ?? 0);

  const norm = (s) => s.toLowerCase().replace(/[\s_-]/g, '');
  const want = norm(spec);
  const files = listFontFiles();

  // 1) ファイル名 (拡張子なし) が一致
  const byStem = files.find((f) => norm(path.parse(f).name) === want);
  if (byStem) return pick(openFontFile(byStem), fontIndex ?? 0);

  // 2) フォント内の名前で検索。完全一致を優先し、なければ前方一致
  let prefixHit = null;
  for (const file of files) {
    let fonts;
    try { fonts = openFontFile(file); } catch { continue; }
    for (const font of fonts) {
      const names = fontNames(font).map(norm);
      if (names.includes(want)) return font;
      if (!prefixHit && names.some((n) => n.startsWith(want))) prefixHit = font;
    }
  }
  if (prefixHit) return prefixHit;
  throw new KeychainError(`フォントが見つかりません: ${spec}`);
}

// 記号・アイコン用フォント (文字キーホルダーには使えない)
const isSymbolFont = (font) =>
  font.cmap.tables.some((t) => t.platformID === 3 && t.encodingID === 0)
  || /icons|mdl2|emoji|webdings|wingdings|marlett|bookshelf|mt extra|outlook|specialty/i.test(font.familyName || '');

export const supportsText = (font, text) =>
  [...text].every((ch) => /\s/.test(ch) || font.hasGlyphForCodePoint(ch.codePointAt(0)));

const displayName = (font) => {
  const full = font.name?.records?.fullName || {};
  return full.ja || full.en || font.fullName || font.postscriptName;
};

// 太さ違いをまとめるためのファミリー名 (日本語名を優先)
const familyName = (font) => {
  const r = font.name?.records || {};
  const fam = r.preferredFamily || r.fontFamily || {};
  // プロポーショナル版 (HGP, ＭＳ Ｐ, BIZ UDP など) も元のファミリーにまとめる
  return (fam.ja || fam.en || font.familyName || font.postscriptName)
    .replace(/^HG[PS]/, 'HG').replace(/^BIZ UDP/, 'BIZ UD').replace(/^ＭＳ Ｐ/, 'ＭＳ ')
    .replace(/^(UD デジタル 教科書体 N)[PK]$/, '$1');
};

// かなを含むが日本語用ではないフォント
const isChineseKoreanFont = (font) => /YaHei|JhengHei|Malgun|SimSun|MingLiU/i.test(font.familyName || '');

// 使えるフォントの一覧 (text を表示できるものだけ)。日本語 → 欧文 → 中韓の順
//   group: 'ja' | 'latin' | 'cjk'
export function collectFonts(text = '') {
  const result = [];
  const seen = new Set();
  for (const file of listFontFiles()) {
    let fonts;
    try { fonts = openFontFile(file); } catch { continue; }
    fonts.forEach((font, index) => {
      if (!font.postscriptName || seen.has(font.postscriptName) || isSymbolFont(font)) return;
      if (text && !supportsText(font, text)) return;
      seen.add(font.postscriptName);
      const group = !supportsText(font, 'あア') ? 'latin' : isChineseKoreanFont(font) ? 'cjk' : 'ja';
      result.push({
        font, file, index, group, id: font.postscriptName, name: displayName(font), family: familyName(font),
        weight: (font['OS/2']?.usWeightClass || 400) + (font.italicAngle ? 1 : 0),
      });
    });
  }
  const order = { ja: 0, latin: 1, cjk: 2 };
  return result.sort((a, b) => (order[a.group] - order[b.group])
    || a.family.localeCompare(b.family, 'ja') || (a.weight - b.weight));
}
