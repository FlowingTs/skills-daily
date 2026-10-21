import { addDays, diffDays } from './util.mjs';

const DAY = 86400000;

function createdWithin(repo, targetDate, days) {
  const cutoff = Date.parse(`${addDays(targetDate, -(days - 1))}T00:00:00+08:00`);
  return Date.parse(repo.created_at) >= cutoff;
}

function pushedWithin(repo, targetDate, days) {
  const cutoff = Date.parse(`${addDays(targetDate, -(days - 1))}T00:00:00+08:00`);
  return Date.parse(repo.pushed_at) >= cutoff;
}

/**
 * 计算某一列的增量榜
 * @returns {{status:string, items:Array, have:number, need:number}}
 */
export function computeDeltaColumn(pool, snapshots, targetDate, windowDays, minStars, perColumn) {
  const nowKey = targetDate;
  const baseKey = addDays(targetDate, -windowDays);
  const nowSnap = snapshots[nowKey];
  const baseSnap = snapshots[baseKey];
  const have = Object.keys(snapshots).filter((d) => d <= targetDate).length;
  const need = windowDays + 1;

  if (nowSnap && baseSnap) {
    const items = [];
    for (const repo of pool) {
      const a = nowSnap[repo.full_name];
      const b = baseSnap[repo.full_name];
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      const delta = a - b;
      if (delta <= 0) continue;
      items.push({ repo, delta, kind: 'delta' });
    }
    items.sort((x, y) => y.delta - x.delta || y.repo.stargazers_count - x.repo.stargazers_count);
    return { status: 'live', items: items.slice(0, perColumn), have, need };
  }

  return { status: 'collecting', items: [], have, need };
}

/** 冷启动降级口径：窗口内新建的仓库，按 star 排 */
export function computeColdStart(pool, targetDate, windowDays, minStars, perColumn) {
  const items = pool
    .filter((r) => r.stargazers_count >= minStars)
    .filter((r) => createdWithin(r, targetDate, Math.max(windowDays, 1)))
    .map((repo) => ({ repo, delta: null, kind: 'stars' }))
    .sort((x, y) => y.repo.stargazers_count - x.repo.stargazers_count);
  return items.slice(0, perColumn);
}

/** 总热门：近 12 个月新建 + star 总量 */
export function computeAllTime(pool, minStars, perColumn) {
  const now = Date.now();
  const cutoff = now - 365 * DAY;
  const items = pool
    .filter((r) => r.stargazers_count >= minStars)
    .filter((r) => Date.parse(r.created_at) >= cutoff)
    .map((repo) => ({ repo, delta: null, kind: 'stars' }))
    .sort((x, y) => y.repo.stargazers_count - x.repo.stargazers_count);
  return items.slice(0, perColumn);
}

export function buildColumns({ pool, snapshots, targetDate, config }) {
  const { perColumn, minStars } = config;
  const out = [];

  for (const col of config.columns) {
    if (col.metric === 'stars') {
      const items = computeAllTime(pool, minStars, perColumn);
      out.push({
        ...col,
        status: items.length ? 'live' : 'empty',
        items,
        have: 0,
        need: 0,
        badge: 'STAR TOTAL',
      });
      continue;
    }

    const live = computeDeltaColumn(pool, snapshots, targetDate, col.window, minStars, perColumn);
    if (live.status === 'live') {
      out.push({ ...col, ...live, badge: `+${col.window}D NET` });
      continue;
    }

    const cold = computeColdStart(pool, targetDate, col.window, minStars, perColumn);
    out.push({
      ...col,
      status: cold.length ? 'coldstart' : 'collecting',
      items: cold.map((x) => ({ ...x, approx: true })),
      have: live.have,
      need: live.need,
      badge: 'COLD START',
    });
  }

  return out;
}

/** 热度原始值（对数压缩），列内再做归一化才有区分度 */
export function heatRaw(item) {
  const v = item.kind === 'delta' ? item.delta : item.repo.stargazers_count;
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
