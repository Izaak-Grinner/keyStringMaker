// 文字キーホルダー生成の本体 (ブラウザ・Node 共通。Node 専用の機能は使わない)
//   文字の輪郭 → 土台・リング付きの 2D 形状 → 押し出しメッシュ → OBJ / STL / 3MF
//   フォントは fontkit の Font オブジェクトを受け取る (読み込みは呼び出し側で行う)

import ClipperLib from 'clipper-lib';
import earcut from 'earcut';
import { DEFAULTS } from './defaults.mjs';

export { DEFAULTS };

const CL_SCALE = 1000; // Clipper は整数座標なので 1mm = 1000 単位 (1µm) で扱う

export class KeychainError extends Error {}

// 文字列をグリフと位置に変換する。一部のフォントは字詰め情報 (GSUB/GPOS) の読み込みに失敗するので、
// その場合は字詰めなしで並べる
export function layoutText(font, str) {
  try {
    return font.layout(str);
  } catch {
    const glyphs = font.glyphsForString(str);
    const positions = glyphs.map((g) => ({ xAdvance: g.advanceWidth, yAdvance: 0, xOffset: 0, yOffset: 0 }));
    return { glyphs, positions };
  }
}

// ---------------------------------------------------------------------------
// 文字のアウトライン → 多角形
// ---------------------------------------------------------------------------

// 二次/三次ベジェを、弦の誤差が tol 以下になる分割数で直線化
function quadSegments(p0, p1, p2, tol) {
  const d = Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]);
  return Math.min(100, Math.max(1, Math.ceil(Math.sqrt(d / (4 * tol)))));
}

function cubicSegments(p0, p1, p2, p3, tol) {
  const m = Math.max(
    Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]),
    Math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]),
  );
  return Math.min(100, Math.max(1, Math.ceil(Math.sqrt((0.75 * m) / tol))));
}

// fontkit の Path を、変換 (font units → mm) を掛けた折れ線の配列にする
function flattenPath(glyphPath, transform, tol) {
  const contours = [];
  let cur = null;
  let last = null;
  const push = (p) => { cur.push(p); last = p; };

  for (const { command, args } of glyphPath.commands) {
    switch (command) {
      case 'moveTo':
        if (cur && cur.length >= 3) contours.push(cur);
        cur = [];
        push(transform(args[0], args[1]));
        break;
      case 'lineTo':
        push(transform(args[0], args[1]));
        break;
      case 'quadraticCurveTo': {
        const p0 = last, p1 = transform(args[0], args[1]), p2 = transform(args[2], args[3]);
        const n = quadSegments(p0, p1, p2, tol);
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
        }
        break;
      }
      case 'bezierCurveTo': {
        const p0 = last, p1 = transform(args[0], args[1]), p2 = transform(args[2], args[3]),
          p3 = transform(args[4], args[5]);
        const n = cubicSegments(p0, p1, p2, p3, tol);
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
          push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
        }
        break;
      }
      case 'closePath':
        if (cur && cur.length >= 3) contours.push(cur);
        cur = null;
        break;
    }
  }
  if (cur && cur.length >= 3) contours.push(cur);
  return contours;
}

const toClipper = (contour) => contour.map(([x, y]) => ({ X: Math.round(x * CL_SCALE), Y: Math.round(y * CL_SCALE) }));

