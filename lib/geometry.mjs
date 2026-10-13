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
function textToPaths(fontAt, text, opt, colorOf) {
  const all = []; // { color, contour }
  const lines = []; // 文字のある行ごとの範囲 (上の行から順)
  const missing = new Set();
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
    // 各行を中央揃え
    const lineWidth = penX - (chars.length ? opt.spacing : 0);
    const lb = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const { color, contour } of lineContours) {
      const moved = contour.map(([x, y]) => [x - lineWidth / 2, y]);
      all.push({ color, contour: moved });
      for (const [x, y] of moved) {
        lb.minX = Math.min(lb.minX, x); lb.maxX = Math.max(lb.maxX, x);
        lb.minY = Math.min(lb.minY, y); lb.maxY = Math.max(lb.maxY, y);
      }
    }
    if (lineContours.length) lines.push(lb);
    lineStart += [...line].length + 1; // + 改行
  });

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

// 土台プレート (穴なし・ひとつながり) を作る
//   outline: 文字の形に沿う / rect: 四角 (corner で角の丸み) / circle: 正円 / ellipse: 楕円
function makePlate(textPaths, lines, opt) {
  const b = bounds(textPaths);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const points = textPaths.flat().map(({ X, Y }) => [X / CL_SCALE - cx, Y / CL_SCALE - cy]);

  switch (opt.plate) {
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
      //   4) 最後にフチの幅だけ膨らませる
      const shape = union(textPaths, lineGapFillers(lines, opt));
      const gap = Math.max(opt.size * 0.18, 0.5);
      let core = union(outers(offset(offset(shape, gap), -gap)));
      core = connectComponents(core, Math.max(opt.size * 0.25, 1.5));
      return union(outers(offset(core, opt.border)));
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

// リング (外円を足して穴を抜く) を左上に付ける
function addRing(plate, textPaths, opt) {
  const holeR = opt.ringHole / 2;
  const outerR = holeR + opt.ringWall;

  // プレートを囲む四角の左上の角から、45° 斜め内側 (右下) へ進み、穴がプレートに接したところに置く。
  // リングの円がプレートに「穴の縁まで」重なるので、付け根は十分な幅になり、外側はきれいな円のまま残る
  const pb = bounds(plate);
  const ux = Math.SQRT1_2, uy = -Math.SQRT1_2;
  const plateSegs = segments(plate);
  const inPlate = (x, y) => plate.some((p) => ClipperLib.Clipper.PointInPolygon(
    { X: Math.round(x * CL_SCALE), Y: Math.round(y * CL_SCALE) }, p) !== 0);
  const distToPlate = (x, y) => (inPlate(x, y) ? 0 : distanceTo(plateSegs, x, y));
  const maxT = Math.hypot(pb.maxX - pb.minX, pb.maxY - pb.minY);
  let t = 0;
  while (t < maxT && distToPlate(pb.minX + ux * t, pb.maxY + uy * t) > holeR) t += 0.1;

  // 穴と文字の間にリング肉厚ぶんの壁が残るまで外側 (左上) へ戻す
  const textSegs = segments(textPaths);
  const at = () => [pb.minX + ux * t, pb.maxY + uy * t];
  for (let i = 0; i < 600 && distanceTo(textSegs, ...at()) < outerR; i++) t -= 0.1;
  const [cx, cy] = at();

  let shape = union(plate, [circle(cx, cy, outerR)]);

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
function groupPolygons(paths) {
  const c = new ClipperLib.Clipper();
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

// 厚み z0〜z1 の柱体を作る。頂点は上下面と側面で共有し、閉じたメッシュにする
function extrude(paths, z0, z1) {
  const verts = [];
  const faces = [];

  for (const { outer, holes } of groupPolygons(paths)) {
    // 外周は反時計回り、穴は時計回りにそろえる (法線を外向きにするため)
    const rings = [outer, ...holes].map((ring, i) => {
      const ccw = ClipperLib.Clipper.Orientation(ring);
      const r = ring.map(({ X, Y }) => [X / CL_SCALE, Y / CL_SCALE]);
      return (i === 0) === ccw ? r : r.reverse();
    });

    const flat = [];
    const holeIdx = [];
    for (const [i, r] of rings.entries()) {
      if (i > 0) holeIdx.push(flat.length / 2);
      for (const [x, y] of r) flat.push(x, y);
    }
    const n = flat.length / 2;
    const base = verts.length;
    for (let i = 0; i < n; i++) verts.push([flat[2 * i], flat[2 * i + 1], z0]);
    for (let i = 0; i < n; i++) verts.push([flat[2 * i], flat[2 * i + 1], z1]);
    const bot = (i) => base + i;
    const top = (i) => base + n + i;

    // 上下面
    const tris = earcut(flat, holeIdx);
    for (let t = 0; t < tris.length; t += 3) {
      let [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
      const area = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1])
        - (flat[2 * c] - flat[2 * a]) * (flat[2 * b + 1] - flat[2 * a + 1]);
      if (area < 0) [b, c] = [c, b];
      faces.push([top(a), top(b), top(c)]);
      faces.push([bot(a), bot(c), bot(b)]);
    }

    // 側面
    let start = 0;
    for (const r of rings) {
      for (let i = 0; i < r.length; i++) {
        const a = start + i;
        const b = start + ((i + 1) % r.length);
        faces.push([bot(a), bot(b), top(b)]);
        faces.push([bot(a), top(b), top(a)]);
      }
      start += r.length;
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
  if (!['outline', 'rect', 'circle', 'ellipse'].includes(opt.plate)) throw new KeychainError(`枠の形が不正です: ${opt.plate}`);

  const textColor = normColor(opt.textColor) || DEFAULTS.textColor;
  const charColors = Array.isArray(opt.charColors) ? opt.charColors : [];
  const colorOf = (i) => normColor(charColors[i]) || textColor;
  // charFonts[i]: i 番目の文字のフォント (fontkit の Font)。指定がなければ font
  const charFonts = Array.isArray(options.charFonts) ? options.charFonts : [];
  const fontAt = (i) => charFonts[i] || font;
  const { paths: textPaths, parts, lines, missing } = textToPaths(fontAt, text, opt, colorOf);
  if (!textPaths.length) throw new KeychainError('文字の輪郭が取得できませんでした (フォントに含まれない文字の可能性があります)');

  const plate = addRing(makePlate(textPaths, lines, opt), textPaths, opt);

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

// 3MF: 各パーツを 1 つのオブジェクトの部品 (component) として書く。
//   スライサーでは 1 つのモデルとして読み込まれ、部品ごとに色 (フィラメント) を割り当てられる。
//   色は標準の basematerials (displaycolor) で各パーツに付ける
export function to3mf(objects) {
  const MATERIALS_ID = 1;
  const materials = objects.map(({ name, color }) => `<base name="${name}" displaycolor="${color.toUpperCase()}FF"/>`).join('');
  const meshXml = objects.map(({ name, mesh }, i) => {
    const v = mesh.verts.map(([x, y, z]) => `<vertex x="${fmt(x)}" y="${fmt(y)}" z="${fmt(z)}"/>`).join('');
    const t = mesh.faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
    return `<object id="${i + 2}" type="model" name="${name}" pid="${MATERIALS_ID}" pindex="${i}"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
  }).join('\n');
  const parentId = objects.length + 2;
  const components = objects.map((_, i) => `<component objectid="${i + 2}"/>`).join('');

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources>
<basematerials id="${MATERIALS_ID}">${materials}</basematerials>
${meshXml}
<object id="${parentId}" type="model" name="keychain"><components>${components}</components></object>
</resources>
<build><item objectid="${parentId}"/></build>
</model>
`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  return zip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rels],
    ['3D/3dmodel.model', model],
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
