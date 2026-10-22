# SKILLS DAILY · 技能日报

每天北京时间 **08:00** 自动抓取 GitHub 上的 AI Agent 技能仓库，生成一份赛博朋克风格的日报页面，并把摘要推到企业微信群。

四个栏目：**总热门 / 月热门 / 周热门 / 单日热门**，每栏最多 10 条，抓不满就空着。

---

## 口径说明（先看这段，不然会误读榜单）

| 栏目 | 口径 | 冷启动期 |
|---|---|---|
| 总热门 | 近 12 个月新建的仓库，按 star 总数排 | 立即有数据 |
| 月热门 | 近 30 天 star **净增** | 快照不足 31 天时，降级为「近 30 天新建仓库按 star」 |
| 周热门 | 近 7 天 star 净增 | 快照不足 8 天时，降级为「近 7 天新建仓库按 star」 |
| 单日热门 | 前一天 00:00–24:00 的 star 净增 | 快照不足 2 天时，降级为空置 |

**为什么净增要等？** GitHub 官方 API 只返回当前 star 总数，不提供历史曲线。净增只能靠每天存一次快照、用相邻两次快照相减得到。

快照在 `data/snapshots/<日期>.json`，每天追加一个文件，永不覆盖。所以：

- 第 2 天起，单日热门开始有真实数据
- 第 8 天起，周热门切到真实净增
- 第 31 天起，月热门切到真实净增

降级期间页面顶部有 `COLD START` 横幅，卡片角标显示 `≈`，不会把代理数据伪装成净增。

**发布日与数据日的关系**：8:00 发布的日报，标题日期是**前一天**，覆盖前一天整天。快照在每天同一时刻采集，因此相邻快照相减恰好是 24 小时窗口。

---

## 目录结构

```
.github/workflows/daily.yml   定时任务：采集 → 生成 → 提交 → 部署 → 推送
config/config.json             阈值、权重、栏目、搜索车道
scripts/collect.mjs            抓仓库、落快照
scripts/build.mjs              算榜、调模型点评、生成页面
scripts/notify.mjs             企业微信群机器人推送
scripts/lib/github.mjs         GitHub API（带限流退避）
scripts/lib/rank.mjs           榜单计算与推荐分
scripts/lib/render.mjs         页面渲染
data/pool.json                 仓库池（累积，不重置）
data/snapshots/                每日 star 快照（净增的唯一依据）
data/daily/                    每日日报成品
data/enrich-cache.json         模型点评缓存（30 天 / 仓库更新后失效）
site/                          生成的静态站，GitHub Pages 直接从这儿取
```

**三条发现车道**（`config.search.lanes`）：高星（按 star）、新晋（近 30 天新建）、活跃（近 7 天有提交）。少了「新晋」车道，新冒头的小仓库永远进不了池子，单日/周榜会失效——这是刻意设计的。

---

## 本地跑

```bash
# 首次：抓数据（无 token 也能跑，但会被限流到 10 次/分钟）
node scripts/collect.mjs

# 生成页面
DEEPSEEK_API_KEY=sk-xxx node scripts/build.mjs

# 打开 site/index.html
```

有 token 会快很多，也能启用 SKILL.md 代码搜索校验：

```bash
GITHUB_TOKEN=ghp_xxx node scripts/collect.mjs
```

调试用的环境变量：

| 变量 | 作用 |
|---|---|
| `SD_QUERY_LIMIT` | 只跑前 N 个搜索任务 |
| `SD_PAGES` | 每个任务翻几页 |
| `REPORT_DATE` | 指定报告日期，默认昨天 |
| `LLM_BASE_URL` / `LLM_MODEL` | 覆盖模型接口（默认 DeepSeek）|

---

## 部署到 GitHub Actions

1. **建仓库**（public，Pages 免费），把本目录推上去。
2. **开 Pages**：Settings → Pages → Source 选 **GitHub Actions**。
3. **加 Secrets**（Settings → Secrets and variables → Actions）：
   - `DEEPSEEK_API_KEY` —— 必填，没有就退化成英文原文描述
   - `WECOM_WEBHOOK` —— 企业微信**群机器人**的完整 webhook URL
4. **加 Variables**（可选）：`LLM_BASE_URL`、`LLM_MODEL`、`NOTIFY_ENABLED=false`。
5. **手动跑一次**：Actions → Skills Daily → Run workflow，确认全流程通。

之后每天自动执行。**注意定时不是整点**，而是北京 08:07 和 08:37 两个时段，原因见下。

### 为什么不用整点

GitHub 官方文档写得很直白：`schedule` 在每小时开头负荷最高，任务会延迟，**负荷足够高时排队任务会被直接丢弃**。把 cron 定成 `0 0 * * *` 是最差的选择——本项目第一版就是这么写的，结果第二天早上一条记录都没有。

所以做了两层防护：

1. **避开整点**：`7 0 * * *`（北京 08:07）+ `37 0 * * *`（北京 08:37）两个时段。
2. **幂等守卫**：`scripts/guard.mjs` 检查当天报告是否已生成。08:07 跑成功了，08:37 那次会直接退出，不会重复推送；08:07 被丢弃了，08:37 照常干活。

代价是准点变成「08:07～08:40 之间」。这是 GitHub 托管 cron 的固有不确定性，要严格准点只能换自己的服务器。

拿群机器人 webhook：企业微信群 → 右上角设置 → 群机器人 → 添加 → 复制 Webhook 地址。

---

## 调参

| 想改什么 | 改哪里 |
|---|---|
| 每栏条数 | `config.perColumn` |
| 最低 star 门槛 | `config.minStars`（默认 10，个位数直接不纳入统计）|
| 推荐分权重 | `config.scoreWeights` |
| 抓取范围 | `config.search.topics` / `lanes` |
| 推送条数 | `config.notify.topNPerColumn` |
| 模型批次大小 | `config.deepseek.batchSize` |

**推荐分** = 热度 35% + 模型判断 35% + 活跃度 20% + 信息完整度 10%。
热度在**同栏内归一化**，所以 REC 分只在同一栏里比较有意义，跨栏不可比。

---

## 已知边界

- **star 净增无法回溯**。这是 GitHub API 的限制，不是实现问题。想要第 1 天就有净增，只能接第三方 star 历史数据源。
- **GitHub 托管 cron 不保证准点，甚至可能丢**。已用「非整点 + 双时段 + 幂等守卫」缓解，但仍不是硬保证。要硬保证只能用自建服务器跑。
- **筛选靠 topic + 名称/描述关键词**。GitHub 没有官方的「技能」分类，误收和漏收都会存在。有 token 时用代码搜索校验 `SKILL.md` 是否存在，能挡掉一部分误收。
- **模型点评会判断错**。REC 分是辅助信号，别当成结论。
- 企业微信群机器人有 **20 条/分钟** 的频率限制，本项目每天只推 1 条，不会触碰。
