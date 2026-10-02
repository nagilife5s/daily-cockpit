/**
 * daily-cockpit — Cloudflare Worker（サーバー側。gas/Code.gs からの移植 2026-09-29）
 *
 * 役割: Notion REST API との中継。トークンはここ（Worker の Secret）にだけ置き、
 *       画面（GitHub Pages）には一切渡さない。
 *
 * 呼び方: POST /api/<関数名>  body: {"args": [...]}  ヘッダー X-Cockpit-Key: <合言葉>
 *         → 200 {"result": ...} | 4xx/5xx {"error": "..."}
 *
 * ★Secret / 変数（wrangler secret put / wrangler.toml の [vars]）:
 *     NOTION_TOKEN   … Notion 内部インテグレーションのトークン（必須・Secret）
 *     COCKPIT_KEY    … 合言葉（必須・Secret）
 *     KOKOROE        … 「心得」バナーの筆文字（任意）
 *     ALLOWED_ORIGIN … 画面の置き場所（例 https://xxx.github.io）。カンマ区切りで複数可
 *
 * ★GAS 版との違い
 *   ・全部 async（UrlFetchApp → fetch）
 *   ・CacheService → isolate 内のメモリキャッシュ（消えても取り直すだけなので害はない）
 *   ・Utilities.formatDate → +9h して UTC ゲッターで読む（JST は夏時間なし）
 *   ・apiMode_ / bodyBudget_ は同時実行で混ざらないよう、リクエストごとの closure に閉じ込めた
 *   ・getWeek の読み取りは並列化（GAS では直列だった）
 */

/* ==========================================================================
   設定
   ========================================================================== */
const NOTION_DS = {
  nagi:    { ds: '2fff65e9-08f1-47f5-9a95-fe1ecaceef4c', db: '42ab1f2b-4da2-461b-8715-c3488ab3238e' }, /* ナギレンダー */
  task:    { ds: '7c381178-e506-4a1c-92d9-5c1c00eb90ac', db: '1acf8b3f-ee98-432a-94ac-e6ae995ca054' }, /* DB_TASK */
  journal: { ds: 'ccb037b8-598c-44e0-8bcd-e8d4861f671d', db: '7ec62929-9b34-4c6a-bbc9-1aa99ac37ef4' }, /* Daily Journaling all */
  project: { ds: '99a09b07-4c76-40ad-979e-afc575f48e5d', db: 'fd510c02-94e0-4a6d-bd0a-aadb8ebc97d6' }, /* DB_PROJECT */
  docs:    { ds: '0068f743-83db-4ad5-8053-03471d41f74d', db: 'b7ce3056-a78e-4fe1-a86e-47f0dcb44580' }, /* 書類DB */
  links:   { ds: 'e119857b-6daf-42e5-b9b9-4fb48cf37544', db: 'de46b30d-ba46-422b-b78e-fb1aa27a6623' }, /* クイックリンク */
  schoolwide: { ds: 'f1ce0ada-3655-40ea-94df-6a3ef1c769bb', db: 'ea362d48-3d91-43b4-a4c4-ea19d70cd592' }, /* 校内コマDB */
  sciunit: { ds: 'ec95f0af-f9db-4c18-a16d-fa278b567ed5', db: '5bc1c070-bf59-4e8a-8526-522e9372df8d' }  /* R8 理科単元計画 */
};

/* 標準時刻。実施予定日の時刻がこの6値に一致したときだけ「校時割り当て」とみなす */
const PERIOD_START_STD = ['8:35', '9:35', '10:35', '11:35', '13:30', '14:30'];

const LESSON_REL_PROPS = [
  { prop: '書類DB',       kind: '書類' },
  { prop: 'PROJECT',      kind: 'プロジェクト' },
  { prop: 'TASK',         kind: 'タスク' },
  { prop: '理科単元計画', kind: '単元計画' },
  { prop: '道徳',         kind: '道徳' }
];
const SCHOOL_REL_PROPS = [
  { prop: '書類DB',       kind: '書類' },
  { prop: 'PROJECT',      kind: 'PJ' },
  { prop: 'スケジュール', kind: '自分' }
];
/* Daily Journaling all の改名吸収（読みは新旧どちらでも拾う。書きは実在する方へ） */
const JOURNAL_ALIASES = {
  gyouji:     ['学校行事',   '行事'],
  shucchou:   ['出張｜全員', '出張'],
  kyuka:      ['休暇｜全員', '休暇'],
  kyukaKanri: ['休暇管理｜my', '休暇管理'],
  renraku:    ['連絡事項',   '連絡'],
  shukkin:    ['出勤｜my',   '出勤']
};

const BODY_MAX_BLOCKS = 200;

/* 画面から呼んでよい関数（これ以外は 404） */
const PUBLIC_FNS = [
  'getWeek', 'getDay', 'getMonth', 'getSchoolWideTimetable', 'getScienceUnits', 'getScienceUnitDetail', 'getScienceLessons', 'setLessonSeqs', 'updateUnitPlan', 'getProjects', 'getProjectBody',
  'updateLesson', 'createLesson', 'deleteLesson',
  'getDocs', 'searchDocs', 'updateDoc',
  'updateTask', 'updateOrders', 'updateTasks', 'createTask', 'deleteTask',
  'updateJournalDay'
];

/* ==========================================================================
   メモリキャッシュ（CacheService の代わり。isolate が生きている間だけ）
   ========================================================================== */
const memCache = new Map();
function cacheGet(key) {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) { memCache.delete(key); return null; }
  return hit.v;
}
function cachePut(key, v, sec) {
  if (memCache.size > 2000) memCache.clear();
  memCache.set(key, { v, exp: Date.now() + sec * 1000 });
}

/* ==========================================================================
   HTTP 入口
   ========================================================================== */
