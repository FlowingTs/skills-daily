# SKILLS DAILY · 技能日报

每天北京时间 **08:00**（cron-job.org 触发，见下文「定时触发」）抓取 GitHub 上的仓库，
生成一份黑色宇宙风格的日报页面，并把摘要推到企业微信群。

两个领域 × 四个周期：**Skills / AIGC** 各出 **日 / 周 / 月 / 总** 四档，每档最多 10 条；
下面是两份独立的**潜力榜**（Skills 新苗 / AIGC 新苗），各最多 5 条。

页面打开默认只显示 **Skills 日榜**，想看别的就点一下：顶部粘顶导航切周期（日/周/月/总），
榜单区的分段标签切领域（Skills / AIGC）。抓不满就空着，不补位。

---

## 口径说明（先看这段，不然会误读榜单）

| 档位 | 口径 | 冷启动期 |
|---|---|---|
| 总热门 | Skills：近 12 个月新建，按 star 总量；AIGC：全历史，按 star 总量 | 立即有数据 |
| 月热门 | 近 30 天 star **净增** | 快照不足 31 天时，降级为「近 30 天新建仓库按 star」 |
| 周热门 | 近 7 天 star 净增 | 快照不足 8 天时，降级为「近 7 天新建仓库按 star」 |
| 单日热门 | 前一天 00:00–24:00 的 star 净增 | 快照不足 2 天时，降级为「近 7 天新建仓库按 star」 |
| 潜力榜 | 新建仓库按**每天拿到的 star** 排（速度，不是存量） | 无需快照，立即有数据 |

两个领域各自一套仓库池和快照，互不干扰：

| | Skills | AIGC |
|---|---|---|
| 收什么 | `SKILL.md` 那类 Agent 技能仓库 | 不限 skills，生成式 AI 全范围（模型、推理、图像/视频/语音生成、框架、Agent、RAG） |
| star 门槛 | 统一 10 | 日/周 50，月/总 100 |
| 潜力榜门槛 | 10 | 50 |
| 池子 | `data/pool.json` · `data/snapshots/` | `data/pool-aigc.json` · `data/snapshots-aigc/` |

**AIGC 单向让路**：AIGC 的每一档都会剔掉 Skills 榜上出现过的仓库（四档 + 潜力榜全算），Skills 榜不受影响。

### 跨档去重：一个仓库一天只出现一次

排名按 **总 → 月 → 周 → 日 → 潜力榜** 的优先级依次生成，每一档排除前面已入选的仓库。
被剔掉的位置继续往下取，补满 10 条——所以日榜不会被抽空，但它的语义变了：
**不再是「昨天涨得最多的 10 个」，而是「没进总/月/周榜的仓库里涨得最多的 10 个」**。

实测 11-01 那期，Skills 日榜前三从 `+7,301 / +1,840 / +1,445` 变成 `+415 / +294 / +235`。
数字是真的，但量级差了一个数量级，这是规则本身决定的，不是 bug。

去重顺序在 `config.dedupeOrder` 里，和页面展示顺序（日/周/月/总）是两回事：

| | 顺序 | 用途 |
|---|---|---|
| `config.periods` | 日 → 周 → 月 → 总 | 顶部导航的排列 |
| `config.dedupeOrder` | 总 → 月 → 周 → 日 | 谁先挑仓库 |

**首屏不受影响。** 「昨夜最亮的 / 涨了 N」取的是全站当日净增第一，不参与去重；
那个仓库一定在总榜里，没有从页面上消失。取数在 `build.mjs` 里单独跑一次（`heroItem`），
不重用日榜第一名——否则首屏大数字会跟着塌到 +415。

潜力榜排在日榜之后，所以它现在是「四档都没收下的新苗」。AIGC 潜力榜的实际力度会明显下降
（原来那 5 条全被四档吃掉），数量仍靠窗口外扩（7→28 天）补满 5 条，不降门槛。

潜力榜的排序刻意不用 star 总量：一个 3 天涨 300 的仓库，比 20 天涨 900 的更值得看。