// 文字列をレイアウトして、文字全体の輪郭 (Clipper Paths)、色ごとの輪郭、行ごとの範囲、フォントにない文字を返す
//   fontAt(i) / colorOf(i): 文字列の i 番目 (コードポイント単位、改行も 1 文字と数える) の文字のフォント / 色
//   行は opt.lineAligns / opt.align で左・中央・右に揃える (左右は、いちばん長い行の端に合わせる)
function textToPaths(fontAt, text, opt, colorOf) {
  const all = []; // { color, contour }
  const lines = []; // 文字のある行ごとの範囲 (上の行から順)
  const missing = new Set();
  const laidOut = []; // 行ごとの { contours, width, align }
  let lineStart = 0;

  text.split('\n').forEach((line, li) => {
    const chars = [...line];
    const lineContours = [];
    let penX = 0; // mm
    const baseY = -li * opt.size * opt.lineHeight;

    // 同じフォントが続く範囲 (ラン) ごとにレイアウトする。ラン内では字詰め・合字が効く
    for (let runStart = 0; runStart < chars.length;) {
      const font = fontAt(lineStart + runStart);
      let runEnd = runStart + 1;
      while (runEnd < chars.length && fontAt(lineStart + runEnd) === font) runEnd++;
      const scale = opt.size / font.unitsPerEm; // font units → mm
      const run = layoutText(font, chars.slice(runStart, runEnd).join(''));
      let cursor = runStart;
      run.glyphs.forEach((glyph, gi) => {
        const pos = run.positions[gi];
        // グリフが表す文字数だけ進める (合字は先頭の文字の色になる)
        const color = colorOf(lineStart + cursor);
        cursor += Math.max(1, glyph.codePoints.length);
        if (glyph.id === 0) {
          const ch = glyph.codePoints.length ? String.fromCodePoint(...glyph.codePoints) : '?';
          if (!/^\s+$/.test(ch)) missing.add(ch);
        }
        const ox = penX + pos.xOffset * scale;
        const oy = baseY + pos.yOffset * scale;
        const tf = (x, y) => [ox + x * scale, oy + y * scale];
        for (const contour of flattenPath(glyph.path, tf, opt.tolerance)) lineContours.push({ color, contour });
        penX += pos.xAdvance * scale + opt.spacing;
      });
      runStart = runEnd;
    }
    const width = penX - (chars.length ? opt.spacing : 0);
    const align = (Array.isArray(opt.lineAligns) && opt.lineAligns[li]) || opt.align;
    laidOut.push({ contours: lineContours, width, align });
    lineStart += [...line].length + 1; // + 改行
  });

  // 行を揃える。全体の幅の中心を x = 0 にする
  const maxWidth = Math.max(0, ...laidOut.map((l) => l.width));
  for (const { contours, width, align } of laidOut) {
    const dx = align === 'left' ? -maxWidth / 2 : align === 'right' ? maxWidth / 2 - width : -width / 2;
    const lb = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const { color, contour } of contours) {
      const moved = contour.map(([x, y]) => [x + dx, y]);
      all.push({ color, contour: moved });
      for (const [x, y] of moved) {
        lb.minX = Math.min(lb.minX, x); lb.maxX = Math.max(lb.maxX, x);
        lb.minY = Math.min(lb.minY, y); lb.maxY = Math.max(lb.maxY, y);
      }
    }
    if (contours.length) lines.push(lb);
  }

  // 非ゼロ規則で合成すると、TrueType/CFF の向きの違いや文字同士の重なりを正しく処理できる
  const merge = (contours) => {
    const p = ClipperLib.Clipper.CleanPolygons(union(contours.map(toClipper)), 2);
    return opt.bold ? union(offset(p, opt.bold)) : p;
  };
  const paths = merge(all.map((a) => a.contour));

  // 色ごとにまとめる。太らせた文字同士が重なる部分は、先に出てきた色を優先して後の色から削る
  const byColor = new Map();
  for (const { color, contour } of all) byColor.set(color, [...(byColor.get(color) || []), contour]);
  const parts = [];
  let taken = [];
  for (const [color, contours] of byColor) {
    let p = merge(contours);
    if (taken.length) p = difference(p, taken);
    if (!p.length) continue;
    parts.push({ color, paths: p });
    taken = union(taken, p);
  }
  // 太らせた分だけ行の範囲も広げる
  const grow = Math.max(opt.bold, 0);
  for (const l of lines) { l.minX -= grow; l.maxX += grow; l.minY -= grow; l.maxY += grow; }
  return { paths, parts, lines, missing: [...missing] };
}

// ---------------------------------------------------------------------------
// 2D 形状の操作 (Clipper)
// ---------------------------------------------------------------------------

function boolOp(type, subject, clip = []) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const out = [];
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

const union = (a, b = []) => boolOp(ClipperLib.ClipType.ctUnion, a, b);
const difference = (a, b) => boolOp(ClipperLib.ClipType.ctDifference, a, b);

function offset(paths, deltaMm, endType = ClipperLib.EndType.etClosedPolygon) {
  const co = new ClipperLib.ClipperOffset(2, 0.01 * CL_SCALE);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, endType);
  const out = [];
  co.Execute(out, deltaMm * CL_SCALE);
  return out;
}

const outers = (paths) => paths.filter((p) => ClipperLib.Clipper.Orientation(p));

function bounds(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (const { X, Y } of p) {
    if (X < minX) minX = X; if (X > maxX) maxX = X;
    if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
  }
  return { minX: minX / CL_SCALE, minY: minY / CL_SCALE, maxX: maxX / CL_SCALE, maxY: maxY / CL_SCALE };
}

function ellipse(cx, cy, rx, ry) {
  const n = Math.max(48, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / 0.3));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push({ X: Math.round((cx + rx * Math.cos(a)) * CL_SCALE), Y: Math.round((cy + ry * Math.sin(a)) * CL_SCALE) });
  }
  return pts;
}

const circle = (cx, cy, r) => ellipse(cx, cy, r, r);

// 隣り合う行の間を埋める四角 (上下の行が横に重なっている幅だけ)。
//   行の中に少し食い込ませて、行間の土台が細いくびれにならないようにする
function lineGapFillers(lines, opt) {
  const fillers = [];
  const inset = opt.size * 0.2;
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i], b = lines[i + 1]; // a が上の行
    const x0 = Math.max(a.minX, b.minX), x1 = Math.min(a.maxX, b.maxX);
    if (x1 - x0 < 0.1) continue;
    const y0 = Math.min(b.maxY - inset, a.minY + inset), y1 = Math.max(b.maxY - inset, a.minY + inset);
    fillers.push(toClipper([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]));
  }
  return fillers;
}

