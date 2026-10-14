// 利用者の AI (チャット型・エージェント型) で設定を調整するための部品
//   - normalizePatch: AI から来た設定 (変更する項目だけの JSON) を検証して、state に入れられる形にする
//   - buildPrompt:    チャット型 AI に貼る依頼文を作る
//   - extractJson:    AI の返答から設定の JSON を取り出す

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

const HEX = /^#[0-9a-f]{6}$/i;
const MAX_TEXT = 100;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lineCountOf = (text) => text.split('\n').length;

// patch: AI から来た設定。numbers: スライダーの項目 ({ key, label, unit, min, max })
// resolveFont(名前 or id) → id | null、fontName(id) → 名前、current: いまの state
// 戻り値 changes: state に上書きする値、applied: 変わった項目の説明、warnings: 丸めた・無視した項目の説明
export function normalizePatch(patch, { numbers, resolveFont, fontName, current }) {
  if (typeof patch === 'string') patch = JSON.parse(patch);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('設定は {"項目": 値} の形の JSON にしてください');
  const changes = {}, applied = [], warnings = [];
  const numberField = new Map(numbers.map((f) => [f.key, f]));
  const put = (key, value, label, from, to) => {
    if (same(current[key], value)) return;
    changes[key] = value;
    applied.push(`${label}: ${from} → ${to}`);
  };

  for (const [key, raw] of Object.entries(patch)) {
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
      if (typeof raw !== 'string' || !HEX.test(raw)) { warnings.push(`${LABELS[key]} (${key}): "${raw}" は #rrggbb の形ではないので無視しました`); continue; }
      put(key, raw.toLowerCase(), LABELS[key], current[key], raw.toLowerCase());
    } else if (key === 'charColors' || key === 'charFonts' || key === 'lineAligns') {
      if (!Array.isArray(raw)) { warnings.push(`${LABELS[key]} (${key}): 配列ではないので無視しました`); continue; }
      changes[key] = raw; // 文字数・行数が決まってから下で整える
    } else {
      warnings.push(`"${key}" は設定できる項目ではないので無視しました`);
    }
  }

  // 文字ごと・行ごとの指定を、最終的な文字列の長さ・行数に合わせる
  const text = changes.text ?? current.text;
  const length = [...text].length;
  const lines = lineCountOf(text);
  const perItem = {
    charColors: { size: length, fix: (v) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null), show: (a) => a.filter(Boolean).join(', ') },
    charFonts: { size: length, fix: (v) => (v ? resolveFont(v) : null), show: (a) => a.filter(Boolean).map(fontName).join(', ') },
    lineAligns: { size: lines, fix: (v) => (v in CHOICES.align.values ? v : null), show: (a) => a.map((v) => (v ? CHOICES.align.values[v] : '既定')).join(', ') },
  };
  for (const [key, { size, fix, show }] of Object.entries(perItem)) {
    if (key in changes) {
      const raw = changes[key];
      delete changes[key];
      const value = Array.from({ length: size }, (_, i) => (raw[i] == null || raw[i] === '' ? null : fix(raw[i])));
      if (raw.some((v, i) => i < size && v != null && v !== '' && value[i] === null)) warnings.push(`${LABELS[key]} (${key}): 使えない値を既定に戻しました`);
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

// AI に見せる「設定できる項目」の説明 (keychain.spec() でも返す)
export function describeParams(numbers) {
  return [
    { key: 'text', type: 'string', label: '文字 (改行は \\n)' },
    { key: 'font', type: 'string', label: 'フォント名 (フォント一覧から)' },
    ...numbers.map(({ key, label, unit, min, max, hint, when }) =>
      ({ key, type: 'number', label: [label, hint, when].filter(Boolean).join('。'), unit, min, max })),
    ...Object.entries(CHOICES).map(([key, { label, values }]) => ({ key, type: 'choice', label, values })),
    { key: 'textColor', type: 'color', label: '文字の色 (#rrggbb)' },
    { key: 'baseColor', type: 'color', label: '土台の色 (#rrggbb)' },
    { key: 'charColors', type: 'array', label: '文字ごとの色。文字列の i 番目 (改行も 1 文字と数える) の色、null は textColor' },
    { key: 'charFonts', type: 'array', label: '文字ごとのフォント名。null は font' },
    { key: 'lineAligns', type: 'array', label: 'i 行目の揃え ("left" / "center" / "right")、null は align' },
  ];
}

function describeLine(p) {
  if (p.type === 'number') return `- ${p.key}: ${p.label} (${p.min}〜${p.max}${p.unit ? ` ${p.unit}` : ''})`;
  if (p.type === 'choice') return `- ${p.key}: ${p.label}。${Object.entries(p.values).map(([v, l]) => `"${v}" (${l})`).join(' / ')}`;
  return `- ${p.key}: ${p.label}`;
}

// チャット型 AI に貼る依頼文
export function buildPrompt({ settings, params, fontNames, moreFonts }) {
  return `あなたは 3D プリンター用の「文字キーホルダー」を作るアプリの設定を調整するアシスタントです。
文字の形をした土台に文字が浮き出し、端に吊り下げ用のリングが付いたキーホルダーです。長さの単位はすべて mm です。
下の「いまの設定」を、私の希望に合わせて変更してください。画像が添付されていれば、それがいまの見た目です。

## 返答のしかた
- 変更する項目だけを、\`\`\`json のコードブロック 1 つで返してください (例: {"border": 4, "ringPos": "top"})
- 値は「設定できる項目」の範囲・選択肢から選んでください
- コードブロックのあとに、何をなぜ変えたかを短く説明してください
- 私の希望があいまいなときは、案を 1 つに決めて返してください

## 設定できる項目
${params.map(describeLine).join('\n')}

## 使えるフォント
${fontNames.map((n) => `- ${n}`).join('\n')}${moreFonts ? '\n(ほかに、この PC にインストールされているフォントも使えます)' : ''}

## いまの設定
\`\`\`json
${JSON.stringify(settings, null, 2)}
\`\`\`

## 私の希望
`;
}

// AI の返答から設定の JSON を取り出す。```json ブロックがあれば最後のもの、なければ最初の { から最後の } まで。
// 「?s=…」付きの URL でもよい
export function extractJson(text) {
  const blocks = [...text.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)].map((m) => m[1]).reverse();
  const candidates = blocks.length ? blocks : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* 次の候補へ */ }
  }
  const url = text.match(/[?&]s=([^\s&#]+)/);
  if (url) {
    try { return JSON.parse(decodeURIComponent(url[1])); } catch { /* 下のエラーへ */ }
  }
  throw new Error('返答の中に設定 (JSON) が見つかりませんでした');
}