**窗口会自动外扩。** 从近 7 天开始，如果凑不够 3 条，就放宽到 14 天、21 天、28 天，
直到够 3 条为止（上限 28 天）。页面会写明当期实际用的是哪个窗口，不会让人以为固定 7 天。
参数在 `config.json` 的 `potential.skills` / `potential.aigc`：`windowSteps` / `minCount` / `limit`。

**为什么净增要等？** GitHub 官方 API 只返回当前 star 总数，不提供历史曲线。净增只能靠每天存一次快照、用相邻两次快照相减得到。

快照在 `data/snapshots/<日期>.json`，每天追加一个文件，永不覆盖。所以：

- 第 2 天起，单日热门开始有真实数据
- 第 8 天起，周热门切到真实净增
- 第 31 天起，月热门切到真实净增

降级的那一栏，栏目标题下会写明「真净增要攒满 N 天快照，现在只有 M 天，暂时按窗口内新建仓库的 star 排」，
不会把代理数据伪装成净增。

**发布日与数据日的关系**：8:00 发布的日报，标题日期是**前一天**，覆盖前一天整天。快照在每天同一时刻采集，因此相邻快照相减恰好是 24 小时窗口。

---

## 推送什么

早八点只推**两份潜力榜**：Skills 新苗 top3 + AIGC 新苗 top3，带一句中文点评。

理由是日/周/月/总已经收进页面切换里，早上最值得看的是「昨天又冒出来什么」，而不是「谁又涨了」。
完整四档要看就点链接进页面。企业微信 markdown 上限 4096 字节，`notify.mjs` 里有逐级降级阶梯
（先压点评长度 → 再去掉 REC 标签 → 再减条目 → 最后按行硬截），不会因为字数超限整条发不出去。

---

## 页面设计

方向：**The sentence is the layout**（seed 1609627027）——一句短话就是整个版式。
页面上的想法不是"黑底加星星"，而是从主体长出来的：GitHub 的计量单位本来就叫 **star**，
所以这一页把「一个仓库的 star 数」当作「一颗星的亮度」，日报就是一张"昨夜谁变亮了"的星图。
首屏那句「昨夜最亮的 / 涨了 7,301」由下面的仓库卡片补全主语。

三处按需求改动，记录在此：

| 槽位 | 抽到的 | 换成 | 原因 |
|---|---|---|---|
| 配色 | Bubblegum and lime（粉底+荧光绿） | 近黑 `#060609` + 暖白墨 + 单一强调色 `#e6d3a7` | 你明确要黑色宇宙；粉底与之直接冲突 |
| 字体 | Newsreader 新闻宋 | 系统无衬线（Segoe UI / 苹方 / 雅黑） | Newsreader 没有中文字形，正文八成是中文；Windows 回落到 SimSun 在深色上偏细 |
| 区块 | list=表格推右、stats=滑杆 | list=带图点的菜单、stats=数字写进句子里 | 页面没有用户输入，滑杆无处可设；表格推右会让左半屏四次空着 |

图片全部在构建时下载到本地（`site/assets/faces`、`site/assets/cards`），
页面因此不依赖 github.com，国内打开不会出现一片空白，也不会因为头像 403 而整行塌掉。

### 第二轮：导航、潜力榜、交互动效

| 改动 | 做法 |
|---|---|
| 粘顶导航 | 五条锚点 + 一个动作。原来手机端整条 `display:none`、桌面端随页面滚走，等于没有。现在手机上折成第二行的横滑条，桌面端粘顶；离开首屏换一层底色（色阶，不是阴影/毛玻璃）；当前所在栏目的链接自动点亮 |
| 潜力榜 | 版式刻意与另外四栏不同：没有 168px 的大头像头名，改成双列紧凑行，右侧给「每天 +N」。条目为奇数时最后一条横跨两列，不留空洞 |
| 动效 | 入场 `translateY + scale(.985)`，缓动末段过冲 1.04 做弹起；悬停整行右移 6–8px、头像放大 1.06–1.14；按下回缩 0.994–0.997。全部只动 transform，`prefers-reduced-motion` 下全部关闭；**不使用透明动画**，脚本失败时内容依然可见 |

### 第三轮：两个领域 × 四个周期

原来的四栏并排，其中总热门几乎不变、月榜也在趋稳，等于每天有一半屏幕在重复昨天。
改成「一次只看一档」：

