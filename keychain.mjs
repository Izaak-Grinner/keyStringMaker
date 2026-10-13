#!/usr/bin/env node
// 文字キーホルダー 3D モデルジェネレーター (コマンドライン版)
//   文字列とフォントから「土台プレート + 浮き出し文字 + 吊り下げ用リング」の 3D モデルを作り、
//   3MF / STL / OBJ (単位: mm) で出力する。GUI 版は gui.mjs。
//
//   node keychain.mjs "Hello" --font arial -o hello.obj
//   node keychain.mjs "ねこ" --font "メイリオ" --size 18 -o neko.3mf

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULTS, FORMATS, KeychainError, buildKeychain, exportModel, layoutText } from './lib/geometry.mjs';
import { collectFonts, resolveFont } from './lib/fonts-node.mjs';

const HELP = `使い方: node keychain.mjs <文字列> --font <フォント> [オプション]
       (画面で操作するなら: pnpm dev でブラウザ版を起動)

  -f, --font <path|名前>   フォントファイルのパス、またはフォント名 (例: arial, meiryo, "游ゴシック")
      --font-index <n>     TTC 内のフォント番号 (名前指定時は自動選択)          [0]
  -o, --out <file>         出力ファイル。拡張子で形式を決める (.3mf/.stl/.obj)   [keychain.obj]
  -s, --size <mm>          文字サイズ (フォントの 1em の大きさ)                  [${DEFAULTS.size}]
      --bold <mm>          文字の線を太らせる量 (負で細く)                       [${DEFAULTS.bold}]
      --spacing <mm>       文字間隔の追加量 (負で詰める)                         [${DEFAULTS.spacing}]
      --line-height <倍>   改行時の行送り (em 比)。文字列中の \\n で改行          [${DEFAULTS.lineHeight}]
      --text-height <mm>   文字の浮き出し高さ                                    [${DEFAULTS.textHeight}]
      --base-height <mm>   土台プレートの厚さ                                    [${DEFAULTS.baseHeight}]
      --border <mm>        文字の周りの土台のフチ幅                              [${DEFAULTS.border}]
      --plate <type>       枠の形: outline (文字の周り) / rect (四角) /
                           circle (正円) / ellipse (楕円) / capsule (カプセル)   [${DEFAULTS.plate}]
      --corner <mm>        四角の角の丸み (0 で角ばった四角)                     [${DEFAULTS.corner}]
      --smooth <割合>      外周のなめらかさ (outline のみ。0 で文字の形に近く)   [${DEFAULTS.smooth}]
      --ring-hole <mm>     リング穴の直径 (リングは 1 行目の中心線上の左端)      [${DEFAULTS.ringHole}]
      --ring-wall <mm>     リングの肉厚                                          [${DEFAULTS.ringWall}]
      --ring-fillet <mm>   リングの付け根の丸み                                  [${DEFAULTS.ringFillet}]
      --tolerance <mm>     曲線の分割精度                                        [${DEFAULTS.tolerance}]
      --color <#rrggbb>    文字の色                                              [${DEFAULTS.textColor}]
      --char-colors <list> 文字ごとの色をカンマ区切りで (空欄は --color の色)
                           例: "ねこ" を赤と青に → --char-colors "#e0464d,#2f6fde"
      --base-color <#rrggbb> 土台の色                                            [${DEFAULTS.baseColor}]
      --up <z|y>           OBJ の上方向の軸 (スライサーは z、Blender 等は y)      [z]
      --list-fonts         使えるフォントの一覧を表示 (文字列を付けるとその文字を表示できるフォントだけ)
      --font-sheet <file>  フォント見本を HTML で出力 (文字列を付けるとその文字で見本を作る)
  -h, --help               このヘルプを表示`;

// CLI オプション名 → DEFAULTS のキー (数値)
const NUMERIC = {
  size: 'size', bold: 'bold', spacing: 'spacing', 'line-height': 'lineHeight', 'text-height': 'textHeight',
  'base-height': 'baseHeight', border: 'border', corner: 'corner', smooth: 'smooth', 'ring-hole': 'ringHole',
  'ring-wall': 'ringWall', 'ring-fillet': 'ringFillet', tolerance: 'tolerance',
};