export default {
  async fetch(request, env) {
    const cors = corsHeaders_(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/([A-Za-z]+)$/);
    if (request.method === 'GET' && url.pathname === '/') {
      return json_({ ok: true, app: 'daily-cockpit' }, 200, cors);
    }
    if (!m || request.method !== 'POST') return json_({ error: 'not found' }, 404, cors);

    if (!env.COCKPIT_KEY || !env.NOTION_TOKEN) {
      return json_({ error: 'Worker の設定が未完了です（NOTION_TOKEN / COCKPIT_KEY）' }, 500, cors);
    }
    let key = request.headers.get('X-Cockpit-Key') || '';
    try { key = decodeURIComponent(key); } catch (e) {}   /* 画面側は encodeURIComponent して送る（日本語の合言葉対策） */
    if (!safeEqual_(key, env.COCKPIT_KEY)) {
      return json_({ error: 'unauthorized', code: 'unauthorized' }, 401, cors);
    }

    const fn = m[1];
    if (PUBLIC_FNS.indexOf(fn) < 0) return json_({ error: 'unknown function: ' + fn }, 404, cors);

    let args = [];
    try {
      const body = await request.json();
      if (body && Array.isArray(body.args)) args = body.args;
    } catch (e) { /* 引数なし */ }

    try {
      const api = createApi(env);
      const result = await api[fn](...args);
      return json_({ result: result === undefined ? null : result }, 200, cors);
    } catch (e) {
      console.error('[' + fn + '] ' + String((e && e.message) || e));   /* wrangler tail で原因を追えるように */
      return json_({ error: String((e && e.message) || e).slice(0, 1000) }, 500, cors);
    }
  }
};

function corsHeaders_(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.indexOf(origin) >= 0 ||
             /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);   /* 手元での確認用 */
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Cockpit-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (ok) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json_(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {})
  });
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ==========================================================================
   純関数（日付・プロパティ getter・HTML 変換）
   ========================================================================== */
function addDays_(ymd, n) {
  const a = ymd.split('-');
  const d = new Date(Date.UTC(+a[0], +a[1] - 1, +a[2]) + n * 86400000);
  return d.getUTCFullYear() + '-' +
    ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' +
    ('0' + d.getUTCDate()).slice(-2);
}
function addMonths_(ym, n) {
  const a = ym.split('-');
  let m = (+a[1]) - 1 + n;
  const y = (+a[0]) + Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return y + '-' + ('0' + (m + 1)).slice(-2);
}
/* Notion の date.start → JST の {date:"YYYY-MM-DD", time:"H:mm"|null} */
function toJst_(iso) {
  if (!iso) return null;
  if (String(iso).length <= 10) return { date: String(iso), time: null };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const j = new Date(d.getTime() + 9 * 3600000);
  return {
    date: j.getUTCFullYear() + '-' + ('0' + (j.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + j.getUTCDate()).slice(-2),
    time: j.getUTCHours() + ':' + ('0' + j.getUTCMinutes()).slice(-2)
  };
}
function firstPeriod_(labels) {
  let first = null;
  (labels || []).forEach(l => {
    const i = ['1校時', '2校時', '3校時', '4校時', '5校時', '6校時'].indexOf(l);
    if (i >= 0 && (first === null || i < first)) first = i;
  });
  return first;
}
function hmToMin_(hm) { const a = String(hm).split(':'); return (+a[0]) * 60 + (+a[1]); }
function minToHm_(m) { m = Math.max(0, Math.min(23 * 60 + 59, m)); return Math.floor(m / 60) + ':' + ('0' + (m % 60)).slice(-2); }
function jstIso_(date, hm) {
  const a = String(hm).split(':');
  return date + 'T' + ('0' + a[0]).slice(-2) + ':' + ('0' + a[1]).slice(-2) + ':00+09:00';
}

/* 全角数字を半角へ。単元計画DBの学年は「１年」（全角）、ナギレンダーは「1年」（半角） */
function normGrade_(g) {
  return g ? String(g).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) : null;
}
function propFiles_(p) { return p && p.files ? p.files.map(f => f.name || '') .filter(Boolean) : []; }
function todayJst_() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }

function plain_(rt) { return (rt || []).map(x => x.plain_text || '').join(''); }
function propTitle_(p)    { return p && p.title ? plain_(p.title) : ''; }
function propText_(p)     { return p && p.rich_text ? plain_(p.rich_text) : ''; }
function propSelect_(p)   { return p && p.select ? p.select.name : null; }
function propStatus_(p)   { return p && p.status ? p.status.name : null; }
function propMulti_(p)    { return p && p.multi_select ? p.multi_select.map(o => o.name) : []; }
function propNumber_(p)   { return p && typeof p.number === 'number' ? p.number : null; }
function propDateRaw_(p)  { return p && p.date ? p.date.start : null; }
function propRelation_(p) { return p && p.relation ? p.relation.map(r => r.id) : []; }
function propCheckbox_(p) { return !!(p && p.checkbox === true); }

function propAny_(props, names) {
  for (const n of names) if (props && Object.prototype.hasOwnProperty.call(props, n)) return props[n];
  return null;
}
function propNameAny_(props, names) {
  for (const n of names) if (props && Object.prototype.hasOwnProperty.call(props, n)) return n;
  return names[0];
}
function noContent_(s) {
  const t = String(s == null ? '' : s).trim();
  return (t === 'No content' || t === 'no content') ? '' : String(s == null ? '' : s);
}

function assertId_(id) {
  if (!/^[0-9a-f-]{32,36}$/i.test(String(id))) throw new Error('ページIDが不正です: ' + id);
  return String(id);
}
function assertYmd_(v, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error(label + ' が不正です: ' + v);
}

function safeHref_(u) { return /^(https?:|mailto:)/i.test(String(u || '')); }
function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function rt2html_(arr) {
  return (arr || []).map(t => {
    let s = esc_(t.plain_text || '').replace(/\n/g, '<br>');
    const a = t.annotations || {};
    if (a.code)          s = '<code>' + s + '</code>';
    if (a.bold)          s = '<b>' + s + '</b>';
    if (a.italic)        s = '<i>' + s + '</i>';
    if (a.strikethrough) s = '<s>' + s + '</s>';
    if (a.underline)     s = '<u>' + s + '</u>';
    if (t.href && safeHref_(t.href)) s = '<a href="' + esc_(t.href) + '" target="_blank" rel="noopener">' + s + '</a>';
    return s;
  }).join('');
}

function relIds_(p) {
  const out = [];
  LESSON_REL_PROPS.forEach(r => propRelation_(p[r.prop]).forEach(id => out.push({ id, kind: r.kind })));
  return out;
}
function schoolRelIds_(p) {
  const out = [];
  SCHOOL_REL_PROPS.forEach(r => propRelation_(p[r.prop]).forEach(id => out.push({ id, kind: r.kind })));
  return out;
}
function collectRelIds_(rows) {
  const acc = [];
  rows.forEach(r => (r.relations || []).forEach(x => acc.push(x.id)));
  return acc;
}

