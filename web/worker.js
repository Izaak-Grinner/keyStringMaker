// 形状の生成を画面とは別のスレッドで行う (重い計算で入力が引っかからないように)
//
//   画面からのメッセージ: { id, type, ...payload }  → 返信: { id, ok: true, result } / { id, ok: false, error }
//     font  { fontId, buffer, postscriptName }   フォントを登録する
//     drop  { fontId }                           フォントを捨てる (メモリ節約)
//     build { params }                           プレビュー用メッシュを作る
//     export { params, format, up }              ファイルを作る

import * as fontkit from 'fontkit';
import { buildKeychain, exportModel, KeychainError } from '../lib/geometry.mjs';

const fonts = new Map(); // fontId → fontkit の Font

function registerFont({ fontId, buffer, postscriptName }) {
  let font = fontkit.create(new Uint8Array(buffer), postscriptName || undefined);
  if (font.fonts) font = font.fonts[0]; // TTC で名前の指定がないときは最初のフォント
  fonts.set(fontId, font);
  return { name: font.fullName || font.postscriptName };
}

function build({ text, font, charFonts = [], ...options }) {
  const get = (id) => {
    const f = fonts.get(id);
    if (!f) throw new KeychainError(`フォントが読み込まれていません: ${id}`);
    return f;
  };
  return buildKeychain(get(font), text, { ...options, charFonts: charFonts.map((id) => (id ? get(id) : null)) });
}

const handlers = {
  font: registerFont,
  drop: ({ fontId }) => { fonts.delete(fontId); return null; },
  build: ({ params }) => {
    const { objects, size, missing } = build(params);
    const meshes = objects.map(({ name, color, mesh }) => ({
      name, color,
      positions: Float32Array.from(mesh.verts.flat()),
      indices: Uint32Array.from(mesh.faces.flat()),
    }));
    return { meshes, size, missing };
  },
  export: ({ params, format, up }) => ({ bytes: exportModel(build(params).objects, format, up) }),
};

self.onmessage = ({ data: { id, type, ...payload } }) => {
  try {
    const result = handlers[type](payload);
    // 大きな配列はコピーせずに渡す
    const transfer = [];
    for (const m of result?.meshes || []) transfer.push(m.positions.buffer, m.indices.buffer);
    if (result?.bytes) transfer.push(result.bytes.buffer);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    const message = e instanceof KeychainError ? e.message : `生成に失敗しました: ${e.message}`;
    if (!(e instanceof KeychainError)) console.error(e);
    self.postMessage({ id, ok: false, error: message });
  }
};
