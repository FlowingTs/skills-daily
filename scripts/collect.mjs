import {
  ensureDirs,
  loadConfig,
  readJSON,
  writeJSON,
  groupPoolFile,
  groupSnapshotDir,
} from './lib/store.mjs';
import { searchRepos, hasToken, getStats, setSearchInterval, verifySkillFile } from './lib/github.mjs';
import { addDays, bjToday, bjNowISO, log, sleep } from './lib/util.mjs';

const SKILL_TOPICS = new Set([
  'claude-skills', 'agent-skills', 'agent-skill', 'claude-skill', 'skill-md',
  'claude-code-plugin', 'codex-skills', 'opencode-skills', 'gemini-cli-skills',
  'claude-code-skill', 'skills', 'skill', 'agent-skills-cli',
]);

/** AIGC 认的 topic。比 skills 宽得多，但仍然是「生成式 AI」这个范围，不是泛 AI 工具。 */
const AIGC_TOPICS = new Set([
  'generative-ai', 'aigc', 'llm', 'llms', 'text-generation', 'image-generation',
  'video-generation', 'text-to-image', 'text-to-video', 'text-to-speech',
  'stable-diffusion', 'stable-diffusion-webui', 'comfyui', 'diffusion',
  'llm-inference', 'llm-serving', 'ai-agents', 'agent', 'multimodal', 'rag',
  'prompt-engineering', 'embeddings', 'vector-database', 'fine-tuning', 'lora',
  'whisper', 'tts', 'ai-video', 'ai-art', 'chatgpt', 'openai', 'transformer',
]);

/** 描述里出现这些词也算 AIGC，否则只靠 topic 会漏掉一大批没打 topic 的新仓库 */
const AIGC_TEXT = new RegExp(
  [
    'aigc', 'generative ai', 'llm', 'gpt', 'chatgpt', 'diffusion',
    'stable diffusion', 'comfyui', 'text-to-image', 'text-to-video',
    'text-to-speech', 'image generation', 'video generation', 'voice clone',
    'llm inference', 'multimodal', 'embedding', 'fine-tun', 'lora',
    'ai agent', 'agentic', 'rag',
  ].join('|'),
  'i',
);

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

function hasAigcSignal(e) {
  const topics = (e.topics || []).map((t) => t.toLowerCase());
  const hasTopic = topics.some((t) => AIGC_TOPICS.has(t));
  const text = `${e.name} ${e.description} ${topics.join(' ')}`;
  const hasText = AIGC_TEXT.test(text);
  return { hasTopic, hasText };
}

const SIGNALS = { skills: hasSkillSignal, aigc: hasAigcSignal };

/**
 * 多条车道并行发现：
 *  高星 —— 按 star 降序，保证覆盖成熟项目
 *  新芽 —— 近 7 天新建，潜力榜的候选来源
 *  新晋 —— 近 30 天新建
 *  活跃 —— 按更新时间排，捕捉正在被持续维护的项目
 */
