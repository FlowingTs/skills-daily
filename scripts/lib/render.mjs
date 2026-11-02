import { esc, fmtNum } from './util.mjs';

/* ────────────────────────────────────────────────────────────
   辅助
   ──────────────────────────────────────────────────────────── */

const fmtInt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');

function timeAgo(iso) {
  if (!iso) return '—';
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分钟前`;
  if (h < 24) return `${Math.round(h)} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.round(d / 30)} 个月前`;
}

/* ────────────────────────────────────────────────────────────
   条目
   ──────────────────────────────────────────────────────────── */

function renderEntry(item, index, root, faces) {
  const r = item.repo;
  const [owner, name] = r.full_name.split('/');
  const hasDelta = typeof item.delta === 'number';
  const fig = hasDelta ? `+${fmtInt(item.delta)}` : fmtNum(r.stargazers_count);

  const meta = [
    `${fmtNum(r.stargazers_count)} star`,
    `${fmtNum(r.forks_count)} fork`,
    r.language || null,
    `${timeAgo(r.pushed_at)}更新`,
    typeof item.score === 'number' ? `推荐度 ${item.score}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const note = item.summary || (r.description || '').slice(0, 150) || '仓库没有提供描述。';

  return `<li class="entry reveal" style="--i:${Math.min(index, 6)}"><a href="${esc(r.html_url)}" target="_blank" rel="noopener"><span class="face"><img src="${root}assets/faces/${esc(faces[owner] || `${owner}.png`)}" alt="" width="44" height="44" decoding="async" onerror="this.parentNode.classList.add('blank');this.remove()"></span><span class="entry-body"><span class="entry-name">${esc(owner)}<span class="sep">/</span>${esc(name)}</span><span class="entry-note">${esc(note)}</span><span class="entry-meta">${esc(meta)}</span></span><span class="entry-fig">${esc(fig)}</span></a></li>`;
}

function renderLeader(item, root, faces) {
  const r = item.repo;
  const [owner, name] = r.full_name.split('/');
  const hasDelta = typeof item.delta === 'number';
  const fig = hasDelta ? `+${fmtInt(item.delta)}` : fmtNum(r.stargazers_count);
  const note = item.summary || (r.description || '').slice(0, 170) || '仓库没有提供描述。';
  const meta = [
    `${fmtNum(r.stargazers_count)} star`,
    `${fmtNum(r.forks_count)} fork`,
    r.language || null,
    `${timeAgo(r.pushed_at)}更新`,
    typeof item.score === 'number' ? `推荐度 ${item.score}` : null,
  ].filter(Boolean).join(' · ');
  const face = faces[owner] || (owner + '.png');

  return `<div class="leader reveal"><a href="${esc(r.html_url)}" target="_blank" rel="noopener"><span class="leader-face"><img src="${root}assets/faces/${esc(face)}" alt="${esc(owner)} 的项目头像" width="168" height="168" decoding="async" onerror="this.parentNode.classList.add('blank');this.remove()"></span><span class="leader-body"><span class="leader-name">${esc(owner)}<span class="sep">/</span>${esc(name)}</span><span class="leader-note">${esc(note)}</span><span class="entry-meta">${esc(meta)}</span></span><span class="leader-fig">${esc(fig)}</span></a></div>`;
}

/** 潜力榜：双列紧凑行，右侧是速度而不是总量，和其他榜单刻意不同版式 */
function renderRise(item, index, root, faces) {
  const r = item.repo;
  const [owner, name] = r.full_name.split('/');
  const speed = Math.round(item.velocity ?? 0);
  const note = item.summary || (r.description || '').slice(0, 110) || '仓库没有提供描述。';
  const face = faces[owner] || (owner + '.png');
  const age = item.ageDays ?? null;

  return `<li class="rise reveal" style="--i:${Math.min(index, 4)}"><a href="${esc(r.html_url)}" target="_blank" rel="noopener"><span class="rise-face"><img src="${root}assets/faces/${esc(face)}" alt="" width="72" height="72" decoding="async" onerror="this.parentNode.classList.add('blank');this.remove()"></span><span class="rise-body"><span class="rise-name">${esc(owner)}<span class="sep">/</span>${esc(name)}</span><span class="rise-note">${esc(note)}</span><span class="rise-meta">${age ? `${age} 天前建` : ''}${age ? ' · ' : ''}${fmtNum(r.stargazers_count)} star · ${fmtNum(r.forks_count)} fork</span></span><span class="rise-fig"><span class="rise-num">+${fmtInt(speed)}</span><span class="rise-unit">每天</span></span></a></li>`;
}

