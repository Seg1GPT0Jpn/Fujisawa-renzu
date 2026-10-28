#!/usr/bin/env node
// site/data/status.json（トップページ用の小さな更新状況）を生成する
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (p) => { try { return JSON.parse(await readFile(join(ROOT, p), 'utf8')); } catch { return null; } };

const shelters = await read('site/data/shelters.json');
const datasets = [{
  id: 'shelters', name: '避難先（指定緊急避難場所・指定避難所）',
  status: shelters ? 'ok' : 'unavailable', lastCheckedAt: shelters?.lastCheckedAt ?? null,
}];
for (const [id, name, file] of [
  ['landcover', '土地利用・土地被覆', 'site/data/environment/landcover.json'],
  ['water-quality', '海水浴場の水質', 'site/data/environment/water-quality.json'],
  ['air-quality', '大気環境', 'site/data/environment/air-quality.json'],
]) {
  const d = await read(file);
  datasets.push({ id, name, status: d?.status ?? 'unavailable', lastCheckedAt: d?.retrievedAt ?? d?.generatedAt?.slice(0, 10) ?? null });
}
await writeFile(join(ROOT, 'site/data/status.json'), JSON.stringify({ generatedAt: new Date().toISOString(), datasets }));
console.log(datasets);
