// 開発用サーバー: pnpm dev → http://127.0.0.1:5173/
//   web/ を書き換えると自動で作り直す (ブラウザは手動で再読み込み)

import { buildWeb, DIST } from './build-web.mjs';

const ctx = await buildWeb({ watch: true });
const { port } = await ctx.serve({ servedir: DIST, host: '127.0.0.1', port: 5173 });
console.log(`開発サーバー: http://127.0.0.1:${port}/   (終了は Ctrl+C)`);