| 改动 | 做法 |
|---|---|
| 周期切换 | 顶部粘顶导航就是周期切换器：日榜 / 周榜 / 月榜 / 总榜 + 潜力榜。点日榜不只是跳转，会真的把面板切到当日 |
| 领域切换 | 榜单区的分段标签 Skills / AIGC，下方只有一块内容区；换领域时保留当前周期 |
| 潜力榜 | 独立一段，自带 Skills / AIGC 子切换。首名单独一层（168 头像 + 速度大字），其余是双列紧凑行 |
| 默认状态 | Skills + 日榜。刷新回到默认，不做记忆 |
| 无脚本时 | `no-js` 下八个面板全部展开，内容不丢 |

面板用 `display:none` 隐藏，所以切换时必须重算图片尺寸——`few-pictures` 这条体检规则会因此
只数到一张榜内大图。解法是让潜力榜首名也占一张 168px 头像，页面同时有三处大图。

锚点需要 `scroll-margin-top` 抵消粘顶栏（桌面 84px、手机 116px），否则标题会被盖住。

体检（`inspect.mjs`）在 1440 / 768 / 390 三个宽度下 **0 FAIL**。剩两条 WARN 是主动保留的：
无视频（这个题材没有诚实的片子可用，放一段星轨空镜只是装饰）、
未使用抽到的字体（同上，中文字形缺失）。

---

## 目录结构

```
.github/workflows/daily.yml   定时任务：采集 → 生成 → 提交 → 部署 → 推送
config/config.json             阈值、权重、领域与周期、搜索车道
scripts/collect.mjs            抓仓库、落快照
scripts/build.mjs              算榜、调模型点评、生成页面
scripts/notify.mjs             企业微信群机器人推送（只推两份潜力榜）
scripts/lib/github.mjs         GitHub API（带限流退避）
scripts/lib/rank.mjs           榜单计算与推荐分
scripts/lib/render.mjs         页面渲染
data/pool.json                 Skills 仓库池（累积，不重置）
data/pool-aigc.json            AIGC 仓库池
data/snapshots/                Skills 每日快照（净增的唯一来源，别删）
data/snapshots-aigc/           AIGC 每日快照
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

### 定时触发在本仓库是坏的（实测结论）

初版把 cron 写成 `0 0 * * *`，第二天早上一条记录都没有。当时的解释是「整点被 GitHub 丢弃了」，于是改成
`7 0 * * *` + `37 0 * * *` 双时段，并加了幂等守卫。

**这个解释是错的。** 后续两天的观测：

| 时间（UTC） | 期望 | 实际 |
|---|---|---|
| 10-22 00:00 | `0 0 * * *` 触发 | 无 |
| 10-23 00:07 | `7 0 * * *` 触发 | 无 |
| 10-23 00:37 | `37 0 * * *` 触发 | 无 |
| 10-23 00:50 / 00:55 | 探针 `*/5 * * * *` 触发 | 无 |

为排除「是我们的工作流写错了」，专门加过一个 `probe.yml`（内容只有一个 echo，cron `*/5`），
同样一次都没跑。同时确认了：工作流 `state=active`、仓库非 fork/未归档、Actions 权限为
`allowed_actions: all`、默认分支就是 `main`、平台侧当时无 Actions 故障。

**结论：这个仓库的 `schedule` 事件根本不派发，与 cron 写几点无关。** 幂等守卫仍有价值（多调度器并存时不重复推送），
但「避开整点」这条推理已作废。

### 因此：定时必须由仓库外的调度器承担

共用动作是 `scripts/dispatch.mjs`——调 GitHub 的 workflow_dispatch 接口，一行命令触发一次：

```bash
GH_TOKEN=xxx node scripts/dispatch.mjs
# 或把 token 写进项目根的 .dispatch-token（已 gitignore），然后直接：
node scripts/dispatch.mjs
```

任何外部定时器只要能发一个带 `Authorization: Bearer <token>` 头的 POST 即可：

```
POST https://api.github.com/repos/FlowingTs/skills-daily/actions/workflows/daily.yml/dispatches
Authorization: Bearer <PAT>
Content-Type: application/json

