#!/usr/bin/env node
// 環境変数から site/config.js を生成する（秘密情報は含めない。APIの公開URLのみ）
//   CROWDING_API_BASE=https://fujisawa-lens-crowding.example.workers.dev node scripts/write-config.mjs
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.env.CROWDING_API_BASE ?? '').trim();
if (base && !/^https:\/\/[^\s"'<>]+$/.test(base)) {
  console.error('CROWDING_API_BASE は https:// で始まるURLにしてください');
  process.exit(1);
}
const body = `// 公開時の設定。scripts/write-config.mjs が環境変数 CROWDING_API_BASE から生成する。
// crowdingApiBase が空のとき、混雑共有は「準備中」と表示され、投稿・取得は行わない。
window.FUJISAWA_LENS_CONFIG = {
  crowdingApiBase: ${JSON.stringify(base.replace(/\/+$/, ''))},
  crowdingApiLabel: ""
};
`;
await writeFile(join(ROOT, 'site/config.js'), body);
console.log(`site/config.js: crowdingApiBase=${base || '（未設定）'}`);
