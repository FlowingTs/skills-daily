import {
  P,
  ensureDirs,
  loadConfig,
  readJSON,
  writeJSON,
} from './lib/store.mjs';
import { searchRepos, hasToken, getStats, setSearchInterval, verifySkillFile } from './lib/github.mjs';
import { addDays, bjToday, bjNowISO, log, sleep } from './lib/util.mjs';

const SKILL_TOPICS = new Set([
  'claude-skills', 'agent-skills', 'agent-skill', 'claude-skill', 'skill-md',
  'claude-code-plugin', 'codex-skills', 'opencode-skills', 'gemini-cli-skills',
  'claude-code-skill', 'skills', 'skill', 'agent-skills-cli',
]);

function toEntry(it) {
  return {
    full_name: it.full_name,
    name: it.name,
    owner: it.owner?.login ?? it.full_name.split('/')[0],
    html_url: it.html_url,
    description: it.description ?? '',
    stargazers_count: it.stargazers_count ?? 0,
    forks_count: it.forks_count ?? 0,
    open_issues_count: it.open_issues_count ?? 0,
    created_at: it.created_at,
    pushed_at: it.pushed_at,
    topics: it.topics ?? [],
    language: it.language ?? '',
    homepage: it.homepage ?? '',
    license: it.license?.spdx_id ?? '',
    archived: Boolean(it.archived),
    fork: Boolean(it.fork),
    disabled: Boolean(it.disabled),
  };
}

function hasSkillSignal(e) {
  const topics = (e.topics || []).map((t) => t.toLowerCase());
  const hasTopic = topics.some((t) => SKILL_TOPICS.has(t));
  const text = `${e.name} ${e.description} ${topics.join(' ')}`.toLowerCase();
  const hasText = /\bskills?\b/.test(text) || text.includes('skill.md');
  return { hasTopic, hasText };
}

/**
 * 三条车道并行发现：
 *  高星 —— 按 star 降序，保证覆盖成熟项目
 *  新晋 —— 限定时间窗内新建，否则新冒头的小仓库永远进不了池子
 *  活跃 —— 按更新时间排，捕捉正在被持续维护的项目
 */
