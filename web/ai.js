// 利用者の AI (チャット型・エージェント型) で設定を調整するための部品
//   - normalizePatch: AI から来た設定 (変更する項目だけの JSON) を検証して、state に入れられる形にする
//   - buildPrompt:    チャット型 AI に貼る依頼文を作る (buildSettingsUpdate は 2 回目以降の「いまの設定だけ」)
//   - extractJson:    AI の返答から設定の JSON を取り出す
//   - parseQuery:     URL の ?s=<JSON> と ?text=…&plate=… (短い別名も可) から設定を取り出す

// 選択肢のある項目 (値 → 画面での呼び名)
export const CHOICES = {
  plate: { label: '枠の形', values: { outline: '文字の周り', rect: '四角', circle: '丸', ellipse: '楕円', capsule: 'カプセル' } },
  ringPos: {
    label: 'リングの位置',
    values: { left: '左 (文字全体の上下中央)', 'top-left': '左上 (1 行目の左)', top: '上', 'top-right': '右上 (1 行目の右)', right: '右 (文字全体の上下中央)' },
  },
  align: { label: '行の揃え', values: { left: '左揃え', center: '中央揃え', right: '右揃え' } },
};

const LABELS = {
  text: '文字', font: 'フォント', textColor: '文字の色', baseColor: '土台の色',
  charColors: '文字ごとの色', charFonts: '文字ごとのフォント', lineAligns: '行ごとの揃え',
};

// URL で使える短い別名 (キャメルケースの項目は頭文字 2 つ)
export const ALIASES = {
  t: 'text', f: 'font', lh: 'lineHeight', th: 'textHeight', bh: 'baseHeight', rp: 'ringPos',
  rh: 'ringHole', rw: 'ringWall', rg: 'ringGap', rf: 'ringFillet', tc: 'textColor', bc: 'baseColor',
  cc: 'charColors', cf: 'charFonts', la: 'lineAligns',
};