// カプセル台座の形: 半径 r、左右の半円の中心 ax / bx、中心線の高さ cy
//   左右の半円は、文字のどの点もフチ幅ぶん内側に入るところまで外へ広げる (文字の角が端に寄らないように)
function capsuleLayout(textPaths, opt) {
  const b = bounds(textPaths);
  const cy = (b.minY + b.maxY) / 2;
  const inner = (b.maxY - b.minY) / 2;
  const r = inner + opt.border;
  const pts = textPaths.flat().map(({ X, Y }) => [X / CL_SCALE, Y / CL_SCALE]);
  // side = 1: 右の半円 (cx より右の点を見る)、-1: 左の半円
  const fits = (cx, side) => pts.every(([x, y]) => side * (x - cx) <= 0 || Math.hypot(x - cx, y - cy) <= inner);
  const step = 0.05;
  let bx = b.maxX - inner;
  while (bx < b.maxX && !fits(bx, 1)) bx += step;
  let ax = b.minX + inner;
  while (ax > b.minX && !fits(ax, -1)) ax -= step;
  return { r, ax, bx: Math.max(bx, ax + 0.01), cy };
}

// 土台プレート (穴なし・ひとつながり) を作る
//   outline: 文字の形に沿う / rect: 四角 (corner で角の丸み) / circle: 正円 / ellipse: 楕円
//   capsule: 両端が半円の台座
function makePlate(textPaths, lines, opt) {
  const b = bounds(textPaths);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const points = textPaths.flat().map(({ X, Y }) => [X / CL_SCALE - cx, Y / CL_SCALE - cy]);

  switch (opt.plate) {
    case 'capsule': {
      // 高さ = 文字の高さ + フチ
      const { r, ax, bx, cy: y } = capsuleLayout(textPaths, opt);
      return offset([toClipper([[ax, y], [bx, y]])], r, ClipperLib.EndType.etOpenRound);
    }
    case 'rect': {
      const x0 = b.minX - opt.border, x1 = b.maxX + opt.border, y0 = b.minY - opt.border, y1 = b.maxY + opt.border;
      // 角丸は「内側に縮めた四角を半径 r で膨らませる」ことで作る
      const r = Math.max(0, Math.min(opt.corner, (x1 - x0) / 2 - 0.01, (y1 - y0) / 2 - 0.01));
      const box = toClipper([[x0 + r, y0 + r], [x1 - r, y0 + r], [x1 - r, y1 - r], [x0 + r, y1 - r]]);
      return r > 0.005 ? offset([box], r) : [box];
    }
    case 'circle': {
      const r = points.reduce((m, [x, y]) => Math.max(m, Math.hypot(x, y)), 0);
      return [circle(cx, cy, r + opt.border)];
    }
    case 'ellipse': {
      // 文字の縦横比に合わせた楕円を、全ての点が入るまで相似拡大する
      const hw = Math.max((b.maxX - b.minX) / 2, 0.1), hh = Math.max((b.maxY - b.minY) / 2, 0.1);
      const s = points.reduce((m, [x, y]) => Math.max(m, Math.hypot(x / hw, y / hh)), 0);
      return [ellipse(cx, cy, hw * s + opt.border, hh * s + opt.border)];
    }
    default: {
      // 文字の形に沿う土台。フチの幅が細くても割れないよう、膨らませる前に文字どうしをしっかりつなぐ
      //   1) 複数行のときは行の間を埋める
      //   2) クロージング (膨張→収縮) で、隣の文字や 1 文字の中の離れた部分 (濁点・はねなど) の隙間を埋める
      //   3) それでも離れている部分 (スペースなど) は、いちばん近いところを帯でつなぐ
      //   4) フチの幅 + R だけ膨らませてから R だけ縮める (外周の波・字間の谷・濁点のコブ・切れ込みの奥をならす)。
      //      R = 文字サイズ × smooth。0 でも内側の角だけは丸める
      //   5) 細い突起 (ノズル径以下) を削る (収縮→膨張)
      const shape = union(textPaths, lineGapFillers(lines, opt));
      const gap = Math.max(opt.size * 0.18, 0.5);
      let core = union(outers(offset(offset(shape, gap), -gap)));
      core = connectComponents(core, Math.max(opt.size * 0.25, 1.5));
      const R = Math.max(opt.size * opt.smooth, opt.size * 0.1, 1);
      const plate = union(outers(offset(offset(core, opt.border + R), -R)));
      const m = Math.min(opt.border * 0.4, 0.8);
      return m > 0.01 ? union(outers(offset(offset(plate, -m), m))) : plate;
    }
  }
}