/* ────────────────────────────────────────────────────────────
   说明文字
   ──────────────────────────────────────────────────────────── */

function columnNote(col, group) {
  const tail = col.excluded ? '已剔除同期 Skills 榜上出现过的仓库。' : '';

  if (col.metric === 'velocity') {
    const w = col.usedWindow ?? col.window;
    const lead = w > (col.window ?? 7)
      ? `近 ${w} 天新建的仓库，按每天拿到的 star 排。${col.window ?? 7} 天里凑不到 ${col.minCount ?? 3} 个，窗口自动外扩到了 ${w} 天。`
      : `近 ${w} 天新建的仓库，按每天拿到的 star 排。3 天涨 300，比 20 天涨 900 更说明问题。`;
    return lead + tail;
  }
  if (col.metric === 'delta' && col.status === 'live') {
    const span = col.window === 1 ? '昨天（00:00–24:00）' : `近 ${col.window} 天`;
    return `${span}的 star 净增，由前后两次快照相减得出。${tail}`;
  }
  if (col.status === 'coldstart') {
    const w = col.coldWindow ?? col.window;
    return `真净增要攒满 ${col.need} 天快照，${group.label} 现在只有 ${col.have} 天，这一栏暂时按「近 ${w} 天新建仓库的 star 总量」排。${tail}`;
  }
  if (col.status === 'collecting') {
    return '快照还在攒，这一栏今天空着。宁缺勿滥。';
  }
  return (col.note || '') + tail;
}

/* ────────────────────────────────────────────────────────────
   区块
   ──────────────────────────────────────────────────────────── */

function renderBoardPanel(group, col, root, faces, isOn = false) {
  const count = col.items.length;
  const lead = col.items[0];
  const rest = col.items.slice(1);
  const body = count
    ? `${renderLeader(lead, root, faces)}${rest.length ? `<ol class="ranking" start="2">${rest.map((it, i) => renderEntry(it, i + 1, root, faces)).join('')}</ol>` : ''}`
    : '<p class="col-empty">这一栏今天没有满足条件的仓库。空着，也不拿低质量项目补位。</p>';

  return `<div class="panel${isOn ? ' is-on' : ''}" data-panel="${esc(group.id)}-${esc(col.id)}" role="tabpanel" aria-label="${esc(group.label)} ${esc(col.label)}">
<div class="panel-head"><h2>${esc(col.label)}<span class="badge">${esc(col.badge)}</span></h2><span class="col-count">${count} 条</span></div>
<p class="col-note reveal">${esc(columnNote(col, group))}</p>
${body}
</div>`;
}

/** 潜力榜第一名：单独一层，头像放大。其余仍是紧凑双列 */
function renderRiseTop(item, root, faces) {
  const r = item.repo;
  const [owner, name] = r.full_name.split('/');
  const speed = Math.round(item.velocity ?? 0);
  const note = item.summary || (r.description || '').slice(0, 170) || '仓库没有提供描述。';
  const face = faces[owner] || (owner + '.png');
  const age = item.ageDays ?? null;
  const meta = [
    age ? `${age} 天前建` : null,
    `${fmtNum(r.stargazers_count)} star`,
    `${fmtNum(r.forks_count)} fork`,
    typeof item.score === 'number' ? `推荐度 ${item.score}` : null,
  ].filter(Boolean).join(' · ');

  return `<div class="rise-top reveal"><a href="${esc(r.html_url)}" target="_blank" rel="noopener"><span class="rise-top-face"><img src="${root}assets/faces/${esc(face)}" alt="${esc(owner)} 的项目头像" width="168" height="168" decoding="async" onerror="this.parentNode.classList.add('blank');this.remove()"></span><span class="rise-top-body"><span class="rise-name">${esc(owner)}<span class="sep">/</span>${esc(name)}</span><span class="rise-note">${esc(note)}</span><span class="entry-meta">${esc(meta)}</span></span><span class="rise-fig"><span class="rise-num">+${fmtInt(speed)}</span><span class="rise-unit">每天</span></span></a></div>`;
}