const MAX_TEXT = 100;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lineCountOf = (text) => text.split('\n').length;
const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// "#rrggbb" に直す ("rrggbb"・"#rgb" も受け付ける)。だめなら null
function toHex(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${h.toLowerCase()}`;
}

// 項目の画面での呼び名
export function labelOf(key, numbers) {
  return LABELS[key] ?? CHOICES[key]?.label ?? numbers.find((f) => f.key === key)?.label ?? key;
}

// 文字列の「位置 → 文字」の一覧 (改行は ↵)。AI が位置を数え間違えないように依頼文に載せる
export function positionTable(text) {
  return [...text].map((ch, i) => `${i}:${ch === '\n' ? '↵' : ch}`).join(' ');
}

// patch: AI から来た設定。numbers: スライダーの項目 ({ key, label, unit, min, max })
// resolveFont(名前 or id) → id | null、fontName(id) → 名前、current: いまの state
// 戻り値 changes: state に上書きする値、applied: 変わった項目の説明、warnings: 丸めた・無視した項目の説明
export function normalizePatch(patch, { numbers, resolveFont, fontName, current }) {
  if (typeof patch === 'string') {
    try { patch = JSON.parse(patch); } catch { throw new Error(`設定は {"項目": 値} の形の JSON にしてください (例: {"border": 4})。読めなかった値: ${patch}`); }
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('設定は {"項目": 値} の形の JSON にしてください');
  const changes = {}, applied = [], warnings = [];
  const numberField = new Map(numbers.map((f) => [f.key, f]));
  const put = (key, value, label, from, to) => {
    if (same(current[key], value)) return;
    changes[key] = value;
    applied.push(`${label}: ${from} → ${to}`);
  };

  for (const [name, raw] of Object.entries(patch)) {
    const key = ALIASES[name] ?? name;
    const f = numberField.get(key);
    if (f) {
      const v = Number(raw);
      if (raw === null || raw === '' || !Number.isFinite(v)) { warnings.push(`${f.label} (${key}): 数値ではないので無視しました`); continue; }
      const clamped = Math.min(f.max, Math.max(f.min, v));
      if (clamped !== v) warnings.push(`${f.label} (${key}): ${v} は範囲 (${f.min}〜${f.max}) の外なので ${clamped} にしました`);
      put(key, clamped, f.label, `${current[key]}${f.unit}`, `${clamped}${f.unit}`);
    } else if (CHOICES[key]) {
      const { label, values } = CHOICES[key];
      if (!(raw in values)) { warnings.push(`${label} (${key}): "${raw}" は選べないので無視しました (${Object.keys(values).join(' / ')})`); continue; }
      put(key, raw, label, values[current[key]] ?? current[key], values[raw]);
    } else if (key === 'text') {
      if (typeof raw !== 'string' || !raw.trim()) { warnings.push('文字 (text): 空なので無視しました'); continue; }
      let text = raw.replace(/\r\n?/g, '\n');
      if ([...text].length > MAX_TEXT) { text = [...text].slice(0, MAX_TEXT).join(''); warnings.push(`文字 (text): 長すぎるので ${MAX_TEXT} 文字までにしました`); }
      put('text', text, LABELS.text, `「${current.text}」`, `「${text}」`);
    } else if (key === 'font') {
      const id = resolveFont(raw);
      if (!id) { warnings.push(`フォント (font): "${raw}" が見つからないので無視しました`); continue; }
      put('font', id, LABELS.font, fontName(current.font), fontName(id));
    } else if (key === 'textColor' || key === 'baseColor') {
      const hex = toHex(raw);
      if (!hex) { warnings.push(`${LABELS[key]} (${key}): "${raw}" は #rrggbb の形ではないので無視しました`); continue; }
      put(key, hex, LABELS[key], current[key], hex);
    } else if (key === 'charColors' || key === 'charFonts') {
      // 配列 (i 番目の値) か、文字で指定するオブジェクト ({"ね": "#ff0000"})
      if (!Array.isArray(raw) && !isPlainObject(raw)) { warnings.push(`${LABELS[key]} (${key}): 配列か {"文字": 値} の形ではないので無視しました`); continue; }
      changes[key] = raw; // 文字数が決まってから下で整える
    } else if (key === 'lineAligns') {
      if (!Array.isArray(raw)) { warnings.push(`${LABELS[key]} (${key}): 配列ではないので無視しました`); continue; }
      changes[key] = raw; // 行数が決まってから下で整える
    } else {
      warnings.push(`"${name}" は設定できる項目ではないので無視しました`);
    }
  }

  // 文字ごと・行ごとの指定を、最終的な文字列の長さ・行数に合わせる
  const text = changes.text ?? current.text;
  const length = [...text].length;
  const lines = lineCountOf(text);
  const textKept = !('text' in changes) || [...current.text].length === length;
  const perItem = {
    charColors: { size: length, fix: toHex, show: (a) => a.filter(Boolean).join(', ') },
    charFonts: { size: length, fix: (v) => (typeof v === 'string' ? resolveFont(v) : null), show: (a) => a.filter(Boolean).map(fontName).join(', ') },
    lineAligns: { size: lines, fix: (v) => (v in CHOICES.align.values ? v : null), show: (a) => a.map((v) => (v ? CHOICES.align.values[v] : '既定')).join(', ') },
  };
  const empty = (v) => v == null || v === '';
  for (const [key, { size, fix, show }] of Object.entries(perItem)) {
    if (key in changes) {
      let raw = changes[key];
      delete changes[key];
      if (isPlainObject(raw)) raw = byCharacter(key, raw, text, textKept ? current[key] : [], warnings);
      const value = Array.from({ length: size }, (_, i) => (empty(raw[i]) ? null : fix(raw[i])));
      if (raw.some((v, i) => i < size && !empty(v) && value[i] === null)) warnings.push(`${LABELS[key]} (${key}): 使えない値を既定に戻しました`);
      if (raw.length > size) warnings.push(`${LABELS[key]} (${key}): 数が多すぎるので後ろを捨てました`);
      put(key, value, LABELS[key], show(current[key] || []) || 'なし', show(value) || 'なし');
    } else if ('text' in changes) {
      // 文字数 (行の揃えは行数) が同じなら引き継ぎ、変わったら位置がずれるので消す
      const kept = key === 'lineAligns' ? lineCountOf(current.text) === lines : [...current.text].length === length;
      if (!kept && (current[key] || []).some(Boolean)) {
        changes[key] = [];
        warnings.push(`${LABELS[key]}: 文字数・行数が変わったので解除しました`);
      }
    }
  }
  return { changes, applied, warnings };
}