async function discover(config) {
  const found = new Map();
  const limit = Number(process.env.SD_QUERY_LIMIT || 0);
  const topics = config.search.topics || [];
  const lanes = config.search.lanes || [{ name: '高星', sort: 'stars', pages: 2, sinceDays: null }];
  const pageCap = Number(process.env.SD_PAGES || 0);

  const jobs = [];
  for (const lane of lanes) {
    const pages = pageCap > 0 ? pageCap : lane.pages ?? 1;
    for (const topic of topics) {
      let q = `topic:${topic}`;
      if (lane.sinceDays) {
        const since = new Date(Date.now() - lane.sinceDays * 86400000).toISOString().slice(0, 10);
        q += lane.sort === 'updated' ? ` pushed:>=${since}` : ` created:>=${since}`;
      }
      jobs.push({ lane: lane.name, q, sort: lane.sort, pages });
    }
  }
  for (const q of config.search.extraQueries || []) {
    jobs.push({ lane: '补充', q, sort: 'stars', pages: pageCap > 0 ? pageCap : 1 });
  }

  const selected = limit > 0 ? jobs.slice(0, limit) : jobs;

  for (const job of selected) {
    for (let page = 1; page <= job.pages; page++) {
      try {
        const { items, total } = await searchRepos(job.q, { sort: job.sort, perPage: 100, page });
        for (const it of items) {
          const e = toEntry(it);
          const prev = found.get(e.full_name);
          if (prev) {
            // 同一仓库在多条车道命中时，保留更新鲜的元数据
            if (Date.parse(e.pushed_at) > Date.parse(prev.pushed_at)) found.set(e.full_name, e);
          } else {
            e.lanes = [job.lane];
            found.set(e.full_name, e);
          }
          if (prev && !prev.lanes.includes(job.lane)) {
            const cur = found.get(e.full_name);
            cur.lanes = [...(cur.lanes || []), job.lane];
          }
        }
        log(`[${job.lane}] "${job.q}" p${page} → ${items.length} 条（该查询共 ${total}）`);
        if (items.length < 100) break;
      } catch (err) {
        log(`[${job.lane}] 搜索失败 "${job.q}" p${page}: ${err.message}`);
        break;
      }
    }
  }

  const byLane = {};
  for (const e of found.values()) byLane[e.lanes?.[0] ?? '?'] = (byLane[e.lanes?.[0] ?? '?'] ?? 0) + 1;
  log(`车道命中：${Object.entries(byLane).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  return found;
}

function passesFilters(e, config) {
  if (e.fork || e.archived || e.disabled) return false;
  if (e.stargazers_count < config.minStars) return false;
  const { hasTopic, hasText } = hasSkillSignal(e);
  if (!hasTopic && !hasText) return false;
  const name = e.name.toLowerCase();
  for (const pat of config.filters.excludePatterns || []) {
    try {
      if (new RegExp(pat, 'i').test(name)) return false;
    } catch { /* 忽略非法正则 */ }
  }
  return true;
}

async function main() {
  await ensureDirs();
  const config = await loadConfig();
  setSearchInterval(config.search.minIntervalMs ?? 2100);

  const today = bjToday();
  const targetDate = addDays(today, -1);
  log(`采集开始 · 今天 ${today} · 报告日期 ${targetDate} · token ${hasToken() ? '有' : '无'}`);

  const discovered = await discover(config);
  log(`本次发现 ${discovered.size} 个候选`);

  const existing = (await readJSON(P.pool, { repos: [] })).repos ?? [];
  const merged = new Map();
  for (const e of existing) merged.set(e.full_name, e);
  for (const [k, v] of discovered) {
    const prev = merged.get(k);
    merged.set(k, prev ? { ...prev, ...v, first_seen: prev.first_seen ?? targetDate } : { ...v, first_seen: targetDate });
  }

  let pool = [...merged.values()].filter((e) => passesFilters(e, config));

  // 关键词命中但无 skill topic 的，用代码搜索确认真的存在 SKILL.md
  if (hasToken()) {
    const needVerify = pool
      .filter((e) => !e.verified && !hasSkillSignal(e).hasTopic)
      .sort((a, b) => b.stargazers_count - a.stargazers_count)
      .slice(0, 60);
    if (needVerify.length) {
      log(`代码搜索验证 ${needVerify.length} 个仓库是否存在 SKILL.md`);
      const rejected = new Set();
      for (const e of needVerify) {
        const ok = await verifySkillFile(e.full_name).catch(() => null);
        if (ok === false) rejected.add(e.full_name);
        else e.verified = true;
        await sleep(300);
      }
      if (rejected.size) log(`剔除 ${rejected.size} 个无 SKILL.md 的仓库`);
      pool = pool.filter((e) => !rejected.has(e.full_name));
    }
  }

  pool.sort((a, b) => b.stargazers_count - a.stargazers_count);

  // 池子截断不能只按 star 排，否则「新晋」车道捞回来的低星新仓库全被挤掉。
  // 三段配额：高星 60% / 新晋 20% / 活跃 20%，去重后不超上限。
  const cap = config.poolLimit;
  const before = pool.length;
  if (pool.length > cap) {
    const quotaStar = Math.round(cap * 0.6);
    const quotaNew = Math.round(cap * 0.2);
    const picked = new Map();

    const addAll = (list, quota) => {
      let added = 0;
      for (const e of list) {
        if (added >= quota) break;
        if (picked.has(e.full_name)) continue;
        picked.set(e.full_name, e);
        added++;
      }
    };

    addAll(pool, quotaStar);
    addAll(
      [...pool].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
      quotaNew,
    );
    addAll(
      [...pool].sort((a, b) => Date.parse(b.pushed_at) - Date.parse(a.pushed_at)),
      cap - picked.size,
    );
    pool = [...picked.values()].sort((a, b) => b.stargazers_count - a.stargazers_count);
    log(`池子截断 ${before} → ${pool.length}（高星/新晋/活跃 三段配额）`);
  }

  await writeJSON(P.pool, {
    updated_at: bjNowISO(),
    date: targetDate,
    count: pool.length,
    repos: pool,
  });

  const snapshot = {
    date: targetDate,
    taken_at: bjNowISO(),
    repos: Object.fromEntries(pool.map((e) => [e.full_name, e.stargazers_count])),
  };
  // 每天只在 targetDate（昨天）这个键上落一次快照。
  // 相邻两天的快照都是在各自当天 08:00 取的，因此差值恰好是 24h 窗口。
  await writeJSON(`${P.snapshots}/${targetDate}.json`, snapshot);

  const stats = getStats();
  const skillsTopicCount = pool.filter((e) => hasSkillSignal(e).hasTopic).length;
  log(
    `写入快照 ${targetDate}：${pool.length} 个仓库（topic 命中 ${skillsTopicCount}）· API ${stats.calls} 次 · 剩余额度 ${stats.remaining ?? '?'}`,
  );
}

main().catch((err) => {
  console.error('采集失败:', err);
  process.exit(1);
});
