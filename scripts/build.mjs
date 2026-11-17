import path from 'node:path';
import {
  P,
  ROOT,
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
import { findJunkRepos } from './lib/quality.mjs';
import { writeShareCard } from './lib/share-card.mjs';
import { writeShareCard as writeShareCardBitmap } from './lib/share-card-bitmap.mjs';
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

  // 刷量仓库要先摘出去再看榜。三个池子合起来判，跨池的同批垃圾才抓得住
  // （同一个克隆批次有时一半落在 MCP 池、一半落在 AIGC 池）。
  const poolCache = new Map();
  for (const g of config.groups) {
    poolCache.set(g.id, (await readJSON(groupPoolFile(g.pool), { repos: [] })).repos ?? []);
  }
  const junkMap = findJunkRepos([...poolCache.values()].flat());
  if (junkMap.size) {
    const byReason = new Map();
    for (const r of junkMap.values()) {
      const k = r.split(' · ')[0];
      byReason.set(k, (byReason.get(k) ?? 0) + 1);
    }
    const detail = [...byReason.entries()].map(([k, n]) => `${k} ${n}`).join('，');
    log(`剔重：${junkMap.size} 个刷量/克隆仓库不参与任何榜单（${detail}）`);
  }

  for (const g of config.groups) {
    const rawPool = poolCache.get(g.id) ?? [];
    if (!rawPool.length) throw new Error(`${g.label} 仓库池为空，请先执行 collect`);
    const pool = rawPool.filter((e) => !junkMap.has(e.full_name));
    if (pool.length < rawPool.length) {
      log(`[${g.id}] 池 ${rawPool.length} → 剔除 ${rawPool.length - pool.length} 个刷量仓库`);
    }

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

  // 结构规则抓不到零星的营销号（比如打着 MCP 旗号卖虚拟卡的软文，
  // 它没有同类克隆、星数也不高），但模型点评看得出来：这类条目 verdict 通常个位数。
  // 全库 verdict 中位数 68，低于 25 的基本都是「装不了、用不上、别碰」。
  // 没有点评的（undefined）一律放行，不拿缺失当垃圾。
  const JUNK_VERDICT = 25;
  let verdictDropped = 0;
  for (const b of built) {
    for (const c of [...b.columns, b.potential]) {
      const kept = c.items.filter((it) => it.verdict == null || it.verdict >= JUNK_VERDICT);
      if (kept.length !== c.items.length) {
        const dropped = c.items.filter((it) => !kept.includes(it));
        for (const it of dropped) {
          log(`[${b.group.id}] ${c.label} 剔除低质：${it.repo.full_name}（verdict ${it.verdict}）`);
        }
        verdictDropped += c.items.length - kept.length;
        c.items = kept;
      }
    }
  }
  if (verdictDropped) log(`共剔除 ${verdictDropped} 条点评判定为无实用价值的条目`);

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

  // 生成每日分享图（竖版 PNG）：三个领域潜力榜各取前三（带一句介绍）+ 二维码。
  // 主路径用 HTML/CSS 排版后截图（真字体、真层级）；没有浏览器时退回点阵版。
  try {
    // 每个领域把整份潜力榜都传过去：分享图会先折叠同类镜像仓库再取前三，
    // 折叠掉几条就要能往后补位，这里不能提前切。
    const perGroup = (b) =>
      (b.potential?.items ?? []).map((it) => ({
        full_name: it.repo.full_name,
        velocity: it.velocity,
        summary: it.summary,
      }));
    const shareGroups = built.map((b) => ({
      id: b.group.id,
      label: b.group.label,
      window: b.potential?.usedWindow,
      items: perGroup(b),
    }));
    // 点阵兜底版只认单列 items，把它拍平成一份
    const shareItems = built.flatMap(perGroup).slice(0, 5);
    const shareUrl = (config.siteUrl || '').replace(/\/$/, '') + '/';
    let shareRes;
    try {
      shareRes = await writeShareCard({ date: TARGET, groups: shareGroups, url: shareUrl });
    } catch (err) {
      log(`HTML 分享图失败（${err.message}），退回点阵版`);
      shareRes = await writeShareCardBitmap({ date: TARGET, items: shareItems, url: shareUrl });
    }
    log(`分享图已生成：${path.relative(ROOT, shareRes.path)}（${(shareRes.bytes / 1024).toFixed(1)} KB）`);
  } catch (err) {
    log(`分享图生成失败，跳过（不影响日报）: ${err.message}`);
  }

  const totalItems = allItems.length;
  log(`页面已生成：site/index.html（${totalItems} 条）· 归档 ${TARGET}.html`);
}

main().catch((err) => {
  console.error('构建失败:', err);
  process.exit(1);
});