// 離れた島どうしを、幅 width の帯でつないで 1 つにする (いちばん近い点どうしを順につなぐ)
function connectComponents(paths, width) {
  let shape = paths;
  for (let guard = 0; guard < 100; guard++) {
    const comps = outers(shape);
    if (comps.length <= 1) return shape;
    // 探索を軽くするため、頂点を間引いて最寄りの組を探す
    const sample = (p) => {
      const step = Math.max(1, Math.floor(p.length / 300));
      return p.filter((_, i) => i % step === 0);
    };
    const first = sample(comps[0]);
    let best = null, bestD = Infinity;
    for (let j = 1; j < comps.length; j++) {
      for (const q of sample(comps[j])) {
        for (const p of first) {
          const d = (p.X - q.X) ** 2 + (p.Y - q.Y) ** 2;
          if (d < bestD) { bestD = d; best = [p, q]; }
        }
      }
    }
    shape = union(shape, offset([best], width / 2, ClipperLib.EndType.etOpenRound));
  }
  return shape;
}

// 輪郭の辺を (x1, y1, x2, y2) の列で返す (mm)
function segments(paths) {
  const segs = [];
  for (const p of paths) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      segs.push([a.X / CL_SCALE, a.Y / CL_SCALE, b.X / CL_SCALE, b.Y / CL_SCALE]);
    }
  }
  return segs;
}

// 点から輪郭までの最短距離
function distanceTo(segs, px, py) {
  let best = Infinity;
  for (const [x1, y1, x2, y2] of segs) {
    const ex = x2 - x1, ey = y2 - y1;
    const len2 = ex * ex + ey * ey;
    const s = len2 ? Math.max(0, Math.min(1, ((px - x1) * ex + (py - y1) * ey) / len2)) : 0;
    best = Math.min(best, Math.hypot(x1 + s * ex - px, y1 + s * ey - py));
  }
  return best;
}

// リングの位置 → 外へ向かう向き [dx, dy] と、基準にする範囲 (all: 文字全体 / first: 1 行目)
const RING_DIRS = {
  left: { dir: [-1, 0], area: 'all' },
  'top-left': { dir: [-1, 0], area: 'first' },
  top: { dir: [0, 1], area: 'all' },
  'top-right': { dir: [1, 0], area: 'first' },
  right: { dir: [1, 0], area: 'all' },
};
const ALIGNS = ['left', 'center', 'right'];

// リングを、文字の範囲の端から opt.ringPos の向きへ「文字列の延長」として付ける。
//   左・右は文字全体の上下中央、左上・右上は 1 行目の上下中央、上は文字全体の左右中央。
//   円 + 太い首 (外径の 8 割の幅) でプレートにつなぎ、付け根をフィレットで丸めてから穴を抜く
function addRing(plate, textPaths, lines, opt) {
  const holeR = opt.ringHole / 2;
  const outerR = holeR + opt.ringWall;

  // 起点 (範囲の端) と向き。リングの中心は 起点 + t × 向き に置く
  const { dir: [dx, dy], area } = RING_DIRS[opt.ringPos];
  const tb = area === 'first' && lines[0] ? lines[0] : bounds(textPaths);
  const ax = dx < 0 ? tb.minX : dx > 0 ? tb.maxX : (tb.minX + tb.maxX) / 2;
  const ay = dy > 0 ? tb.maxY : (tb.minY + tb.maxY) / 2;
  const at = (t) => [ax + dx * t, ay + dy * t];
  const inPlate = ([x, y]) => plate.some((p) => ClipperLib.Clipper.PointInPolygon(
    { X: Math.round(x * CL_SCALE), Y: Math.round(y * CL_SCALE) }, p) !== 0);

  // 向きの線上で、プレートのいちばん外側
  const pb = bounds(plate);
  const far = Math.hypot(pb.maxX - pb.minX, pb.maxY - pb.minY) + outerR;
  let edgeT = far;
  while (edgeT > -far && !inPlate(at(edgeT))) edgeT -= 0.1;

  // 位置: (a) 穴のふちと文字の間が opt.ringGap になる位置まで外から寄せる (0 なら穴が文字に触れる手前まで)
  //       (b) 丸・楕円 (文字から遠くまでプレートがある) では、穴がプレートの外側に接する位置
  //       のうち、より外側。穴が文字の範囲より内側に入り込まないようにもする
  const textSegs = segments(textPaths);
  const keep = holeR + opt.ringGap;
  let textT = far;
  while (textT > holeR && distanceTo(textSegs, ...at(textT - 0.1)) > keep) textT -= 0.1;
  const roundPlate = opt.plate === 'circle' || opt.plate === 'ellipse';
  const tc = Math.max(textT, roundPlate ? edgeT + holeR : -Infinity, holeR);
  const [cx, cy] = at(tc);

  // 首: 円の中心から、プレートの中へ食い込むところまで。両端が丸い帯 (幅は外径の 6 割)
  const [ex, ey] = at(Math.min(edgeT, tc) - Math.max(opt.border * 2, outerR));
  const neck = offset([toClipper([[cx, cy], [ex, ey]])], outerR * 0.6, ClipperLib.EndType.etOpenRound);
  let shape = union(plate, [circle(cx, cy, outerR), ...neck]);

  // 付け根のフィレット (クロージング)
  if (opt.ringFillet > 0) shape = union(outers(offset(offset(shape, opt.ringFillet), -opt.ringFillet)));

  // 文字の形によってはプレートから離れることがあるので、そのときだけ帯でつなぐ
  if (outers(shape).length > 1) {
    let best = null, bestD = Infinity;
    for (const p of plate) for (const pt of p) {
      const d = Math.hypot(pt.X / CL_SCALE - cx, pt.Y / CL_SCALE - cy);
      if (d < bestD) { bestD = d; best = pt; }
    }
    const bridge = offset([[{ X: Math.round(cx * CL_SCALE), Y: Math.round(cy * CL_SCALE) }, best]],
      opt.ringWall, ClipperLib.EndType.etOpenRound);
    shape = union(shape, bridge);
  }

  return difference(shape, [circle(cx, cy, holeR)]);
}

