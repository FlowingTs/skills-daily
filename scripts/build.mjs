import path from 'node:path';
import {
  P,
  ensureDirs,
  loadConfig,
  loadRecentSnapshots,
  readJSON,
  writeJSON,
  writeText,
  listJSONNames,
} from './lib/store.mjs';
import { buildColumns, scoreItem, heatRange } from './lib/rank.mjs';
import { enrichRepos, fallbackSummary } from './lib/enrich.mjs';
import { fetchImages } from './lib/faces.mjs';
import { renderPage } from './lib/render.mjs';
import { addDays, bjNowISO, bjToday, log } from './lib/util.mjs';

const TARGET = process.env.REPORT_DATE || addDays(bjToday(), -1);

async function main() {
  await ensureDirs();
  const config = await loadConfig();

  const poolData = await readJSON(P.pool, { repos: [] });
  const pool = poolData.repos ?? [];
  if (!pool.length) throw new Error('仓库池为空，请先执行 collect');

  const snapshots = await loadRecentSnapshots(TARGET, 40);
  const snapDays = Object.keys(snapshots).length;
  log(`报告日期 ${TARGET} · 池 ${pool.length} · 可用快照 ${snapDays} 天`);

  const columns = buildColumns({ pool, snapshots, targetDate: TARGET, config });

  for (const c of columns) {
    log(`  ${c.label}: ${c.items.length} 条 · ${c.status} · 快照 ${c.have || 0}/${c.need || 0}`);
  }

  // 去重后统一做模型点评
  const uniq = new Map();
  for (const c of columns) {
    for (const it of c.items) {
      const prev = uniq.get(it.repo.full_name);
      if (!prev || (typeof it.delta === 'number' && (prev.__delta ?? -1) < it.delta)) {
        uniq.set(it.repo.full_name, { ...it.repo, __delta: it.delta ?? undefined });
      }
    }
  }

  let enrichMap = {};
  try {
    enrichMap = await enrichRepos([...uniq.values()], config);
  } catch (err) {
    log(`点评环节失败，降级为原文描述: ${err.message}`);
  }

  const weights = config.scoreWeights;
  for (const c of columns) {
    const range = heatRange(c.items);
    for (const it of c.items) {
      const e = enrichMap[it.repo.full_name];
      it.summary = e?.summary || '';
      it.verdict = e?.verdict;
      it.score = scoreItem(it, range, weights, e?.verdict);
    }
  }

  const generatedAt = bjNowISO();

  // 头像与首屏卡片落到本地，页面不依赖外网图片
  const allItems = columns.flatMap((c) => c.items);
  const dayItems = columns.find((c) => c.id === 'day')?.items ?? [];
  const heroRepo = (dayItems[0] ?? allItems[0])?.repo ?? null;
  const { cardPath, faces } = await fetchImages(allItems, TARGET, { onCard: heroRepo });

  const archiveNames = (await listJSONNames(P.daily)).concat(TARGET).sort().reverse();
  const archive = [...new Set(archiveNames)];

  const report = {
    date: TARGET,
    generated_at: generatedAt,
    pool_size: pool.length,
    snapshot_days: snapDays,
    columns: columns.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status,
      badge: c.badge,
      metric: c.metric,
      note: c.note,
      have: c.have,
      need: c.need,
      items: c.items.map((it) => ({
        full_name: it.repo.full_name,
        url: it.repo.html_url,
        stars: it.repo.stargazers_count,
        forks: it.repo.forks_count,
        delta: it.delta,
        created_at: it.repo.created_at,
        pushed_at: it.repo.pushed_at,
        language: it.repo.language,
        topics: it.repo.topics,
        summary: it.summary,
        score: it.score,
      })),
    })),
  };
  await writeJSON(path.join(P.daily, `${TARGET}.json`), report, true);

  const shared = {
    date: TARGET,
    columns,
    archive,
    config,
    poolSize: pool.length,
    snapshotDays: snapDays,
    cardPath,
    faces,
    generatedAt,
  };

  await writeText(path.join(P.site, 'index.html'), renderPage({ ...shared, root: '' }));
  await writeText(path.join(P.site, 'archive', `${TARGET}.html`), renderPage({ ...shared, root: '../' }));

  const totalItems = columns.reduce((s, c) => s + c.items.length, 0);
  log(`页面已生成：site/index.html（${totalItems} 条）· 归档 ${TARGET}.html`);
}

main().catch((err) => {
  console.error('构建失败:', err);
  process.exit(1);
});
