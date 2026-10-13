// ブラウザ版 (Vercel で配信する静的サイト) を dist/ に作る
//   pnpm build  … 本番用にまとめる
//   pnpm dev    … scripts/dev.mjs から watch: true で呼ぶ
//
//   web/app.js (画面) と web/worker.js (形状の生成) を esbuild でまとめ、
//   同梱フォント (Google Fonts の OFL / Apache ライセンスのもの) と、その一覧・クレジットを出力する。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as fontkit from 'fontkit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = path.join(ROOT, 'dist');
const WEB = path.join(ROOT, 'web');

// 同梱するフォント (@expo-google-fonts/* の中の TTF)。キーホルダー向きの太め・ポップなものを選んでいる
const BUNDLED = [
  { pkg: 'mochiy-pop-one', file: '400Regular/MochiyPopOne_400Regular.ttf', name: 'モッチーポップ' },
  { pkg: 'dela-gothic-one', file: '400Regular/DelaGothicOne_400Regular.ttf', name: 'デラゴシック (極太)' },
  { pkg: 'rocknroll-one', file: '400Regular/RocknRollOne_400Regular.ttf', name: 'ロックンロール' },
  { pkg: 'hachi-maru-pop', file: '400Regular/HachiMaruPop_400Regular.ttf', name: 'はちまるポップ' },
  { pkg: 'yusei-magic', file: '400Regular/YuseiMagic_400Regular.ttf', name: '油性マジック' },
  { pkg: 'm-plus-rounded-1c', file: '800ExtraBold/MPLUSRounded1c_800ExtraBold.ttf', name: 'M PLUS Rounded 1c ExtraBold (丸ゴシック)' },
  { pkg: 'zen-maru-gothic', file: '900Black/ZenMaruGothic_900Black.ttf', name: 'Zen 丸ゴシック Black' },
  { pkg: 'zen-maru-gothic', file: '700Bold/ZenMaruGothic_700Bold.ttf', name: 'Zen 丸ゴシック Bold' },
  { pkg: 'kosugi-maru', file: '400Regular/KosugiMaru_400Regular.ttf', name: '小杉丸ゴシック' },
  { pkg: 'noto-sans-jp', file: '900Black/NotoSansJP_900Black.ttf', name: 'Noto Sans JP Black (ゴシック)' },
  { pkg: 'noto-sans-jp', file: '700Bold/NotoSansJP_700Bold.ttf', name: 'Noto Sans JP Bold (ゴシック)' },
  { pkg: 'fredoka', file: '700Bold/Fredoka_700Bold.ttf', name: 'Fredoka Bold' },
  { pkg: 'lilita-one', file: '400Regular/LilitaOne_400Regular.ttf', name: 'Lilita One' },
  { pkg: 'titan-one', file: '400Regular/TitanOne_400Regular.ttf', name: 'Titan One' },
  { pkg: 'pacifico', file: '400Regular/Pacifico_400Regular.ttf', name: 'Pacifico (筆記体)' },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 同梱フォントをコピーし、一覧 (fonts.json) とクレジット (credits.html) を作る
function buildFonts() {
  const outDir = path.join(DIST, 'fonts');
  fs.mkdirSync(outDir, { recursive: true });
  const list = BUNDLED.map(({ pkg, file, name }) => {
    const src = path.join(ROOT, 'node_modules', '@expo-google-fonts', pkg, file);
    const base = path.basename(file);
    fs.copyFileSync(src, path.join(outDir, base));
    const font = fontkit.openSync(src);
    const r = font.name.records;
    return {
      file: base,
      name,
      family: font.familyName,
      group: font.hasGlyphForCodePoint(0x3042) ? 'ja' : 'latin',
      copyright: r.copyright?.en || '',
      license: r.license?.en || '',
      licenseURL: r.licenseURL?.en || '',
    };
  });
  fs.writeFileSync(path.join(outDir, 'fonts.json'),
    JSON.stringify(list.map(({ file, name, family, group }) => ({ file, name, family, group }))));

  const rows = list.map((f) => `<section><h2>${esc(f.name)} <small>${esc(f.family)}</small></h2>
<p>${esc(f.copyright)}</p><p>${esc(f.license)}${f.licenseURL ? ` <a href="${esc(f.licenseURL)}">${esc(f.licenseURL)}</a>` : ''}</p></section>`);
  fs.writeFileSync(path.join(DIST, 'credits.html'), `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>クレジット</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;color:#1f2328;background:#fff;line-height:1.6}
h1{font-size:20px}h2{font-size:15px;margin:0}h2 small{color:#6a737d;font-weight:400}section{border-top:1px solid #e3e6ea;padding:12px 0}
p{margin:4px 0;font-size:13px;color:#444}</style></head><body>
<h1>クレジット</h1>
<p>このサイトに同梱しているフォントは、それぞれのライセンスに基づいて配布しています。フォントファイルは改変していません。</p>
${rows.join('\n')}
<section><h2>ライブラリ</h2><p>three.js (MIT) / fontkit (MIT) / Clipper (Boost Software License) / earcut (ISC)</p></section>
</body></html>`);
}

function copyHtml() {
  fs.copyFileSync(path.join(WEB, 'index.html'), path.join(DIST, 'index.html'));
}

const jsOptions = {
  entryPoints: { app: path.join(WEB, 'app.js'), worker: path.join(WEB, 'worker.js') },
  outdir: DIST,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  logLevel: 'warning',
};

// watch: true のときは esbuild の context を返す (dev サーバー用)
export async function buildWeb({ watch = false } = {}) {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  buildFonts();
  copyHtml();
  if (watch) {
    fs.watch(path.join(WEB, 'index.html'), () => copyHtml());
    const ctx = await esbuild.context({ ...jsOptions, sourcemap: true });
    await ctx.watch();
    return ctx;
  }
  await esbuild.build({ ...jsOptions, minify: true });
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWeb();
  const size = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
  console.log(`dist/ を作りました (${(size(DIST) / 1024 / 1024).toFixed(1)} MB)`);
}
