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
   区块
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

function columnNote(column) {
  if (column.metric === 'delta' && column.status === 'live') {
    return `近 ${column.window} 天的 star 净增，由前后两次快照相减得出。`;
  }
  if (column.status === 'coldstart') {
    return `真净增要攒满 ${column.need} 天快照，现在只有 ${column.have} 天，这一栏暂时按「${column.window} 天内新建仓库的 star 总量」排。`;
  }
  if (column.status === 'collecting') {
    return '快照还在攒，这一栏今天空着。宁缺勿滥。';
  }
  return column.note || '';
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

function renderList(column, root, faces) {
  const count = column.items.length;
  const lead = column.items[0];
  const rest = column.items.slice(1);
  const body = count
    ? `${renderLeader(lead, root, faces)}${rest.length ? `<ol class="ranking" start="2">${rest.map((it, i) => renderEntry(it, i + 1, root, faces)).join('')}</ol>` : ''}`
    : '<p class="col-empty">这一栏今天没有满足条件的仓库。空着，也不拿低质量项目补位。</p>';

  return `<section class="col" id="${esc(column.id)}"><div class="col-head"><h2>${esc(column.label)}</h2><span class="col-count">${count} 条</span></div><p class="col-note reveal">${esc(columnNote(column))}</p>${body}</section>`;
}

function renderStats({ columns, poolSize, snapshotDays }) {
  const total = columns.reduce((s, c) => s + c.items.length, 0);
  const allLive = columns.every((c) => c.status === 'live');

  const sentence = allLive
    ? `扫出 ${fmtInt(poolSize)} 个仓库，${total} 个上榜。四份榜单都是真净增，来自 ${snapshotDays} 天的快照相减。`
    : `扫出 ${fmtInt(poolSize)} 个仓库，${total} 个上榜。快照只攒了 ${snapshotDays} 天，月榜和周榜仍是预热口径：按窗口内新建仓库的 star 排，不是净增。`;

  return `<section class="method" id="method"><p class="statement reveal">${esc(sentence)}</p><p class="method-note reveal">每份榜单最多 10 条，star 不到 10 的仓库不进候选池。每天北京时间 08:07 自动更新。</p></section>`;
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

export function renderPage({ date, columns, archive, root = '', config, poolSize, snapshotDays = 0, cardPath = null, faces = {}, generatedAt }) {
  const dayCol = columns.find((c) => c.id === 'day');
  const heroItems = dayCol?.items?.length ? dayCol.items : (columns[0]?.items ?? []);
  const top = heroItems[0];
  const hasDelta = Boolean(top) && typeof top.delta === 'number';

  const A = hasDelta ? '昨夜最亮的' : '榜首攒了';
  const B = top ? (hasDelta ? `涨了 ${fmtInt(top.delta)}` : `${fmtNum(top.repo.stargazers_count)} 颗`) : '—';

  const heroNote = top
    ? `每天八点，比对 GitHub 上 ${fmtInt(poolSize)} 个 AI 技能仓库的 star 变化。下面这张卡片是${
        hasDelta ? `昨夜涨得最多的 ${top.repo.full_name}` : `今天排在第一的 ${top.repo.full_name}`
      }。`
    : '每天八点，比对 GitHub 上 AI 技能仓库的 star 变化。';

  const card = cardPath && top
    ? `<figure class="hero-figure reveal" style="--i:3"><a href="${esc(top.repo.html_url)}" target="_blank" rel="noopener"><img class="hero-card" src="${root}${esc(cardPath)}" alt="${esc(top.repo.full_name)} 在 GitHub 上的仓库卡片，写着仓库简介和 star 数" width="1200" height="630" decoding="async"></a><figcaption>${esc(top.repo.full_name)}，${
        hasDelta ? `昨夜 +${fmtInt(top.delta)} 颗星` : `${fmtNum(top.repo.stargazers_count)} 颗星`
      }</figcaption></figure>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skills Daily · ${esc(date)}</title>
<meta name="description" content="每天从 GitHub 抓取 AI 技能仓库，按 star 净增排出总热门、月热门、周热门、单日热门四份榜单。">
<link rel="stylesheet" href="${root}assets/style.css">
</head>
<body>

<header class="masthead">
  <a class="wordmark" href="${root}index.html">Skills Daily</a>
  <div class="masthead-end">
    <nav class="nav" aria-label="榜单">
      <a href="#all">总热门</a>
      <a href="#month">月热门</a>
      <a href="#week">周热门</a>
      <a href="#day">单日热门</a>
    </nav>
    <a class="btn btn-solid" href="#archive">往期日报</a>
  </div>
</header>

<section class="hero">
  <h1 class="hero-line"><span class="half reveal">${esc(A)}</span><span class="half half-b reveal" style="--i:1">${esc(B)}</span></h1>
  <p class="hero-note reveal" style="--i:2">${esc(heroNote)}</p>
  ${card}
</section>

${columns.map((c) => renderList(c, root, faces)).join('')}

${renderStats({ columns, poolSize, snapshotDays })}

${renderFooter({ archive, root, date, generatedAt })}

<script>
(function () {
  var html = document.documentElement;
  html.className = (html.className || '').replace('no-js', 'js');

  var items = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(items, function (el) { el.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
  Array.prototype.forEach.call(items, function (el) { io.observe(el); });
})();
</script>
</body>
</html>`;
}
