import fs from 'node:fs/promises';
import path from 'node:path';

export const ROOT = path.resolve(process.cwd());

export const P = {
  snapshots: path.join(ROOT, 'data', 'snapshots'),
  daily: path.join(ROOT, 'data', 'daily'),
  pool: path.join(ROOT, 'data', 'pool.json'),
  enrich: path.join(ROOT, 'data', 'enrich-cache.json'),
  site: path.join(ROOT, 'site'),
  config: path.join(ROOT, 'config', 'config.json'),
};

export async function ensureDirs() {
  for (const d of [P.snapshots, P.daily, path.join(P.site, 'assets'), path.join(P.site, 'archive')]) {
    await fs.mkdir(d, { recursive: true });
  }
}

export async function readJSON(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJSON(file, data, pretty = false) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, pretty ? 2 : 0), 'utf8');
}

export async function writeText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

export async function listJSONNames(dir) {
  try {
    const files = await fs.readdir(dir);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

export async function loadConfig() {
  return JSON.parse(await fs.readFile(P.config, 'utf8'));
}

/** 读取最近 n 天的快照，返回 { 'YYYY-MM-DD': { fullName: stars } } */
export async function loadRecentSnapshots(latestDate, maxDays) {
  const out = {};
  const names = await listJSONNames(P.snapshots);
  const cutoff = Date.parse(`${latestDate}T12:00:00Z`) - maxDays * 86400000;
  for (const name of names) {
    if (Date.parse(`${name}T12:00:00Z`) < cutoff) continue;
    const s = await readJSON(path.join(P.snapshots, `${name}.json`));
    if (s?.repos) out[name] = s.repos;
  }
  return out;
}