// {"ね": "#ff0000", "こ": null} → 文字列の中のその文字 (2 文字以上ならその並び) すべてに値を付けた配列。
// base (いまの文字ごとの指定) に上書きする
function byCharacter(key, map, text, base, warnings) {
  const chars = [...text];
  const out = chars.map((_, i) => base?.[i] ?? null);
  for (const [sub, v] of Object.entries(map)) {
    const target = [...sub];
    let hits = 0;
    for (let i = 0; target.length && i + target.length <= chars.length; i++) {
      if (target.every((ch, j) => chars[i + j] === ch)) {
        for (let j = 0; j < target.length; j++) out[i + j] = v;
        hits++;
      }
    }
    if (!hits) warnings.push(`${LABELS[key]} (${key}): 「${sub}」は文字の中にないので無視しました`);
  }
  return out;
}

// AI に見せる「設定できる項目」の説明 (keychain.spec() でも返す)
export function describeParams(numbers) {
  return [
    { key: 'text', type: 'string', label: '文字 (改行は \n)' },
    { key: 'font', type: 'string', label: 'フォント名 (フォント一覧から)' },
    ...numbers.map(({ key, label, unit, min, max, hint, when }) =>
      ({ key, type: 'number', label: [label, hint, when].filter(Boolean).join('。'), unit, min, max })),
    ...Object.entries(CHOICES).map(([key, { label, values }]) => ({ key, type: 'choice', label, values })),
    { key: 'textColor', type: 'color', label: '文字の色 (#rrggbb)' },
    { key: 'baseColor', type: 'color', label: '土台の色 (#rrggbb)' },
    { key: 'charColors', type: 'array', label: '文字ごとの色。{"文字": "#rrggbb"} でその文字すべてに付く (おすすめ)。配列なら文字列の i 番目 (改行も 1 文字と数える) の色、null は textColor' },
    { key: 'charFonts', type: 'array', label: '文字ごとのフォント名。{"文字": "フォント名"} か配列、null は font' },
    { key: 'lineAligns', type: 'array', label: 'i 行目の揃え ("left" / "center" / "right")、null は align' },
  ].map((p) => ({ ...p, alias: Object.keys(ALIASES).find((a) => ALIASES[a] === p.key) }));
}

function describeLine(p) {
  if (p.type === 'number') return `- ${p.key}: ${p.label} (${p.min}〜${p.max}${p.unit ? ` ${p.unit}` : ''})`;
  if (p.type === 'choice') return `- ${p.key}: ${p.label}。${Object.entries(p.values).map(([v, l]) => `"${v}" (${l})`).join(' / ')}`;
  return `- ${p.key}: ${p.label}`;
}

// 「いまの設定」と、文字ごとの指定の番号の一覧
function settingsBlock(settings) {
  const chars = [...settings.text];
  return `\`\`\`json
${JSON.stringify(settings, null, 2)}
\`\`\`${chars.length > 1 ? `

文字の位置 (配列で文字ごとに指定するときの番号。↵ は改行): ${positionTable(settings.text)}` : ''}`;
}

