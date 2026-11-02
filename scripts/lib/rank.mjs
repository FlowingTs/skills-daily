import { addDays, diffDays } from './util.mjs';

const DAY = 86400000;

function createdWithin(repo, targetDate, days) {
  const cutoff = Date.parse(`${addDays(targetDate, -(days - 1))}T00:00:00+08:00`);
  return Date.parse(repo.created_at) >= cutoff;
}

function keep(repo, exclude) {
  return !exclude || !exclude.has(repo.full_name);
}

/**
 * 计算某个领域在某个周期下的榜单
 * @param {'delta'|'stars'} period.metric
 * @returns {{status:string, items:Array, have:number, need:number, badge:string}}
 */
export function buildPeriodColumn({
  pool,
  snapshots,
  targetDate,
  period,
  minStars,
  perColumn,
  allSinceDays = null,
  exclude = null,
}) {
  if (period.metric === 'stars') {
    const cutoff = allSinceDays ? Date.parse(`${addDays(targetDate, -allSinceDays)}T00:00:00+08:00`) : null;
    const items = pool
      .filter((r) => r.stargazers_count >= minStars)
      .filter((r) => keep(r, exclude))
      .filter((r) => !cutoff || Date.parse(r.created_at) >= cutoff)
      .map((repo) => ({ repo, delta: null, kind: 'stars' }))
      .sort((x, y) => y.repo.stargazers_count - x.repo.stargazers_count);
    const top = items.slice(0, perColumn);
    return {
      status: top.length ? 'live' : 'empty',
      items: top,
      have: 0,
      need: 0,
      badge: '热度总量',
    };
  }

  const nowSnap = snapshots[targetDate];
  const baseSnap = snapshots[addDays(targetDate, -period.window)];
  const have = Object.keys(snapshots).filter((d) => d <= targetDate).length;
  const need = period.window + 1;

  if (nowSnap && baseSnap) {
    const items = [];
    for (const repo of pool) {
      if (repo.stargazers_count < minStars) continue;
      if (!keep(repo, exclude)) continue;
      const a = nowSnap[repo.full_name];
      const b = baseSnap[repo.full_name];
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      const delta = a - b;
      if (delta <= 0) continue;
      items.push({ repo, delta, kind: 'delta' });
    }
    items.sort((x, y) => y.delta - x.delta || y.repo.stargazers_count - x.repo.stargazers_count);
    return { status: 'live', items: items.slice(0, perColumn), have, need, badge: `近 ${period.window} 天净增` };
  }

  // 冷启动降级：窗口内新建的仓库按 star 排。角标与说明必须写明这不是净增。
  // 单日档在冷启动时用 7 天窗（period.coldWindow）：「一天内新建且够门槛」的仓库太少，
  // 硬按 1 天算会得到一张空榜，反而没法判断这一档有没有东西。
  const coldWindow = period.coldWindow ?? Math.max(period.window, 1);
  const cold = pool
    .filter((r) => r.stargazers_count >= minStars)
    .filter((r) => keep(r, exclude))
    .filter((r) => createdWithin(r, targetDate, coldWindow))
    .map((repo) => ({ repo, delta: null, kind: 'stars' }))
    .sort((x, y) => y.repo.stargazers_count - x.repo.stargazers_count)
    .slice(0, perColumn);

  return {
    status: cold.length ? 'coldstart' : 'collecting',
    items: cold.map((x) => ({ ...x, approx: true })),
    have,
    need,
    coldWindow,
    badge: '冷启动',
  };
}

/**
 * 潜力榜：窗口从近 7 天开始，凑不够 minCount 条就往外扩（7 → 14 → 21 → 28）。
 * 排序用「每天拿到的 star」而不是总量：一个 3 天涨 300 的仓库，比 20 天涨 900 的更值得看。
 * 窗口被撑到哪一步，要在页面上写明，不能让人以为是固定 7 天。
 */
export function computePotential(pool, targetDate, cfg, exclude = null) {
  const steps = cfg.windowSteps ?? [cfg.window ?? 7];
  const limit = cfg.limit ?? 5;
  const minCount = cfg.minCount ?? 3;
  const minStars = cfg.minStars ?? 10;
  const refEnd = Date.parse(`${targetDate}T23:59:59+08:00`);

  let last = { window: steps[0], items: [] };

  for (const windowDays of steps) {
    const items = pool
      .filter((r) => r.stargazers_count >= minStars)
      .filter((r) => keep(r, exclude))
      .filter((r) => createdWithin(r, targetDate, windowDays))
      .map((repo) => {
        const ageDays = Math.max(1, Math.ceil((refEnd - Date.parse(repo.created_at)) / DAY));
        return { repo, delta: null, kind: 'velocity', ageDays, velocity: repo.stargazers_count / ageDays };
      })
      .sort((x, y) => y.velocity - x.velocity || y.repo.stargazers_count - x.repo.stargazers_count);

    last = { window: windowDays, items };
    if (items.length >= minCount) break;
  }

  return { window: last.window, items: last.items.slice(0, limit) };
}

/** 热度原始值（对数压缩），列内再做归一化才有区分度 */
export function heatRaw(item) {
  const v =
    item.kind === 'delta' ? item.delta
    : item.kind === 'velocity' ? item.velocity
    : item.repo.stargazers_count;
  return Math.log10(Math.max(1, v ?? 1) + 1);
}

/** 计算一列的热度区间，用于列内归一化 */
export function heatRange(items) {
  const vals = items.map(heatRaw);
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

/** 推荐分：热度 + 模型判断 + 活跃度 + 信息完整度 */
export function scoreItem(item, range, weights, modelScore) {
  const raw = heatRaw(item);
  const heat =
    range && range.max > range.min
      ? Math.max(0, Math.min(1, (raw - range.min) / (range.max - range.min)))
      : 0.6;

  const pushAge = (Date.now() - Date.parse(item.repo.pushed_at)) / DAY;
  const activity = Math.max(0, 1 - Math.min(pushAge, 30) / 30);
  const model = typeof modelScore === 'number' ? Math.max(0, Math.min(1, modelScore / 100)) : 0.5;

  const r = item.repo;
  const completeness =
    (r.description ? 0.4 : 0) +
    ((r.topics?.length ?? 0) >= 3 ? 0.2 : 0.1) +
    (r.license ? 0.2 : 0) +
    (r.homepage ? 0.2 : 0);

  const s =
    weights.heat * heat +
    weights.model * model +
    weights.activity * activity +
    weights.completeness * completeness;

  return Math.round(Math.max(5, Math.min(99, s * 100)));
}

export function daysSince(dateStr) {
  return diffDays(dateStr.slice(0, 10), new Date().toISOString().slice(0, 10));
}
