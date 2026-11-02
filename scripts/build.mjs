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
  groupPoolFile,
  groupSnapshotDir,
} from './lib/store.mjs';
import { buildPeriodColumn, computePotential, scoreItem, heatRange } from './lib/rank.mjs';
import { enrichRepos } from './lib/enrich.mjs';
import { fetchImages } from './lib/faces.mjs';
import { renderPage } from './lib/render.mjs';
import { addDays, bjNowISO, bjToday, log } from './lib/util.mjs';

const TARGET = process.env.REPORT_DATE || addDays(bjToday(), -1);

function serializeItem(it) {
  return {
    full_name: it.repo.full_name,
    url: it.repo.html_url,
    stars: it.repo.stargazers_count,
    forks: it.repo.forks_count,
    delta: it.delta,
    velocity: it.velocity ?? null,
    age_days: it.ageDays ?? null,
    created_at: it.repo.created_at,
    pushed_at: it.repo.pushed_at,
    language: it.repo.language,
    topics: it.repo.topics,
    summary: it.summary,
    score: it.score,
  };
}

async function main() {
  await ensureDirs();
  const config = await loadConfig();
  const primary = config.groups[0];

  const built = [];
  const periodNamesByGroup = {};
  const potentialNamesByGroup = {};
  let snapshotDays = 0;

  for (const g of config.groups) {
    const pool = (await readJSON(groupPoolFile(g.pool), { repos: [] })).repos ?? [];
    if (!pool.length) throw new Error(`${g.label} 仓库池为空，请先执行 collect`);

    const snapshots = await loadRecentSnapshots(groupSnapshotDir(g.snapshots), TARGET, 40);
    const days = Object.keys(snapshots).length;
    snapshotDays = Math.max(snapshotDays, days);
    log(`[${g.id}] 池 ${pool.length} · 可用快照 ${days} 天`);

    // AIGC 单向让路：同周期里已在主榜出现的仓库，不再进 AIGC 榜
    const excludeByPeriod = {};
    let excludePotential = null;
    if (g.id !== primary.id) {
      Object.assign(excludeByPeriod, periodNamesByGroup[primary.id] ?? {});
      excludePotential = potentialNamesByGroup[primary.id] ?? null;
    }

    const columns = [];
    for (const period of config.periods) {
      const minStars = g.minStarsByPeriod?.[period.id] ?? g.minStars ?? config.minStars;
      const res = buildPeriodColumn({
        pool,
        snapshots,
        targetDate: TARGET,
        period,
        minStars,
        perColumn: config.perColumn,
        allSinceDays: g.allSinceDays ?? null,
        exclude: excludeByPeriod[period.id] ?? null,
      });
      columns.push({
        ...period,
        ...res,
        minStars,
        note: period.id === 'all' ? g.allNote || period.note : period.note,
        excluded: Boolean(excludeByPeriod[period.id]?.size),
      });
      log(`[${g.id}] ${period.label}: ${res.items.length} 条 · ${res.status} · 门槛 ${minStars} · 快照 ${res.have || 0}/${res.need || 0}`);
    }

    const potCfg = config.potential[g.id];
    const pot = computePotential(pool, TARGET, potCfg, excludePotential);
    const potential = {
      ...potCfg,
      status: pot.items.length ? 'live' : 'empty',
      usedWindow: pot.window,
      items: pot.items,
      badge: `${pot.window} 天新苗`,
      excluded: Boolean(excludePotential?.size),
    };
    log(`[${g.id}] ${potCfg.label}: ${pot.items.length} 条 · 窗口 ${pot.window} 天`);

    periodNamesByGroup[g.id] = Object.fromEntries(
      columns.map((c) => [c.id, new Set(c.items.map((it) => it.repo.full_name))]),
    );
    potentialNamesByGroup[g.id] = new Set(pot.items.map((it) => it.repo.full_name));

    built.push({ group: g, pool, columns, potential, snapshotDays: days });
  }

  // 去重后统一做模型点评
  const uniq = new Map();
  for (const b of built) {
    for (const c of [...b.columns, b.potential]) {
      for (const it of c.items) {
        const prev = uniq.get(it.repo.full_name);
        if (!prev) uniq.set(it.repo.full_name, { ...it.repo });
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
  for (const b of built) {
    for (const c of [...b.columns, b.potential]) {
      const range = heatRange(c.items);
      for (const it of c.items) {
        const e = enrichMap[it.repo.full_name];
        it.summary = e?.summary || '';
        it.verdict = e?.verdict;
        it.score = scoreItem(it, range, weights, e?.verdict);
      }
    }
  }

  const generatedAt = bjNowISO();

  const allItems = built.flatMap((b) => [
    ...b.columns.flatMap((c) => c.items),
    ...b.potential.items,
  ]);
  const primaryDay = built[0].columns.find((c) => c.id === 'day')?.items ?? [];
  const heroRepo = (primaryDay[0] ?? allItems[0])?.repo ?? null;
  const { cardPath, faces } = await fetchImages(allItems, TARGET, { onCard: heroRepo });

  const archiveNames = (await listJSONNames(P.daily)).concat(TARGET).sort().reverse();
  const archive = [...new Set(archiveNames)];

  const groups = built.map((b) => ({
    id: b.group.id,
    label: b.group.label,
    en: b.group.en,
    desc: b.group.desc,
    pool_size: b.pool.length,
    snapshot_days: b.snapshotDays,
    columns: b.columns.map((c) => ({
      id: c.id,
      label: c.label,
      nav_label: c.navLabel,
      en: c.en,
      status: c.status,
      badge: c.badge,
      metric: c.metric,
      note: c.note,
      min_stars: c.minStars,
      excluded: c.excluded,
      have: c.have,
      need: c.need,
      items: c.items.map(serializeItem),
    })),
    potential: {
      id: b.potential.id,
      label: b.potential.label,
      en: b.potential.en,
      status: b.potential.status,
      badge: b.potential.badge,
      note: b.potential.note,
      used_window: b.potential.usedWindow,
      min_stars: b.potential.minStars,
      window_steps: b.potential.windowSteps,
      min_count: b.potential.minCount,
      excluded: b.potential.excluded,
      items: b.potential.items.map(serializeItem),
    },
  }));

  const report = {
    date: TARGET,
    generated_at: generatedAt,
    snapshot_days: snapshotDays,
    pool_size: groups.reduce((s, g) => s + g.pool_size, 0),
    groups,
  };
  await writeJSON(path.join(P.daily, `${TARGET}.json`), report, true);

  const shared = {
    date: TARGET,
    groups: built.map((b) => ({
      id: b.group.id,
      label: b.group.label,
      en: b.group.en,
      desc: b.group.desc,
      poolSize: b.pool.length,
      snapshotDays: b.snapshotDays,
      columns: b.columns,
      potential: b.potential,
    })),
    periods: config.periods,
    archive,
    config,
    poolSize: groups.reduce((s, g) => s + g.pool_size, 0),
    snapshotDays,
    cardPath,
    faces,
    generatedAt,
  };

  await writeText(path.join(P.site, 'index.html'), renderPage({ ...shared, root: '' }));
  await writeText(path.join(P.site, 'archive', `${TARGET}.html`), renderPage({ ...shared, root: '../' }));

  const totalItems = allItems.length;
  log(`页面已生成：site/index.html（${totalItems} 条）· 归档 ${TARGET}.html`);
}

main().catch((err) => {
  console.error('构建失败:', err);
  process.exit(1);
});