// チャット型 AI に貼る依頼文
export function buildPrompt({ settings, params, fontNames, moreFonts }) {
  return `あなたは 3D プリンター用の「文字キーホルダー」を作るアプリの設定を調整するアシスタントです。
文字の形をした土台に文字が浮き出し、端に吊り下げ用のリングが付いたキーホルダーです。長さの単位はすべて mm です。
下の「いまの設定」を、私の希望に合わせて変更してください。画像が添付されていれば、それがいまの見た目です。

## 返答のしかた
- 変更する項目だけを、\`\`\`json のコードブロック 1 つで返してください (例: {"border": 4, "ringPos": "top"})
- 値は「設定できる項目」の範囲・選択肢から選んでください
- 文字ごとの色・フォントは、文字で指定してください (例: {"charColors": {"ね": "#ff0000"}} で「ね」がすべて赤)
- コードブロックのあとに、何をなぜ変えたかを短く説明してください
- 私の希望があいまいなときは、案を 1 つに決めて返してください
- このあとも同じ形で何度かやりとりします。私が画面で設定を変えたときは、新しい「いまの設定」を送ります

## 設定できる項目
${params.map(describeLine).join('\n')}

## 使えるフォント
${fontNames.map((n) => `- ${n}`).join('\n')}${moreFonts ? '\n(ほかに、この PC にインストールされているフォントも使えます)' : ''}

## いまの設定
${settingsBlock(settings)}

## 私の希望
`;
}

// 2 回目以降に貼る「いまの設定だけ」(画面で設定を変えたあと、AI の知っている設定をそろえる)
export function buildSettingsUpdate({ settings }) {
  return `画面で設定を変えました。いまの設定は次のとおりです。これをもとに、さきほどと同じ形 (変更する項目だけの \`\`\`json) で返してください。

## いまの設定
${settingsBlock(settings)}

## 私の希望
`;
}

// URL のパラメーターのうち、設定にあたるもの (s か、項目名・別名)
export const isSettingParam = (name, known) => name === 's' || known.has(ALIASES[name] ?? name);

// URL の ?s=<JSON> と、項目ごとのパラメーター (?text=ねこ&plate=capsule&bc=ffcc00) から設定を取り出す。
// 項目ごとの値は文字列のまま (数値・色は normalizePatch で直す)。配列はカンマ区切りか JSON
export function parseQuery(params, known) {
  const patch = {};
  const s = params.get('s');
  if (s !== null) {
    const v = JSON.parse(s);
    if (!isPlainObject(v)) throw new Error('s は {"項目": 値} の形の JSON にしてください');
    Object.assign(patch, v);
  }
  for (const [name, raw] of params) {
    if (name === 's' || !isSettingParam(name, known)) continue;
    const key = ALIASES[name] ?? name;
    if (key === 'charColors' || key === 'charFonts' || key === 'lineAligns') {
      patch[key] = /^\s*[[{]/.test(raw) ? JSON.parse(raw) : raw.split(',').map((v) => v.trim() || null);
    } else {
      patch[key] = key === 'text' ? raw.replace(/\n/g, '\n') : raw; // URL を手で書く AI のために \n も改行にする
    }
  }
  return patch;
}

// AI の返答から設定の JSON を取り出す。```json ブロックがあれば最後のもの、なければ最初の { から最後の } まで。
// 設定付きの URL (?s=… や ?text=…&plate=…) でもよい
export function extractJson(text, known = new Set()) {
  const blocks = [...text.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)].map((m) => m[1]).reverse();
  const candidates = blocks.length ? blocks : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (isPlainObject(v)) return v;
    } catch { /* 次の候補へ */ }
  }
  for (const [, query] of text.matchAll(/\?([^\s<>"'`)]+)/g)) {
    try {
      const patch = parseQuery(new URLSearchParams(query), known);
      if (Object.keys(patch).length) return patch;
    } catch { /* 次の候補へ */ }
  }
  throw new Error('返答の中に設定 (JSON) が見つかりませんでした');
}
