#!/usr/bin/env node
// site/data/shelters.json の施設IDを Worker 側の許可リストとして書き出す
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(await readFile(join(ROOT, 'site/data/shelters.json'), 'utf8'));
const ids = data.facilities.filter((f) => !(f.notice && f.notice.type === 'suspended')).map((f) => f.id).sort();
await writeFile(join(ROOT, 'worker/src/facility-ids.json'), JSON.stringify({ generatedFrom: 'site/data/shelters.json', lastCheckedAt: data.lastCheckedAt, ids }, null, 1) + '\n');
console.log(`worker/src/facility-ids.json: ${ids.length} 件`);