function parseCli() {
  // 「--spacing -1」のような負の数を値として受け取れるよう「--spacing=-1」に直す
  const args = process.argv.slice(2).reduce((out, a, i, all) => {
    if (i > 0 && /^-\d/.test(a) && /^--[a-z-]+$/.test(all[i - 1]) && out.at(-1) === all[i - 1]) out[out.length - 1] += `=${a}`;
    else out.push(a);
    return out;
  }, []);

  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      font: { type: 'string', short: 'f' },
      'font-index': { type: 'string' },
      out: { type: 'string', short: 'o', default: 'keychain.obj' },
      size: { type: 'string', short: 's' },
      ...Object.fromEntries(Object.keys(NUMERIC).filter((k) => k !== 'size').map((k) => [k, { type: 'string' }])),
      plate: { type: 'string', default: DEFAULTS.plate },
      up: { type: 'string', default: 'z' },
      color: { type: 'string' },
      'char-colors': { type: 'string' },
      'base-color': { type: 'string' },
      'list-fonts': { type: 'boolean', default: false },
      'font-sheet': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const opt = {};
  for (const [flag, key] of Object.entries(NUMERIC)) {
    if (values[flag] === undefined) continue;
    const v = Number(values[flag]);
    if (!Number.isFinite(v)) fail(`--${flag} には数値を指定してください: ${values[flag]}`);
    opt[key] = v;
  }
  const oneOf = (key, choices) => {
    if (!choices.includes(values[key])) fail(`--${key} は ${choices.join(' / ')} のいずれかです: ${values[key]}`);
    return values[key];
  };
  opt.plate = oneOf('plate', ['outline', 'rect', 'circle', 'ellipse', 'capsule']);

  const color = (flag, v) => {
    if (!/^#[0-9a-f]{6}$/i.test(v)) fail(`--${flag} は #rrggbb 形式で指定してください: ${v}`);
    return v;
  };
  if (values.color) opt.textColor = color('color', values.color);
  if (values['base-color']) opt.baseColor = color('base-color', values['base-color']);
  const text = positionals.join(' ').replace(/\\n/g, '\n');
  if (values['char-colors']) {
    // 色の並びは空白・改行を除いた文字に対応させ、文字列中の位置 (改行も 1 文字) に直す
    const list = values['char-colors'].split(',').map((c) => c.trim());
    let k = 0;
    opt.charColors = [...text].map((ch) => {
      if (/\s/.test(ch)) return null;
      const c = list[k++];
      return c ? color('char-colors', c) : null;
    });
  }

  const format = path.extname(values.out).slice(1).toLowerCase();
  if (!FORMATS.includes(format)) fail(`出力ファイルの拡張子は ${FORMATS.map((f) => '.' + f).join(' / ')} のいずれかです`);

  return {
    help: values.help,
    listFonts: values['list-fonts'],
    fontSheet: values['font-sheet'],
    text,
    font: values.font,
    fontIndex: values['font-index'] === undefined ? undefined : Number(values['font-index']),
    out: values.out,
    format,
    up: oneOf('up', ['z', 'y']),
    opt,
  };
}

function fail(msg) {
  console.error(`エラー: ${msg}`);
  process.exit(1);
}

// 端末での表示幅 (全角 = 2)
const textWidth = (s) => [...s].reduce((w, ch) => {
  const c = ch.codePointAt(0);
  return w + (c >= 0x2e80 && !(c >= 0xff61 && c <= 0xff9f) ? 2 : 1);
}, 0);

// ファミリーごとに 1 行: 「ファミリー名   指定名1  指定名2 ...」
function printFontList(text) {
  const fonts = collectFonts(text.replace(/\n/g, ''));
  const print = (title, list) => {
    if (!list.length) return;
    const families = new Map();
    for (const f of list) families.set(f.family, [...(families.get(f.family) || []), f.id]);
    const width = Math.max(...[...families.keys()].map(textWidth)) + 2;
    console.log(`\n■ ${title}`);
    for (const [fam, ids] of families) console.log(`  ${fam}${' '.repeat(width - textWidth(fam))}${ids.join('  ')}`);
  };
  console.log(`--font には右側の名前 (英数字) を指定してください${text ? `\n「${text.replace(/\n/g, ' ')}」を表示できるフォントだけを表示しています` : ''}`);
  print('日本語フォント', fonts.filter((f) => f.group === 'ja'));
  print('欧文フォント', fonts.filter((f) => f.group === 'latin'));
  print('中国語・韓国語フォント (かなも表示可)', fonts.filter((f) => f.group === 'cjk'));
  console.log('\n※ HGP〜 / MS-P〜 / BIZ-UDP〜 などの P 付きは、文字幅が詰まったプロポーショナル版です');
  console.log('見た目で選ぶなら: node keychain.mjs "文字列" --font-sheet fonts.html');
}

// 各フォントで文字列を描いた見本 HTML を書き出す
function writeFontSheet(file, text) {
  const sample = text.replace(/\n/g, ' ');
  const fonts = collectFonts(sample);
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const cards = fonts.map(({ font, id, name, group }) => {
    const str = sample || (group !== 'latin' ? 'あいう Abc 123' : 'Abc 123');
    const run = layoutText(font, str);
    let x = 0;
    const paths = run.glyphs.map((g, i) => {
      const pos = run.positions[i];
      const d = g.path.toSVG();
      const el = d ? `<path transform="translate(${x + pos.xOffset} ${pos.yOffset})" d="${d}"/>` : '';
      x += pos.xAdvance;
      return el;
    }).join('');
    const top = font.ascent, bottom = font.descent;
    const svg = `<svg viewBox="0 ${-top} ${Math.max(x, 1)} ${top - bottom}"><g transform="scale(1 -1)">${paths}</g></svg>`;
    return `<div class="card" data-k="${esc((id + ' ' + name).toLowerCase())}">
<div class="meta"><span class="name">${esc(name)}</span><code title="クリックでコピー">--font ${esc(id)}</code></div>${svg}</div>`;
  });

  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>フォント見本</title>
<style>
body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; background: #f6f6f4; color: #222; }
header { position: sticky; top: 0; background: #f6f6f4; padding: 8px 0 12px; }
input { width: 100%; max-width: 360px; padding: 8px; font-size: 15px; box-sizing: border-box; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.card { background: #fff; border-radius: 8px; padding: 12px; box-shadow: 0 1px 2px #0002; }
.meta { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; margin-bottom: 8px; flex-wrap: wrap; }
.name { color: #666; }
code { background: #eef; padding: 2px 6px; border-radius: 4px; cursor: pointer; }
code.ok { background: #cfc; }
svg { height: 56px; max-width: 100%; display: block; fill: #222; }
</style></head><body>
<header><h3 style="margin:0 0 8px">フォント見本 (${fonts.length} 件)</h3>
<input id="q" placeholder="名前で絞り込み (例: gothic, 明朝, bold)"></header>
<div class="grid">${cards.join('\n')}</div>
<script>
q.oninput = () => { const k = q.value.toLowerCase(); for (const c of document.querySelectorAll('.card')) c.hidden = !c.dataset.k.includes(k); };
for (const c of document.querySelectorAll('code')) c.onclick = () => {
  navigator.clipboard.writeText(c.textContent.replace('--font ', '')).then(() => { c.classList.add('ok'); setTimeout(() => c.classList.remove('ok'), 800); });
};
</script></body></html>`;
  fs.writeFileSync(file, html);
  console.log(`${fonts.length} 件のフォント見本を出力しました: ${path.resolve(file)}`);
}

function main() {
  const cli = parseCli();
  if (cli.help) { console.log(HELP); return; }
  if (cli.listFonts) { printFontList(cli.text); return; }
  if (cli.fontSheet) { writeFontSheet(cli.fontSheet, cli.text); return; }
  if (!cli.text.trim()) { console.log(HELP); fail('文字列を指定してください'); }

  try {
    const font = resolveFont(cli.font, cli.fontIndex);
    console.log(`フォント: ${font.fullName || font.postscriptName}`);

    const { objects, size, missing } = buildKeychain(font, cli.text, cli.opt);
    if (missing.length) console.warn(`警告: フォントに含まれない文字があります: ${missing.join(' ')}`);
    fs.writeFileSync(cli.out, exportModel(objects, cli.format, cli.up));

    const tris = objects.reduce((n, o) => n + o.mesh.faces.length, 0);
    console.log(`出力: ${path.resolve(cli.out)}`);
    console.log(`サイズ: ${size.w.toFixed(1)} x ${size.h.toFixed(1)} x ${size.t.toFixed(1)} mm, ${tris} 三角形`);
  } catch (e) {
    if (e instanceof KeychainError) fail(e.message);
    throw e;
  }
}

main();
