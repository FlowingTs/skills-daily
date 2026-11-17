// 识别批量刷星的空壳仓库。
//
// 背景：2026-11 中旬起，潜力榜被几批批量注册的账号占领——
// 同一段描述被复制到上百个不同 owner 的同名仓库上，星数几乎一致：
//   GitHub-Copilot-app ×109、ai--manus2.0 ×235、Gemini-Config-Checker- ×21
// 它们星数高（600+）所以排在池子最前，把真正的新项目全挤掉了。
//
// 为什么用「描述完全相同」而不是「同名」：skills、mcp 这种通用词，
// 二十几个真实项目都叫这个名字，按名判会误杀 anthropics/skills（19 万星）、
// antfu/skills、dotnet/skills。而一整段描述被多个不同 owner 逐字共用，
// 真实项目几乎不会出现——实测 3465 个仓库里只命中 3 组，全是真的刷量批次。
//
// 第二条规则（同名 + 同期创建 + 星数雷同）只作为补充，兜住那些改了描述的批次。

const DESC_KEY_LEN = 80; // 取描述前 80 字做指纹，足够区分又容忍尾部差异
const MIN_DESC_LEN = 30; // 太短的描述（"a cli tool"）不参与克隆判断
const MIN_GROUP = 3; // 至少 3 个不同 owner 共用同一段描述才算克隆
const BATCH_DAYS = 7; // 同名批次：创建时间跨度
const STAR_RATIO = 1.05; // 同名批次：星数最大值 / 最小值 的上限

const key = (r) => String(r?.description ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, DESC_KEY_LEN);
const owner = (r) => String(r?.owner ?? '').toLowerCase();
const repoTail = (r) => String(r?.name || r?.full_name?.split('/').pop() || '').toLowerCase();
const stars = (r) => r?.stargazers_count ?? 0;
const createdDay = (r) => (r?.created_at ? String(r.created_at).slice(0, 10) : '');

/**
 * 找出刷量/克隆仓库。
 * @param {Array} repos 可以是单个池，也可以是多个池合并后的数组（内部按 full_name 去重）
 * @returns {Map<string, string>} full_name → 判定理由
 */
export function findJunkRepos(repos) {
  const junk = new Map();

  // 去重 + 排除真 fork / 已归档
  const uniq = new Map();
  for (const r of repos || []) {
    if (!r?.full_name || r.fork || r.archived) continue;
    if (!uniq.has(r.full_name)) uniq.set(r.full_name, r);
  }
  const alive = [...uniq.values()];

  // 规则 1：描述克隆 —— 同一段描述被 >=3 个不同 owner 使用
  const byDesc = new Map();
  for (const r of alive) {
    const k = key(r);
    if (k.length < MIN_DESC_LEN) continue;
    if (!byDesc.has(k)) byDesc.set(k, []);
    byDesc.get(k).push(r);
  }
  for (const [, group] of byDesc) {
    const owners = new Set(group.map(owner));
    // 3 个以上账号共用一段描述：直接判为克隆。
    // 只有 2 个时得再加一条佐证（都无语言，或者都零 fork）——
    // 两个真实项目恰好抄了同一句介绍是可能的，光看描述不够。
    const strong = owners.size >= MIN_GROUP;
    const weak = owners.size === 2 && group.every((r) => !r.language || !(r.forks_count > 0));
    if (!strong && !weak) continue;
    for (const r of group) {
      if (!junk.has(r.full_name)) {
        junk.set(r.full_name, `描述克隆 · ${owners.size} 个账号共用同一段介绍`);
      }
    }
  }

  // 规则 2：同名 + 同期创建 + 星数雷同
  const byName = new Map();
  for (const r of alive) {
    const k = repoTail(r);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  for (const [nm, group] of byName) {
    if (group.length < MIN_GROUP) continue;
    const dated = group.filter((r) => createdDay(r)).sort((a, b) => createdDay(a).localeCompare(createdDay(b)));
    for (let i = 0; i < dated.length; i++) {
      const start = Date.parse(`${createdDay(dated[i])}T00:00:00Z`);
      if (!Number.isFinite(start)) continue;
      // 只有落在 [start, start+7天] 里的才算同一批；注意必须带下界，
      // 否则更早创建的成员会因为差值为负数被卷进来（这个坑踩过）。
      const batch = dated.filter((r) => {
        const diff = Date.parse(`${createdDay(r)}T00:00:00Z`) - start;
        return diff >= 0 && diff <= BATCH_DAYS * 86400000;
      });
      if (batch.length < MIN_GROUP) continue;
      for (const base of batch) {
        const floor = stars(base);
        if (floor <= 0) continue;
        const cluster = batch.filter((r) => stars(r) >= floor && stars(r) <= floor * STAR_RATIO);
        const owners = new Set(cluster.map(owner));
        if (cluster.length >= MIN_GROUP && owners.size >= MIN_GROUP) {
          for (const r of cluster) {
            if (!junk.has(r.full_name)) {
              junk.set(r.full_name, `同名同批 · ${nm} 的一批副本星数都在 ${floor} 上下`);
            }
          }
          break;
        }
      }
    }
  }

  return junk;
}