function renderRisePanel(group, pot, root, faces, isOn = false) {
  const count = pot.items.length;
  const [first, ...rest] = pot.items;
  const body = count
    ? `${renderRiseTop(first, root, faces)}${rest.length ? `<ol class="rising">${rest.map((it, i) => renderRise(it, i, root, faces)).join('')}</ol>` : ''}`
    : '<p class="col-empty">这一栏今天没有满足条件的仓库。空着，也不拿低质量项目补位。</p>';

  return `<div class="panel${isOn ? ' is-on' : ''}" data-rise-panel="${esc(group.id)}" role="tabpanel" aria-label="${esc(group.label)} 潜力榜">
<div class="panel-head"><h2>${esc(pot.label)}<span class="badge">${esc(pot.badge)}</span></h2><span class="col-count">${count} 个</span></div>
<p class="col-note reveal">${esc(columnNote(pot, group))}</p>
${body}
</div>`;
}

function renderStats({ groups, snapshotDays }) {
  const total = groups.reduce(
    (s, g) => s + g.columns.reduce((a, c) => a + c.items.length, 0) + g.potential.items.length,
    0,
  );
  // 同一档在两个领域都没攒够时，合成一句「月热门（Skills、AIGC）」，别写成「Skills 月热门、AIGC 月热门」
  const wetMap = new Map();
  for (const g of groups) {
    for (const c of g.columns) {
      if (c.status !== 'coldstart' && c.status !== 'collecting') continue;
      if (!wetMap.has(c.label)) wetMap.set(c.label, []);
      wetMap.get(c.label).push(g.label);
    }
  }
  const wet = [...wetMap].map(([label, gs]) => `${label}（${gs.join('、')}）`);
  const totalPool = groups.reduce((n, g) => n + g.poolSize, 0);

  const sentence = `两个池子共 ${fmtInt(totalPool)} 个仓库，${total} 个上榜。`;

  const wetNote = wet.length
    ? `${wet.join('、')}还没攒够快照，暂时按窗口内新建仓库的 star 排，不是净增。`
    : `日、周两档是真实净增，由 ${snapshotDays} 天的快照相减得出。`;

  const note = `${wetNote}每档最多 10 条，Skills 门槛 10 star，AIGC 日/周 50 star、月/总 100 star。潜力榜最多 5 条，窗口从 7 天起自动外扩。AIGC 榜已剔除同期 Skills 榜上出现过的仓库。每天北京时间 08:00 自动更新。`;

  return `<section class="method" id="method"><p class="statement reveal">${esc(sentence)}</p><p class="method-note reveal">${esc(note)}</p></section>`;
}

function renderFooter({ archive, root, date, generatedAt }) {
  const links = (archive || [])
    .slice(0, 12)
    .map((d) => `<a href="${root}archive/${d}.html">${d.replace(/-/g, '.')}</a>`)
    .join('');

  const prev = (archive || []).find((d) => d < date);
  const prevHref = prev ? `${root}archive/${prev}.html` : `${root}index.html`;
  const prevLabel = prev ? `${Number(prev.slice(5, 7))} 月 ${Number(prev.slice(8, 10))} 日` : '今天这期';

  return `<footer class="close" id="archive"><div class="close-top"><div class="invite"><p class="invite-line reveal">往期都<br>留在这儿</p><a class="btn btn-solid reveal" href="${prevHref}">打开 ${esc(prevLabel)}</a></div><nav class="past reveal" aria-label="往期日报">${links || '<span class="past-empty">还没有往期</span>'}</nav></div><p class="credit">数据来自 GitHub 公开接口 · 生成于 ${esc(generatedAt)}</p><div class="close-mark" aria-hidden="true">Skills Daily</div></footer>`;
}

/* ────────────────────────────────────────────────────────────
   页面
   ──────────────────────────────────────────────────────────── */

