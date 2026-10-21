import { P, readJSON, writeJSON } from './store.mjs';
import { chunk, log, sleep } from './util.mjs';

let cache = null;
let cacheDirty = false;

async function loadCache() {
  if (cache) return cache;
  cache = (await readJSON(P.enrich, { items: {} })).items ?? {};
  return cache;
}

export async function saveCache() {
  if (!cacheDirty || !cache) return;
  await writeJSON(P.enrich, { updated_at: new Date().toISOString(), items: cache });
}

const SYSTEM = `你是资深 AI 工具编辑，为「AI Agent 技能日报」写条目点评。
读者是使用 WorkBuddy / Claude Code 这类 agent 工具的中文开发者，他们关心：这东西能不能装、装了能干什么、值不值得花时间。

要求：
- summary：中文，40~55 字，说清「这是什么 + 解决什么问题 + 适合谁」。禁止空话、禁止"这是一个…的仓库"这种句式。
- verdict：0-100 整数，代表对上述读者的实用价值。判断依据：是否真的可安装可用、是否解决真实痛点、是否只是套壳或营销仓库、维护是否活跃。
- 不要复述英文描述，要给出判断。`;

function buildPrompt(batch) {
  const lines = batch.map((r, i) => {
    const parts = [
      `#${i + 1}`,
      `repo: ${r.full_name}`,
      `desc: ${(r.description || '(无描述)').slice(0, 220)}`,
      `topics: ${(r.topics || []).slice(0, 12).join(', ') || '(无)'}`,
      `stars: ${r.stargazers_count}`,
      `语言: ${r.language || '未知'}`,
      `最近提交: ${r.pushed_at?.slice(0, 10)}`,
    ];
    if (typeof r.__delta === 'number') parts.push(`近期净增 star: ${r.__delta}`);
    return parts.join('\n');
  });

  return `为下面 ${batch.length} 个仓库各写一条点评。

严格只输出 JSON，格式：
{"items":[{"repo":"owner/name","summary":"中文点评","verdict":88}]}

仓库列表：
${lines.join('\n\n')}`;
}

async function callDeepSeek(batch, cfg, apiKey) {
  const baseUrl = (process.env.LLM_BASE_URL || cfg.baseUrl).replace(/\/$/, '');
  const model = process.env.LLM_MODEL || cfg.model;
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildPrompt(batch) },
    ],
    temperature: 0.4,
    response_format: { type: 'json_object' },
    max_tokens: 2000,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`DeepSeek ${res.status}: ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 为一批仓库补中文点评与模型评分，带缓存。
 * @returns {Record<string, {summary:string, verdict:number, source:string}>}
 */
export async function enrichRepos(repos, config, { maxEnrich } = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || '';
  const out = {};
  const store = await loadCache();
  const ttlMs = 30 * 86400000;

  const pending = [];
  for (const r of repos) {
    const hit = store[r.full_name];
    const fresh =
      hit && hit.pushed_at === r.pushed_at && Date.now() - Date.parse(hit.at || 0) < ttlMs;
    if (fresh) {
      out[r.full_name] = { summary: hit.summary, verdict: hit.verdict, source: 'cache' };
    } else {
      pending.push(r);
    }
  }

  const limit = maxEnrich ?? config.deepseek.maxEnrich ?? 60;
  const todo = pending.slice(0, limit);

  if (!apiKey) {
    log(`未配置 DEEPSEEK_API_KEY，跳过模型点评（${todo.length} 个待评）`);
    return out;
  }
  if (!todo.length) {
    log(`点评全部命中缓存（${Object.keys(out).length} 条）`);
    return out;
  }

  log(`调用 DeepSeek 生成点评：${todo.length} 个仓库，分 ${Math.ceil(todo.length / config.deepseek.batchSize)} 批`);

  for (const batch of chunk(todo, config.deepseek.batchSize ?? 8)) {
    let items = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        items = await callDeepSeek(batch, config.deepseek, apiKey);
        break;
      } catch (err) {
        log(`点评批次失败(${attempt + 1}/3): ${err.message}`);
        if (attempt === 2) break;
        await sleep(2000 * (attempt + 1));
      }
    }

    const byName = new Map(items.map((x) => [String(x.repo || '').toLowerCase(), x]));
    for (const r of batch) {
      const got = byName.get(r.full_name.toLowerCase());
      if (!got) continue;
      const summary = String(got.summary || '').trim();
      const verdict = Math.max(0, Math.min(100, Math.round(Number(got.verdict) || 0)));
      if (!summary) continue;
      out[r.full_name] = { summary, verdict, source: 'model' };
      store[r.full_name] = { summary, verdict, pushed_at: r.pushed_at, at: new Date().toISOString() };
      cacheDirty = true;
    }
    await sleep(400);
  }

  await saveCache();
  log(`点评完成：新增 ${Object.values(out).filter((x) => x.source === 'model').length} 条`);
  return out;
}

/** 无模型时的保底点评：从英文描述拼一句中文说明 */
export function fallbackSummary(repo) {
  const d = (repo.description || '').trim();
  const topics = (repo.topics || []).slice(0, 3).join(' / ');
  if (!d) return '仓库未提供描述，建议进仓库看 README 判断。';
  return `${d.length > 100 ? `${d.slice(0, 100)}…` : d}${topics ? `（${topics}）` : ''}`;
}