function mapLesson_(pg) {
  const p = pg.properties || {};
  const d = toJst_(propDateRaw_(p['日付']));
  if (!d) return null;
  const e = (p['日付'] && p['日付'].date && p['日付'].date.end) ? toJst_(p['日付'].date.end) : null;
  const endTime = (d.time && e && e.time && e.date === d.date) ? e.time : null;
  return {
    id: pg.id,
    name: propTitle_(p['Name']),
    date: d.date,
    time: d.time,
    endTime,
    /* 複数日の予定の最終日（2026-09-29。月タブで期間中の毎日に出す）。1日だけなら null */
    endDate: (e && e.date > d.date) ? e.date : null,
    periodLabels: propMulti_(p['時限']),
    grade: propMulti_(p['学年'])[0] || null,
    place: propMulti_(p['場所']),
    summary: propText_(p['概要']),
    memo: propText_(p['詳細メモ']),
    feedback: propText_(p['フィードバック']),
    excluded: propCheckbox_(p['関係なし']),
    shubetsu: propSelect_(p['種別']),   /* 理科／道徳／学活／総合… 区分フィルタの教科判定に使う（2026-09-29） */
    relations: relIds_(p)
  };
}

function mapSchoolLesson_(pg) {
  const p = pg.properties || {};
  const raw = propDateRaw_(p['日付']);
  return {
    date: raw ? String(raw).slice(0, 10) : null,
    period: propSelect_(p['校時']),
    grade: propText_(p['学年・クラス']),
    subject: propText_(p['教科']),
    relations: schoolRelIds_(p)
  };
}

function mapTask_(pg) {
  const p = pg.properties || {};
  const d = toJst_(propDateRaw_(p['実施予定日']));
  let period = null;
  if (d && d.time) {
    const idx = PERIOD_START_STD.indexOf(d.time);
    if (idx >= 0) period = idx + 1;
  }
  const status = propStatus_(p['status']) || 'Not Started';
  let startedAt = null;
  if (status === 'In Progress') {
    const raw = propDateRaw_(p['セッション開始']);
    if (raw && String(raw).length > 10) {
      const ms = new Date(raw).getTime();
      if (!isNaN(ms)) startedAt = ms;
    }
  }
  const deadline = toJst_(propDateRaw_(p['期限']));
  return {
    id: pg.id,
    name: propTitle_(p['名前']),
    status,
    date: d ? d.date : null,
    period,
    deadline: deadline ? deadline.date : null,
    kind: propSelect_(p['タスク種別']),
    mikomi: propNumber_(p['だいたい見込み時間']),
    spentMin: propNumber_(p['累積実績(分)']) || 0,
    order: propNumber_(p['並び順']),
    startedAt,
    projectIds: propRelation_(p['PROJECT'])
  };
}

function mapDoc_(pg) {
  const p = pg.properties || {};
  const deadline = toJst_(propDateRaw_(p['〆切']));
  const jisshi = toJst_(propDateRaw_(p['実施日']));
  return {
    id: pg.id,
    url: pg.url || null,
    name: propTitle_(p['名前']),
    memo: propText_(p['メモ']),
    shinchoku: propText_(p['進捗状況']),
    deadline: deadline ? deadline.date : null,
    jisshi: jisshi ? jisshi.date : null,
    kinds: propMulti_(p['種類']),
    years: propMulti_(p['年度']),
    files: (p['添付'] && p['添付'].files || []).map(f => f.name || ''),
    hinshutsu: !!(p['頻出'] && p['頻出'].checkbox)
  };
}

function mapJournal_(pg) {
  const p = pg.properties || {};
  const club = p['部活時間'] && p['部活時間'].date ? p['部活時間'].date : null;
  const cs = club ? toJst_(club.start) : null;
  const ce = club && club.end ? toJst_(club.end) : null;
  return {
    nichoku:  noContent_(propText_(p['日直'])),
    renraku:  noContent_(propText_(propAny_(p, JOURNAL_ALIASES.renraku))),
    kyushoku: noContent_(propText_(p['給食'])),
    tsuin:    noContent_(propText_(p['通院予定'])),
    donnahi:  noContent_(propText_(p['今日はどんな日'])),
    cheerup:  noContent_(propText_(p['CheerUp'])),
    gyouji:     noContent_(propText_(propAny_(p, JOURNAL_ALIASES.gyouji))),
    shucchou:   noContent_(propText_(propAny_(p, JOURNAL_ALIASES.shucchou))),
    kyuka:      noContent_(propText_(propAny_(p, JOURNAL_ALIASES.kyuka))),
    kyukaKanri: noContent_(propText_(propAny_(p, JOURNAL_ALIASES.kyukaKanri))),
    gakki:      propSelect_(p['学期']),
    shukkin:    propMulti_(propAny_(p, JOURNAL_ALIASES.shukkin)),
    gtdfb:      noContent_(propText_(p['GTDフィードバック'])),
    setupDone:  propCheckbox_(p['セットアップ済']),
    closeDone:  propCheckbox_(p['クローズ済']),
    club:       propSelect_(p['部活従事']),
    clubStart:  cs && cs.time ? cs.time : null,
    clubEnd:    ce && ce.time ? ce.time : null
  };
}

/* existing = 現物の 日付（{start, end}）、existingPeriods = 現物の 時限（updateLesson のときだけ渡る） */
function lessonProps_(data, existing, existingPeriods) {
  const props = {};
  if ('name' in data) props['Name'] = { title: [{ text: { content: String(data.name || '').slice(0, 2000) } }] };
  if ('periods' in data) props['時限'] = { multi_select: (data.periods || []).map(l => ({ name: l })) };
  if ('date' in data) {
    const firstP = firstPeriod_(data.periods);
    const ex = existing && existing.start ? toJst_(existing.start) : null;
    /* 日も先頭校時も変わっていない（＝動かしていない）なら 日付 には一切触らない */
    const moved = !(ex && existingPeriods && ex.date === data.date && firstPeriod_(existingPeriods) === firstP);
    if ('time' in data) {
      const tObj = { start: data.time ? jstIso_(data.date, data.time) : data.date };
      if (data.time && data.endTime) tObj.end = jstIso_(data.date, data.endTime);
      props['日付'] = { date: tObj };
    } else if (moved) {
      let start = data.date;
      if (firstP !== null) start = jstIso_(data.date, PERIOD_START_STD[firstP]);
      else if (ex && ex.time) start = jstIso_(data.date, ex.time);
      const dateObj = { start };
      const exEnd = existing && existing.end ? toJst_(existing.end) : null;
      if (exEnd && exEnd.time && ex && ex.time && exEnd.date === ex.date) {
        if (start.length > 10) dateObj.end = jstIso_(data.date, minToHm_(hmToMin_(start.slice(11, 16)) + hmToMin_(exEnd.time) - hmToMin_(ex.time)));
      } else if (existing && existing.end && String(existing.end).slice(0, 10) >= data.date) {
        dateObj.end = existing.end;
      }
      props['日付'] = { date: dateObj };
    }
  }
  if ('grade' in data) props['学年'] = { multi_select: data.grade ? [{ name: data.grade }] : [] };
  if ('place' in data) props['場所'] = { multi_select: (data.place || []).map(p => ({ name: p })) };
  if ('summary' in data)  props['概要']           = { rich_text: data.summary  ? [{ text: { content: String(data.summary).slice(0, 2000) } }]  : [] };
  if ('memo' in data)     props['詳細メモ']       = { rich_text: data.memo     ? [{ text: { content: String(data.memo).slice(0, 2000) } }]     : [] };
  if ('feedback' in data) props['フィードバック'] = { rich_text: data.feedback ? [{ text: { content: String(data.feedback).slice(0, 2000) } }] : [] };
  if ('excluded' in data) props['関係なし']       = { checkbox: !!data.excluded };
  return props;
}