// ---------------------------------------------------------------------------
// 押し出し → 三角形メッシュ
// ---------------------------------------------------------------------------

// Clipper Paths を「外周 + その穴」のグループに分ける
//   StrictlySimple: 外周と穴が点で接しているような形を、接しない単純な多角形に分けて出力させる
function groupPolygons(paths) {
  const c = new ClipperLib.Clipper();
  c.StrictlySimple = true;
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);

  const groups = [];
  const visit = (node) => {
    for (const outer of node.Childs()) {
      const holes = outer.Childs();
      groups.push({ outer: outer.Contour(), holes: holes.map((h) => h.Contour()) });
      holes.forEach(visit); // 穴の中の島
    }
  };
  visit(tree);
  return groups;
}

// earcut は、頂点が一直線上に並ぶところ (穴の辺どうしが同じ直線に乗るときなど) で、別の頂点を
// 辺の途中に乗せたまま三角形を作ったり、一直線上の頂点を飛ばしたりする (T 字接合)。
// 側面の辺と食い違って非多様体エッジになるので、辺の途中に乗った頂点で三角形を分ける
//   tris: [a, b, c] の配列、pts: [x, y] (整数座標)、ringEdges: 外周・穴の辺 [a, b]
function splitTJunctions(tris, pts, ringEdges) {
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let pass = 0; pass < 10; pass++) {
    // 閉じた面なら、どの辺も「三角形 2 つ」か「三角形 1 つ + 外周・穴の辺」で使われる
    const count = new Map();
    const add = (a, b) => count.set(key(a, b), (count.get(key(a, b)) || 0) + 1);
    for (const [a, b] of ringEdges) add(a, b);
    for (const [a, b, c] of tris) { add(a, b); add(b, c); add(c, a); }
    const loose = new Set();
    for (const [k, n] of count) if (n !== 2) for (const v of k.split(',')) loose.add(+v);
    if (!loose.size) break;

    // 辺 p-q の途中 (両端を除く) に乗っている頂点を、p に近い順に
    const between = (p, q) => {
      const [px, py] = pts[p], ex = pts[q][0] - px, ey = pts[q][1] - py, len2 = ex * ex + ey * ey;
      const on = [];
      for (const v of loose) {
        const dx = pts[v][0] - px, dy = pts[v][1] - py, t = dx * ex + dy * ey;
        if (dx * ey - dy * ex === 0 && t > 0 && t < len2) on.push([t, v]);
      }
      return on.sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    };
    let changed = false;
    tris = tris.flatMap(([a, b, c]) => {
      for (const [p, q, r] of [[a, b, c], [b, c, a], [c, a, b]]) {
        if (count.get(key(p, q)) === 2) continue;
        const chain = [p, ...between(p, q), q];
        if (chain.length === 2) continue;
        changed = true;
        return chain.slice(0, -1).map((v, i) => [v, chain[i + 1], r]); // 向きはそのまま
      }
      return [[a, b, c]];
    });
    if (!changed) break;
  }
  return tris;
}

