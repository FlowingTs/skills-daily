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
  let snapshotDays = 0;

  // 去重优先级：总 → 月 → 周 → 日 → 潜力榜。
  // 同一个仓库只在最高的那一档出现；被剔掉的位置继续往下取，补满 perColumn 条。
  // 这个顺序和页面展示顺序（日/周/月/总）不同，不能混用。
  const dedupeOrder = config.dedupeOrder ?? ['all', 'month', 'week', 'day'];

  // 前面所有领域去重后的全集（四档 + 潜力榜）。
  // 让路顺序 = config.groups 的顺序：Skills 先挑 → MCP 次 → AIGC 最后，后者剔掉前面全部。
  // 用累积集合而不是「只让主领域」，否则第三个领域会撞上前两个。
  let priorSet = null;
  let heroItem = null;

  for (const g of config.groups) {
    const pool = (await readJSON(groupPoolFile(g.pool), { repos: [] })).repos ?? [];
    if (!pool.length) throw new Error(`${g.label} 仓库池为空，请先执行 collect`);

    const snapshots = await loadRecentSnapshots(groupSnapshotDir(g.snapshots), TARGET, 40);
    const days = Object.keys(snapshots).length;
    snapshotDays = Math.max(snapshotDays, days);
    log(`[${g.id}] 池 ${pool.length} · 可用快照 ${days} 天`);

    const isPrimary = g.id === primary.id;
    // 排在后面的领域要剔掉前面所有领域已经挑走的仓库
    const crossExclude = priorSet;

    // 本领域已经上过榜的仓库，随着优先级推进不断累积
    const taken = new Set();

    const byId = new Map();
    for (const pid of dedupeOrder) {
      const period = config.periods.find((p) => p.id === pid);
      if (!period) continue;

      const minStars = g.minStarsByPeriod?.[period.id] ?? g.minStars ?? config.minStars;
      const exclude = crossExclude?.size ? new Set([...taken, ...crossExclude]) : taken;
      const res = buildPeriodColumn({
        pool,
        snapshots,
        targetDate: TARGET,
        period,
        minStars,
        perColumn: config.perColumn,
        allSinceDays: g.allSinceDays ?? null,
        exclude: exclude.size ? exclude : null,
      });

      byId.set(period.id, {
        ...period,
        ...res,
        minStars,
        note: period.id === 'all' ? g.allNote || period.note : period.note,
        excluded: Boolean(crossExclude?.size),
      });
      for (const it of res.items) taken.add(it.repo.full_name);

      log(`[${g.id}] ${period.label}: ${res.items.length} 条 · ${res.status} · 门槛 ${minStars} · 快照 ${res.have || 0}/${res.need || 0}`);
    }

    // 展示顺序回到日/周/月/总，和顶部导航一致
    const columns = config.periods.map((p) => byId.get(p.id)).filter(Boolean);

    const potCfg = config.potential[g.id];
    // 潜力榜排在日榜之后：四档出现过的都不再进来。
    // 数量不足 5 条时靠 computePotential 的窗口外扩（7→28 天）补，不降门槛。
    const potExclude = crossExclude?.size ? new Set([...taken, ...crossExclude]) : taken;
    const pot = computePotential(pool, TARGET, potCfg, potExclude.size ? potExclude : null);
    const potential = {
      ...potCfg,
      status: pot.items.length ? 'live' : 'empty',
      usedWindow: pot.window,
      items: pot.items,
      badge: `${pot.window} 天新苗`,
      excluded: Boolean(crossExclude?.size),
    };
    for (const it of pot.items) taken.add(it.repo.full_name);
    log(`[${g.id}] ${potCfg.label}: ${pot.items.length} 条 · 窗口 ${pot.window} 天`);

    // 本领域挑完后并入累积集合，供后面的领域排除
    priorSet = priorSet ? new Set([...priorSet, ...taken]) : new Set(taken);

    if (isPrimary) {

      // 首屏单独取一次：全站当日净增第一，不参与去重。
      // 去重后日榜第一会掉到 +415 这种量级，首屏需要的是「今天最值得看的一件事」，
      // 不是「日榜的补充说明」。它必然在总榜里，没有消失。
      const dayPeriod = config.periods.find((p) => p.id === 'day');
      if (dayPeriod) {
        const top = buildPeriodColumn({
          pool,
          snapshots,
          targetDate: TARGET,
          period: dayPeriod,
          minStars: g.minStarsByPeriod?.[dayPeriod.id] ?? g.minStars ?? config.minStars,
          perColumn: 1,
          allSinceDays: g.allSinceDays ?? null,
          exclude: null,
        });
        heroItem = top.items[0] ?? null;
      }
    }

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
  const heroRepo = (heroItem ?? allItems[0])?.repo ?? null;
  // 首屏那个仓库可能因为去重而不在任何一档里，图片要单独带上，否则卡片下载不到
  const imageEntries = heroItem && !allItems.includes(heroItem) ? [...allItems, heroItem] : allItems;
  const { cardPath, faces } = await fetchImages(imageEntries, TARGET, { onCard: heroRepo });

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
    heroItem,
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