/* ==========================================================================
   API 本体（リクエストごとに作る。apiMode / bodyBudget を他リクエストと混ぜない）
   ========================================================================== */
function createApi(env) {
  let apiMode = null;      /* 'ds'（新: data_sources）| 'db'（旧: databases） */
  let bodyBudget = 0;

  /* 429/5xx は少し待って最大3回 */
  async function request_(url, method, payload, version) {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await fetch(url, {
        method: method.toUpperCase(),
        headers: {
          'Authorization': 'Bearer ' + env.NOTION_TOKEN,
          'Notion-Version': version,
          'Content-Type': 'application/json'
        },
        body: payload ? JSON.stringify(payload) : undefined
      });
      const code = resp.status;
      const text = await resp.text();
      let js = null;
      try { js = JSON.parse(text); } catch (e) {}
      last = { ok: code >= 200 && code < 300, code, text, json: js };
      if (code !== 429 && code < 500) return last;
      /* 作成(POST /v1/pages)は非冪等なので 5xx ではリトライしない（二重作成防止） */
      if (code >= 500 && method === 'post' && /\/v1\/pages$/.test(url)) return last;
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
    }
    return last;
  }

  function shouldFallback_(r) {
    if (r.code === 404) return true;
    const c = r.json && r.json.code;
    return r.code === 400 && (c === 'invalid_request_url' || c === 'object_not_found');
  }

  async function queryOnce_(dbKey, body) {
    const d = NOTION_DS[dbKey];
    const label = { nagi: 'ナギレンダー', task: 'DB_TASK', journal: 'Daily Journaling all', project: 'DB_PROJECT', docs: '書類DB', links: 'クイックリンク', schoolwide: '校内コマDB', sciunit: 'R8 理科単元計画' }[dbKey] || dbKey;
    const hint = '（404 なら Notion 側でこの DB にインテグレーションを接続し忘れている可能性が高い）';
    if (apiMode !== 'db') {
      const r = await request_('https://api.notion.com/v1/data_sources/' + d.ds + '/query', 'post', body, '2025-09-03');
      if (r.ok) { apiMode = 'ds'; return r.json; }
      if (apiMode === 'ds' || !shouldFallback_(r)) {
        throw new Error('Notion query 失敗 [' + label + '] (' + r.code + ') ' + hint + ': ' + String(r.text).slice(0, 300));
      }
    }
    const r2 = await request_('https://api.notion.com/v1/databases/' + d.db + '/query', 'post', body, '2022-06-28');
    if (r2.ok) { apiMode = 'db'; return r2.json; }
    throw new Error('Notion query 失敗 [' + label + '] (' + r2.code + ') ' + hint + ': ' + String(r2.text).slice(0, 300));
  }

  async function queryAll_(dbKey, body, limit) {
    let results = [];
    let cursor = null;
    do {
      const b = JSON.parse(JSON.stringify(body || {}));
      b.page_size = limit ? Math.min(100, limit) : 100;
      if (cursor) b.start_cursor = cursor;
      const res = await queryOnce_(dbKey, b);
      results = results.concat(res.results || []);
      cursor = res.has_more ? res.next_cursor : null;
      if (limit && results.length >= limit) break;
    } while (cursor);
    return limit ? results.slice(0, limit) : results;
  }

  function dateRange_(prop, lo, hi) {
    return { and: [
      { property: prop, date: { on_or_after: lo } },
      { property: prop, date: { on_or_before: hi } }
    ] };
  }

  async function fetchPageOf_(id, dbKey, label) {
    assertId_(id);
    const r = await request_('https://api.notion.com/v1/pages/' + id, 'get', null, '2022-06-28');
    if (!r.ok) throw new Error(label + 'の取得に失敗しました (' + r.code + ')');
    const pg = r.json || {};
    const parent = pg.parent || {};
    const pid = String(parent.database_id || parent.data_source_id || '').replace(/-/g, '');
    const d = NOTION_DS[dbKey];
    const okIds = [d.db, d.ds].map(x => x.replace(/-/g, ''));
    if (okIds.indexOf(pid) < 0) throw new Error(label + 'ではないページです（' + dbKey + ' 以外への書き込みを拒否）');
    return pg;
  }

  async function patchPage_(id, body, failLabel) {
    const r = await request_('https://api.notion.com/v1/pages/' + id, 'patch', body, '2022-06-28');
    if (!r.ok) throw new Error(failLabel + ' (' + r.code + '): ' + String(r.text).slice(0, 300));
    return r;
  }

  async function quickLinks_() {
    try {
      const rows = await queryAll_('links', {
        filter: { property: '非表示', checkbox: { equals: false } },
        sorts: [{ property: '並び順', direction: 'ascending' }]
      });
      const items = rows.map(pg => {
        const p = pg.properties || {};
        const url = p['URL'] && p['URL'].url ? String(p['URL'].url) : '';
        return {
          id: pg.id,
          name: propTitle_(p['名前']).slice(0, 100),
          url: /^(https?:|mailto:)/i.test(url) ? url : null,
          kind: propSelect_(p['区分']),
          memo: propText_(p['メモ']).slice(0, 200),
          order: propNumber_(p['並び順'])
        };
      }).filter(l => l.url);
      return { items };
    } catch (e) {
      return { items: [], error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  async function projectNames_() {
    const hit = cacheGet('projectNames');
    if (hit) return hit;
    const map = {};
    (await queryAll_('project', {})).forEach(pg => { map[pg.id] = propTitle_((pg.properties || {})['名前']); });
    cachePut('projectNames', map, 600);
    return map;
  }

  /* リレーション先のページ名と URL を {id: {title, url}} で返す。10分キャッシュ・実引きは30件まで */
  async function relationTitles_(ids) {
    const map = {}, miss = [];
    ids.forEach(id => {
      if (map[id]) return;
      const hit = cacheGet('reltitle_' + id);
      if (hit) { map[id] = hit; return; }
      if (miss.indexOf(id) < 0) miss.push(id);
    });
    await Promise.all(miss.slice(0, 30).map(async id => {
      let r;
      try { r = await request_('https://api.notion.com/v1/pages/' + id, 'get', null, '2022-06-28'); }
      catch (e) { return; }
      if (!r.ok || !r.json) return;
      const props = r.json.properties || {};
      let title = '';
      Object.keys(props).some(k => {
        if (props[k] && props[k].type === 'title') { title = propTitle_(props[k]); return true; }
        return false;
      });
      const v = { title: title || '無題', url: r.json.url || null };
      map[id] = v;
      cachePut('reltitle_' + id, v, 600);
    }));
    return map;
  }

  async function listChildren_(blockId) {
    let results = [];
    let cursor = null;
    do {
      const url = 'https://api.notion.com/v1/blocks/' + blockId + '/children?page_size=100' +
                  (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '');
      const r = await request_(url, 'get', null, '2022-06-28');
      if (!r.ok) throw new Error('本文の取得に失敗しました (' + r.code + ')');
      results = results.concat(r.json.results || []);
      cursor = r.json.has_more ? r.json.next_cursor : null;
    } while (cursor);
    return results;
  }

  async function renderBlocks_(id, depth) {
    if (depth > 3 || bodyBudget <= 0) return '';
    let html = '';
    let listBuf = '';
    let listType = null;
    const flush = () => {
      if (listBuf) html += '<' + listType + '>' + listBuf + '</' + listType + '>';
      listBuf = ''; listType = null;
    };
    const blocks = await listChildren_(id);
    for (const b of blocks) {
      if (bodyBudget-- <= 0) break;
      const t = b.type;
      if (t === 'bulleted_list_item' || t === 'numbered_list_item') {
        const lt = t === 'bulleted_list_item' ? 'ul' : 'ol';
        if (listType !== lt) flush();
        listType = lt;
        listBuf += '<li>' + rt2html_(b[t].rich_text) +
                   (b.has_children ? await renderBlocks_(b.id, depth + 1) : '') + '</li>';
      } else {
        flush();
        html += await renderBlock_(b, depth);
      }
    }
    flush();
    return html;
  }

  async function renderBlock_(b, depth) {
    const t = b.type;
    const d = b[t] || {};
    const kids = async () => (b.has_children ? renderBlocks_(b.id, depth + 1) : '');
    switch (t) {
      case 'paragraph':  return '<p>' + rt2html_(d.rich_text) + '</p>' + await kids();
      case 'heading_1':  return '<h4>' + rt2html_(d.rich_text) + '</h4>' + await kids();
      case 'heading_2':  return '<h5>' + rt2html_(d.rich_text) + '</h5>' + await kids();
      case 'heading_3':  return '<h6>' + rt2html_(d.rich_text) + '</h6>' + await kids();
      case 'to_do':      return '<div class="todo">' + (d.checked ? '☑' : '☐') + ' ' +
                                (d.checked ? '<s>' + rt2html_(d.rich_text) + '</s>' : rt2html_(d.rich_text)) +
                                '</div>' + await kids();
      case 'toggle':     return '<details><summary>' + rt2html_(d.rich_text) + '</summary>' + await kids() + '</details>';
      case 'callout':    return '<div class="co">' + (d.icon && d.icon.emoji ? esc_(d.icon.emoji) + ' ' : '') +
                                rt2html_(d.rich_text) + await kids() + '</div>';
      case 'quote':      return '<blockquote>' + rt2html_(d.rich_text) + await kids() + '</blockquote>';
      case 'divider':    return '<hr>';
      case 'code':       return '<pre>' + rt2html_(d.rich_text) + '</pre>';
      case 'table': {
        const rows = await listChildren_(b.id);
        bodyBudget -= rows.length;
        return '<table>' + rows.map(r => {
          const cells = (r.table_row && r.table_row.cells) || [];
          return '<tr>' + cells.map(c => '<td>' + rt2html_(c) + '</td>').join('') + '</tr>';
        }).join('') + '</table>';
      }
      case 'child_page': {
        const pid = String(b.id).replace(/-/g, '');
        return '<p><a href="https://www.notion.so/' + pid + '" target="_blank" rel="noopener">📄 ' +
               esc_(d.title || '無題') + '</a></p>';
      }
      case 'child_database': return '<p class="ph">（データベース: ' + esc_(d.title || '') + '）</p>';
      case 'image':          return '<p class="ph">（画像）</p>';
      case 'file':           return '<p class="ph">（ファイル）</p>';
      case 'pdf':            return '<p class="ph">（PDF）</p>';
      case 'bookmark':       return d.url && safeHref_(d.url) ? '<p><a href="' + esc_(d.url) + '" target="_blank" rel="noopener">🔗 ' + esc_(d.url) + '</a></p>' : '';
      case 'embed':          return '<p class="ph">（埋め込み）</p>';
      default:               return await kids();   /* column_list / column / synced_block / 未知 */
    }
  }

  async function journalPageId_(date) {
    let found = null;
    (await queryAll_('journal', { filter: dateRange_('日付', addDays_(date, -1), addDays_(date, 1)) })).forEach(pg => {
      const d = toJst_(propDateRaw_((pg.properties || {})['日付']));
      if (d && d.date === date) found = pg.id;
    });
    return found;
  }

  /* 新エンドポイント判定を先に1回済ませる（並列クエリが全部フォールバックを踏まないように） */
  async function warmApiMode_() {
    if (apiMode) return;
    await queryAll_('links', { filter: { property: '非表示', checkbox: { equals: true } } }, 1).catch(() => {});
  }

  /* ------------------------------------------------------------------------
     公開関数
     ------------------------------------------------------------------------ */
  const api = {
    async getWeek(weekStart) {
      assertYmd_(weekStart, 'weekStart');
      const days = [];
      for (let i = 0; i < 5; i++) days.push(addDays_(weekStart, i));
      const weekend     = [addDays_(weekStart, 5), addDays_(weekStart, 6)];
      const prevWeekend = [addDays_(weekStart, -2), addDays_(weekStart, -1)];
      const shown = prevWeekend.concat(days, weekend);
      const lo = addDays_(weekStart, -3);
      const hi = addDays_(weekStart, 7);

      await warmApiMode_();
      const [schedRows, taskRows, journalRows, projectNames, links] = await Promise.all([
        queryAll_('nagi', { filter: dateRange_('日付', lo, hi), sorts: [{ property: '日付', direction: 'ascending' }] }),
        queryAll_('task', { filter: { or: [
          { property: 'status', status: { does_not_equal: 'Done' } },
          dateRange_('実施予定日', lo, hi)
        ] } }),
        queryAll_('journal', { filter: dateRange_('日付', lo, hi) }),
        projectNames_(),
        quickLinks_()
      ]);

      const schedule = schedRows.map(mapLesson_).filter(r => r && shown.indexOf(r.date) >= 0);
      const allTasks = taskRows.map(mapTask_);
      const journal = {};
      journalRows.forEach(pg => {
        const d = toJst_(propDateRaw_((pg.properties || {})['日付']));
        if (!d || shown.indexOf(d.date) < 0) return;
        journal[d.date] = mapJournal_(pg);
      });
      const weekTasks = allTasks
        .filter(t => t.date && days.indexOf(t.date) >= 0 && t.period)
        .map(t => ({ id: t.id, name: t.name, date: t.date, period: t.period, status: t.status }));

      return {
        weekStart, days, schedule,
        tasks: weekTasks,
        journal,
        kokoroe: env.KOKOROE || '',
        allTasks,
        projectNames,
        relationTitles: await relationTitles_(collectRelIds_(schedule)),
        weekend, prevWeekend,
        links
      };
    },

    async getDay(date) {
      assertYmd_(date, 'date');
      const lo = addDays_(date, -1), hi = addDays_(date, 1);
      await warmApiMode_();
      const [schedRows, journalRows] = await Promise.all([
        queryAll_('nagi', { filter: dateRange_('日付', lo, hi), sorts: [{ property: '日付', direction: 'ascending' }] }),
        queryAll_('journal', { filter: dateRange_('日付', lo, hi) })
      ]);
      const schedule = schedRows.map(mapLesson_).filter(r => r && r.date === date);
      let journal = null;
      journalRows.forEach(pg => {
        const d = toJst_(propDateRaw_((pg.properties || {})['日付']));
        if (d && d.date === date) journal = mapJournal_(pg);
      });
      return { date, schedule, journal, relationTitles: await relationTitles_(collectRelIds_(schedule)) };
    },

    async getMonth(ym) {
      if (!/^\d{4}-\d{2}$/.test(String(ym))) throw new Error('ym が不正です: ' + ym);
      const lo = addDays_(ym + '-01', -1);
      const hi = addMonths_(ym, 1) + '-01';
      const events = (await queryAll_('nagi', { filter: dateRange_('日付', lo, hi), sorts: [{ property: '日付', direction: 'ascending' }] }))
        .map(mapLesson_).filter(r => r && r.date.slice(0, 7) === ym);
      return { ym, events };
    },

    async getSchoolWideTimetable(weekStart) {
      assertYmd_(weekStart, 'weekStart');
      const items = (await queryAll_('schoolwide', {
        filter: dateRange_('日付', weekStart, addDays_(weekStart, 4)),
        sorts: [{ property: '日付', direction: 'ascending' }]
      })).map(mapSchoolLesson_).filter(r => r && r.date);
      return { weekStart, items, relationTitles: await relationTitles_(collectRelIds_(items)) };
    },

    /* 理科タブ（閲覧のみ）。単元計画DBの全行＋ナギレンダーの紐づき（実施日）＋「次の理科授業」 */
    async getScienceUnits() {
      await warmApiMode_();
      const today = todayJst_();
      const fyStart = (+today.slice(5, 7) >= 4 ? today.slice(0, 4) : String(+today.slice(0, 4) - 1)) + '-04-01';
      const [unitRows, lessonRows, nextRows] = await Promise.all([
        queryAll_('sciunit', {}),
        /* 単元計画DBは年度をまたいで使われ、過去年度のコマも紐づいている（2026-10-02 実データで確認）。今年度（4/1〜）に限る */
        queryAll_('nagi', { filter: { and: [
          { property: '理科単元計画', relation: { is_not_empty: true } },
          { property: '日付', date: { on_or_after: fyStart } }
        ] } }),
        queryAll_('nagi', { filter: { and: [
          { property: '種別', select: { equals: '理科' } },
          { property: '日付', date: { on_or_after: today } }
        ] }, sorts: [{ property: '日付', direction: 'ascending' }] }, 1).catch(() => [])
      ]);

      const lessonsByUnit = {};
      const linked = [];
      lessonRows.map(mapLesson_).filter(Boolean).forEach(l => {
        l.relations.filter(r => r.kind === '単元計画').forEach(r => {
          const k = r.id.replace(/-/g, '');
          (lessonsByUnit[k] = lessonsByUnit[k] || []).push({ id: l.id, date: l.date, time: l.time, periodLabels: l.periodLabels });
          linked.push({ date: l.date, unitId: r.id });
        });
      });

      const units = unitRows.map(pg => {
        const p = pg.properties || {};
        const lessons = (lessonsByUnit[pg.id.replace(/-/g, '')] || []).sort((a, b) => a.date < b.date ? -1 : 1);
        return {
          id: pg.id,
          url: pg.url || null,
          name: propTitle_(p['授業名']),
          grade: normGrade_(propSelect_(p['学年'])),
          unitNo: propSelect_(p['単元No']),
          unitName: propSelect_(p['単元名']) || '(単元名なし)',
          hour: propNumber_(p['時数']),
          area: propSelect_(p['領域']),
          view: propSelect_(p['見方']),
          goal: noContent_(propText_(p['目標'])),
          flow: noContent_(propText_(p['流れ'])),
          tools: noContent_(propText_(p['道具'])),
          forms: propMulti_(p['授業形態']),
          status: propStatus_(p['status']) || 'not',
          feedback: propText_(p['フィードバック']),
          driveUrl: p[' Google Drive'] && safeHref_(p[' Google Drive'].url) ? p[' Google Drive'].url : null,
          counts: {
            kahoot: propRelation_(p['kahoot']).length,
            recipe: propRelation_(p['実験レシピ']).length,
            artifact: propRelation_(p['理科アーティファクト']).length,
            worksheet: propFiles_(p['ワークシート']).length
          },
          lessons
        };
      });

      linked.sort((a, b) => a.date < b.date ? -1 : 1);
      const nextLinked = linked.find(x => x.date >= today) || null;
      const nextLesson = nextRows.length ? mapLesson_(nextRows[0]) : null;
      return {
        units, today,
        next: {
          date: nextLinked ? nextLinked.date : (nextLesson ? nextLesson.date : null),
          unitId: nextLinked ? nextLinked.unitId : null,
          grade: normGrade_(nextLesson ? nextLesson.grade : null)
        }
      };
    },

    /* 理科タブ左ペイン: 今年度（4/1〜）の理科の授業（ナギレンダー）。「関係なし」は除く。授業数は保存値をそのまま返す（通し番号は画面で数える） */
    async getScienceLessons() {
      await warmApiMode_();
      const today = todayJst_();
      const fyStart = (+today.slice(5, 7) >= 4 ? today.slice(0, 4) : String(+today.slice(0, 4) - 1)) + '-04-01';
      const rows = await queryAll_('nagi', {
        /* 種別＝理科 が正。種別が未設定のコマ（新規作成など）も「理科」で始まる名前なら拾う。「理」を含むだけでは 伝承料理・管理職 まで混ざるので使わない */
        filter: { and: [
          { or: [
            { property: '種別', select: { equals: '理科' } },
            { property: 'Name', title: { starts_with: '理科' } }
          ] },
          { property: '日付', date: { on_or_after: fyStart } }
        ] },
        sorts: [{ property: '日付', direction: 'ascending' }]
      });
      const lessons = [];
      rows.forEach(pg => {
        const l = mapLesson_(pg);
        if (!l || l.excluded) return;
        const unit = l.relations.filter(r => r.kind === '単元計画')[0];
        lessons.push({
          id: l.id, name: l.name, date: l.date, time: l.time, periodLabels: l.periodLabels,
          grade: normGrade_(l.grade), cls: propSelect_((pg.properties || {})['クラス']), summary: l.summary, memo: l.memo,
          seq: propNumber_((pg.properties || {})['授業数']),
          unitId: unit ? unit.id : null
        });
      });
      return { lessons, today };
    },

    /* 本時を展開したときだけ呼ぶ。関連ページ名と Notion リンク、ワークシートのファイル名（URL は短命なので返さない） */
    async getScienceUnitDetail(pageId) {
      const pg = await fetchPageOf_(pageId, 'sciunit', '理科単元計画のページ');
      const p = pg.properties || {};
      const groups = { kahoot: 'kahoot', recipes: '実験レシピ', artifacts: '理科アーティファクト' };
      const idsOf = {};
      let all = [];
      Object.keys(groups).forEach(k => { idsOf[k] = propRelation_(p[groups[k]]); all = all.concat(idsOf[k]); });
      const titles = await relationTitles_(all);
      const out = { url: pg.url || null, worksheets: propFiles_(p['ワークシート']) };
      Object.keys(groups).forEach(k => {
        out[k] = idsOf[k].map(id => titles[id] ? { title: titles[id].title, url: titles[id].url } : { title: '(取得できません。DBへの接続を確認)', url: null });
      });
      return out;
    },

    /* 理科単元計画の書き込み。書いてよいのは status（not / Done）と フィードバック だけ（ホワイトリスト）。
       単元計画DBのページでなければ拒否する */
    async updateUnitPlan(pageId, patch) {
      assertId_(pageId);
      patch = patch || {};
      const props = {};
      if ('status' in patch) {
        if (patch.status !== 'not' && patch.status !== 'Done') throw new Error('status は not / Done のどちらかです');
        props['status'] = { status: { name: patch.status } };
      }
      if ('feedback' in patch) {
        const t = String(patch.feedback == null ? '' : patch.feedback).slice(0, 2000);
        props['フィードバック'] = { rich_text: t ? [{ type: 'text', text: { content: t } }] : [] };
      }
      if (!Object.keys(props).length) return { ok: true };
      await fetchPageOf_(pageId, 'sciunit', '理科単元計画のページ');
      await patchPage_(pageId, { properties: props }, '単元計画の保存に失敗しました');
      return { ok: true };
    },

    async getProjects() {
      return (await queryAll_('project', { sorts: [{ property: '期間', direction: 'descending' }] })).map(pg => {
        const p = pg.properties || {};
        const period = p['期間'] && p['期間'].date ? p['期間'].date : null;
        return {
          id: pg.id,
          url: pg.url || null,
          name: propTitle_(p['名前']),
          kind: propSelect_(p['種類']),
          status: propStatus_(p['ステータス']) || 'Not Started',
          importance: propSelect_(p['Importance']) || '',
          periodStart: period && period.start ? String(period.start).slice(0, 10) : null,
          periodEnd: period && period.end ? String(period.end).slice(0, 10) : null,
          goal: propText_(p['GOAL']),
          plan: propText_(p['Action Plan']),
          naiyo: propText_(p['内容'])
        };
      });
    },

    async getProjectBody(pageId) {
      if (!/^[0-9a-f-]{32,36}$/i.test(String(pageId))) throw new Error('pageId が不正です');
      bodyBudget = BODY_MAX_BLOCKS;
      let html = await renderBlocks_(pageId, 0);
      if (bodyBudget <= 0) html += '<p class="trunc">…長いので途中まで。続きは「Notion で開く」から。</p>';
      return { html };
    },

    async updateLesson(lessonId, data) {
      const pg = await fetchPageOf_(lessonId, 'nagi', 'ナギレンダーのコマ');
      const existing = (pg.properties && pg.properties['日付'] && pg.properties['日付'].date) || null;
      const existingPeriods = propMulti_(pg.properties && pg.properties['時限']);
      data = data || {};
      const props = lessonProps_(data, existing, existingPeriods);
      /* 理科タブ用（2026-10-02）: 授業数（学年ごとの通し番号）と、理科単元計画への紐づけ（1コマ1本時。null で解除） */
      if ('seq' in data) props['授業数'] = { number: data.seq == null ? null : Number(data.seq) };
      if ('unitId' in data) {
        if (data.unitId) {
          await fetchPageOf_(data.unitId, 'sciunit', '理科単元計画のページ');
          props['理科単元計画'] = { relation: [{ id: data.unitId }] };
        } else {
          props['理科単元計画'] = { relation: [] };
        }
      }
      await patchPage_(lessonId, { properties: props }, 'コマの保存に失敗しました');
      return { ok: true };
    },

    /* 授業数の一括反映。items: [{id, seq}]。ナギレンダーのコマ以外は拒否。順番に書く（Notion のレート制限対策） */
    async setLessonSeqs(items) {
      items = (items || []).slice(0, 120);
      let n = 0;
      for (const it of items) {
        await fetchPageOf_(it.id, 'nagi', 'ナギレンダーのコマ');
        await patchPage_(it.id, { properties: { '授業数': { number: it.seq == null ? null : Number(it.seq) } } }, '授業数の保存に失敗しました');
        n++;
      }
      return { ok: true, count: n };
    },

    async createLesson(data) {
      data = data || {};
      const props = lessonProps_(data);
      if (data.date) {
        const y = +data.date.slice(0, 4);
        const fy = (+data.date.slice(5, 7)) >= 4 ? y : y - 1;
        props['年度'] = { select: { name: 'R' + (fy - 2018) } };
      }
      const r = await request_('https://api.notion.com/v1/pages', 'post',
                               { parent: { database_id: NOTION_DS.nagi.db }, properties: props }, '2022-06-28');
      if (!r.ok) throw new Error('コマの作成に失敗しました (' + r.code + '): ' + String(r.text).slice(0, 300));
      return { ok: true, id: r.json && r.json.id };
    },

    async deleteLesson(lessonId) {
      await fetchPageOf_(lessonId, 'nagi', 'ナギレンダーのコマ');
      await patchPage_(lessonId, { archived: true }, 'コマの削除に失敗しました');
      return { ok: true };
    },

    async getDocs() {
      return (await queryAll_('docs', { filter: { property: '頻出', checkbox: { equals: true } } })).map(mapDoc_);
    },

    async searchDocs(q) {
      q = String(q || '').trim();
      if (!q) return [];
      return (await queryAll_('docs', { filter: { property: '名前', title: { contains: q } } }, 30)).map(mapDoc_);
    },

    async updateDoc(docId, patch) {
      assertId_(docId);
      patch = patch || {};
      const props = {};
      if ('hinshutsu' in patch) props['頻出'] = { checkbox: !!patch.hinshutsu };
      if (!Object.keys(props).length) return { ok: true };
      await patchPage_(docId, { properties: props }, 'Notion への保存に失敗しました');
      return { ok: true };
    },

    /* 書いてよいのは status / 実施予定日 / タスク種別 / 累積実績(分) / セッション開始 / 並び順 だけ */
    async updateTask(taskId, patch) {
      assertId_(taskId);
      patch = patch || {};
      const props = {};
      if ('status' in patch)   props['status']       = { status: patch.status ? { name: patch.status } : null };
      if ('date' in patch)     props['実施予定日']   = patch.date ? { date: { start: patch.date } } : { date: null };
      if ('kind' in patch)     props['タスク種別']   = patch.kind ? { select: { name: patch.kind } } : { select: null };
      if ('spentMin' in patch) props['累積実績(分)'] = { number: patch.spentMin == null ? null : Number(patch.spentMin) };
      if ('sessionStart' in patch) {
        props['セッション開始'] = patch.sessionStart ? { date: { start: String(patch.sessionStart) } } : { date: null };
      }
      if ('order' in patch)    props['並び順']       = { number: patch.order == null ? null : Number(patch.order) };
      if (!Object.keys(props).length) return { ok: true };
      await patchPage_(taskId, { properties: props }, 'Notion への保存に失敗しました');
      return { ok: true };
    },

    async updateOrders(pairs) {
      for (const pr of pairs || []) await api.updateTask(pr.id, { order: pr.order });
      return { ok: true };
    },

    async updateTasks(items) {
      for (const it of items || []) await api.updateTask(it.id, it.patch || {});
      return { ok: true };
    },

    async createTask(data) {
      data = data || {};
      const name = String(data.name || '').trim();
      if (!name) throw new Error('タスク名が空です');
      const props = {
        '名前':   { title: [{ text: { content: name.slice(0, 2000) } }] },
        'status': { status: { name: 'Not Started' } }
      };
      if (data.date) props['実施予定日'] = { date: { start: String(data.date) } };
      if (data.kind) props['タスク種別'] = { select: { name: String(data.kind) } };
      const r = await request_('https://api.notion.com/v1/pages', 'post',
                               { parent: { database_id: NOTION_DS.task.db }, properties: props }, '2022-06-28');
      if (!r.ok) throw new Error('タスクの作成に失敗しました (' + r.code + '): ' + String(r.text).slice(0, 300));
      return mapTask_(r.json || {});
    },

    async deleteTask(taskId) {
      await fetchPageOf_(taskId, 'task', 'DB_TASK のタスク');
      await patchPage_(taskId, { archived: true }, 'タスクの削除に失敗しました');
      return { ok: true };
    },

    /* 書いてよいキー: setupDone / closeDone / club / clubStart / clubEnd / shukkin。ページが無い日は作らない */
    async updateJournalDay(date, patch) {
      assertYmd_(date, 'date');
      patch = patch || {};
      const pageId = await journalPageId_(date);
      if (!pageId) throw new Error(date + ' の Daily Journaling ページがまだありません（セットアップちゃんの実行前です）');
      const pg = await fetchPageOf_(pageId, 'journal', 'Daily Journaling all のページ');

      const props = {};
      if ('setupDone' in patch) props['セットアップ済'] = { checkbox: !!patch.setupDone };
      if ('closeDone' in patch) props['クローズ済']     = { checkbox: !!patch.closeDone };
      if ('club' in patch)      props['部活従事']       = patch.club ? { select: { name: String(patch.club) } } : { select: null };
      if ('shukkin' in patch) {
        const key = propNameAny_(pg.properties || {}, JOURNAL_ALIASES.shukkin);
        props[key] = { multi_select: (patch.shukkin || []).map(n => ({ name: String(n) })) };
      }
      if ('clubStart' in patch || 'clubEnd' in patch) {
        if (!patch.clubStart) {
          props['部活時間'] = { date: null };
        } else {
          const v = { start: jstIso_(date, patch.clubStart) };
          if (patch.clubEnd) v.end = jstIso_(date, patch.clubEnd);
          props['部活時間'] = { date: v };
        }
      }
      if (!Object.keys(props).length) return { ok: true };
      await patchPage_(pageId, { properties: props }, 'Notion への保存に失敗しました');
      return { ok: true };
    }
  };
  return api;
}