// 1 点で接している形 (外周と穴、隣の島など) は、側面の縦の辺を 4 枚の面が共有して非多様体になる。
// ごくわずか (5µm) 膨らませてから縮める (クロージング) と、接点がつながって解消する。角は留め継ぎで保つ。
// まれにクロージング後も接点が残るので、そのときは量を増やしてやり直す。返り値は groupPolygons と同じ
function fusedGroups(paths) {
  const run = (p, delta) => {
    const co = new ClipperLib.ClipperOffset();
    co.AddPaths(p, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
    const out = [];
    co.Execute(out, delta);
    return out;
  };
  // 1 点で接しているか: 同じ位置の頂点が 2 回以上出てくる、または頂点がほかの辺の途中に乗っている
  const touching = (groups) => {
    const rings = groups.flatMap(({ outer, holes }) => [outer, ...holes]);
    const seen = new Set();
    for (const ring of rings) for (const { X, Y } of ring) {
      const k = `${X},${Y}`;
      if (seen.has(k)) return true;
      seen.add(k);
    }
    // 辺を 1mm 四方のマスに振り分けて、頂点の近くの辺だけ調べる
    const CELL = CL_SCALE;
    const grid = new Map();
    for (const ring of rings) ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length];
      for (let gx = Math.floor(Math.min(a.X, b.X) / CELL); gx <= Math.floor(Math.max(a.X, b.X) / CELL); gx++) {
        for (let gy = Math.floor(Math.min(a.Y, b.Y) / CELL); gy <= Math.floor(Math.max(a.Y, b.Y) / CELL); gy++) {
          const k = `${gx},${gy}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push([a, b]);
        }
      }
    });
    for (const ring of rings) for (const v of ring) {
      for (const [a, b] of grid.get(`${Math.floor(v.X / CELL)},${Math.floor(v.Y / CELL)}`) || []) {
        if (v === a || v === b) continue;
        const ex = b.X - a.X, ey = b.Y - a.Y, dx = v.X - a.X, dy = v.Y - a.Y, t = dx * ex + dy * ey;
        if (dx * ey - dy * ex === 0 && t > 0 && t < ex * ex + ey * ey) return true;
      }
    }
    return false;
  };
  let groups;
  for (const mm of [0.005, 0.01, 0.02, 0.04]) {
    const d = mm * CL_SCALE;
    groups = groupPolygons(run(run(paths, d), -d));
    if (!touching(groups)) break;
  }
  return groups;
}

// 厚み z0〜z1 の柱体を作る。頂点は上下面と側面で共有し、閉じたメッシュにする
function extrude(paths, z0, z1) {
  const verts = [];
  const faces = [];

  for (const { outer, holes } of fusedGroups(paths)) {
    // 外周は反時計回り、穴は時計回りにそろえる (法線を外向きにするため)。座標は Clipper の整数のまま扱う
    const rings = [outer, ...holes].map((ring, i) => {
      const ccw = ClipperLib.Clipper.Orientation(ring);
      const r = ring.map(({ X, Y }) => [X, Y]);
      return (i === 0) === ccw ? r : r.reverse();
    });

    // 同じ位置の頂点 (外周と穴が 1 点で接するところなど) は 1 つにまとめる。
    //   別々のままだと、上下面と側面で違う方の頂点を使ってしまい辺が食い違う
    const pts = [];
    const ids = new Map();
    const idOf = ([x, y]) => {
      const k = `${x},${y}`;
      if (!ids.has(k)) { ids.set(k, pts.length); pts.push([x, y]); }
      return ids.get(k);
    };
    const ringIds = rings.flat().map(idOf); // earcut の頂点番号 → まとめた頂点番号
    const holeIdx = [];
    const ringEdges = [];
    let start = 0;
    for (const [i, r] of rings.entries()) {
      if (i > 0) holeIdx.push(start);
      for (let j = 0; j < r.length; j++) {
        const a = ringIds[start + j], b = ringIds[start + ((j + 1) % r.length)];
        if (a !== b) ringEdges.push([a, b]);
      }
      start += r.length;
    }
    const n = pts.length;
    const base = verts.length;
    for (const [x, y] of pts) verts.push([x / CL_SCALE, y / CL_SCALE, z0]);
    for (const [x, y] of pts) verts.push([x / CL_SCALE, y / CL_SCALE, z1]);
    const bot = (i) => base + i;
    const top = (i) => base + n + i;

    // 上下面 (三角形を反時計回りにそろえてから T 字接合を直す)
    const idx = earcut(rings.flat().flat(), holeIdx).map((i) => ringIds[i]);
    const tris = [];
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      if (a === b || b === c || c === a) continue;
      const area = (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[c][0] - pts[a][0]) * (pts[b][1] - pts[a][1]);
      tris.push(area < 0 ? [a, c, b] : [a, b, c]);
    }
    for (const [a, b, c] of splitTJunctions(tris, pts, ringEdges)) {
      faces.push([top(a), top(b), top(c)]);
      faces.push([bot(a), bot(c), bot(b)]);
    }

    // 側面
    for (const [a, b] of ringEdges) {
      faces.push([bot(a), bot(b), top(b)]);
      faces.push([bot(a), top(b), top(a)]);
    }
  }
  return { verts, faces };
}

// ---------------------------------------------------------------------------
// キーホルダー全体の生成
// ---------------------------------------------------------------------------

const normColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);

// 返り値: { objects: [{ name, color, mesh }], size: { w, h, t }, missing: [文字] }
//   objects は土台 (base) と、文字の色ごとのパーツ (text / text_1, text_2, ...)
//   座標は mm、土台の左下が原点、Z が上
//   options.charFonts で文字ごとのフォント (Font オブジェクトの配列) を指定できる
export function buildKeychain(font, text, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  if (!text.trim()) throw new KeychainError('文字を入力してください');
  for (const key of ['size', 'textHeight', 'baseHeight', 'ringHole', 'ringWall', 'tolerance']) {
    if (!(opt[key] > 0)) throw new KeychainError(`${key} は 0 より大きい値にしてください`);
  }
  if (!['outline', 'rect', 'circle', 'ellipse', 'capsule'].includes(opt.plate)) throw new KeychainError(`枠の形が不正です: ${opt.plate}`);
  if (!ALIGNS.includes(opt.align)) throw new KeychainError(`行の揃えが不正です: ${opt.align}`);
  if (!RING_DIRS[opt.ringPos]) throw new KeychainError(`リングの位置が不正です: ${opt.ringPos}`);
  if (!(opt.ringGap >= 0)) throw new KeychainError('ringGap は 0 以上の値にしてください');

  const textColor = normColor(opt.textColor) || DEFAULTS.textColor;
  const charColors = Array.isArray(opt.charColors) ? opt.charColors : [];
  const colorOf = (i) => normColor(charColors[i]) || textColor;
  // charFonts[i]: i 番目の文字のフォント (fontkit の Font)。指定がなければ font
  const charFonts = Array.isArray(options.charFonts) ? options.charFonts : [];
  const fontAt = (i) => charFonts[i] || font;
  const { paths: textPaths, parts, lines, missing } = textToPaths(fontAt, text, opt, colorOf);
  if (!textPaths.length) throw new KeychainError('文字の輪郭が取得できませんでした (フォントに含まれない文字の可能性があります)');

  const plate = addRing(makePlate(textPaths, lines, opt), textPaths, lines, opt);

  // 全体の左下を原点に移動
  const b = bounds(plate);
  const dx = Math.round(b.minX * CL_SCALE), dy = Math.round(b.minY * CL_SCALE);
  const shift = (paths) => paths.map((p) => p.map(({ X, Y }) => ({ X: X - dx, Y: Y - dy })));

  const top = opt.baseHeight + opt.textHeight;
  return {
    objects: [
      { name: 'base', color: normColor(opt.baseColor) || DEFAULTS.baseColor, mesh: extrude(shift(plate), 0, opt.baseHeight) },
      ...parts.map(({ color, paths }, i) => ({
        name: parts.length > 1 ? `text_${i + 1}` : 'text', color, mesh: extrude(shift(paths), opt.baseHeight, top),
      })),
    ],
    size: { w: b.maxX - b.minX, h: b.maxY - b.minY, t: opt.baseHeight + opt.textHeight },
    missing,
  };
}

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

export const FORMATS = ['3mf', 'stl', 'obj'];

const fmt = (v) => {
  const s = v.toFixed(4).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

// OBJ: パーツを別オブジェクトとして書く。色は頂点カラー (v x y z r g b) で入れる。
//   up = 'y' なら Y-up (Blender 等) に回す
export function toObj(objects, up = 'z') {
  const lines = ['# text keychain (units: mm)'];
  let offsetIdx = 1;
  for (const { name, color, mesh } of objects) {
    lines.push(`o ${name}`);
    const c = rgb(color).map((v) => v.toFixed(3)).join(' ');
    for (const [x, y, z] of mesh.verts) {
      lines.push(up === 'y' ? `v ${fmt(x)} ${fmt(z)} ${fmt(-y)} ${c}` : `v ${fmt(x)} ${fmt(y)} ${fmt(z)} ${c}`);
    }
    for (const [a, b, c] of mesh.faces) lines.push(`f ${a + offsetIdx} ${b + offsetIdx} ${c + offsetIdx}`);
    offsetIdx += mesh.verts.length;
  }
  return utf8(lines.join('\n') + '\n');
}

const utf8 = (s) => new TextEncoder().encode(s);

// バイナリ STL: 全オブジェクトをひとつにまとめる
export function toStl(objects) {
  const count = objects.reduce((n, o) => n + o.mesh.faces.length, 0);
  const bytes = new Uint8Array(84 + 50 * count);
  bytes.set(utf8('text keychain (units: mm)'));
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  let p = 84;
  for (const { mesh } of objects) {
    for (const f of mesh.faces) {
      const [a, b, c] = f.map((i) => mesh.verts[i]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(...n) || 1;
      for (const x of [...n.map((x) => x / len), ...a, ...b, ...c]) { view.setFloat32(p, x, true); p += 4; }
      p += 2; // attribute byte count
    }
  }
  return bytes;
}

// 3MF: Bambu Studio 形式で書く (Orca Slicer / Creality Print などもこの形式を読む)。
//   各パーツを 1 つのオブジェクトの部品 (component) にし、Metadata/model_settings.config で
//   部品ごとのフィラメント番号を指定する (同じ色は同じ番号、出てきた順に 1, 2, ...)。
//   スライサーでは 1 つのモデルとして読み込まれ、色ごとに別のフィラメントが割り当てられた状態になる。
//   ほかのソフト向けに、標準の basematerials (displaycolor) でも色を付けておく
export function to3mf(objects) {
  const OBJECTS_PATH = '3D/Objects/object_1.model';
  const MATERIALS_ID = objects.length + 1;
  const parentId = objects.length + 2;
  const partId = (i) => i + 1;
  const filaments = [...new Set(objects.map((o) => o.color))];
  const filamentOf = (o) => filaments.indexOf(o.color) + 1;
  // Production 拡張 (p:path) で使う UUID。中身は区別できればよいので連番で作る
  const uuid = (n) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
    + 'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" '
    + 'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';

  const materials = objects.map(({ name, color }) => `<base name="${name}" displaycolor="${color.toUpperCase()}FF"/>`).join('');
  const meshXml = objects.map(({ name, mesh }, i) => {
    const v = mesh.verts.map(([x, y, z]) => `<vertex x="${fmt(x)}" y="${fmt(y)}" z="${fmt(z)}"/>`).join('');
    const t = mesh.faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
    return `<object id="${partId(i)}" p:UUID="${uuid(partId(i))}" type="model" name="${name}" pid="${MATERIALS_ID}" pindex="${i}"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
  }).join('\n');
  const objectsModel = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" ${NS}>
<metadata name="BambuStudio:3mfVersion">1</metadata>
<resources>
<basematerials id="${MATERIALS_ID}">${materials}</basematerials>
${meshXml}
</resources>
<build/>
</model>
`;

  const components = objects.map((_, i) =>
    `<component p:path="/${OBJECTS_PATH}" objectid="${partId(i)}" p:UUID="${uuid(0x10000 + i)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" ${NS}>
<metadata name="Application">BambuStudio-01.09.00.00</metadata>
<metadata name="BambuStudio:3mfVersion">1</metadata>
<metadata name="Title">keychain</metadata>
<resources>
<object id="${parentId}" p:UUID="${uuid(parentId)}" type="model"><components>${components}</components></object>
</resources>
<build p:UUID="${uuid(0x20000)}"><item objectid="${parentId}" p:UUID="${uuid(0x20001)}" printable="1"/></build>
</model>
`;

  const faceCount = objects.reduce((n, o) => n + o.mesh.faces.length, 0);
  const parts = objects.map((o, i) => `    <part id="${partId(i)}" subtype="normal_part">
      <metadata key="name" value="${o.name}"/>
      <metadata key="extruder" value="${filamentOf(o)}"/>
      <mesh_stat face_count="${o.mesh.faces.length}"/>
    </part>`).join('\n');
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${parentId}">
    <metadata key="name" value="keychain"/>
    <metadata key="extruder" value="1"/>
    <metadata face_count="${faceCount}"/>
${parts}
  </object>
</config>
`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
<Default Extension="config" ContentType="text/xml"/>
</Types>
`;
  const rels = (target) => `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/${target}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  return zip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels('3D/3dmodel.model')],
    ['3D/3dmodel.model', model],
    ['3D/_rels/3dmodel.model.rels', rels(OBJECTS_PATH)],
    [OBJECTS_PATH, objectsModel],
    ['Metadata/model_settings.config', modelSettings],
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 最小限の ZIP 書き出し (無圧縮。ブラウザでも Node でも同じように動く)
function zip(entries) {
  const parts = [];
  const centrals = [];
  let offsetPos = 0;
  const header = (size, fill) => {
    const b = new Uint8Array(size);
    fill(new DataView(b.buffer));
    return b;
  };
  for (const [name, content] of entries) {
    const data = utf8(content);
    const nameBytes = utf8(name);
    const crc = crc32(data);
    const common = (v, at) => {
      v.setUint16(at, 20, true);            // version needed
      v.setUint16(at + 2, 0x0800, true);    // flags: UTF-8 names
      v.setUint16(at + 4, 0, true);         // 無圧縮
      v.setUint16(at + 6, 0, true);         // time
      v.setUint16(at + 8, 0x21, true);      // date (1980-01-01)
      v.setUint32(at + 10, crc, true);
      v.setUint32(at + 14, data.length, true);
      v.setUint32(at + 18, data.length, true);
      v.setUint16(at + 22, nameBytes.length, true);
    };
    const local = header(30, (v) => { v.setUint32(0, 0x04034b50, true); common(v, 4); });
    parts.push(local, nameBytes, data);
    const central = header(46, (v) => {
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);             // version made by
      common(v, 6);
      v.setUint32(42, offsetPos, true);
    });
    centrals.push(central, nameBytes);
    offsetPos += local.length + nameBytes.length + data.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = header(22, (v) => {
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, entries.length, true);
    v.setUint16(10, entries.length, true);
    v.setUint32(12, cdSize, true);
    v.setUint32(16, offsetPos, true);
  });
  const all = [...parts, ...centrals, end];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

// format: '3mf' | 'stl' | 'obj', up: OBJ のみ ('z' | 'y')
export function exportModel(objects, format, up = 'z') {
  switch (format) {
    case '3mf': return to3mf(objects);
    case 'stl': return toStl(objects);
    case 'obj': return toObj(objects, up);
    default: throw new KeychainError(`対応していない形式です: ${format}`);
  }
}