async function discover(group, config) {
  const found = new Map();
  const limit = Number(process.env.SD_QUERY_LIMIT || 0);
  const search = group.search || {};
  const topics = search.topics || [];
  const lanes = search.lanes || [{ name: '高星', sort: 'stars', pages: 2, sinceDays: null }];
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
  for (const q of search.extraQueries || []) {
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
        log(`[${group.id}/${job.lane}] "${job.q}" p${page} → ${items.length} 条（该查询共 ${total}）`);
        if (items.length < 100) break;
      } catch (err) {
        log(`[${group.id}/${job.lane}] 搜索失败 "${job.q}" p${page}: ${err.message}`);
        break;
      }
    }
  }

  const byLane = {};
  for (const e of found.values()) byLane[e.lanes?.[0] ?? '?'] = (byLane[e.lanes?.[0] ?? '?'] ?? 0) + 1;
  log(`[${group.id}] 车道命中：${Object.entries(byLane).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  return found;
}

function passesFilters(e, group, config) {
  if (e.fork || e.archived || e.disabled) return false;
  if (e.stargazers_count < (group.minStars ?? config.minStars)) return false;
  const { hasTopic, hasText } = (SIGNALS[group.id] || hasSkillSignal)(e);
  if (!hasTopic && !hasText) return false;
  const name = e.name.toLowerCase();
  for (const pat of config.filters.excludePatterns || []) {
    try {
      if (new RegExp(pat, 'i').test(name)) return false;
    } catch { /* 忽略非法正则 */ }
  }
  return true;
}

/** 池子截断不能只按 star 排，否则新车道捞回来的低星新仓库全被挤掉 */
function truncatePool(pool, cap, tag) {
  if (pool.length <= cap) return pool;
  const before = pool.length;
  const quotaStar = Math.round(cap * 0.6);
  const quotaNew = Math.round(cap * 0.22);
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
  addAll([...pool].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)), quotaNew);
  addAll([...pool].sort((a, b) => Date.parse(b.pushed_at) - Date.parse(a.pushed_at)), cap - picked.size);

  const out = [...picked.values()].sort((a, b) => b.stargazers_count - a.stargazers_count);
  log(`[${tag}] 池子截断 ${before} → ${out.length}（高星/新芽/活跃 三段配额）`);
  return out;
}

async function collectGroup(group, config, targetDate) {
  log(`—— ${group.label}（${group.id}）开始 ——`);
  const discovered = await discover(group, config);
  log(`[${group.id}] 本次发现 ${discovered.size} 个候选`);

  const existing = (await readJSON(groupPoolFile(group.pool), { repos: [] })).repos ?? [];
  const merged = new Map();
  for (const e of existing) merged.set(e.full_name, e);
  for (const [k, v] of discovered) {
    const prev = merged.get(k);
    merged.set(k, prev
      ? { ...prev, ...v, first_seen: prev.first_seen ?? targetDate }
      : { ...v, first_seen: targetDate });
  }

  let pool = [...merged.values()].filter((e) => passesFilters(e, group, config));

  // 只有 skills 池需要用代码搜索确认 SKILL.md 真实存在
  if (group.id === 'skills' && hasToken()) {
    const needVerify = pool
      .filter((e) => !e.verified && !hasSkillSignal(e).hasTopic)
      .sort((a, b) => b.stargazers_count - a.stargazers_count)
      .slice(0, 60);
    if (needVerify.length) {
      log(`[${group.id}] 代码搜索验证 ${needVerify.length} 个仓库是否存在 SKILL.md`);
      const rejected = new Set();
      for (const e of needVerify) {
        const ok = await verifySkillFile(e.full_name).catch(() => null);
        if (ok === false) rejected.add(e.full_name);
        else e.verified = true;
        await sleep(300);
      }
      if (rejected.size) log(`[${group.id}] 剔除 ${rejected.size} 个无 SKILL.md 的仓库`);
      pool = pool.filter((e) => !rejected.has(e.full_name));
    }
  }

  pool.sort((a, b) => b.stargazers_count - a.stargazers_count);
  pool = truncatePool(pool, group.poolLimit ?? 1200, group.id);

  await writeJSON(groupPoolFile(group.pool), {
    updated_at: bjNowISO(),
    date: targetDate,
    group: group.id,
    count: pool.length,
    repos: pool,
  });

  const dir = groupSnapshotDir(group.snapshots);
  await writeJSON(`${dir}/${targetDate}.json`, {
    date: targetDate,
    group: group.id,
    taken_at: bjNowISO(),
    repos: Object.fromEntries(pool.map((e) => [e.full_name, e.stargazers_count])),
  });

  log(`[${group.id}] 写入快照 ${targetDate}：${pool.length} 个仓库`);
  return pool.length;
}

async function main() {
  await ensureDirs();
  const config = await loadConfig();
  setSearchInterval(config.search.minIntervalMs ?? 2100);

  const today = bjToday();
  const targetDate = addDays(today, -1);
  log(`采集开始 · 今天 ${today} · 报告日期 ${targetDate} · token ${hasToken() ? '有' : '无'}`);

  const only = process.env.SD_GROUP ? new Set(process.env.SD_GROUP.split(',').map((s) => s.trim())) : null;
  const result = {};
  for (const group of config.groups) {
    if (only && !only.has(group.id)) {
      log(`跳过 ${group.label}（SD_GROUP 只跑 ${[...only].join(',')}）`);
      continue;
    }
    result[group.id] = await collectGroup(group, config, targetDate);
  }

  const stats = getStats();
  log(
    `全部完成：${Object.entries(result).map(([k, v]) => `${k} ${v}`).join(' · ')} · API ${stats.calls} 次 · 剩余额度 ${stats.remaining ?? '?'}`,
  );
}

main().catch((err) => {
  console.error('采集失败:', err);
  process.exit(1);
});
