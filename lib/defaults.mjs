// 設定の既定値 (画面・生成処理・コマンドライン版で共通)

export const DEFAULTS = {
  size: 15,         // 文字サイズ (1em, mm)
  bold: 0,          // 文字の線を太らせる量 (mm, 負で細く)
  spacing: 0,       // 文字間隔の追加量 (mm)
  lineHeight: 1.2,  // 行送り (em 比)
  textHeight: 1.5,  // 文字の浮き出し高さ (mm)
  baseHeight: 2.5,  // 土台の厚さ (mm)
  border: 2.5,      // 文字の周りのフチ幅 (mm)
  plate: 'outline', // outline (文字の周り) / rect (四角) / circle (正円) / ellipse (楕円) / capsule (カプセル)
  corner: 3,        // 四角の角の丸み (mm, 0 で角ばった四角)
  smooth: 0.3,      // 外周のなめらかさ (outline のみ。文字サイズに対する割合、0 で文字の形に近く)
  ringHole: 4,      // リング穴の直径 (mm)。リングは 1 行目の中心線上の左端に付く
  ringWall: 2.5,    // リングの肉厚 (mm)
  ringFillet: 2.5,  // リングの付け根の丸み (mm)
  tolerance: 0.03,  // 曲線の分割精度 (mm)
  baseColor: '#f2f2f2', // 土台の色
  textColor: '#e0464d', // 文字の色 (charColors で指定のない文字)
  charColors: [],   // 文字ごとの色。文字列の i 番目 (コードポイント単位、改行も 1 文字) の色、null は textColor
};