{"ref":"main"}
```

可选方案（都需一个免费账号，GitHub 本身这条路已堵死）：

| 方案 | 成本 | 说明 |
|---|---|---|
| cron-job.org | 免费 | 建一个 job，POST 上面的 URL，加两个头。最快，但 PAT 会存在第三方站点 |
| Cloudflare Worker + Cron Trigger | 免费 | token 存 Worker Secret，cron `0 0 * * *`。更干净，需部署一次 |
| 本机定时（WorkBuddy 自动化 / 计划任务） | 免费 | 不需要账号，但电脑关机那天就断更 |

`daily.yml` 里的 `schedule` 暂时保留——万一哪天 GitHub 修好了，幂等守卫会让它和外部调度器不冲突。

#### cron-job.org 具体配置（当前采用）

**第 1 步：建一个只够用的 token**

不要用那把 classic PAT（它带 `repo` 全域权限）。新建 fine-grained token：

`https://github.com/settings/personal-access-tokens/new`

| 字段 | 填什么 |
|---|---|
| Token name | `skills-daily-cron` |
| Expiration | 90 天或 1 年（到期那天触发会静默失效，见下方「失效监测」） |
| Repository access | Only select repositories → 只勾 `FlowingTs/skills-daily` |
| Permissions → Repository → **Actions** | **Read and write** |

生成后只显示一次，立刻复制。

**第 2 步：建 job**

登录 https://cron-job.org → Create cronjob：

| 字段 | 填什么 |
|---|---|
| Title | `Skills Daily` |
| URL | `https://api.github.com/repos/FlowingTs/skills-daily/actions/workflows/daily.yml/dispatches` |
| Schedule | Every day at **08:00**，Time zone 选 **Asia/Shanghai** |
| 激活任务 | 保持开 |
| 在任务历史中保存响应 | **开**——出问题时能直接看到 204 / 401 / 404 的返回体 |

展开 **进阶（Advanced）**：

| 字段 | 填什么 |
|---|---|
| Request method | `POST` |
| Headers | `Accept: application/vnd.github+json` |
| | `Authorization: Bearer <刚复制的 token>` |
| | `Content-Type: application/json` |
| Request body | `{"ref":"main"}`（英文双引号，别用中文引号） |
| 请求超时 | 30 秒即可 |

保存后点 **Test run**。**返回 204 才是成功**（GitHub 的 dispatch 接口成功时是 204 No Content，不是 200；
博客里常写 200，那是错的）。同时去 Actions 页面确认多了一次 `workflow_dispatch` 运行。

**第 3 步：打开失败通知**

job 设置里启用失败邮件通知。cron-job.org 在连续失败 25 次后会**自动停用 job**，
token 过期、仓库改名都会触发这条路径——有邮件才能及时发现。

#### 注意

- cron-job.org 在 08:00 触发时，`daily.yml` 里残留的 `7 0` / `37 0` 也会尝试触发。
  **顺序无所谓**：先跑完的那次生成报告，后到的被幂等守卫跳过，不会重复推送（已实测验证）。
- `dispatch.mjs` 可用于手动补发，也是换调度器时的通用动作。

拿群机器人 webhook：企业微信群 → 右上角设置 → 群机器人 → 添加 → 复制 Webhook 地址。

---

## 调参

| 想改什么 | 改哪里 |
|---|---|
| 每档条数 | `config.perColumn`（默认 10） |
| star 门槛 | `groups[].minStars` 与 `groups[].minStarsByPeriod`（Skills 10；AIGC 日/周 50、月/总 100）|
| 潜力榜条数 / 窗口 | `potential.skills` / `potential.aigc` 的 `limit` / `windowSteps` / `minCount` |
| 领域顺序（默认哪个在前） | `config.groups` 数组顺序，第一个就是默认打开的领域 |
| 去重优先级 | `config.dedupeOrder`（默认 `all,month,week,day`，潜力榜永远排最后） |
| 推荐分权重 | `config.scoreWeights` |
| Skills 抓取范围 | `groups[skills].search.topics` / `lanes` |
| AIGC 抓取范围 | `groups[aigc].search.topics` / `lanes` |
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