export function renderPage({
  date,
  groups,
  periods,
  archive,
  root = '',
  config,
  poolSize,
  snapshotDays = 0,
  cardPath = null,
  faces = {},
  heroItem = null,
  generatedAt,
}) {
  const primary = groups[0];
  const dayCol = primary.columns.find((c) => c.id === 'day');
  const heroItems = dayCol?.items?.length ? dayCol.items : (primary.columns[0]?.items ?? []);
  // 首屏用全站当日净增第一（不参与去重），日榜第一只是兜底
  const top = heroItem ?? heroItems[0];
  const hasDelta = Boolean(top) && typeof top.delta === 'number';

  const A = hasDelta ? '昨夜最亮的' : '榜首攒了';
  const B = top ? (hasDelta ? `涨了 ${fmtInt(top.delta)}` : `${fmtNum(top.repo.stargazers_count)} 颗`) : '—';

  const heroNote = top
    ? `每天八点，比对 GitHub 上两个池子共 ${fmtInt(poolSize)} 个仓库的 star 变化。下面这张卡片是${
        hasDelta ? `昨夜涨得最多的 ${top.repo.full_name}` : `今天排在第一的 ${top.repo.full_name}`
      }。`
    : '每天八点，比对 GitHub 上技能与 AIGC 仓库的 star 变化。';

  const card = cardPath && top
    ? `<figure class="hero-figure reveal" style="--i:3"><a href="${esc(top.repo.html_url)}" target="_blank" rel="noopener"><img class="hero-card" src="${root}${esc(cardPath)}" alt="${esc(top.repo.full_name)} 在 GitHub 上的仓库卡片，写着仓库简介和 star 数" width="1200" height="630" decoding="async"></a><figcaption>${esc(top.repo.full_name)}，${
        hasDelta ? `昨夜 +${fmtInt(top.delta)} 颗星` : `${fmtNum(top.repo.stargazers_count)} 颗星`
      }</figcaption></figure>`
    : '';

  const navLinks = [
    ...periods.map(
      (p) => `<a href="#board" data-period="${esc(p.id)}">${esc(p.navLabel)}</a>`,
    ),
    `<a href="#potential" data-jump="potential">潜力榜</a>`,
  ].join('');

  const groupTabs = groups
    .map(
      (g, i) => `<button type="button" class="seg-btn${i === 0 ? ' is-on' : ''}" role="tab" aria-selected="${i === 0 ? 'true' : 'false'}" data-group="${esc(g.id)}">${esc(g.label)}<em>${esc(g.desc)}</em></button>`,
    )
    .join('');

  const panels = groups
    .map((g, gi) => g.columns.map((c) => renderBoardPanel(g, c, root, faces, gi === 0 && c.id === 'day')).join(''))
    .join('');

  const riseTabs = groups
    .map(
      (g, i) => `<button type="button" class="seg-btn seg-btn-sm${i === 0 ? ' is-on' : ''}" role="tab" aria-selected="${i === 0 ? 'true' : 'false'}" data-rise="${esc(g.id)}">${esc(g.label)}</button>`,
    )
    .join('');

  const risePanels = groups.map((g, i) => renderRisePanel(g, g.potential, root, faces, i === 0)).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skills Daily · ${esc(date)}</title>
<meta name="description" content="每天从 GitHub 抓取 AI 技能与 AIGC 仓库，按 star 净增排出日、周、月、总四档榜单，外加两份只看新项目的潜力榜。">
<link rel="stylesheet" href="${root}assets/style.css">
</head>
<body>

<header class="masthead">
  <a class="wordmark" href="${root}index.html">Skills Daily</a>
  <nav class="nav" aria-label="跳到某一份榜单">${navLinks}</nav>
  <a class="btn btn-solid" href="#archive">往期日报</a>
</header>

<section class="hero">
  <h1 class="hero-line"><span class="half reveal">${esc(A)}</span><span class="half half-b reveal" style="--i:1">${esc(B)}</span></h1>
  <p class="hero-note reveal" style="--i:2">${esc(heroNote)}</p>
  ${card}
</section>

<section class="board" id="board">
  <div class="board-head">
    <div class="seg" role="tablist" aria-label="领域">${groupTabs}</div>
    <span class="board-date">${esc(date.replace(/-/g, '.'))}</span>
  </div>
  ${panels}
</section>

<section class="board board-rise" id="potential">
  <div class="board-head">
    <div class="seg" role="tablist" aria-label="领域">${riseTabs}</div>
    <span class="board-date">按每天拿到的 star 排</span>
  </div>
  ${risePanels}
</section>

${renderStats({ groups, snapshotDays })}

${renderFooter({ archive, root, date, generatedAt })}

<script>
(function () {
  var html = document.documentElement;
  html.className = (html.className || '').replace('no-js', 'js');

  var state = { group: ${JSON.stringify(primary.id)}, period: 'day' };

  var panels = Array.prototype.slice.call(document.querySelectorAll('[data-panel]'));
  var groupBtns = Array.prototype.slice.call(document.querySelectorAll('[data-group]'));
  var periodLinks = Array.prototype.slice.call(document.querySelectorAll('.nav a[data-period]'));
  var potLink = document.querySelector('.nav a[data-jump="potential"]');
  var riseBtns = Array.prototype.slice.call(document.querySelectorAll('[data-rise]'));
  var risePanels = Array.prototype.slice.call(document.querySelectorAll('[data-rise-panel]'));

  function paint() {
    panels.forEach(function (p) {
      p.classList.toggle('is-on', p.getAttribute('data-panel') === state.group + '-' + state.period);
    });
    groupBtns.forEach(function (b) {
      var on = b.getAttribute('data-group') === state.group;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    periodLinks.forEach(function (a) {
      a.classList.toggle('is-on', activeSection === 'board' && a.getAttribute('data-period') === state.period);
    });
    if (potLink) potLink.classList.toggle('is-on', activeSection === 'potential');
  }

  var activeSection = 'board';

  groupBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      state.group = b.getAttribute('data-group');
      paint();
    });
  });

  periodLinks.forEach(function (a) {
    a.addEventListener('click', function (e) {
      state.period = a.getAttribute('data-period');
      activeSection = 'board';
      paint();
      // 让粘顶栏不盖住板块标题
      e.preventDefault();
      document.getElementById('board').scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', '#board');
    });
  });

  // 潜力榜：两个领域各自独立切换
  var riseState = ${JSON.stringify(primary.id)};
  function paintRise() {
    risePanels.forEach(function (p) {
      p.classList.toggle('is-on', p.getAttribute('data-rise-panel') === riseState);
    });
    riseBtns.forEach(function (b) {
      var on = b.getAttribute('data-rise') === riseState;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  riseBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      riseState = b.getAttribute('data-rise');
      paintRise();
    });
  });

  if (!('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(document.querySelectorAll('.reveal'), function (el) {
      el.classList.add('in');
    });
    paint();
    paintRise();
    return;
  }

  // 入场：只做位移和缩放，不做透明——观察器没触发时内容也必须可见
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });

  function observeReveals() {
    Array.prototype.forEach.call(document.querySelectorAll('.reveal:not(.in)'), function (el) {
      io.observe(el);
    });
  }
  observeReveals();

  // 面板切换后，新露出来的条目也要有入场
  var mo = new MutationObserver(function () { observeReveals(); });
  panels.forEach(function (p) { mo.observe(p, { attributes: true, attributeFilter: ['class'] }); });
  risePanels.forEach(function (p) { mo.observe(p, { attributes: true, attributeFilter: ['class'] }); });

  // 滚到哪一段，导航就亮哪一条
  var board = document.getElementById('board');
  var pot = document.getElementById('potential');
  var secIO = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      activeSection = en.target.id === 'potential' ? 'potential' : 'board';
      paint();
    });
  }, { rootMargin: '-45% 0px -45% 0px' });
  if (board) secIO.observe(board);
  if (pot) secIO.observe(pot);

  // 顶栏：离开首屏后换一层底色（是色阶，不是阴影）
  var head = document.querySelector('.masthead');
  var onScroll = function () {
    head.classList.toggle('is-stuck', window.scrollY > 24);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  paint();
  paintRise();
})();
</script>
</body>
</html>`;
}
