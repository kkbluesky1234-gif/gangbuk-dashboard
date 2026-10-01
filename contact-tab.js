/* =========================================================
   접촉현황 탭 — contact-tab.js
   현장별로 차장이 임대의원/조합원을 얼마나 만났는지,
   시공사 지지 성향이 어떻게 바뀌는지, 친밀도(상/중/하) 변화,
   투어/간담회/설문조사 같은 특별행사 이력을 관리합니다.
   그리고 실제 업무에서 쓰는 "담당별 접촉현황 집계" 엑셀 시트를
   월 단위로 업로드해서 차장별 상담/단순/TM 그래프도 볼 수 있습니다.

   이 파일은 app.js 전역 변수/함수(esc, fmtNum, persist, sites,
   currentDetailId, isAdmin)를 그대로 사용합니다. app.js보다
   반드시 뒤에 로드되어야 합니다.
   ========================================================= */

const CONTACT_LEVELS = ["상", "중", "하"];
const CONTACT_LEVEL_RANK = { "상": 2, "중": 1, "하": 0 };
const CONTACT_TYPES = ["임대의원", "조합원"];
const ROLE_OPTIONS = ["", "조합장", "감사", "이사", "대의원"];
const CONTACT_METHODS = ["", "상담", "단순상담", "TM", "거부", "부재", "불명"];
const DEFAULT_EVENT_TYPES = ["투어", "간담회", "설문조사"];
const EVENT_COLORS = ["#378add", "#d85a30", "#1d9e75", "#8b5cf6", "#f59e0b"];
const PERIOD_MODES = [["day", "일별"], ["week", "주별"], ["month", "월별"]];
const REGISTRY_PARSER_VERSION = 4;
/* 임대의원으로 인정하는 직책 값. "당선/탈락/후보/번호" 같은 후보 관련 값은 임대의원이 아님 */
const LEASE_ROLES = ["부조합장", "조합장", "감사", "이사", "대의원", "총무"];
function leaseRoleOf(v) {
  const s = String(v ?? "").replace(/\s/g, "");
  if (!s || /후보|탈락|낙선|당선|사퇴/.test(s)) return "";
  return LEASE_ROLES.find(r => s.includes(r)) ? s : "";
}
const CONTACT_TAB_VERSION = "2026-10-01 v27";

/* 모든 막대/선 그래프 위에 숫자 값을 표시하는 공통 플러그인 (도넛 차트는 제외) */
if (typeof Chart !== "undefined" && !Chart._ctValueLabelsRegistered) {
  Chart.register({
    id: "ctValueLabels",
    afterDatasetsDraw(chart) {
      if (chart.config.type === "doughnut" || chart.config.type === "pie") return;
      if (chart.options?.plugins?.ctValueLabels === false) return;
      const ctx = chart.ctx;
      chart.data.datasets.forEach((dataset, dsIndex) => {
        const meta = chart.getDatasetMeta(dsIndex);
        if (meta.hidden) return;
        meta.data.forEach((element, index) => {
          const raw = dataset.data[index];
          if (raw === null || raw === undefined || raw === 0) return;
          const pos = element.tooltipPosition ? element.tooltipPosition() : { x: element.x, y: element.y };
          const isPercent = chart.options?.scales?.y?.ticks?.callback && String(chart.options.scales.y.ticks.callback((0))).includes("%");
          const text = isPercent ? `${raw}%` : String(raw);
          ctx.save();
          ctx.fillStyle = "#334155";
          ctx.font = "11px Arial, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(text, pos.x, pos.y - 4);
          ctx.restore();
        });
      });
    }
  });
  Chart._ctValueLabelsRegistered = true;
  Chart.defaults.layout = Chart.defaults.layout || {};
  Chart.defaults.layout.padding = { top: 22 };
}

const _contactCharts = {}; // siteId -> { contact, stance, sentiment, intimacy, event, monthly }
const _contactState = {}; // siteId -> { selectedChajang: Set, period, selectedStatMonth }

/* 담당(차장) 이름 통일: 공백 제거, 끝의 직함(차장·과장·팀장·님 등) 제거 */
function normChajang(v) {
  const s = String(v ?? "").replace(/\s+/g, "");
  if (!s) return "";
  const t = s.replace(/(차장님|차장|과장|부장|대리|팀장|실장|님)$/, "");
  return t.length >= 2 ? t : s;   // "이차장"처럼 성+직함만 있는 이름은 그대로 둠
}
/* 담당 이름 A를 B로 합치기 (접촉기록·스냅샷·명부현황 모두) */
function mergeChajang(site, from, to) {
  let n = 0;
  site.contacts.forEach(c => { if (c.chajang === from) { c.chajang = to; n++; } });
  site.stanceSnapshots.forEach(x => { if (x.chajang === from) x.chajang = to; });
  Object.values(site.registryStats || {}).forEach(rows => rows.forEach(r => { if (r[0] === from) r[0] = to; }));
  site.chajangAliases = site.chajangAliases || {};
  site.chajangAliases[from] = to;   // 다음 명부 업로드 때도 자동으로 같은 이름으로
  return n;
}
function applyChajangAlias(site, name) {
  const al = site.chajangAliases || {};
  let n = normChajang(name), guard = 0;
  while (al[n] && al[n] !== n && guard++ < 5) n = al[n];
  return n;
}
function allChajangCounts(site) {
  const m = {};
  site.contacts.forEach(c => { const k = c.chajang || ""; if (k) m[k] = (m[k] || 0) + 1; });
  Object.values(site.registryStats || {}).forEach(rows => rows.forEach(r => { if (r[0]) m[r[0]] = m[r[0]] || 0; }));
  return m;
}

function ensureContactData(site) {
  site.contacts = site.contacts || [];
  site.companies = site.companies || ["포스코"];
  site.specialEvents = site.specialEvents || [];
  site.stanceSnapshots = site.stanceSnapshots || [];

  // [수정 #7] 예전 버전에서 엑셀로 들어온 기록(접촉방법 칸이 없고 직책 칸이 있는 기록)은
  // "업로드 당시 현재 성향을 과거 날짜에 복사한 값"이므로 성향/친밀도 변화 계산에서 제외하도록 표시합니다.
  let migrated = false;
  site.contacts.forEach(c => {
    if (c.source) return;
    c.source = (!("method" in c) && ("role" in c)) ? "import" : "manual";
    migrated = true;
  });
  // 기존 데이터에 스냅샷이 하나도 없으면, 사람별 가장 최근 기록 1건을 최초 스냅샷으로 만들어 둡니다.
  if (!site.stanceSnapshots.length && site.contacts.some(c => c.source === "import")) {
    const latest = {};
    site.contacts.filter(c => c.source === "import" && c.name && c.date).forEach(c => {
      const k = personKey(c);
      if (!latest[k] || latest[k].date < c.date) latest[k] = c;
    });
    Object.values(latest).forEach(c => site.stanceSnapshots.push({
      id: uid(), date: c.date, name: c.name, birthDate: c.birthDate || "", chajang: c.chajang || "",
      type: c.type, role: c.role || "", stance: c.stance || "미정", level: c.level || "하"
    }));
    migrated = true;
  }
  // 예전 업로드에서 잘못 들어간 숫자/날짜 성향 값(예: 1024) 정리
  const badCompanies = site.companies.filter(c => !isValidStanceLabel(c));
  if (badCompanies.length) { site.companies = site.companies.filter(isValidStanceLabel); migrated = true; }
  [...site.contacts, ...site.stanceSnapshots].forEach(c => {
    const fixed = cleanStance(c.stance);
    if ((c.stance || "미정") !== fixed) { c.stance = fixed; migrated = true; }
  });
  if (cleanupPeople(site)) migrated = true;
  // 예전에 "단순", "tm" 등으로 저장돼 통계에서 빠지던 접촉방법을 표준값으로 정리
  site.contacts.forEach(c => {
    if (!c.method) return;
    const m = normalizeMethod(c.method);
    if (m !== c.method) { c.method = m; migrated = true; }
  });
  // 담당 이름 표기 통일 (예: "박미화 ", "박미화차장" → "박미화")
  const fix = v => applyChajangAlias(site, v);
  site.contacts.forEach(c => { if (c.chajang && fix(c.chajang) !== c.chajang) { c.chajang = fix(c.chajang); migrated = true; } });
  site.stanceSnapshots.forEach(x => { if (x.chajang && fix(x.chajang) !== x.chajang) { x.chajang = fix(x.chajang); migrated = true; } });
  Object.values(site.registryStats || {}).forEach(rows => rows.forEach(r => { if (r[0] && fix(r[0]) !== r[0]) { r[0] = fix(r[0]); migrated = true; } }));
  if (migrated) persist();
}

/* 성향 값으로 쓸 수 없는 것: 빈칸, 숫자, 날짜처럼 생긴 값 (예: 1024, 10/24, 10.24, 10월24일) */
function isValidStanceLabel(v) {
  const s = String(v ?? "").trim();
  if (!s) return false;
  if (/^[\d\s.,\/\-~:()년월일주차]+$/.test(s)) return false;
  return true;
}
/* 명부 머리글 약어 → 시공사 이름 (예: "P" = 포스코) */
const STANCE_ALIASES = { "P": "포스코", "p": "포스코", "포스코이앤씨": "포스코" };
function stanceFromLabel(v) {
  const s = String(v ?? "").trim();
  return STANCE_ALIASES[s] || s;
}
/* 칸에 "표시"가 되어 있는지 (1, ○, V 등). 긴 메모 글자는 표시로 보지 않음 */
function isMark(v) {
  if (v === null || v === undefined || v === "") return false;
  if (typeof v === "number") return v > 0;
  const s = String(v).trim();
  if (!s) return false;
  return s.length <= 2 || !!parseMethod(s);
}
function cleanStance(v) {
  const s = String(v ?? "").trim();
  return s === "미정" || isValidStanceLabel(s) ? (s || "미정") : "미정";
}

/* 접촉방식 값 해석: 명부 날짜 칸에 적힌 글자(상담/단순/TM/거부/부재/불명 등) → 표준 접촉방법 */
const METHOD_ALIASES = [
  ["단순상담", ["단순상담", "단순", "단"]],
  ["상담", ["상담", "상다", "대면", "면담", "방문", "상"]],
  ["TM", ["tm", "전화", "통화", "t"]],
  ["거부", ["거부", "거절", "거"]],
  ["부재", ["부재", "부재중", "부"]],
  ["불명", ["불명", "붕명", "결번", "주소불명", "불"]]
];
function parseMethod(v) {
  const s = String(v ?? "").replace(/\s/g, "").toLowerCase();
  if (!s) return "";
  for (const [method, aliases] of METHOD_ALIASES) if (aliases.includes(s)) return method;
  for (const [method, aliases] of METHOD_ALIASES) if (aliases.some(a => a.length > 1 && s.includes(a))) return method;
  return "";
}

/* 머리글용: 한 글자 약어(상/부 등)는 친밀도 "상"과 헷갈리므로 제외하고 판별 */
function parseMethodStrict(v) {
  const s = String(v ?? "").replace(/\s/g, "").toLowerCase();
  if (!s) return "";
  for (const [method, aliases] of METHOD_ALIASES) if (aliases.some(a => a.length > 1 && a === s)) return method;
  return "";
}
/* 명단/표에 저장된 접촉방법을 표준값으로 (예: "단순" → "단순상담", "tm" → "TM") */
function normalizeMethod(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return "";
  return parseMethod(raw) || raw;
}

/* =========================================================
   사람 정리 (탭을 열 때마다 자동, 모든 담당)
   ① 직책(조합장·감사·이사·대의원) 없이 "임대의원"으로만 표시된 기록 → 일반 조합원
   ② 생년월일 없는 예전 기록 → 명부의 같은 이름(한 명뿐일 때)과 합침
   ③ 같은 사람·같은 날짜 중복 → 하나만
   ④ 최신 명부에 없는 사람의 기록 → 삭제 ("+ 접촉 기록 추가"로 직접 넣은 기록은 유지)
   ========================================================= */
function cleanupPeople(site) {
  let changed = false;
  const regDates = registryDates(site);
  const latest = regDates.length ? (site.registryStats[regDates[regDates.length - 1]] || []) : [];
  const regHasKeys = latest.length && latest[0][4];
  const reg = {};                    // key -> {chajang, role, type}
  // 같은 사람이 여러 행(필지)에 있으면 직책이 있는 행을 우선
  if (regHasKeys) latest.forEach(r => { if (reg[r[4]] && reg[r[4]].role && !r[5]) return; reg[r[4]] = { chajang: r[0], type: r[1] ? "임대의원" : "조합원", role: r[5] || "" }; });

  // 이름 → 생년월일 있는 사람 목록 (명부 우선, 없으면 기록에서)
  const byName = {};
  const addName = (key) => { const [n, b] = key.split("|"); if (!b) return; (byName[n] = byName[n] || new Set()).add(key); };
  if (regHasKeys) Object.keys(reg).forEach(addName); else site.contacts.forEach(c => addName(personKey(c)));

  site.contacts.forEach(c => {
    if (!c.name) return;
    // ②
    if (!c.birthDate && byName[c.name] && byName[c.name].size === 1) {
      c.birthDate = [...byName[c.name]][0].split("|")[1]; changed = true;
    }
    const r = reg[personKey(c)];
    if (r) {
      if (c.chajang !== r.chajang || c.type !== r.type || (c.role || "") !== r.role) { c.chajang = r.chajang; c.type = r.type; c.role = r.role; changed = true; }
    } else if (c.type === "임대의원" && !leaseRoleOf(c.role)) {
      c.type = "조합원"; changed = true;   // ①
    }
  });
  // ③
  const keep = new Map();
  site.contacts.forEach(c => {
    if (!c.name) return;
    const k = `${personKey(c)}__${c.date}`;
    const prev = keep.get(k);
    if (!prev) { keep.set(k, c); return; }
    const score = x => (x.source === "import" ? 2 : 0) + (x.method ? 1 : 0);
    const win = score(c) > score(prev) ? c : prev, lose = win === c ? prev : c;
    if (!win.method && lose.method) win.method = lose.method;
    if (!win.note && lose.note) win.note = lose.note;
    keep.set(k, win);
  });
  const before = site.contacts.length;
  site.contacts = site.contacts.filter(c => !c.name || keep.get(`${personKey(c)}__${c.date}`) === c);
  // ④
  if (regHasKeys) site.contacts = site.contacts.filter(c => !c.name || c.ui || reg[personKey(c)]);
  if (site.contacts.length !== before) changed = true;
  if (regHasKeys) {
    const n0 = site.stanceSnapshots.length;
    site.stanceSnapshots = site.stanceSnapshots.filter(x => reg[personKey(x)]);
    if (site.stanceSnapshots.length !== n0) changed = true;
  }
  return changed;
}

/* [수정 #12] 동명이인 구분: 이름 + 생년월일(있을 때) */
function personKey(c) {
  return `${(c.name || "").trim()}|${(c.birthDate || "").trim()}`;
}
function personLabel(c, allRecords) {
  if (!c.birthDate) return c.name;
  const same = allRecords.some(o => o.name === c.name && (o.birthDate || "") !== (c.birthDate || ""));
  return same ? `${c.name}(${c.birthDate})` : c.name;
}

/* 엑셀 날짜 값(일련번호/문자열/Date)을 YYYY-MM-DD로 통일 */
function normalizeDateValue(v) {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date && !isNaN(v)) return formatDateLocal(v);
  if (typeof v === "number" && v > 20000 && v < 80000) return formatDateUTC(excelSerialToDate(v));
  const s = String(v).trim();
  if (/^\d{5}(\.\d+)?$/.test(s)) return normalizeDateValue(Number(s));
  const m = s.match(/^(\d{4})[.\-\/년\s]+(\d{1,2})[.\-\/월\s]+(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  return s;
}
function isValidDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || "");
}

function monthKeyOf(dateStr) {
  return (dateStr || "").slice(0, 7);
}
function monthEndOf(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${monthKey}-${pad2(new Date(y, m, 0).getDate())}`;
}
function weekKeyOf(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return formatDateLocal(d); // [수정 #1] toISOString()은 UTC로 바뀌어 한국시간에서 하루 밀림
}
function groupKeyOf(dateStr, mode) {
  if (mode === "day") return dateStr || "";
  if (mode === "week") return weekKeyOf(dateStr);
  return monthKeyOf(dateStr);
}
function groupLabel(key, mode) {
  if (mode === "week") return key.slice(5).replace("-", "/") + "주~";
  if (mode === "day") return key.slice(5).replace("-", "/");
  return key;
}

function contactStateFor(siteId) {
  if (!_contactState[siteId]) _contactState[siteId] = { selectedChajang: null, targetType: "", period: "month", selectedStatMonth: null, selectedWeeklyMonth: null };
  return _contactState[siteId];
}

function destroyContactCharts(siteId) {
  const c = _contactCharts[siteId];
  if (!c) return;
  Object.values(c).forEach(ch => { if (ch) ch.destroy(); });
  delete _contactCharts[siteId];
}

/* [수정 #3, #13] 데이터가 바뀌면 탭 안의 모든 표·그래프를 한 번에 다시 그림 */
function refreshContactViews(site, opts = {}) {
  renderStaleWarn(site);
  renderChajangPills(site);
  if (opts.table !== false) renderContactTable(site);
  if (opts.companies) renderCompanyTags(site);
  if (opts.events) renderEventTable(site);
  renderRegistryStatusSection(site);
  renderMonthlyStatSection(site);
  renderWeeklyPersonSection(site);
  rebuildContactCharts(site);
}

/* 게스트는 표를 볼 수만 있고 수정은 못 하도록 (수정 #9) */
function roAttr() {
  return (typeof isAdmin !== "undefined" && isAdmin) ? "" : "disabled";
}

/* =========================================================
   성향/친밀도 "관측값" (수정 #7)
   - 직접 입력한 기록(manual) + 업로드 시점 스냅샷(stanceSnapshots)만 사용
   - 엑셀에서 날짜별로 풀어 넣은 기록(import/weekly)은 "현재 값을 과거로 복사"한
     것이라 변화 계산에서 제외
   ========================================================= */
function observationsFor(site, contacts) {
  const keys = new Set(contacts.map(personKey));
  const obs = [];
  contacts.forEach(c => {
    if (c.source === "manual" && c.name && isValidDateStr(c.date)) {
      obs.push({ key: personKey(c), date: c.date, stance: c.stance || "미정", level: c.level || "" });
    }
  });
  site.stanceSnapshots.forEach(s => {
    const k = personKey(s);
    if (keys.has(k) && isValidDateStr(s.date)) obs.push({ key: k, date: s.date, stance: s.stance || "미정", level: s.level || "", confirmedUntil: s.confirmedUntil || "" });
  });
  // 관측값이 전혀 없는 사람은 최근 기록 값으로 대체
  const hasObs = new Set(obs.map(o => o.key));
  const fallback = {};
  contacts.forEach(c => {
    const k = personKey(c);
    if (!c.name || hasObs.has(k)) return;
    if (!fallback[k] || (fallback[k].date || "") < (c.date || "")) fallback[k] = c;
  });
  Object.entries(fallback).forEach(([k, c]) => obs.push({ key: k, date: c.date || "", stance: c.stance || "미정", level: c.level || "" }));

  const byKey = {};
  obs.forEach((o, i) => { o.pri = i; (byKey[o.key] = byKey[o.key] || []).push(o); });
  Object.keys(byKey).forEach(k => {
    // 같은 날짜에 여러 값이 있으면 직접 입력한 기록(먼저 push됨)을 우선하고 하나만 남김
    const seen = new Map();
    byKey[k].forEach(o => { if (!seen.has(o.date) || seen.get(o.date).pri > o.pri) seen.set(o.date, o); });
    byKey[k] = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
  });
  return byKey;
}
function stateAsOf(list, dateStr) {
  let cur = null;
  for (const o of list) { if (o.date <= dateStr) cur = o; else break; }
  return cur;
}

/* ---------- 인쇄 ---------- */
function printContactTab(size) {
  let styleTag = document.getElementById("ctPrintPageSize");
  if (!styleTag) {
    styleTag = document.createElement("style");
    styleTag.id = "ctPrintPageSize";
    document.head.appendChild(styleTag);
  }
  styleTag.textContent = `@page { size: ${size} landscape; margin: 10mm; }`;
  document.body.classList.add("printing-contact");
  const cleanup = () => {
    document.body.classList.remove("printing-contact");
    styleTag.textContent = "";
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
}

/* =========================================================
   보고서 출력 — 화면(인터넷 창) 그대로가 아니라, 보고용 양식으로 새로 만들어 인쇄
   - 표는 표로, 그래프는 이미지로 정리
   - 브라우저가 붙이는 주소/날짜 머리글·바닥글이 나오지 않도록 여백을 페이지 안에서 처리
   ========================================================= */
function chartImage(ch) {
  if (!ch) return "";
  try {
    const prev = ch.options.animation;
    ch.options.animation = false;
    ch.update("none");
    ch.resize();   // 방금 다시 그린 그래프가 빈 이미지로 찍히지 않도록 강제로 그림
    ch.draw();
    const url = ch.toBase64Image("image/png", 1);
    ch.options.animation = prev;
    return url;
  } catch (e) { return ""; }
}
/* 보고서용: 화면 그래프와 같은 내용을 인쇄에 맞는 크기로 따로 그려서 이미지로 만듦 */
function chartImageSized(ch, w, h) {
  if (!ch) return "";
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:-10000px;top:0;width:${w}px;height:${h}px`;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h; cv.style.width = w + "px"; cv.style.height = h + "px";
  box.appendChild(cv);
  document.body.appendChild(box);
  let url = "";
  try {
    const data = JSON.parse(JSON.stringify({ labels: ch.data.labels, datasets: ch.data.datasets.map(d => {
      const o = {}; Object.keys(d).forEach(k => { if (!k.startsWith("_") && typeof d[k] !== "function") o[k] = d[k]; }); return o; }) }));
    const opts = Object.assign({}, ch.config.options, { responsive: false, maintainAspectRatio: false, animation: false, devicePixelRatio: 2 });
    opts.plugins = Object.assign({}, ch.config.options.plugins, { legend: Object.assign({}, ch.config.options.plugins?.legend, { labels: { font: { size: 13 } } }) });
    const tmp = new Chart(cv, { type: ch.config.type, data, options: opts });
    url = tmp.toBase64Image("image/png", 1);
    tmp.destroy();
  } catch (e) { url = chartImage(ch); }
  box.remove();
  return url;
}
function cloneTableHtml(el) {
  if (!el) return "";
  const c = el.cloneNode(true);
  c.querySelectorAll("[style]").forEach(n => n.removeAttribute("style"));
  c.removeAttribute("style");
  c.removeAttribute("id");
  return c.outerHTML;
}

/* 차장 한 명 출력용: 그 차장이 맡은 조합원 명단 (명부 기준 + 이 달 주차별 접촉) */
function buildPersonListHtml(site, chajang, regDate, weekMonth) {
  const tt = contactStateFor(site.id).targetType;
  const regs = registryPeople(site, regDate, true).filter(x => x.chajang === chajang &&
    (!tt || (tt === "임대의원" ? x.type === "임대의원" : x.type !== "임대의원")))
    .map(x => ({ ...x, cumMethod: x.cum, weekMethod: x.week }));
  const ranges = weekRangesOfMonth(weekMonth);
  const W = ranges.map((_, i) => i + 1);
  const weeksByKey = {};
  site.contacts.forEach(c => {
    if (!isValidDateStr(c.date) || !ranges.length || c.date < ranges[0].start || c.date > ranges[ranges.length - 1].end) return;
    const k = personKey(c); const w = weekIndexIn(ranges, c.date);
    (weeksByKey[k] = weeksByKey[k] || {})[w] = (weeksByKey[k][w] || 0) + 1;
  });
  let people;
  if (regs.length && regs[0].key) {
    people = regs.map(x => ({ key: x.key, type: x.type, role: x.role, cum: x.cumMethod, week: x.weekMethod, stance: x.stance, level: x.level }));
  } else {
    // 예전 방식으로 저장된 명부(이름 정보 없음): 접촉 기록에서 명단을 만듦
    const m = {};
    site.contacts.filter(c => (c.chajang || "(담당 미지정)") === chajang && c.name).forEach(c => {
      m[personKey(c)] = { key: personKey(c), type: c.type, role: c.role, cum: c.method || "-", week: "-", stance: c.stance, level: c.level };
    });
    people = Object.values(m).filter(p => !tt || (tt === "임대의원" ? p.type === "임대의원" : p.type !== "임대의원"));
  }
  const order = s => { const i = REG_STATUS.indexOf(s); return i < 0 ? 99 : i; };
  people.sort((a, b) => (a.type === "임대의원" ? 0 : 1) - (b.type === "임대의원" ? 0 : 1) || order(a.cum) - order(b.cum) || a.key.localeCompare(b.key));
  const nameOf = k => { const [n, bd] = k.split("|"); return bd ? `${n} <span>(${bd.slice(0, 6)})</span>` : n; };
  const cls = s => ({ "상담": "g", "단순상담": "g", "TM": "g", "거부": "r", "부재": "a", "불명": "a", "미접촉": "n" }[s] || "n");
  const shortM = s => s === "단순상담" ? "단순" : s;
  const pill = s => s && s !== "-" ? `<span class="pill ${cls(s)}">${esc(shortM(s))}</span>` : "";
  const rowsHtml = people.map((p, i) => {
    const wk = weeksByKey[p.key] || {};
    const tot = W.reduce((s, w) => s + (wk[w] || 0), 0);
    return `<tr><td class="c">${i + 1}</td><td>${nameOf(p.key)}</td><td class="c">${p.type === "임대의원" ? esc(p.role || "") : ""}</td>
      <td class="c">${pill(p.cum)}</td><td class="c">${pill(p.week)}</td>
      <td class="c">${esc(p.stance && p.stance !== "미정" ? p.stance : "")}</td><td class="c">${esc(p.level || "")}</td>
      ${W.map(w => `<td class="c">${wk[w] || ""}</td>`).join("")}<td class="c strong">${tot || ""}</td></tr>`;
  }).join("");
  const lease = people.filter(p => p.type === "임대의원").length;
  return {
    count: people.length, lease,
    html: `<table class="t list">
      <colgroup><col style="width:4%"><col style="width:18%"><col style="width:9%"><col style="width:7%"><col style="width:7%"><col style="width:7%"><col style="width:6%">${W.map(() => `<col>`).join("")}<col style="width:6%"></colgroup>
      <thead><tr><th>No</th><th>이름</th><th>임대의원</th><th>누계</th><th>주차</th><th>성향</th><th>친밀도</th>
        ${W.map((w, i) => `<th>${w}주<small>${shortMD(ranges[i].start)}~</small></th>`).join("")}<th>합계</th></tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="${8 + W.length}">명단이 없습니다.</td></tr>`}</tbody></table>`
  };
}

/* 보고서용 그래프를 직접 그려서 이미지로 (글씨 크게, 깔끔하게) */
function makeChartImage(config, w, h) {
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:-10000px;top:0;width:${w}px;height:${h}px`;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h; cv.style.width = w + "px"; cv.style.height = h + "px";
  box.appendChild(cv); document.body.appendChild(box);
  const prevSize = Chart.defaults.font.size, prevFamily = Chart.defaults.font.family;
  Chart.defaults.font.size = 15;
  Chart.defaults.font.family = '"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo",sans-serif';
  let url = "";
  try {
    config.options = Object.assign({ responsive: false, maintainAspectRatio: false, animation: false, devicePixelRatio: 2 }, config.options || {});
    const ch = new Chart(cv, config);
    url = ch.toBase64Image("image/png", 1);
    ch.destroy();
  } catch (e) { console.warn(e); }
  Chart.defaults.font.size = prevSize; Chart.defaults.font.family = prevFamily;
  box.remove();
  return url;
}
const RPT_COLORS = { 접촉: "#2f6fb5", 거부: "#d9534f", 부재: "#f0ad4e", 불명: "#8a94a6", 미접촉: "#d5dbe3" };

/* 보고서용 주차 집계 (담당별 · 주차별 실인원/건수) */
function computeWeeklyForReport(site, monthKey) {
  const ranges = weekRangesOfMonth(monthKey);
  const W = ranges.map((_, i) => i + 1);
  const contacts = selectedContacts(site).filter(c => c.name && isValidDateStr(c.date) && ranges.length && c.date >= ranges[0].start && c.date <= ranges[ranges.length - 1].end);
  const by = {};
  contacts.forEach(c => {
    const k = c.chajang || "(담당 미지정)", w = weekIndexIn(ranges, c.date), pk = personKey(c);
    const g = by[k] = by[k] || { name: k, wk: {}, wkCnt: {}, all: new Set(), cnt: 0 };
    (g.wk[w] = g.wk[w] || new Set()).add(pk);
    g.wkCnt[w] = (g.wkCnt[w] || 0) + 1;
    g.all.add(pk); g.cnt++;
  });
  const list = Object.values(by).sort((a, b) => a.name.localeCompare(b.name));
  const tot = { name: "합계", wk: {}, wkCnt: {}, all: new Set(), cnt: 0 };
  list.forEach(g => { W.forEach(w => { (g.wk[w] || new Set()).forEach(p => (tot.wk[w] = tot.wk[w] || new Set()).add(p)); tot.wkCnt[w] = (tot.wkCnt[w] || 0) + (g.wkCnt[w] || 0); }); g.all.forEach(p => tot.all.add(p)); tot.cnt += g.cnt; });
  return { ranges, W, list, tot };
}

function buildContactReportHtml(site, size) {
  const state = contactStateFor(site.id);
  const charts = _contactCharts[site.id] || {};
  const single = state.selectedChajang.size === 1 ? [...state.selectedChajang][0] : "";
  const regDates = registryDates(site);
  const regDate = state.selectedRegDate || regDates[regDates.length - 1] || "";
  const printedAt = todayStr();
  const pctN = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
  const pct = (a, b) => b ? `${pctN(a, b)}%` : "-";
  const GOOD = ["상담", "단순상담", "TM"];
  const who = (single ? `${single} 차장` : "전체 담당") + (state.targetType ? ` · ${targetLabel(state)}` : "");
  const tgt = targetLabel(state);

  // ---- 담당별 집계 ----
  const rows = regDates.length ? registryRows(site, regDate) : [];
  const groups = {};
  rows.forEach(x => {
    const k = x.chajang || "(담당 미지정)";
    const g = groups[k] = groups[k] || { name: k, total: 0, lease: 0, c: {}, wGood: 0 };
    g.total++; if (x.type === "임대의원") g.lease++;
    g.c[x.cumMethod] = (g.c[x.cumMethod] || 0) + 1;
    if (GOOD.includes(x.weekMethod)) g.wGood++;
  });
  const glist = Object.values(groups).sort((a, b) => a.name.localeCompare(b.name));
  const sum = { name: "합계", total: 0, lease: 0, c: {}, wGood: 0 };
  glist.forEach(g => { sum.total += g.total; sum.lease += g.lease; sum.wGood += g.wGood; REG_STATUS.forEach(k => sum.c[k] = (sum.c[k] || 0) + (g.c[k] || 0)); });
  const good = g => GOOD.reduce((s, k) => s + (g.c[k] || 0), 0);
  const bar = (v, color) => `<div class="bar"><i style="width:${Math.min(100, v)}%;background:${color}"></i><b style="${v >= 82 ? "color:#fff" : ""}">${v}%</b></div>`;
  const regRow = (g, cls) => `<tr class="${cls || ""}">
    <td class="nm">${esc(g.name)}</td><td>${g.total}</td>
    <td>${g.c["상담"] || 0}</td><td>${g.c["단순상담"] || 0}</td><td>${g.c["TM"] || 0}</td>
    <td class="strong">${good(g)}</td><td class="barcell">${bar(pctN(good(g), g.total), "#2f6fb5")}</td>
    <td class="strong wk">${g.wGood}</td><td class="barcell wk">${bar(pctN(g.wGood, g.total), "#5b9bd5")}</td>
    <td class="neg">${g.c["거부"] || 0}</td><td>${g.c["부재"] || 0}</td><td>${g.c["불명"] || 0}</td><td class="muted">${g.c["미접촉"] || 0}</td><td>${g.lease}</td></tr>`;
  const regTable = glist.length ? `
    <table class="t">
      <colgroup><col style="width:9%"><col style="width:5%"><col style="width:5%"><col style="width:5%"><col style="width:5%"><col style="width:6%"><col style="width:15%"><col style="width:6%"><col style="width:15%"><col style="width:5%"><col style="width:5%"><col style="width:5%"><col style="width:6%"><col style="width:5.5%"></colgroup>
      <thead>
        <tr class="g"><th rowspan="2">담당</th><th rowspan="2">인원</th><th colspan="5">누계 접촉</th><th colspan="2" class="wk">주차 접촉</th><th colspan="4">미접촉 사유</th><th rowspan="2">임대<br>의원</th></tr>
        <tr><th>상담</th><th>단순</th><th>TM</th><th>계</th><th>접촉률</th><th class="wk">계</th><th class="wk">접촉률</th><th>거부</th><th>부재</th><th>불명</th><th>미접촉</th></tr>
      </thead>
      <tbody>${glist.map(g => regRow(g)).join("")}</tbody>
      ${glist.length > 1 ? `<tfoot>${regRow(sum, "sum")}</tfoot>` : ""}
    </table>` : `<p class="empty">명부가 업로드되지 않았습니다.</p>`;

  // ---- 접촉 구성 막대 (HTML) ----
  const comp = [["접촉", good(sum), "#2f6fb5"], ["거부", sum.c["거부"] || 0, "#d9534f"], ["부재", sum.c["부재"] || 0, "#f0ad4e"], ["불명", sum.c["불명"] || 0, "#8a94a6"], ["미접촉", sum.c["미접촉"] || 0, "#d5dbe3"]];
  const compBar = sum.total ? `
    <div class="stack">${comp.map(([l, v, c]) => v ? `<i style="width:${v / sum.total * 100}%;background:${c}" title="${l}">${v / sum.total >= 0.07 ? `${Math.round(v / sum.total * 100)}%` : ""}</i>` : "").join("")}</div>
    <div class="legend">${comp.map(([l, v, c]) => `<span><em style="background:${c}"></em>${l} <b>${v}</b>명</span>`).join("")}</div>` : "";

  // ---- 주요 사항 (자동 요약) ----
  const notes = [];
  if (sum.total) {
    notes.push(`누계 접촉 <b>${good(sum)}명 / ${sum.total}명 (${pct(good(sum), sum.total)})</b>, 주차 접촉 <b>${sum.wGood}명 (${pct(sum.wGood, sum.total)})</b>`);
    const ranked = glist.filter(g => g.total >= 5 && good(g) > 0).sort((a, b) => pctN(good(b), b.total) - pctN(good(a), a.total));
    if (!single && ranked.length >= 2) {
      const hi = ranked[0], lo = ranked[ranked.length - 1];
      notes.push(`접촉률 최고 <b>${esc(hi.name)} ${pct(good(hi), hi.total)}</b> · 최저 <b>${esc(lo.name)} ${pct(good(lo), lo.total)}</b>`);
    }
    const refuse = sum.c["거부"] || 0;
    if (refuse) {
      const top = glist.filter(g => g.c["거부"]).sort((a, b) => b.c["거부"] - a.c["거부"]).slice(0, 3).map(g => `${esc(g.name)} ${g.c["거부"]}`).join(", ");
      notes.push(`거부 <b>${refuse}명</b>${single ? "" : ` (${top})`}`);
    }
    const un = glist.find(g => g.name === "미배정");
    if (!single && un) notes.push(`미배정 <b>${un.total}명</b> 중 미접촉 ${un.c["미접촉"] || 0}명 — 담당 배정 필요`);
  }
  const stanceCh = charts.stance;
  const stanceChips = stanceCh ? stanceCh.data.labels.map(l => { const m = String(l).match(/^(.*)\s(\d+)명$/); return m ? `<span class="chip${m[1] === "미정" ? " muted" : ""}">${esc(m[1])} <b>${m[2]}</b></span>` : ""; }).join("") : "";

  // ---- 주차 ----
  const weekMonth = state.selectedWeeklyMonth || "";
  const wk = computeWeeklyForReport(site, weekMonth);
  const monthNo = Number(weekMonth.slice(5, 7)) || "";
  const maxWk = Math.max(1, ...wk.list.flatMap(g => wk.W.map(w => (g.wk[w] || new Set()).size)));
  const heat = n => n ? `rgba(47,111,181,${0.08 + 0.5 * n / maxWk})` : "transparent";
  const bbBy = {};
  rows.forEach(x => { if (GOOD.includes(x.weekMethod)) bbBy[x.chajang || "(담당 미지정)"] = (bbBy[x.chajang || "(담당 미지정)"] || 0) + 1; });
  const wkRow = (g, isSum) => `<tr class="${isSum ? "sum" : ""}"><td class="nm">${esc(g.name)}</td>
    ${wk.W.map(w => { const n = (g.wk[w] || new Set()).size, c = g.wkCnt[w] || 0;
      return `<td class="hc" style="${isSum ? "" : `background:${heat(n)}`}">${n ? `<b>${n}</b><small>명 · ${c}건</small>` : `<span class="muted">-</span>`}</td>`; }).join("")}
    <td class="strong">${g.all.size}</td><td class="wk strong">${isSum ? Object.values(bbBy).reduce((a, b) => a + b, 0) : (bbBy[g.name] || 0)}</td></tr>`;
  const weekTable = wk.list.length ? `
    <table class="t wkt">
      <thead><tr><th>담당</th>${wk.W.map((w, i) => `<th>${w}주<small>${shortMD(wk.ranges[i].start)}~${shortMD(wk.ranges[i].end)}</small></th>`).join("")}<th>${monthNo}월 실접촉<small>중복 제외</small></th><th class="wk">주차 접촉<small>명부 기준</small></th></tr></thead>
      <tbody>${wk.list.map(g => wkRow(g)).join("")}</tbody>
      ${wk.list.length > 1 ? `<tfoot>${wkRow(wk.tot, true)}</tfoot>` : ""}
    </table>` : `<p class="empty">이 달 접촉 기록이 없습니다.</p>`;
  // 주차별 전체 막대 (HTML)
  const wTot = wk.W.map(w => ({ n: (wk.tot.wk[w] || new Set()).size, c: wk.tot.wkCnt[w] || 0 }));
  const wMax = Math.max(1, ...wTot.map(x => x.c));
  const weekBars = wk.W.length ? `
    <div class="vbars">${wTot.map(x => `<div class="vb"><div class="col a" style="height:${x.n / wMax * 100}%"><span>${x.n}</span></div><div class="col b" style="height:${x.c / wMax * 100}%"><span>${x.c}</span></div></div>`).join("")}</div>
    <div class="vlabels">${wTot.map((x, i) => `<div>${i + 1}주<small>${shortMD(wk.ranges[i].start)}~${shortMD(wk.ranges[i].end)}</small></div>`).join("")}</div>
    <div class="legend" style="justify-content:center"><span><em style="background:#2f6fb5"></em>접촉 인원</span><span><em style="background:#a9c4e4"></em>접촉 건수</span></div>` : "";

  const plist = single ? buildPersonListHtml(site, single, regDate, weekMonth) : null;
  const kpi = sum.total ? [
    { l: tgt ? (single ? `담당 ${tgt}` : tgt) : (single ? "담당 조합원" : "조합원"), v: fmtNum(sum.total), u: "명", s: state.targetType === "임대의원" ? `조합장·감사·이사·대의원` : `임대의원 ${sum.lease}명` },
    { l: "누계 접촉", v: fmtNum(good(sum)), u: "명", s: `접촉률 ${pct(good(sum), sum.total)}`, p: pctN(good(sum), sum.total) },
    { l: "주차 접촉", v: fmtNum(sum.wGood), u: "명", s: `접촉률 ${pct(sum.wGood, sum.total)}`, p: pctN(sum.wGood, sum.total) },
    { l: `${monthNo}월 실접촉`, v: fmtNum(wk.tot.all.size), u: "명", s: `접촉 ${wk.tot.cnt}건` },
    { l: "거부 · 부재 · 불명", v: fmtNum((sum.c["거부"] || 0) + (sum.c["부재"] || 0) + (sum.c["불명"] || 0)), u: "명", s: `미접촉 ${sum.c["미접촉"] || 0}명` }
  ] : [];
  const kpiHtml = kpi.length ? `<div class="kpis">${kpi.map(k => `<div class="kpi"><div class="l">${esc(k.l)}</div><div class="v">${k.v}<span>${k.u}</span></div><div class="s">${esc(k.s)}</div>${k.p !== undefined ? `<div class="kbar"><i style="width:${k.p}%"></i></div>` : ""}</div>`).join("")}</div>` : "";
  const band = (title, sub, sm) => `<div class="band${sm ? " sm" : ""}"><div><div class="site">${esc(site.name || "현장")}</div><div class="ttl">${title}</div></div><div class="meta">${esc(who)}<br>기준일 ${esc(regDate || printedAt)}${sub ? `<br>${sub}` : ""}</div></div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(site.name || "현장")} 접촉현황 보고</title>
<style>
  @page { size: ${size} landscape; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: "Pretendard", "Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", sans-serif; color: #1f2937; font-size: 9pt; }
  .page { padding: 9mm 12mm 11mm; break-after: page; page-break-after: always; position: relative; min-height: ${size === "A3" ? "297mm" : "210mm"}; }
  .page:last-of-type { break-after: auto; page-break-after: auto; }
  .band { display: flex; justify-content: space-between; align-items: flex-end; background: #1f3b5c; color: #fff; border-radius: 6px; padding: 9px 16px 10px; margin-bottom: 9px; }
  .band.sm { padding: 5px 14px 6px; margin-bottom: 6px; }
  .band.sm .ttl { font-size: 12.5pt; }
  .band.sm .meta { font-size: 7.8pt; line-height: 1.35; }
  .band.sm .site { font-size: 7.5pt; }
  .band .site { font-size: 9pt; opacity: .75; letter-spacing: .5px; }
  .band .ttl { font-size: 17pt; font-weight: 800; letter-spacing: -0.5px; margin-top: 1px; }
  .band .meta { font-size: 8.5pt; text-align: right; line-height: 1.55; opacity: .9; }
  .kpis { display: grid; grid-template-columns: repeat(${Math.max(1, kpi.length)}, 1fr); gap: 8px; margin-bottom: 10px; }
  .kpi { border: 1px solid #e3e8ef; border-radius: 6px; padding: 7px 12px 8px; }
  .kpi .l { font-size: 8pt; color: #6b7280; font-weight: 600; }
  .kpi .v { font-size: 17pt; font-weight: 800; color: #1f3b5c; line-height: 1.2; letter-spacing: -0.5px; }
  .kpi .v span { font-size: 9pt; font-weight: 600; margin-left: 2px; color: #4b5563; }
  .kpi .s { font-size: 8pt; color: #6b7280; }
  .kpi .kbar { height: 4px; background: #e8eef6; border-radius: 2px; margin-top: 4px; overflow: hidden; }
  .kpi .kbar i { display: block; height: 100%; background: #2f6fb5; }
  h2 { font-size: 10.5pt; margin: 0 0 5px; color: #1f3b5c; display: flex; align-items: center; gap: 6px; }
  h2::before { content: ""; width: 4px; height: 12px; background: #2f6fb5; border-radius: 2px; }
  .t { width: 100%; border-collapse: collapse; font-size: 8.4pt; table-layout: fixed; }
  .t th, .t td { padding: 3px 5px; text-align: right; white-space: nowrap; border-bottom: 1px solid #edf0f4; overflow: hidden; text-overflow: ellipsis; }
  .t thead th { background: #f3f6fa; color: #374151; font-weight: 700; text-align: center; border-bottom: 1px solid #cfd8e3; font-size: 8pt; }
  .t thead tr:first-child th { border-top: 2px solid #1f3b5c; }
  .t thead tr.g th { border-bottom: 1px solid #dfe5ec; }
  .t th small { display: block; font-size: 6.8pt; font-weight: 400; color: #6b7280; }
  .t tbody tr:nth-child(even) td { background-color: #fafbfd; }
  .t td.nm { text-align: left; font-weight: 600; color: #111827; }
  .t td.strong { font-weight: 700; color: #1f3b5c; }
  .t td.neg { color: #b42318; }
  .t .muted, .t td.muted { color: #9ca3af; }
  .t .wk { background-color: #f4f8fd !important; }
  .t thead th.wk { background: #e6eef8; }
  .t tfoot td { font-weight: 800; background: #eef2f7 !important; border-top: 1.5px solid #1f3b5c; border-bottom: 2px solid #1f3b5c; }
  .barcell { padding: 2px 6px !important; }
  .bar { position: relative; height: 12px; background: #edf1f6; border-radius: 3px; }
  .bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; }
  .bar b { position: absolute; right: 4px; top: 0; font-size: 7.6pt; line-height: 12px; color: #1f2937; }
  .bottom { display: grid; grid-template-columns: 1.1fr 1.3fr 0.8fr; gap: 10px; margin-top: 10px; }
  .panel { border: 1px solid #e3e8ef; border-radius: 6px; padding: 8px 11px; }
  .panel h3 { font-size: 8.8pt; margin: 0 0 6px; color: #1f3b5c; }
  .stack { display: flex; height: 18px; border-radius: 4px; overflow: hidden; }
  .stack i { display: flex; align-items: center; justify-content: center; color: #fff; font-style: normal; font-size: 7.5pt; font-weight: 700; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 11px; margin-top: 6px; font-size: 7.8pt; color: #4b5563; }
  .legend em { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
  .notes { margin: 0; padding-left: 14px; font-size: 8.3pt; line-height: 1.65; color: #374151; }
  .notes b { color: #1f3b5c; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { background: #eef3f9; color: #1f3b5c; border-radius: 10px; padding: 2px 9px; font-size: 8pt; }
  .chip.muted { background: #f3f4f6; color: #6b7280; }
  .wkt td.hc b { font-size: 9pt; color: #1f3b5c; }
  .wkt td.hc small { font-size: 7pt; color: #6b7280; margin-left: 2px; }
  .wkt tfoot td small { font-size: 7pt; color: #4b5563; }
  .cols { display: grid; grid-template-columns: 63% 1fr; gap: 12px; align-items: start; }
  .vbars { display: flex; align-items: flex-end; gap: 12px; height: 42mm; padding: 14px 6px 0; border-bottom: 1px solid #cfd8e3; }
  .vb { flex: 1; display: flex; align-items: flex-end; gap: 3px; height: 100%; }
  .vb .col { flex: 1; position: relative; border-radius: 3px 3px 0 0; min-height: 1px; }
  .vb .col.a { background: #2f6fb5; } .vb .col.b { background: #a9c4e4; }
  .vb .col span { position: absolute; top: -13px; left: -4px; right: -4px; text-align: center; font-size: 7.3pt; font-weight: 700; color: #374151; }
  .vlabels { display: flex; gap: 12px; padding: 3px 6px 0; }
  .vlabels div { flex: 1; text-align: center; font-size: 7.8pt; font-weight: 700; color: #374151; }
  .vlabels small { display: block; font-weight: 400; font-size: 6.6pt; color: #6b7280; }
  .spacer { height: 18px; }
  .t.list { font-size: 7.5pt; }
  .t.list td { padding: 0.5px 5px; line-height: 1.24; }
  .t.list .pill { line-height: 11.5px; }
  .t.list td:nth-child(2) { text-align: left; font-weight: 600; }
  .t.list td span { font-weight: 400; color: #9ca3af; font-size: 6.8pt; }
  .t.list thead { display: table-header-group; }
  .t .c { text-align: center; }
  .pill { display: inline-block; min-width: 34px; padding: 0 6px; border-radius: 8px; font-size: 7.3pt; font-weight: 700; line-height: 13px; }
  .pill.g { background: #e3edf9; color: #1e4f8a; } .pill.r { background: #fde8e7; color: #b42318; }
  .pill.a { background: #fff3dc; color: #a15c07; } .pill.n { background: #f3f4f6; color: #9ca3af; font-weight: 400; }
  .empty { color: #6b7280; padding: 10px 0; }
  .foot { position: absolute; left: 12mm; right: 12mm; bottom: 4mm; display: flex; justify-content: space-between; font-size: 7pt; color: #9ca3af; }
</style></head><body>

<div class="page">
  ${band(`${tgt || "조합원"} 접촉현황 보고`)}
  ${kpiHtml}
  <h2>${single ? "접촉현황" : "담당별 접촉현황"}</h2>
  ${regTable}
  <div class="bottom">
    <div class="panel"><h3>접촉 구성${single ? "" : " (전체)"}</h3>${compBar || `<p class="empty">-</p>`}</div>
    <div class="panel"><h3>주요 사항</h3><ul class="notes">${notes.map(n => `<li>${n}</li>`).join("") || "<li>-</li>"}</ul></div>
    <div class="panel"><h3>시공사 지지 (접촉자 기준)</h3><div class="chips">${stanceChips || "-"}</div></div>
  </div>
  ${single ? `<div class="cols" style="margin-top:10px;grid-template-columns:58% 1fr"><div><h2>주차별 접촉 · ${monthNo}월</h2>${weekTable}</div><div class="panel"><h3>주차별 접촉 추이</h3>${weekBars}</div></div>` : ""}
  <div class="foot"><span>${esc(site.name || "")} · 조합원 접촉현황</span><span>출력 ${printedAt} · 1 / 2</span></div>
</div>

${single ? `
<div class="page">
  ${band(`담당 ${tgt || "조합원"} 명단 · ${plist.count}명${state.targetType ? "" : ` (임대의원 ${plist.lease}명)`}`, "", true)}
  ${plist.html}
  <div class="foot"><span>누계·주차: 명부 기준 접촉 상태 · 1~5주: ${monthNo}월 주차별 접촉 건수</span><span>출력 ${printedAt} · 2 / 2</span></div>
</div>` : `
<div class="page">
  ${band(`주차별 접촉현황 · ${monthNo}월`)}
  <div class="cols">
    <div><h2>담당별 주차 접촉 <span style="font-weight:400;font-size:8pt;color:#6b7280">(칸 색이 진할수록 접촉 인원이 많음)</span></h2>${weekTable}</div>
    <div>
      <div class="panel"><h3>주차별 접촉 추이 (전체)</h3>${weekBars}</div>
      <div class="panel" style="margin-top:8px"><h3>이 달 요약</h3><ul class="notes">
        <li>${monthNo}월 실접촉 <b>${wk.tot.all.size}명</b> · 접촉 <b>${wk.tot.cnt}건</b></li>
        ${(() => { const best = wTot.reduce((m, x, i) => x.n > m.n ? { n: x.n, i } : m, { n: -1, i: 0 }); return wTot.length ? `<li>가장 많이 만난 주: <b>${best.i + 1}주 (${best.n}명)</b></li>` : ""; })()}
        ${(() => { const top = wk.list.filter(g => g.name !== "미배정").sort((a, b) => b.all.size - a.all.size)[0]; return top ? `<li>실접촉 최다 담당: <b>${esc(top.name)} ${top.all.size}명</b></li>` : ""; })()}
      </ul></div>
    </div>
  </div>
  <div class="foot"><span>${esc(site.name || "")} · 조합원 접촉현황</span><span>출력 ${printedAt} · 2 / 2</span></div>
</div>`}

</body></html>`;
}

/* =========================================================
   임대의원 1장 요약 — 전체 + 차장별 명단을 A4 가로 한 장에
   ========================================================= */
function buildLeaseOnePageHtml(site, size) {
  const state = contactStateFor(site.id);
  const regDates = registryDates(site);
  const regDate = state.selectedRegDate || regDates[regDates.length - 1] || "";
  const printedAt = todayStr();
  const GOOD = ["상담", "단순상담", "TM"];
  const pctN = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;

  const months = [...new Set(site.contacts.map(c => monthKeyOf(c.date)).filter(m => /^\d{4}-\d{2}$/.test(m)))].sort();
  const month = state.selectedWeeklyMonth || months[months.length - 1] || "";
  const ranges = weekRangesOfMonth(month);
  const monthNo = Number(month.slice(5, 7)) || "";

  // 임대의원 명단 (명부 기준 — 예전 방식 저장이면 사람별 기록으로 대신)
  const rowsRaw = regDates.length ? registryRows(site, regDate, true) : [];
  const staleRegistry = !regDates.length || (rowsRaw.length && !rowsRaw[0].key);
  let people = registryPeople(site, regDate, true).filter(x => x.type === "임대의원");
  if (!people.length) {
    const m = {};
    site.contacts.filter(c => c.type === "임대의원" && c.name && leaseRoleOf(c.role)).forEach(c => {
      m[personKey(c)] = { key: personKey(c), chajang: c.chajang || "(담당 미지정)", role: c.role, cum: c.method || "미접촉", week: "" };
    });
    people = Object.values(m);
  }
  const leaseKeys = new Set(people.map(p => p.key));
  const cntByKey = {}, wkByKey = {}, wkSets = ranges.map(() => new Set()), wkCnt = ranges.map(() => 0);
  site.contacts.forEach(c => {
    if (!c.name || !isValidDateStr(c.date) || !ranges.length || c.date < ranges[0].start || c.date > ranges[ranges.length - 1].end) return;
    const k = personKey(c);
    if (!leaseKeys.has(k)) return;
    cntByKey[k] = (cntByKey[k] || 0) + 1;
    const w = weekIndexIn(ranges, c.date);
    if (w) { wkSets[w - 1].add(k); wkCnt[w - 1]++; (wkByKey[k] = wkByKey[k] || {})[w] = (wkByKey[k][w] || 0) + 1; }
  });

  const ROLE_ORDER = ["조합장", "부조합장", "감사", "이사", "대의원"];
  const roleIdx = r => { const i = ROLE_ORDER.findIndex(x => (r || "").includes(x)); return i < 0 ? 9 : i; };
  const stIdx = s => { const i = REG_STATUS.indexOf(s); return i < 0 ? 9 : i; };
  const by = {};
  people.forEach(p => (by[p.chajang] = by[p.chajang] || []).push(p));
  const names = Object.keys(by).sort((a, b) => (a === "미배정") - (b === "미배정") || a.localeCompare(b));
  // 접촉 = 이 달 주차별 기록에서 실제로 만난 사람 (명부 누계 상태가 아니라)
  const stat = list => {
    const o = { total: list.length, good: 0, wk: 0, refuse: 0, absent: 0, none: 0, met: 0, ba: 0 };
    list.forEach(p => {
      const met = !!cntByKey[p.key];
      if (met) o.good++; else if (p.cum === "거부") o.refuse++; else if (p.cum === "부재" || p.cum === "불명") o.absent++; else o.none++;
      if (GOOD.includes(p.cum)) o.ba++;
      if (GOOD.includes(p.week)) o.wk++;
      if (met) o.met++;
    });
    return o;
  };
  const all = stat(people);
  const C = { good: "#2f6fb5", refuse: "#d9534f", absent: "#f0ad4e", none: "#d5dbe3" };

  // ① 도넛 (SVG)
  const R = 42, CIRC = 2 * Math.PI * R;
  let off = 0;
  const segs = [["good", all.good], ["refuse", all.refuse], ["absent", all.absent], ["none", all.none]].filter(x => x[1]);
  const donut = `<svg viewBox="0 0 110 110" width="100%" height="100%">
    <circle cx="55" cy="55" r="${R}" fill="none" stroke="#eef2f7" stroke-width="14"/>
    ${segs.map(([k, v]) => { const len = v / (all.total || 1) * CIRC; const el = `<circle cx="55" cy="55" r="${R}" fill="none" stroke="${C[k]}" stroke-width="14" stroke-dasharray="${len} ${CIRC - len}" stroke-dashoffset="${-off}" transform="rotate(-90 55 55)"/>`; off += len; return el; }).join("")}
    <text x="55" y="53" text-anchor="middle" font-size="17" font-weight="800" fill="#1f3b5c">${pctN(all.good, all.total)}%</text>
    <text x="55" y="67" text-anchor="middle" font-size="7.5" fill="#6b7280">${monthNo}월 만난 비율</text></svg>`;

  // ② 담당별 구성 막대 (인원 기준, 길이 = 인원 수)
  const maxT = Math.max(1, ...names.map(n => by[n].length));
  const barRows = names.map(n => {
    const s = stat(by[n]);
    const seg = (k, v) => v ? `<i style="width:${v / maxT * 100}%;background:${C[k]}">${v / maxT >= 0.09 ? v : ""}</i>` : "";
    return `<div class="br"><div class="bn">${esc(n)}</div>
      <div class="bts"><div class="bt">${seg("good", s.good)}${seg("refuse", s.refuse)}${seg("absent", s.absent)}${seg("none", s.none)}</div>
        <div class="bt wkb"><i style="width:${s.wk / maxT * 100}%;background:#8fb8e3">${s.wk && s.wk / maxT >= 0.09 ? s.wk : ""}</i></div></div>
      <div class="bv"><b>${s.good}</b>/${s.total}<small>${pctN(s.good, s.total)}%</small><span class="wkv"> · 주${s.wk}</span></div></div>`;
  }).join("");

  // ③ 주차별 막대 (임대의원 접촉 인원)
  const wMax = Math.max(1, ...wkSets.map(s => s.size));
  const weekChart = ranges.length ? `<div class="wk">${ranges.map((r, i) => `
    <div class="wc"><div class="wbar"><i style="height:${wkSets[i].size / wMax * 100}%"><span>${wkSets[i].size}</span></i></div>
    <div class="wl">${i + 1}주<small>${shortMD(r.start)}~${shortMD(r.end)}</small></div></div>`).join("")}</div>` : "";

  // ④ 명단 카드
  const cls = s => ({ "상담": "g", "단순상담": "g", "TM": "g", "거부": "r", "부재": "a", "불명": "a", "미접촉": "n" }[s] || "n");
  const dotOf = p => cntByKey[p.key] ? "g" : (p.cum === "거부" ? "r" : (p.cum === "부재" || p.cum === "불명") ? "a" : "n");
  const shortM = s => s === "단순상담" ? "단순" : (s || "-");
  const nameOf = k => esc(((k || "").split("|")[0]).split(/\s+/)[0]);
  const W = ranges.map((_, i) => i + 1);
  const roleShort = r => ({ "조합장": "조합장", "부조합장": "부조합장", "감사": "감사", "이사": "이사", "대의원": "" }[r] ?? r);
  const cards = names.map(n => {
    const list = by[n].slice().sort((a, b) => roleIdx(a.role) - roleIdx(b.role) || stIdx(a.cum) - stIdx(b.cum) || a.key.localeCompare(b.key));
    const s = stat(list);
    const wSum = W.map(w => list.reduce((t, p) => t + ((wkByKey[p.key] || {})[w] || 0), 0));
    const tot = wSum.reduce((a, b) => a + b, 0);
    return `<div class="card"><div class="ch"><b>${esc(n)}</b><span>${s.good}/${s.total}명 만남</span></div>
      <table class="lt">
        <colgroup><col>${W.map(() => `<col class="cw">`).join("")}<col class="ct2"></colgroup>
        <thead><tr><th class="nmh">이름 <span>주차→</span></th>${W.map(w => `<th>${w}</th>`).join("")}<th>계</th></tr></thead>
        <tbody>${list.map(p => {
          const wk = wkByKey[p.key] || {}, t = cntByKey[p.key] || 0, r = roleShort(p.role);
          return `<tr><td class="nm"><span class="dot ${dotOf(p)}"></span>${nameOf(p.key)}${r ? `<span class="rl">${esc(r)}</span>` : ""}${p.cum === "거부" ? `<span class="rf">거부</span>` : ""}</td>
            ${W.map(w => `<td class="w${wk[w] >= 2 ? " hi" : ""}">${wk[w] || `<span class="z">·</span>`}</td>`).join("")}<td class="ct">${t || `<span class="z">-</span>`}</td></tr>`;
        }).join("")}</tbody>
        <tfoot><tr><td class="nm">차장 계</td>${wSum.map(v => `<td class="w">${v || "·"}</td>`).join("")}<td class="ct">${tot}</td></tr></tfoot>
      </table></div>`;
  }).join("");

  const refuse = people.filter(p => p.cum === "거부");
  const lo = names.filter(n => n !== "미배정" && by[n].length >= 3).map(n => ({ n, s: stat(by[n]) })).sort((a, b) => pctN(a.s.good, a.s.total) - pctN(b.s.good, b.s.total))[0];
  const busiest = wkSets.reduce((m, s, i) => s.size > m.v ? { v: s.size, i } : m, { v: -1, i: 0 });

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(site.name || "현장")} 임대의원 접촉현황</title>
<style>
  @page { size: ${size} landscape; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: "Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", sans-serif; color: #1f2937; font-size: 8pt; }
  .page { padding: 8mm 10mm 6mm; height: ${size === "A3" ? "297mm" : "210mm"}; overflow: hidden; display: flex; flex-direction: column; }
  .band { display: flex; justify-content: space-between; align-items: center; border-bottom: 2.5px solid #1f3b5c; padding: 0 2px 5px; margin-bottom: 7px; }
  .band .ttl { font-size: 16pt; font-weight: 800; color: #1f3b5c; letter-spacing: -0.5px; }
  .band .ttl small { font-size: 9pt; font-weight: 600; color: #6b7280; margin-right: 8px; }
  .band .meta { font-size: 8pt; color: #6b7280; text-align: right; line-height: 1.45; }
  .main { flex: 1; display: grid; grid-template-columns: 33% 1fr; grid-template-rows: minmax(0, 1fr); gap: 12px; min-height: 0; }
  .left { display: flex; flex-direction: column; gap: 7px; min-height: 0; overflow: hidden; }
  .left > .box { display: flex; flex-direction: column; }
  .left > .box.grow { flex: 1 1 auto; }
  .left > .box.grow .fill { flex: 1; display: flex; flex-direction: column; justify-content: space-evenly; }
  .left > .box.grow .wk { flex: 1; height: auto; min-height: 20mm; }
  .right { overflow: hidden; }
  .box { border: 1px solid #e3e8ef; border-radius: 7px; padding: 7px 11px; }
  .box h3 { margin: 0 0 6px; font-size: 9pt; color: #1f3b5c; display: flex; justify-content: space-between; align-items: baseline; }
  .box h3 small { font-weight: 400; font-size: 7pt; color: #6b7280; }
  .hero { display: grid; grid-template-columns: 30mm 1fr; gap: 8px; align-items: center; }
  .hero .d { width: 30mm; height: 30mm; }
  .kgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 10px; }
  .k .l { font-size: 7.3pt; color: #6b7280; } .k .v { font-size: 14pt; font-weight: 800; color: #1f3b5c; line-height: 1.15; } .k .v span { font-size: 7.5pt; color: #4b5563; margin-left: 1px; }
  .k.r .v { color: #b42318; }
  .legend { display: flex; gap: 10px; font-size: 7pt; color: #4b5563; margin-top: 4px; }
  .legend em { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 3px; vertical-align: -1px; }
  .br { display: grid; grid-template-columns: 13mm 1fr 22mm; align-items: center; gap: 6px; margin-bottom: 3px; }
  .bts { display: flex; flex-direction: column; gap: 1.5px; }
  .bt { height: 10px; }
  .bt.wkb { height: 5px; background: transparent; }
  .bt.wkb i { font-size: 5.5pt; }
  .bv .wkv { font-size: 6.4pt; color: #5b8cc4; }
  .bn { font-size: 7.8pt; font-weight: 700; color: #111827; white-space: nowrap; }
  .bt { display: flex; height: 11px; background: #f5f7fa; border-radius: 3px; overflow: hidden; }
  .bt i { display: flex; align-items: center; justify-content: center; color: #fff; font-style: normal; font-size: 6.6pt; font-weight: 700; }
  .bv { font-size: 7.4pt; color: #374151; white-space: nowrap; } .bv b { color: #1f3b5c; } .bv small { color: #6b7280; margin-left: 4px; font-size: 6.8pt; }
  .wk { display: flex; gap: 8px; height: 22mm; align-items: flex-end; padding-top: 10px; }
  .wc { flex: 1; display: flex; flex-direction: column; height: 100%; }
  .wbar { flex: 1; display: flex; align-items: flex-end; justify-content: center; border-bottom: 1px solid #cfd8e3; }
  .wbar i { position: relative; width: 62%; background: #2f6fb5; border-radius: 3px 3px 0 0; min-height: 1px; }
  .wbar i span { position: absolute; top: -12px; left: -6px; right: -6px; text-align: center; font-style: normal; font-size: 7.3pt; font-weight: 700; color: #1f3b5c; }
  .wl { text-align: center; font-size: 7.3pt; font-weight: 700; color: #374151; padding-top: 2px; } .wl small { display: block; font-weight: 400; font-size: 6.3pt; color: #6b7280; }
  .notes { margin: 0; padding-left: 13px; font-size: 7.6pt; line-height: 1.6; color: #374151; } .notes b { color: #1f3b5c; } .notes .r { color: #b42318; font-weight: 700; }
  .right { display: flex; flex-direction: column; min-height: 0; }
  .right h3 { margin: 0 0 5px; font-size: 9pt; color: #1f3b5c; display: flex; justify-content: space-between; align-items: baseline; }
  .right h3 small { font-weight: 400; font-size: 7pt; color: #6b7280; }
  .cards { column-count: 3; column-gap: 7px; flex: 1; min-height: 0; overflow: hidden; font-size: 7.4pt; }
  .main, .right { min-height: 0; }
  .card { break-inside: avoid; border: 1px solid #e3e8ef; border-radius: 6px; margin-bottom: 6px; overflow: hidden; }
  .card .ch { display: flex; justify-content: space-between; align-items: baseline; padding: 3px 8px; background: #f3f6fa; border-bottom: 1px solid #e3e8ef; }
  .card .ch b { font-size: 1.12em; color: #1f3b5c; } .card .ch span { font-size: 0.92em; color: #6b7280; }
  .lt { width: 100%; border-collapse: collapse; font-size: inherit; table-layout: fixed; }
  .lt col.cw { width: 1.75em; } .lt col.ct2 { width: 2.1em; }
  .lt td.nm { overflow: hidden; text-overflow: ellipsis; }
  .lt thead th.nmh span { font-weight: 400; color: #9ca3af; margin-left: 4px; }
  .lt td { padding: 0.7px 3px; border-bottom: 1px solid #f2f4f7; white-space: nowrap; }
  .lt td:first-child { padding-left: 6px; }
  .lt thead th { font-size: 0.82em; font-weight: 600; color: #6b7280; padding: 1.5px 2px; border-bottom: 1px solid #e3e8ef; text-align: center; }
  .lt thead th.nmh { text-align: left; padding-left: 6px; }
  .lt td.w { text-align: center; width: 1.9em; color: #1f3b5c; }
  .lt td.w.hi { font-weight: 800; background: #e8f0fa; }
  .lt tfoot td { border-top: 1px solid #cfd8e3; border-bottom: 0; background: #f7f9fc; font-weight: 700; color: #1f3b5c; font-size: 0.92em; }
  .lt .rf { margin-left: 3px; font-size: 0.8em; color: #b42318; font-weight: 700; }
  .lt tbody tr:last-child td { border-bottom: 0; }
  .lt .nm { font-weight: 600; color: #111827; } .lt .rl { color: #9ca3af; font-size: 0.82em; margin-left: 3px; font-weight: 400; }
  .lt .st { font-size: 0.95em; color: #374151; } .lt .ct { text-align: right; font-weight: 700; color: #1f3b5c; font-size: 0.95em; } .lt .z { color: #d1d5db; font-weight: 400; }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 4px; vertical-align: 1px; }
  .dot.g { background: #2f6fb5; } .dot.r { background: #d9534f; } .dot.a { background: #f0ad4e; } .dot.n { background: #cbd5e1; }
  .foot { display: flex; justify-content: space-between; font-size: 6.8pt; color: #9ca3af; margin-top: 3px; }
</style></head><body>
<div class="page">
  <div class="band">
    <div class="ttl"><small>${esc(site.name || "현장")}</small>임대의원 접촉현황</div>
    <div class="meta">기준일 ${esc(regDate || printedAt)} · 조합장·감사·이사·대의원<br>${staleRegistry ? `<b style="color:#b45309">명부 재업로드 시 누계·주차 상태까지 정확히 반영됩니다</b>` : `만남 = ${monthNo}월 주차별 기록 기준`}</div>
  </div>
  <div class="main">
    <div class="left">
      <div class="box">
        <div class="hero"><div class="d">${donut}</div>
          <div class="kgrid">
            <div class="k"><div class="l">임대의원</div><div class="v">${all.total}<span>명</span></div></div>
            <div class="k"><div class="l">${monthNo}월에 만난 인원</div><div class="v">${all.met}<span>명</span></div></div>
            <div class="k"><div class="l">명부 누계 접촉</div><div class="v">${all.ba}<span>명</span></div></div>
            <div class="k r"><div class="l">거부</div><div class="v">${all.refuse}<span>명</span></div></div>
          </div>
        </div>
        <div class="legend"><span><em style="background:${C.good}"></em>만남 ${all.good}</span><span><em style="background:${C.refuse}"></em>거부 ${all.refuse}</span><span><em style="background:${C.absent}"></em>부재·불명 ${all.absent}</span><span><em style="background:${C.none}"></em>못 만남 ${all.none}</span><span><em style="background:#8fb8e3"></em>주차 접촉 ${all.wk}</span></div>
      </div>
      <div class="box grow" style="flex-grow:2">
        <h3>담당별 ${monthNo}월 만남 현황 <small>막대 길이 = 인원 · 윗줄 만남 / 아랫줄 주차 접촉</small></h3>
        <div class="fill">${barRows}</div>
      </div>
      <div class="box grow">
        <h3>${monthNo}월 주차별 접촉 인원 <small>임대의원 중 그 주에 만난 사람</small></h3>
        ${weekChart}
      </div>
      <div class="box">
        <h3>주요 사항</h3>
        <ul class="notes">
          <li>임대의원 <b>${all.total}명</b> 중 ${monthNo}월에 <b>${all.good}명 만남 (${pctN(all.good, all.total)}%)</b> · 총 ${Object.values(cntByKey).reduce((a, b) => a + b, 0)}회</li>
          ${all.none ? `<li>${monthNo}월에 한 번도 못 만난 임대의원 <b>${all.none + all.absent}명</b>${people.filter(p => !cntByKey[p.key] && p.cum !== "거부").length <= 6 ? ` — ${people.filter(p => !cntByKey[p.key] && p.cum !== "거부").map(p => `${nameOf(p.key)}(${esc(p.chajang)})`).join(", ")}` : ""}</li>` : ""}
          ${refuse.length ? `<li><span class="r">거부 ${refuse.length}명</span> — ${refuse.map(p => `${nameOf(p.key)}(${esc(p.chajang)})`).join(", ")}</li>` : ""}
          ${lo ? `<li>만난 비율이 가장 낮은 담당: <b>${esc(lo.n)} ${pctN(lo.s.good, lo.s.total)}%</b> (${lo.s.good}/${lo.s.total}명)</li>` : ""}
          ${busiest.v > 0 ? `<li>${monthNo}월 가장 많이 만난 주: <b>${busiest.i + 1}주 ${busiest.v}명</b></li>` : ""}
        </ul>
      </div>
    </div>
    <div class="right">
      <h3>차장별 임대의원 · 주차별 만난 횟수 (${monthNo}월) <small><span class="dot g"></span>${monthNo}월 만남 <span class="dot r"></span>거부 <span class="dot a"></span>부재·불명 <span class="dot n"></span>못 만남 · 진한 칸 = 한 주에 2회 이상</small></h3>
      <div class="cards">${cards || `<p>임대의원 명단이 없습니다. 명부를 다시 업로드해주세요.</p>`}</div>
    </div>
  </div>
  <div class="foot"><span>${esc(site.name || "")} · 임대의원 접촉현황</span><span>출력 ${printedAt}</span></div>
</div>
<script>
/* 명단이 한 장에 다 들어가도록 글자 크기·열 수 자동 조절 */
function fitLeft() {
  var L = document.querySelector(".left"); if (!L) return;
  function over() { if (L.scrollHeight > L.clientHeight + 1) return true;
    for (var i = 0; i < L.children.length; i++) { var b = L.children[i]; if (b.scrollHeight > b.clientHeight + 1) return true; } return false; }
  var z = 1; L.style.zoom = 1;
  while (over() && z > 0.6) { z -= 0.03; L.style.zoom = z; }
}
window.addEventListener("beforeprint", fitLeft);
(function () {
  // 왼쪽(그래프): 넘치면 전체를 조금씩 축소
  fitLeft();
  var c = document.querySelector(".cards"); if (!c) return;
  var fs = 7.4, cols = 3, g = 0;
  function over() { return c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1; }
  while (!over() && fs < 10 && g++ < 30) { fs = Math.round((fs + 0.2) * 10) / 10; c.style.fontSize = fs + "pt"; }
  if (over()) { fs = Math.round((fs - 0.2) * 10) / 10; c.style.fontSize = fs + "pt"; }
  g = 0;
  while (over() && g++ < 40) {
    if (cols === 3 && fs <= 6.0) { cols = 4; c.style.columnCount = 4; fs = 6.8; }
    else fs = Math.round((fs - 0.2) * 10) / 10;
    c.style.fontSize = fs + "pt";
    if (fs < 5.6) break;
  }
})();
</script>
</body></html>`;
}

/* =========================================================
   보고서 1장 (A4 가로) — 전체 / 차장별 자동 전환
   왼쪽: 그래프  ·  오른쪽: 표(전체) 또는 명단(차장별)
   ========================================================= */
function buildOnePageReportHtml(site, size) {
  const state = contactStateFor(site.id);
  const single = state.selectedChajang.size === 1 ? [...state.selectedChajang][0] : "";
  const tgt = targetLabel(state);
  const regDates = registryDates(site);
  const regDate = state.selectedRegDate || regDates[regDates.length - 1] || "";
  const printedAt = todayStr();
  const GOOD = ["상담", "단순상담", "TM"];
  const pctN = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
  const C = { good: "#2f6fb5", refuse: "#d9534f", absent: "#f0ad4e", none: "#d5dbe3", wk: "#8fb8e3" };

  const months = [...new Set(site.contacts.map(c => monthKeyOf(c.date)).filter(m => /^\d{4}-\d{2}$/.test(m)))].sort();
  const month = state.selectedWeeklyMonth || months[months.length - 1] || "";
  const ranges = weekRangesOfMonth(month);
  const W = ranges.map((_, i) => i + 1);
  const monthNo = Number(month.slice(5, 7)) || "";

  // 명부 기준 사람 목록 (대상/담당 필터 반영)
  const people = regDates.length ? registryPeople(site, regDate) : [];
  const keys = new Set(people.map(p => p.key));

  // 이 달 주차별 접촉 (기록 기준)
  const wkByKey = {}, cntByKey = {};
  const byCj = {};
  selectedContacts(site).forEach(c => {
    if (!c.name || !isValidDateStr(c.date) || !ranges.length || c.date < ranges[0].start || c.date > ranges[ranges.length - 1].end) return;
    const k = personKey(c), w = weekIndexIn(ranges, c.date), cj = c.chajang || "(담당 미지정)";
    (wkByKey[k] = wkByKey[k] || {})[w] = (wkByKey[k][w] || 0) + 1;
    cntByKey[k] = (cntByKey[k] || 0) + 1;
    const g = byCj[cj] = byCj[cj] || { wk: {}, cnt: {}, all: new Set(), n: 0 };
    (g.wk[w] = g.wk[w] || new Set()).add(k); g.cnt[w] = (g.cnt[w] || 0) + 1; g.all.add(k); g.n++;
  });

  const stat = list => {
    const o = { total: list.length, lease: 0, good: 0, wk: 0, refuse: 0, absent: 0, none: 0, c: {} };
    list.forEach(p => {
      if (p.type === "임대의원") o.lease++;
      o.c[p.cum] = (o.c[p.cum] || 0) + 1;
      if (GOOD.includes(p.cum)) o.good++; else if (p.cum === "거부") o.refuse++; else if (p.cum === "부재" || p.cum === "불명") o.absent++; else o.none++;
      if (GOOD.includes(p.week)) o.wk++;
    });
    return o;
  };
  const by = {};
  people.forEach(p => (by[p.chajang] = by[p.chajang] || []).push(p));
  const names = Object.keys(by).sort((a, b) => (a === "미배정") - (b === "미배정") || a.localeCompare(b));
  const all = stat(people);
  const metAll = new Set(); Object.values(byCj).forEach(g => g.all.forEach(k => metAll.add(k)));
  const cntAll = Object.values(byCj).reduce((s, g) => s + g.n, 0);
  const wkPeopleAll = W.map(w => { const s = new Set(); Object.values(byCj).forEach(g => (g.wk[w] || new Set()).forEach(k => s.add(k))); return s.size; });
  const wkCntAll = W.map(w => Object.values(byCj).reduce((s, g) => s + (g.cnt[w] || 0), 0));

  // ---- 공통 그래프 ----
  const R = 42, CIRC = 2 * Math.PI * R; let off = 0;
  const donut = `<svg viewBox="0 0 110 110" width="100%" height="100%">
    <circle cx="55" cy="55" r="${R}" fill="none" stroke="#eef2f7" stroke-width="14"/>
    ${[["good", all.good], ["refuse", all.refuse], ["absent", all.absent], ["none", all.none]].filter(x => x[1]).map(([k, v]) => { const len = v / (all.total || 1) * CIRC; const e = `<circle cx="55" cy="55" r="${R}" fill="none" stroke="${C[k]}" stroke-width="14" stroke-dasharray="${len} ${CIRC - len}" stroke-dashoffset="${-off}" transform="rotate(-90 55 55)"/>`; off += len; return e; }).join("")}
    <text x="55" y="53" text-anchor="middle" font-size="17" font-weight="800" fill="#1f3b5c">${pctN(all.good, all.total)}%</text>
    <text x="55" y="67" text-anchor="middle" font-size="7.5" fill="#6b7280">누계 접촉률</text></svg>`;
  const hero = `<div class="box"><div class="hero"><div class="d">${donut}</div><div class="kgrid">
      <div class="k"><div class="l">${esc(tgt || "조합원")}</div><div class="v">${fmtNum(all.total)}<span>명</span></div></div>
      <div class="k"><div class="l">누계 접촉</div><div class="v">${fmtNum(all.good)}<span>명</span></div></div>
      <div class="k"><div class="l">주차 접촉</div><div class="v">${fmtNum(all.wk)}<span>명 · ${pctN(all.wk, all.total)}%</span></div></div>
      <div class="k"><div class="l">${monthNo}월 실접촉</div><div class="v">${fmtNum(metAll.size)}<span>명 · ${cntAll}건</span></div></div>
    </div></div>
    <div class="legend"><span><em style="background:${C.good}"></em>접촉 ${all.good}</span><span><em style="background:${C.refuse}"></em>거부 ${all.refuse}</span><span><em style="background:${C.absent}"></em>부재·불명 ${all.absent}</span><span><em style="background:${C.none}"></em>미접촉 ${all.none}</span></div></div>`;
  const wMax = Math.max(1, ...wkCntAll);
  const weekChart = W.length ? `<div class="box"><h3>${monthNo}월 주차별 접촉 <small><em class="sw" style="background:${C.good}"></em>인원 <em class="sw" style="background:${C.wk}"></em>건수</small></h3>
    <div class="wk">${W.map((w, i) => `<div class="wc"><div class="wbar"><i class="a" style="height:${wkPeopleAll[i] / wMax * 100}%"><span>${wkPeopleAll[i]}</span></i><i class="b" style="height:${wkCntAll[i] / wMax * 100}%"><span>${wkCntAll[i]}</span></i></div>
      <div class="wl">${w}주<small>${shortMD(ranges[i].start)}~${shortMD(ranges[i].end)}</small></div></div>`).join("")}</div></div>` : "";

  // 담당별 막대 (전체 모드)
  const maxT = Math.max(1, ...names.map(n => by[n].length));
  const barRows = names.map(n => {
    const s = stat(by[n]);
    const seg = (k, v) => v ? `<i style="width:${v / maxT * 100}%;background:${C[k]}">${v / maxT >= 0.08 ? v : ""}</i>` : "";
    return `<div class="br"><div class="bn">${esc(n)}</div><div class="bts"><div class="bt">${seg("good", s.good)}${seg("refuse", s.refuse)}${seg("absent", s.absent)}${seg("none", s.none)}</div>
      <div class="bt wkb"><i style="width:${s.wk / maxT * 100}%;background:${C.wk}"></i></div></div>
      <div class="bv"><b>${pctN(s.good, s.total)}%</b><small>${s.good}/${s.total}</small></div></div>`;
  }).join("");

  // 주요 사항
  const notes = [];
  if (all.total) {
    notes.push(`${esc(tgt || "조합원")} <b>${all.total}명</b> 중 누계 접촉 <b>${all.good}명 (${pctN(all.good, all.total)}%)</b>, 주차 접촉 ${all.wk}명`);
    if (!single) {
      const rk = names.filter(n => n !== "미배정" && by[n].length >= 5).map(n => ({ n, s: stat(by[n]) })).sort((a, b) => pctN(b.s.good, b.s.total) - pctN(a.s.good, a.s.total));
      if (rk.length >= 2) notes.push(`접촉률 최고 <b>${esc(rk[0].n)} ${pctN(rk[0].s.good, rk[0].s.total)}%</b> · 최저 <b>${esc(rk[rk.length - 1].n)} ${pctN(rk[rk.length - 1].s.good, rk[rk.length - 1].s.total)}%</b>`);
    }
    if (all.refuse) notes.push(`<span class="r">거부 ${all.refuse}명</span>${single ? ` — ${people.filter(p => p.cum === "거부").map(p => esc(p.key.split("|")[0])).slice(0, 6).join(", ")}` : ` (${names.map(n => ({ n, v: stat(by[n]).refuse })).filter(x => x.v).sort((a, b) => b.v - a.v).slice(0, 3).map(x => `${esc(x.n)} ${x.v}`).join(", ")})`}`);
    const bi = wkPeopleAll.reduce((m, v, i) => v > m.v ? { v, i } : m, { v: -1, i: 0 });
    if (bi.v > 0) notes.push(`${monthNo}월 가장 많이 만난 주: <b>${bi.i + 1}주 ${bi.v}명</b>`);
    const un = by["미배정"];
    if (!single && un) notes.push(`미배정 <b>${un.length}명</b> — 담당 배정 필요`);
  }
  const notesBox = `<div class="box"><h3>주요 사항</h3><ul class="notes">${notes.map(n => `<li>${n}</li>`).join("")}</ul></div>`;

  // ---- 오른쪽 ----
  let right = "";
  if (!single) {
    const tr = (n, s, g, isSum) => {
      const met = g ? g.all.size : 0;
      return `<tr class="${isSum ? "sum" : ""}"><td class="nm">${esc(n)}</td><td>${s.total}</td><td class="st">${s.good}</td>
        <td class="pc"><div class="pcw"><div class="pb"><i style="width:${pctN(s.good, s.total)}%"></i></div><b>${pctN(s.good, s.total)}%</b></div></td>
        <td class="wkc">${s.wk}</td>
        ${W.map(w => { const v = isSum ? wkPeopleAll[w - 1] : (g && g.wk[w] ? g.wk[w].size : 0); return `<td class="w">${v || `<span class="z">·</span>`}</td>`; }).join("")}
        <td class="st">${isSum ? metAll.size : met}</td>
        <td class="ng">${s.refuse || `<span class="z">·</span>`}</td><td>${s.absent || `<span class="z">·</span>`}</td><td class="z2">${s.none || "·"}</td><td>${s.lease}</td></tr>`;
    };
    right = `<h3 class="rh">담당별 접촉현황 <small>누계·주차 = 명부 기준 인원 · 1~${W.length}주 = 그 주에 만난 인원</small></h3>
      <div class="tbw"><table class="tb">
        <colgroup><col style="width:10%"><col style="width:5%"><col style="width:5%"><col style="width:14%"><col style="width:5.5%">${W.map(() => `<col style="width:${(30 / W.length).toFixed(2)}%">`).join("")}<col style="width:6%"><col style="width:4.5%"><col style="width:6.5%"><col style="width:5.5%"><col style="width:5%"></colgroup>
        <thead><tr><th rowspan="2" class="nmh">담당</th><th rowspan="2">인원</th><th colspan="2">누계 접촉</th><th rowspan="2" class="wkh">주차<br>접촉</th>
          <th colspan="${W.length}">${monthNo}월 주차별 만난 인원</th><th rowspan="2">${monthNo}월<br>실접촉</th><th colspan="3">미접촉 사유</th><th rowspan="2">임대<br>의원</th></tr>
          <tr><th>계</th><th>접촉률</th>${W.map((w, i) => `<th>${w}주<small>${shortMD(ranges[i].start)}~</small></th>`).join("")}<th>거부</th><th>부재·불명</th><th>미접촉</th></tr></thead>
        <tbody>${names.map(n => tr(n, stat(by[n]), byCj[n])).join("")}</tbody>
        <tfoot>${tr("합계", all, null, true)}</tfoot>
      </table></div>
      <div class="row2">${notesBox}
        <div class="box"><h3>시공사 지지 <small>접촉자 기준</small></h3><div class="chips">${(_contactCharts[site.id]?.stance?.data.labels || []).map(l => { const m = String(l).match(/^(.*)\s(\d+)명$/); return m ? `<span class="chip${m[1] === "미정" ? " mu" : ""}">${esc(m[1])} <b>${m[2]}</b></span>` : ""; }).join("")}</div></div></div>`;
  } else {
    const cls = s => ({ "상담": "g", "단순상담": "g", "TM": "g", "거부": "r", "부재": "a", "불명": "a", "미접촉": "n" }[s] || "n");
    const shortM = s => s === "단순상담" ? "단순" : (s || "-");
    const ROLE = ["조합장", "부조합장", "감사", "이사", "대의원"];
    const ri = r => { const i = ROLE.findIndex(x => (r || "").includes(x)); return i < 0 ? 9 : i; };
    const si = s => { const i = REG_STATUS.indexOf(s); return i < 0 ? 9 : i; };
    const list = people.slice().sort((a, b) => (a.type === "임대의원" ? ri(a.role) : 10) - (b.type === "임대의원" ? ri(b.role) : 10) || si(a.cum) - si(b.cum) || a.key.localeCompare(b.key));
    const wSum = W.map(w => list.reduce((t, p) => t + ((wkByKey[p.key] || {})[w] || 0), 0));
    right = `<h3 class="rh">${esc(single)} 차장 담당 명단 · ${list.length}명 <small><span class="dot g"></span> 접촉 &nbsp;<span class="dot r"></span> 거부 &nbsp;<span class="dot a"></span> 부재·불명 &nbsp;<span class="dot n"></span> 미접촉 · 1~${W.length} = ${monthNo}월 주차별 만난 횟수 (진한 칸 2회 이상)</small></h3>
      <div class="phead" id="phead"></div>
      <div class="plist">${list.map(p => {
        const wk = wkByKey[p.key] || {}, t = cntByKey[p.key] || 0;
        const [nm, bd] = p.key.split("|");
        return `<div class="pr${p.type === "임대의원" ? " ls" : ""}"><span class="dot ${cls(p.cum)}"></span><span class="pn">${esc((nm || "").split(/\s+/)[0])}</span><span class="pb2">${bd ? esc(bd.slice(0, 6)) : ""}</span><span class="rl">${p.type === "임대의원" ? esc(p.role) : ""}</span><span class="stt ${cls(p.cum)}">${esc(shortM(p.cum))}</span>${W.map(w => `<span class="w${wk[w] >= 2 ? " hi" : ""}">${wk[w] || "·"}</span>`).join("")}<span class="t">${t || "-"}</span></div>`;
      }).join("")}</div>
      <div class="psum"><span>주차별 합계</span>${W.map((w, i) => `<span><b>${w}주</b> ${wSum[i]}회</span>`).join("")}<span><b>계</b> ${wSum.reduce((a, b) => a + b, 0)}회</span></div>`;
  }

  const left = single
    ? `${hero}${weekChart.replace('class="box"', 'class="box grow"')}${notesBox}`
    : `${hero}<div class="box grow" style="flex-grow:2"><h3>담당별 접촉 <small>윗줄 누계 구성 · 아랫줄 주차 접촉 · 길이 = 인원</small></h3><div class="fill">${barRows}</div></div>${weekChart.replace('class="box"', 'class="box grow"')}`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(site.name || "현장")} 접촉현황 보고</title>
<style>
  @page { size: ${size} landscape; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: "Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", sans-serif; color: #1f2937; font-size: 8pt; }
  .page { padding: 8mm 10mm 6mm; height: ${size === "A3" ? "297mm" : "210mm"}; overflow: hidden; display: flex; flex-direction: column; }
  .band { display: flex; justify-content: space-between; align-items: center; border-bottom: 2.5px solid #1f3b5c; padding: 0 2px 5px; margin-bottom: 7px; }
  .band .ttl { font-size: 16pt; font-weight: 800; color: #1f3b5c; letter-spacing: -0.5px; } .band .ttl small { font-size: 9pt; font-weight: 600; color: #6b7280; margin-right: 8px; }
  .band .meta { font-size: 8pt; color: #6b7280; text-align: right; line-height: 1.45; }
  .main { flex: 1; display: grid; grid-template-columns: ${single ? "36%" : "34%"} 1fr; grid-template-rows: minmax(0, 1fr); gap: 12px; min-height: 0; }
  .left { display: flex; flex-direction: column; gap: 7px; min-height: 0; overflow: hidden; }
  .left > .box { display: flex; flex-direction: column; }
  .left > .box.grow { flex: 1 1 auto; }
  .left > .box.grow .fill { flex: 1; display: flex; flex-direction: column; justify-content: space-evenly; min-height: 0; }
  .left > .box.grow .wk { flex: 1; height: auto; min-height: 24mm; }
  .right { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .box { border: 1px solid #e3e8ef; border-radius: 7px; padding: 7px 11px; }
  .box h3, h3.rh { margin: 0 0 6px; font-size: 9pt; color: #1f3b5c; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .box h3 small, h3.rh small { font-weight: 400; font-size: 6.9pt; color: #6b7280; }
  .sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin: 0 2px 0 6px; vertical-align: -1px; }
  .hero { display: grid; grid-template-columns: 30mm 1fr; gap: 8px; align-items: center; } .hero .d { width: 30mm; height: 30mm; }
  .kgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 8px; }
  .k .l { font-size: 7.2pt; color: #6b7280; } .k .v { font-size: 13.5pt; font-weight: 800; color: #1f3b5c; line-height: 1.15; } .k .v span { font-size: 7.2pt; color: #4b5563; margin-left: 2px; font-weight: 600; }
  .legend { display: flex; flex-wrap: wrap; gap: 3px 10px; font-size: 7pt; color: #4b5563; margin-top: 4px; }
  .legend em { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 3px; vertical-align: -1px; }
  .br { display: grid; grid-template-columns: 13mm 1fr 15mm; align-items: center; gap: 6px; margin-bottom: 2.6px; }
  .bn { font-size: 7.6pt; font-weight: 700; color: #111827; white-space: nowrap; overflow: hidden; }
  .bts { display: flex; flex-direction: column; gap: 1.5px; }
  .bt { display: flex; height: 9px; background: #f5f7fa; border-radius: 2px; overflow: hidden; } .bt.wkb { height: 4px; background: transparent; }
  .bt i { display: flex; align-items: center; justify-content: center; color: #fff; font-style: normal; font-size: 6.3pt; font-weight: 700; }
  .bv { font-size: 7.3pt; white-space: nowrap; } .bv b { color: #1f3b5c; } .bv small { color: #9ca3af; margin-left: 3px; font-size: 6.5pt; }
  .wk { display: flex; gap: 8px; height: 26mm; align-items: flex-end; padding-top: 11px; }
  .wc { flex: 1; display: flex; flex-direction: column; height: 100%; }
  .wbar { flex: 1; display: flex; align-items: flex-end; justify-content: center; gap: 2px; border-bottom: 1px solid #cfd8e3; }
  .wbar i { position: relative; width: 38%; border-radius: 2px 2px 0 0; min-height: 1px; font-style: normal; }
  .wbar i.a { background: #2f6fb5; } .wbar i.b { background: #8fb8e3; }
  .wbar i span { position: absolute; top: -11px; left: -8px; right: -8px; text-align: center; font-size: 6.6pt; font-weight: 700; color: #1f3b5c; }
  .wl { text-align: center; font-size: 7pt; font-weight: 700; color: #374151; padding-top: 2px; } .wl small { display: block; font-weight: 400; font-size: 6.2pt; color: #6b7280; }
  .notes { margin: 0; padding-left: 13px; font-size: 7.6pt; line-height: 1.6; color: #374151; } .notes b { color: #1f3b5c; } .notes .r { color: #b42318; font-weight: 700; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; } .chip { background: #eef3f9; color: #1f3b5c; border-radius: 9px; padding: 1px 8px; font-size: 7.4pt; } .chip.mu { background: #f3f4f6; color: #6b7280; }
  .tbw { flex: 1 1 auto; min-height: 0; display: flex; }
  .tb { width: 100%; height: 100%; border-collapse: collapse; font-size: 8.2pt; table-layout: fixed; }
  .tb th, .tb td { padding: 2.6px 3px; text-align: center; border-bottom: 1px solid #edf0f4; white-space: nowrap; overflow: hidden; }
  .tb thead th { background: #f3f6fa; color: #374151; font-weight: 700; font-size: 7.2pt; border-bottom: 1px solid #cfd8e3; }
  .tb thead tr:first-child th { border-top: 2px solid #1f3b5c; }
  .tb th small { display: block; font-weight: 400; font-size: 6pt; color: #6b7280; }
  .tb th.nmh, .tb td.nm { text-align: left; padding-left: 6px; } .tb td.nm { font-weight: 700; color: #111827; }
  .tb tbody tr:nth-child(even) td { background: #fafbfd; }
  .tb td.st { font-weight: 700; color: #1f3b5c; } .tb td.ng { color: #b42318; } .tb td.z2, .tb .z { color: #cbd5e1; }
  .tb td.wkc, .tb th.wkh { background: #f1f6fc !important; color: #2f6fb5; font-weight: 700; }
  .tb td.w { color: #1f3b5c; }
  .tb td.pc { padding: 2px 5px; }
  .pcw { display: flex; align-items: center; gap: 4px; }
  .pb { position: relative; flex: 1 1 auto; min-width: 28px; height: 8px; background: #edf1f6; border-radius: 3px; } .pb i { position: absolute; left: 0; top: 0; bottom: 0; background: #2f6fb5; border-radius: 3px; }
  .pcw b { width: 3.3em; text-align: right; font-size: 7.2pt; color: #1f3b5c; }
  .tb th, .tb td { padding-top: 3.4px !important; padding-bottom: 3.4px !important; }
  .tb tfoot td { font-weight: 800; background: #eef2f7 !important; border-top: 1.5px solid #1f3b5c; border-bottom: 2px solid #1f3b5c; color: #1f3b5c; }
  .row2 { display: grid; grid-template-columns: 1.6fr 1fr; gap: 8px; margin-top: 8px; flex: 0 0 auto; }
  .plist { column-count: 2; column-gap: 12px; flex: 1; min-height: 0; overflow: hidden; font-size: 7.6pt; column-rule: 1px solid #edf0f4; }
  .pr { display: grid; grid-template-columns: 0.9em 4.2em 3.6em 3em 2.9em repeat(${W.length}, 1.55em) 1.9em; align-items: center; column-gap: 2px; padding: 0.9px 2px; border-bottom: 1px solid #f2f4f7; break-inside: avoid; white-space: nowrap; }
  .pr.ls { background: #f7faff; }
  .phead { display: flex; gap: 12px; font-size: 6.8pt; color: #6b7280; font-weight: 700; border-top: 2px solid #1f3b5c; border-bottom: 1px solid #cfd8e3; background: #f3f6fa; }
  .phead .pr { flex: 1; border: 0; background: transparent; padding: 2px; }
  .phead .pr span { text-align: left; } .phead .pr .w, .phead .pr .t { text-align: center; }
  .pr .pn { font-weight: 700; color: #111827; overflow: hidden; } .pr .pb2 { color: #b0b7c3; font-size: 0.85em; } .pr .rl { color: #2f6fb5; font-size: 0.85em; font-weight: 600; }
  .pr .stt { font-size: 0.88em; color: #374151; } .pr .stt.r { color: #b42318; font-weight: 700; } .pr .stt.n { color: #9ca3af; }
  .pr .w { text-align: center; color: #1f3b5c; } .pr .w.hi { background: #dbe8f7; font-weight: 800; border-radius: 2px; } .pr .t { text-align: right; font-weight: 800; color: #1f3b5c; }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; }
  .dot.g { background: #2f6fb5; } .dot.r { background: #d9534f; } .dot.a { background: #f0ad4e; } .dot.n { background: #cbd5e1; }
  .psum { display: flex; gap: 14px; justify-content: flex-end; font-size: 7.4pt; color: #374151; border-top: 1.5px solid #1f3b5c; padding-top: 3px; margin-top: 3px; }
  .psum span:first-child { margin-right: auto; font-weight: 700; color: #1f3b5c; } .psum b { color: #1f3b5c; }
  .foot { display: flex; justify-content: space-between; font-size: 6.8pt; color: #9ca3af; margin-top: 3px; }
</style></head><body>
<div class="page">
  <div class="band"><div class="ttl"><small>${esc(site.name || "현장")}</small>${single ? `${esc(single)} 차장 ` : ""}${esc(tgt || "조합원")} 접촉현황</div>
    <div class="meta">기준일 ${esc(regDate || printedAt)}${tgt ? ` · ${esc(tgt)}` : ""}<br>주차: ${ranges.length ? `${shortMD(ranges[0].start)} ~ ${shortMD(ranges[ranges.length - 1].end)}` : "-"} (${monthNo}월)</div></div>
  <div class="main"><div class="left">${left}</div><div class="right">${right}</div></div>
  <div class="foot"><span>${esc(site.name || "")} · 접촉현황 보고</span><span>출력 ${printedAt}</span></div>
</div>
<script>
var HEADW = ${JSON.stringify(W.map(w => `<span class="w">${w}</span>`).join(""))};
function fitLeft() {
  var L = document.querySelector(".left"); if (!L) return;
  function over() { if (L.scrollHeight > L.clientHeight + 1) return true;
    for (var i = 0; i < L.children.length; i++) { var b = L.children[i]; if (b.scrollHeight > b.clientHeight + 1) return true; } return false; }
  var z = 1; L.style.zoom = 1;
  while (over() && z > 0.6) { z -= 0.03; L.style.zoom = z; }
}
window.addEventListener("beforeprint", fitLeft);
(function () {
  fitLeft();
  var R = document.querySelector(".right"), zr = 1;
  var P = document.querySelector(".plist");
  function head(n) {
    var h = document.getElementById("phead"); if (!h) return;
    var one = '<div class="pr"><span></span><span>이름</span><span>생일</span><span>직책</span><span>누계</span>' + HEADW + '<span class="t">계</span></div>';
    h.innerHTML = new Array(n + 1).join(one);
    if (P) h.style.fontSize = getComputedStyle(P).fontSize;
  }
  if (P) {
    head(2);
    var fs = 7.6, cols = 2, g = 0;
    function over() { return P.scrollWidth > P.clientWidth + 1 || P.scrollHeight > P.clientHeight + 1; }
    // 공간이 남으면 글자를 키워서 꽉 채움
    while (!over() && fs < 10.5 && g++ < 30) { fs = Math.round((fs + 0.2) * 10) / 10; P.style.fontSize = fs + "pt"; }
    if (over()) { fs = Math.round((fs - 0.2) * 10) / 10; P.style.fontSize = fs + "pt"; }
    g = 0;
    while (over() && g++ < 40) {
      if (cols === 2 && fs <= 6.4) { cols = 3; P.style.columnCount = 3; fs = 6.8; } else fs = Math.round((fs - 0.2) * 10) / 10;
      P.style.fontSize = fs + "pt"; if (fs < 5) break;
    }
    head(cols);
  }
  while (R && R.scrollHeight > R.clientHeight + 1 && zr > 0.7) { zr -= 0.03; R.style.zoom = zr; }
})();
</script>
</body></html>`;
}

function printContactReport(site, size, builder) {
  const html = (builder || buildContactReportHtml)(site, size);
  let frame = document.getElementById("ctReportFrame");
  if (frame) frame.remove();
  frame = document.createElement("iframe");
  frame.id = "ctReportFrame";
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  const go = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) { alert("출력 중 문제가 발생했습니다: " + e.message); } };
  // 이미지가 모두 로드된 뒤 인쇄
  const imgs = [...doc.images];
  let left = imgs.length;
  if (!left) return setTimeout(go, 100);
  imgs.forEach(im => { if (im.complete) { if (--left === 0) setTimeout(go, 100); } else im.onload = im.onerror = () => { if (--left === 0) setTimeout(go, 100); }; });
}

/* 인쇄 전에 미리보기로 확인하고 싶을 때: 새 창에 보고서만 띄우기 */
function previewContactReport(site, size, builder) {
  const w = window.open("", "_blank");
  if (!w) { alert("팝업이 차단되었습니다. 브라우저 주소창 오른쪽에서 팝업 허용 후 다시 눌러주세요."); return; }
  w.document.open(); w.document.write((builder || buildContactReportHtml)(site, size).replace("</body>",
    `<div style="position:fixed;top:10px;right:14px" class="noprint"><button onclick="window.print()" style="font-size:14px;padding:8px 16px;background:#1e3a5f;color:#fff;border:0;border-radius:6px;cursor:pointer">🖨 인쇄</button></div>
     <style>@media print{.noprint{display:none}} @media screen{body{background:#e2e8f0}.page{background:#fff;width:${size === "A3" ? "420mm" : "297mm"};margin:12px auto;box-shadow:0 2px 8px rgba(0,0,0,.15)}}</style></body>`));
  w.document.close();
}

/* ---------- 메인 렌더 ---------- */
function renderContactTab(site) {
  // 다른 현장에서 만든 그래프가 남아있지 않도록 정리
  Object.keys(_contactCharts).forEach(destroyContactCharts);
  ensureContactData(site);
  const panel = document.querySelector('#siteDetailPanel [data-panel="contact"]');
  if (!panel) return;

  const state = contactStateFor(site.id);
  const chajangList = [...new Set(site.contacts.map(c => c.chajang).filter(Boolean))].sort();
  if (state.selectedChajang === null) state.selectedChajang = new Set();

  panel.innerHTML = `
    <div class="detail-card" style="display:flex;justify-content:flex-end;align-items:center;gap:6px">
      <span style="margin-right:auto;font-size:11px;color:var(--slate-500)">접촉현황 버전 ${CONTACT_TAB_VERSION}</span>
      <button id="ctPrintOne" class="btn btn-primary btn-sm" title="전체 또는 선택한 차장 기준, A4 한 장">📄 보고서 1장</button>
      <button id="ctReportPreview" class="btn btn-outline btn-sm" title="표·명단이 자세한 2장 보고서">📄 상세 2장</button>
      <button id="ctPrintLease" class="btn btn-outline btn-sm" title="임대의원 전체 + 차장별 명단을 A4 한 장에">📄 임대의원 1장 요약</button>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>차장 선택 (아래 모든 표·그래프가 이 선택 기준으로 바뀝니다)</h4>
        <button id="ctMergeToggle" class="btn btn-ghost btn-sm admin-only">🔗 담당 이름 합치기</button></div>
      <div id="ctMergePanel" class="hidden" style="background:var(--paper);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12.5px">
        <div style="margin-bottom:6px;color:var(--slate-500)">같은 사람인데 이름이 다르게 들어간 담당을 하나로 합칩니다. 합친 뒤에는 다음 명부 업로드 때도 자동으로 같은 이름으로 들어갑니다.</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <select id="ctMergeFrom" style="border:1px solid var(--slate-300);border-radius:6px;padding:5px 8px"></select>
          <span>→</span>
          <select id="ctMergeTo" style="border:1px solid var(--slate-300);border-radius:6px;padding:5px 8px"></select>
          <button id="ctMergeGo" class="btn btn-primary btn-sm">합치기</button>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:12px;font-weight:700;color:var(--slate-500);margin-right:2px">대상</span>
        <div id="ctTargetPills" style="display:flex;gap:6px"></div>
      </div>
      <div style="display:flex;gap:6px;align-items:flex-start">
        <span style="font-size:12px;font-weight:700;color:var(--slate-500);margin:5px 2px 0 0;white-space:nowrap">담당</span>
        <div id="ctChajangPills" style="display:flex;gap:6px;flex-wrap:wrap"></div>
      </div>
    </div>

    <div id="ctStaleWarn" class="detail-card hidden" style="background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;font-size:13px">
      ⚠ 저장된 명부가 <b>예전 방식</b>이라 이름·직책 정보가 없습니다. 그래서 접촉 기록이 없는 사람(예: 아직 못 만난 대의원)이 명단에서 빠지고, 예전 기록이 대신 보일 수 있습니다.<br>
      아래 <b>「📁 전체 명부 엑셀 업로드」</b>로 최신 명부를 한 번 다시 올려주세요.
    </div>
    <div class="detail-card">
      <div class="detail-card-head">
        <h4>📁 전체 명부 엑셀 업로드 (통합 — 추천)</h4>
      </div>
      <p class="hint" style="margin-bottom:10px">기존에 쓰시던 명부 엑셀 파일(이름/담당/임대의원/날짜별 접촉/시공사성향/친밀도 열이 있는 그 파일)을 그대로 올리면, 아래 모든 그래프(개별 접촉인원 추이·시공사 지지분포·성향 변화·친밀도 변화)가 한 번에 채워집니다. 여러 번 올려도 이미 반영된 날짜는 건너뛰고 새 내용만 추가돼요.</p>
      <input type="file" id="ctMasterExcelFile" accept=".xlsx,.xls" class="hidden">
      <button id="ctMasterExcelUpload" class="btn btn-primary btn-sm admin-only">📁 전체 명부 엑셀 업로드</button>
    </div>

    <div class="detail-card">
      <div class="detail-card-head">
        <h4>담당별 접촉현황 (명부 BA열 누계 · BB열 주차 기준)</h4>
        <select id="ctRegDateSelect" style="border:1px solid var(--slate-300);border-radius:6px;padding:5px 8px;font-size:12px"></select>
      </div>
      <p class="hint" style="margin-bottom:10px">명부의 조합원(B열=1) 전체를 담당별로 묶어서, <b>누계</b>는 "접촉" 열(BA), <b>주차</b>는 "주차접촉" 열(BB) 값으로 사람 수를 셉니다. 「염리4집계」 시트와 같은 방식이에요. 날짜는 명부를 올린 기준일입니다.</p>
      <div id="ctRegTabs" style="display:flex;gap:6px;margin-bottom:10px"></div>
      <div style="position:relative;height:240px;margin-bottom:14px"><canvas id="ctRegChart"></canvas></div>
      <div style="overflow-x:auto"><table id="ctRegTable" style="width:100%;border-collapse:collapse;font-size:12px"></table></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head">
        <h4>월별 담당자 접촉 건수 (날짜별 접촉 기록 기준)</h4>
        <select id="ctStatMonthSelect" style="border:1px solid var(--slate-300);border-radius:6px;padding:5px 8px;font-size:12px"></select>
      </div>
      <p class="hint" style="margin-bottom:10px">위 차장 선택이 그대로 적용됩니다. 명부의 접촉방법 칸(상담·단순상담·TM·거부·부재·불명 열에 적힌 날짜)을 날짜별 접촉과 맞춰서 집계하고, 알 수 없는 건은 회색 <b>구분없음</b>으로 표시돼요.</p>
      <div style="position:relative;height:220px;margin-bottom:14px"><canvas id="ctMonthlyStatChart"></canvas></div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:1px solid var(--slate-300)">
              <th style="text-align:left;padding:5px 4px;color:var(--slate-500)">담당</th>
              <th style="text-align:right;padding:5px 4px;color:var(--slate-500)">인원</th>
              <th style="text-align:right;padding:5px 4px;color:var(--slate-500)">상담</th>
              <th style="text-align:right;padding:5px 4px;color:var(--slate-500)">단순상담</th>
              <th style="text-align:right;padding:5px 4px;color:var(--slate-500)">TM</th>
              <th style="text-align:right;padding:5px 4px;color:var(--slate-500)">거부</th>
              <th style="text-align:right;padding:5px 4px;color:var(--slate-500)">부재</th>
              <th style="text-align:right;padding:5px 4px;color:var(--slate-500)">불명</th>
              <th style="text-align:right;padding:5px 4px;color:var(--slate-500);font-weight:700">총 건수</th>
            </tr>
          </thead>
          <tbody id="ctStatBody"></tbody>
        </table>
      </div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head">
        <h4>주차별 접촉 현황 <span class="hint" style="font-weight:400">(명부 KE~KI열과 같은 주차: 월~일, 1주 = 1일이 속한 주)</span></h4>
        <select id="ctWeeklyMonthSelect" style="border:1px solid var(--slate-300);border-radius:6px;padding:5px 8px;font-size:12px"></select>
      </div>
      <p class="hint" id="ctWeekRangeHint" style="margin:-4px 0 10px"></p>
      <div id="ctWeeklyMetrics" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px"></div>
      <div style="font-size:12.5px;font-weight:700;margin-bottom:6px">담당별 주차별 접촉 인원 <span class="hint" style="font-weight:400">(칸: 인원·건수 / 그 주 접촉방법 — 접촉=상담·단순·TM)</span></div>
      <div id="ctWeeklySummary"></div>
      <div style="position:relative;height:240px;margin-bottom:16px"><canvas id="ctWeeklyByChajangChart"></canvas></div>
      <div style="font-size:12.5px;font-weight:700;margin-bottom:6px">인원별 주차별 접촉 <span class="hint" style="font-weight:400">(담당 이름을 눌러 펼치기)</span></div>
      <div id="ctWeeklyByChajang" style="margin-bottom:14px"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div>
          <div class="hint" style="margin-bottom:6px">이 달 주차별 접촉 인원·건수</div>
          <div style="position:relative;height:180px"><canvas id="ctWeeklyChart"></canvas></div>
        </div>
        <div>
          <div class="hint" style="margin-bottom:6px">월별 총 접촉 건수 추이</div>
          <div style="position:relative;height:180px"><canvas id="ctMonthlyTrendChart"></canvas></div>
        </div>
      </div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>요약</h4></div>
      <div id="ctMetrics" style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px"></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head">
        <h4>개별 접촉 인원 추이 <span class="hint" style="font-weight:400">(기간 내 중복 제외 인원)</span></h4>
        <div id="ctPeriodPills" style="display:flex;gap:6px"></div>
      </div>
      <div style="position:relative;height:220px"><canvas id="ctContactChart"></canvas></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>현재 시공사 지지 분포</h4></div>
      <div style="position:relative;height:200px"><canvas id="ctStanceChart"></canvas></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4 id="ctMethodTitle">접촉방법 통계 (상담/단순상담/TM 등)</h4></div>
      <div style="position:relative;height:200px"><canvas id="ctMethodChart"></canvas></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>시공사 지지 성향 변화 추이 (월말 기준, 인원 비율)</h4></div>
      <div style="position:relative;height:210px"><canvas id="ctSentimentChart"></canvas></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>친밀도 변화 집계 (최초 → 최근)</h4></div>
      <p class="hint" style="margin:-4px 0 10px">성향·친밀도 변화는 직접 입력한 기록과 "전체 명부 업로드" 때마다 저장되는 스냅샷으로 계산합니다. 명부를 주기적으로 올리면 변화가 쌓여요.</p>
      <div id="ctIntimacyBoxes" style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px"></div>
      <div style="position:relative;height:190px"><canvas id="ctIntimacyChart"></canvas></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head">
        <h4>시공사 목록 관리</h4>
        <button id="ctAddCompany" class="btn btn-ghost btn-sm admin-only">+ 시공사 추가</button>
      </div>
      <div id="ctCompanyTags" style="display:flex;gap:6px;flex-wrap:wrap"></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head">
        <h4>접촉 대상자 명단 (개별 기록)</h4>
        <div style="display:flex;gap:6px">
          <button id="ctExcelUpload" class="btn btn-outline btn-sm admin-only">엑셀 업로드</button>
          <button id="ctExcelTemplate" class="btn btn-ghost btn-sm">양식 다운로드</button>
          <button id="ctExcelExport" class="btn btn-ghost btn-sm">📥 엑셀로 내보내기</button>
          <button id="ctAddContact" class="btn btn-primary btn-sm admin-only">+ 접촉 기록 추가</button>
        </div>
      </div>
      <input type="file" id="ctExcelFile" accept=".xlsx,.xls" class="hidden">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead>
            <tr style="border-bottom:1px solid var(--slate-300)">
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">날짜</th>
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">이름</th>
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">담당 차장</th>
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">구분</th>
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">직책</th>
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">접촉방법</th>
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">성향</th>
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">친밀도</th>
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">특이사항</th>
              <th style="width:24px"></th>
            </tr>
          </thead>
          <tbody id="ctContactBody"></tbody>
        </table>
      </div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head">
        <h4>특별행사 이력</h4>
        <div style="display:flex;gap:6px">
          <button id="ctAddEvent" class="btn btn-primary btn-sm admin-only">+ 행사 추가</button>
        </div>
      </div>
      <div style="overflow-x:auto;margin-bottom:14px">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead>
            <tr style="border-bottom:1px solid var(--slate-300)">
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">날짜</th>
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">행사 종류</th>
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">참여 인원</th>
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">메모</th>
              <th style="width:24px"></th>
            </tr>
          </thead>
          <tbody id="ctEventBody"></tbody>
        </table>
      </div>
      <div style="position:relative;height:190px"><canvas id="ctEventChart"></canvas></div>
    </div>
  `;

  renderChajangPills(site);
  renderPeriodPills(site);
  renderCompanyTags(site);
  renderContactTable(site);
  renderEventTable(site);
  renderTargetPills(site);
  renderStaleWarn(site);
  renderRegistryStatusSection(site);
  renderMonthlyStatSection(site);
  renderWeeklyPersonSection(site);
  rebuildContactCharts(site);
  bindContactTabEvents(site);
  bindMergePanel(site);
}

/* ---------- 담당 이름 합치기 ---------- */
function renderMergePanel(site) {
  const from = document.getElementById("ctMergeFrom"), to = document.getElementById("ctMergeTo");
  if (!from) return;
  const counts = allChajangCounts(site);
  const names = Object.keys(counts).sort((a, b) => a.localeCompare(b));
  const opt = n => `<option value="${esc(n)}">${esc(n)} (${counts[n]}건)</option>`;
  from.innerHTML = `<option value="">합칠 이름 (없앨 쪽)</option>` + names.map(opt).join("");
  to.innerHTML = `<option value="">남길 이름</option>` + names.map(opt).join("");
}
function bindMergePanel(site) {
  document.getElementById("ctMergeToggle")?.addEventListener("click", () => {
    const p = document.getElementById("ctMergePanel"); p.classList.toggle("hidden"); renderMergePanel(site);
  });
  document.getElementById("ctMergeGo")?.addEventListener("click", () => {
    const from = document.getElementById("ctMergeFrom").value, to = document.getElementById("ctMergeTo").value;
    if (!from || !to || from === to) { alert("합칠 이름과 남길 이름을 서로 다르게 골라주세요."); return; }
    if (!confirm(`"${from}" 담당을 "${to}"(으)로 합칠까요?\n"${from}"의 모든 기록이 "${to}" 담당으로 바뀝니다.`)) return;
    const n = mergeChajang(site, from, to);
    const st = contactStateFor(site.id); st.selectedChajang.delete(from);
    persist();
    refreshContactViews(site);
    renderMergePanel(site);
    alert(`"${from}" → "${to}" 합치기 완료 (접촉 기록 ${n}건)`);
  });
}

/* ---------- 차장 필터 ---------- */
function renderTargetPills(site) {
  const box = document.getElementById("ctTargetPills");
  if (!box) return;
  const state = contactStateFor(site.id);
  const opts = [["", "전체"], ["임대의원", "임대의원만"], ["조합원", "일반 조합원만"]];
  box.innerHTML = opts.map(([v, l]) => `<button class="btn ${state.targetType === v ? "btn-primary" : "btn-outline"} btn-sm ct-target" data-v="${v}">${l}</button>`).join("");
  box.querySelectorAll(".ct-target").forEach(b => b.onclick = () => {
    state.targetType = b.dataset.v;
    renderTargetPills(site);
    refreshContactViews(site);
  });
}

function renderChajangPills(site) {
  const box = document.getElementById("ctChajangPills");
  const state = contactStateFor(site.id);
  const regDates = registryDates(site);
  const regChajang = regDates.length ? registryRows(site, regDates[regDates.length - 1], true).map(x => x.chajang) : [];
  const chajangList = [...new Set(site.contacts.map(c => c.chajang).concat(regChajang).filter(Boolean))].sort();

  if (!chajangList.length) {
    box.innerHTML = `<p class="hint">등록된 개별 접촉 기록이 없습니다. 아래에서 추가해보세요.</p>`;
    return;
  }
  const allActive = state.selectedChajang.size === 0;
  box.innerHTML =
    `<button class="btn ${allActive ? "btn-primary" : "btn-outline"} btn-sm ct-pill" data-name="">전체</button>` +
    chajangList.map(name => {
      const on = state.selectedChajang.has(name);
      return `<button class="btn ${on ? "btn-primary" : "btn-outline"} btn-sm ct-pill" data-name="${esc(name)}">${esc(name)}</button>`;
    }).join("");

  box.querySelectorAll(".ct-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.name;
      if (!name) state.selectedChajang.clear();
      else state.selectedChajang = new Set([name]);
      refreshContactViews(site); // [수정 #4] 월별 담당자 집계까지 함께 필터
    });
  });
}

/* ---------- 기간 단위(일/주/월) 필터 ---------- */
function renderPeriodPills(site) {
  const box = document.getElementById("ctPeriodPills");
  const state = contactStateFor(site.id);
  box.innerHTML = PERIOD_MODES.map(([val, label]) =>
    `<button class="btn ${state.period === val ? "btn-primary" : "btn-outline"} btn-sm ct-period" data-val="${val}">${label}</button>`
  ).join("");
  box.querySelectorAll(".ct-period").forEach(btn => {
    btn.addEventListener("click", () => {
      state.period = btn.dataset.val;
      renderPeriodPills(site);
      rebuildContactCharts(site);
    });
  });
}

function selectedContacts(site) {
  const state = contactStateFor(site.id);
  return site.contacts.filter(c =>
    (!state.selectedChajang.size || state.selectedChajang.has(c.chajang)) &&
    (!state.targetType || (state.targetType === "임대의원" ? c.type === "임대의원" : c.type !== "임대의원")));
}
function targetLabel(state) {
  return state.targetType === "임대의원" ? "임대의원" : state.targetType === "조합원" ? "일반 조합원" : "";
}

/* ---------- 시공사 목록 ---------- */
function renderCompanyTags(site) {
  const box = document.getElementById("ctCompanyTags");
  box.innerHTML = site.companies.map(name => `
    <span class="tag" style="display:flex;align-items:center;gap:5px">
      ${esc(name)}
      <button class="ct-comp-del admin-only" data-name="${esc(name)}" style="border:none;background:none;color:var(--slate-500);cursor:pointer;font-size:11px">✕</button>
    </span>`).join("") || `<p class="hint">등록된 시공사가 없습니다.</p>`;

  box.querySelectorAll(".ct-comp-del").forEach(btn => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.name;
      if (!confirm(`"${name}"를 시공사 목록에서 삭제할까요? (기존 기록의 성향 값은 그대로 남습니다)`)) return;
      site.companies = site.companies.filter(c => c !== name);
      persist();
      renderCompanyTags(site);
      renderContactTable(site);
      rebuildContactCharts(site);
    });
  });
}

function stanceOptionsHtml(site, val) {
  const opts = [...site.companies, "미정"];
  if (val && !opts.includes(val)) opts.splice(opts.length - 1, 0, val); // 목록에서 삭제된 시공사 값도 그대로 보이게
  return opts.map(o => `<option ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("");
}

/* ---------- 접촉 대상자 명단 (개별 기록) ---------- */
function renderContactTable(site) {
  const body = document.getElementById("ctContactBody");
  const rows = selectedContacts(site).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const ro = roAttr();
  const inp = "border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px";
  const sel = "border:1px solid var(--slate-300);border-radius:5px;padding:3px 4px;font-size:12px";

  body.innerHTML = rows.map(c => `
    <tr data-id="${esc(c.id)}" style="border-bottom:1px solid var(--slate-100)">
      <td style="padding:5px 4px"><input type="date" class="ct-date" value="${isValidDateStr(c.date) ? c.date : ""}" ${ro} style="${inp}${isValidDateStr(c.date) ? "" : ";border-color:#e34948"}" title="${isValidDateStr(c.date) ? "" : "날짜 형식 오류: " + esc(c.date || "비어있음")}"></td>
      <td style="padding:5px 4px"><input type="text" class="ct-name" value="${esc(c.name || "")}" ${ro} style="${inp};width:64px"></td>
      <td style="padding:5px 4px"><input type="text" class="ct-chajang" value="${esc(c.chajang || "")}" placeholder="담당차장" ${ro} style="${inp};width:64px"></td>
      <td style="padding:5px 4px"><select class="ct-type" ${ro} style="${sel}">
        ${CONTACT_TYPES.map(t => `<option ${t === c.type ? "selected" : ""}>${t}</option>`).join("")}
      </select></td>
      <td style="padding:5px 4px"><select class="ct-role" ${ro} style="${sel}">
        ${ROLE_OPTIONS.concat(c.role && !ROLE_OPTIONS.includes(c.role) ? [c.role] : []).map(r => `<option value="${esc(r)}" ${r === (c.role || "") ? "selected" : ""}>${esc(r) || "-"}</option>`).join("")}
      </select></td>
      <td style="padding:5px 4px"><select class="ct-method" ${ro} style="${sel}">
        ${CONTACT_METHODS.map(m => `<option value="${esc(m)}" ${m === (c.method || "") ? "selected" : ""}>${m || "-"}</option>`).join("")}
      </select></td>
      <td style="padding:5px 4px"><select class="ct-stance" ${ro} style="${sel}">
        ${stanceOptionsHtml(site, c.stance)}
      </select></td>
      <td style="padding:5px 4px"><select class="ct-level" ${ro} style="${sel}">
        <option value="" ${c.level ? "" : "selected"}>-</option>${CONTACT_LEVELS.map(l => `<option ${l === c.level ? "selected" : ""}>${l}</option>`).join("")}
      </select></td>
      <td style="padding:5px 4px"><input type="text" class="ct-note" value="${esc(c.note || "")}" placeholder="특이사항" ${ro} style="${inp};width:100px"></td>
      <td style="padding:5px 4px"><button class="ct-del admin-only" style="border:none;background:none;color:var(--slate-300);cursor:pointer">✕</button></td>
    </tr>`).join("") || `<tr><td colspan="10" style="padding:14px 4px;color:var(--slate-500)">표시할 접촉 기록이 없습니다.</td></tr>`;

  if (ro) return; // 게스트는 보기 전용

  body.querySelectorAll("tr[data-id]").forEach(row => {
    const id = row.dataset.id;
    const contact = site.contacts.find(c => c.id === id);
    if (!contact) return;
    const upd = (field, val, tableToo) => {
      contact[field] = val;
      persist();
      refreshContactViews(site, { table: !!tableToo });
    };
    row.querySelector(".ct-date").addEventListener("change", e => upd("date", e.target.value));
    row.querySelector(".ct-name").addEventListener("change", e => upd("name", e.target.value.trim()));
    // 담당 변경 시 필터에서 빠질 수 있으므로 표도 다시 그림
    row.querySelector(".ct-chajang").addEventListener("change", e => upd("chajang", e.target.value.trim(), true));
    row.querySelector(".ct-type").addEventListener("change", e => upd("type", e.target.value));
    row.querySelector(".ct-role").addEventListener("change", e => upd("role", e.target.value));
    row.querySelector(".ct-method").addEventListener("change", e => upd("method", e.target.value));
    // 성향/친밀도를 직접 고치면 그 날짜의 실제 관측값으로 인정
    row.querySelector(".ct-stance").addEventListener("change", e => { contact.source = "manual"; upd("stance", e.target.value); });
    row.querySelector(".ct-level").addEventListener("change", e => { contact.source = "manual"; upd("level", e.target.value); });
    row.querySelector(".ct-note").addEventListener("change", e => { contact.note = e.target.value; persist(); });
    row.querySelector(".ct-del").addEventListener("click", () => {
      if (!confirm("이 접촉 기록을 삭제하시겠습니까?")) return;
      site.contacts = site.contacts.filter(c => c.id !== id);
      persist();
      refreshContactViews(site);
    });
  });
}

/* ---------- 특별행사 이력 ---------- */
function renderEventTable(site) {
  const body = document.getElementById("ctEventBody");
  const ro = roAttr();
  const rows = site.specialEvents.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  body.innerHTML = rows.map(ev => `
    <tr data-id="${esc(ev.id)}" style="border-bottom:1px solid var(--slate-100)">
      <td style="padding:5px 4px"><input type="date" class="ev-date" ${ro} value="${ev.date || ""}" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px"></td>
      <td style="padding:5px 4px"><input type="text" class="ev-type" ${ro} list="ctEventTypeList" value="${esc(ev.type || "")}" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px;width:80px"></td>
      <td style="padding:5px 4px"><input type="number" min="0" class="ev-count" ${ro} value="${ev.count || 0}" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px;width:56px"></td>
      <td style="padding:5px 4px"><input type="text" class="ev-note" ${ro} value="${esc(ev.note || "")}" placeholder="메모" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px;width:160px"></td>
      <td style="padding:5px 4px"><button class="ev-del admin-only" style="border:none;background:none;color:var(--slate-300);cursor:pointer">✕</button></td>
    </tr>`).join("") || `<tr><td colspan="5" style="padding:14px 4px;color:var(--slate-500)">등록된 행사가 없습니다.</td></tr>`;

  if (!document.getElementById("ctEventTypeList")) {
    const dl = document.createElement("datalist");
    dl.id = "ctEventTypeList";
    document.body.appendChild(dl);
  }
  document.getElementById("ctEventTypeList").innerHTML = DEFAULT_EVENT_TYPES.map(t => `<option value="${t}">`).join("");

  if (ro) return;

  body.querySelectorAll("tr[data-id]").forEach(row => {
    const id = row.dataset.id;
    const ev = site.specialEvents.find(e => e.id === id);
    if (!ev) return;
    row.querySelector(".ev-date").addEventListener("change", e => { ev.date = e.target.value; persist(); renderEventTable(site); rebuildContactCharts(site); });
    row.querySelector(".ev-type").addEventListener("change", e => { ev.type = e.target.value.trim(); persist(); rebuildContactCharts(site); });
    row.querySelector(".ev-count").addEventListener("change", e => { ev.count = Number(e.target.value) || 0; persist(); rebuildContactCharts(site); });
    row.querySelector(".ev-note").addEventListener("change", e => { ev.note = e.target.value; persist(); });
    row.querySelector(".ev-del").addEventListener("click", () => {
      if (!confirm("이 행사 기록을 삭제하시겠습니까?")) return;
      site.specialEvents = site.specialEvents.filter(e => e.id !== id);
      persist();
      renderEventTable(site);
      rebuildContactCharts(site);
    });
  });
}

/* =========================================================
   월별 담당자 접촉현황 집계 (엑셀 "OO집계" 시트 업로드)
   ========================================================= */
/* =========================================================
   담당별 접촉현황 — 명부 BA열(누계), BB열(주차) 기준 (「염리4집계」와 같은 계산)
   ========================================================= */
const REG_STATUS = ["상담", "단순상담", "TM", "거부", "부재", "불명", "미접촉"];
const REG_COLORS = { "상담": "#378add", "단순상담": "#eda100", "TM": "#1d9e75", "거부": "#e34948", "부재": "#8b5cf6", "불명": "#64748b", "미접촉": "#cbd5e1" };
function regStatusOf(v) {
  const raw = String(v ?? "").trim();
  if (!raw || raw.includes("미접촉")) return "미접촉";
  return parseMethod(raw) || "미접촉";
}
/* 명부 행 단위 현황을 작게 저장: { "2026-09-30": [[담당, 임대의원1/0, 누계idx, 주차idx], ...] }
   (엑셀 집계처럼 "행" 기준으로 세기 위해 사람 중복을 합치지 않음) */
function registryDates(site) {
  return Object.keys(site.registryStats || {}).sort();
}
function registryRows(site, date, ignoreFilter) {
  const state = contactStateFor(site.id);
  const raw = (site.registryStats || {})[date] || [];
  return raw.map(r => ({ chajang: r[0], type: r[1] ? "임대의원" : "조합원", cumMethod: REG_STATUS[r[2]] || "미접촉", weekMethod: REG_STATUS[r[3]] || "미접촉",
      key: r[4] || "", role: r[5] || "", stance: r[6] || "", level: r[7] || "" }))
    .filter(x => ignoreFilter || ((!state.selectedChajang.size || state.selectedChajang.has(x.chajang)) &&
      (!state.targetType || (state.targetType === "임대의원" ? x.type === "임대의원" : x.type !== "임대의원"))));
}

/* 명부 기준 사람 목록.
   명부현황이 예전 방식(이름 없음)으로 저장돼 있으면, 명부 업로드 때 함께 저장한
   사람별 기록(성향·친밀도 스냅샷: 이름·생년월일·담당·직책 포함)으로 대신 만듦 */
function registryPeople(site, regDate, ignoreFilter) {
  const rows = registryRows(site, regDate, ignoreFilter);
  if (rows.length && rows[0].key) return rows.map(x => ({ key: x.key, chajang: x.chajang || "(담당 미지정)", type: x.type, role: x.role || "", cum: x.cumMethod, week: x.weekMethod }));
  const snaps = (site.stanceSnapshots || []).filter(x => x.name);
  // 가장 최근 명부 업로드(기준일)에 들어 있던 사람만
  const inLatest = snaps.filter(x => x.date === regDate || x.confirmedUntil === regDate);
  const master = (inLatest.length ? inLatest : snaps).filter(x => x.origin === "master");
  const src = master.length ? master : (inLatest.length ? inLatest : snaps);
  const latest = {};
  src.forEach(x => { const k = personKey(x); if (!latest[k] || latest[k].date <= x.date) latest[k] = x; });
  // 최근 접촉방법 (누계 상태 대신)
  const lastM = {};
  site.contacts.forEach(c => { if (!c.name || !c.method) return; const k = personKey(c); if (!lastM[k] || lastM[k].d < c.date) lastM[k] = { d: c.date, m: c.method }; });
  const state = contactStateFor(site.id);
  return Object.entries(latest).map(([k, x]) => {
    const role = leaseRoleOf(x.role) ? x.role : "";
    return { key: k, chajang: x.chajang || "(담당 미지정)", type: role ? "임대의원" : "조합원", role, cum: lastM[k] ? lastM[k].m : "미접촉", week: "" };
  }).filter(p => ignoreFilter || ((!state.selectedChajang.size || state.selectedChajang.has(p.chajang)) &&
    (!state.targetType || (state.targetType === "임대의원" ? p.type === "임대의원" : p.type !== "임대의원"))));
}

function renderStaleWarn(site) {
  const el = document.getElementById("ctStaleWarn"); if (!el) return;
  const d = registryDates(site);
  const rows = d.length ? (site.registryStats[d[d.length - 1]] || []) : [];
  const stale = site.contacts.length > 0 && (!rows.length || !rows[0][4]);
  el.classList.toggle("hidden", !stale);
}
function renderRegistryStatusSection(site) {
  const sel = document.getElementById("ctRegDateSelect");
  if (!sel) return;
  const state = contactStateFor(site.id);
  const dates = registryDates(site);
  if (!state.selectedRegDate || !dates.includes(state.selectedRegDate)) state.selectedRegDate = dates[dates.length - 1] || null;
  if (!state.regMode) state.regMode = "cum";
  sel.innerHTML = dates.length ? dates.map(d => `<option value="${d}" ${d === state.selectedRegDate ? "selected" : ""}>${d} 기준</option>`).join("") : `<option value="">명부 업로드 필요</option>`;
  sel.onchange = () => { state.selectedRegDate = sel.value; renderRegistryStatusSection(site); };

  const tabs = document.getElementById("ctRegTabs");
  tabs.innerHTML = [["cum", "누계 (BA열)"], ["week", "주차 (BB열)"]].map(([v, l]) =>
    `<button class="btn ${state.regMode === v ? "btn-primary" : "btn-outline"} btn-sm ct-reg-tab" data-v="${v}">${l}</button>`).join("");
  tabs.querySelectorAll(".ct-reg-tab").forEach(b => b.onclick = () => { state.regMode = b.dataset.v; renderRegistryStatusSection(site); });

  const table = document.getElementById("ctRegTable");
  if (!dates.length) {
    table.innerHTML = `<tr><td style="padding:14px 4px;color:var(--slate-500)">"전체 명부 엑셀 업로드"로 명부를 올리면 담당별 현황이 나옵니다.</td></tr>`;
    if (_contactCharts[site.id]?.reg) { _contactCharts[site.id].reg.destroy(); delete _contactCharts[site.id].reg; }
    return;
  }

  const field = state.regMode === "week" ? "weekMethod" : "cumMethod";
  const rows = registryRows(site, state.selectedRegDate);
  const groups = {};
  rows.forEach(x => {
    const k = x.chajang || "(담당 미지정)";
    const g = groups[k] = groups[k] || { chajang: k, total: 0, lease: 0 };
    g.total++;
    if (x.type === "임대의원") g.lease++;
    const st = x[field] || "미접촉";
    g[st] = (g[st] || 0) + 1;
  });
  const list = Object.values(groups).sort((a, b) => a.chajang.localeCompare(b.chajang));
  const sumRow = { chajang: "합계", total: 0, lease: 0 };
  list.forEach(g => { sumRow.total += g.total; sumRow.lease += g.lease; REG_STATUS.forEach(k => sumRow[k] = (sumRow[k] || 0) + (g[k] || 0)); });
  const contacted = g => (g["상담"] || 0) + (g["단순상담"] || 0) + (g["TM"] || 0);
  const pct = (a, b) => b ? `${Math.round(a / b * 1000) / 10}%` : "-";

  const th = t => `<th style="text-align:right;padding:5px 4px;color:var(--slate-500)">${t}</th>`;
  const td = (v, extra = "") => `<td style="text-align:right;padding:4px;${extra}">${fmtNum(v || 0)}</td>`;
  const line = (g, bold) => `
    <tr style="border-bottom:1px solid var(--slate-100);${bold ? "border-top:2px solid var(--slate-300);font-weight:700" : ""}">
      <td style="padding:4px">${esc(g.chajang)}</td>${td(g.total)}
      ${td(g["상담"])}${td(g["단순상담"])}${td(g["TM"])}
      <td style="text-align:right;padding:4px;font-weight:700;color:var(--accent)">${fmtNum(contacted(g))}</td>
      <td style="text-align:right;padding:4px">${pct(contacted(g), g.total)}</td>
      ${td(g["거부"], "color:var(--slate-500)")}${td(g["부재"], "color:var(--slate-500)")}${td(g["불명"], "color:var(--slate-500)")}${td(g["미접촉"], "color:var(--slate-500)")}
      ${td(g.lease)}
    </tr>`;
  table.innerHTML = `
    <thead><tr style="border-bottom:1px solid var(--slate-300)">
      <th style="text-align:left;padding:5px 4px;color:var(--slate-500)">담당</th>${th("인원")}
      ${th("상담")}${th("단순")}${th("TM")}${th("<b>누계</b>")}${th("접촉률")}
      ${th("거부")}${th("부재")}${th("불명")}${th("미접촉")}${th("임대의원")}
    </tr></thead>
    <tbody>${list.map(g => line(g)).join("")}${list.length > 1 ? line(sumRow, true) : ""}</tbody>`;

  if (typeof Chart === "undefined") return;
  if (!_contactCharts[site.id]) _contactCharts[site.id] = {};
  if (_contactCharts[site.id].reg) _contactCharts[site.id].reg.destroy();
  _contactCharts[site.id].reg = new Chart(document.getElementById("ctRegChart"), {
    type: "bar",
    data: {
      labels: list.map(g => g.chajang),
      // 방법별로 막대를 나란히 표시 (쌓지 않음) + 막대 위에 숫자
      datasets: REG_STATUS.map(k => ({ label: k, data: list.map(g => g[k] || 0), backgroundColor: REG_COLORS[k], borderRadius: 4 }))
    },
    options: { responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });
}

function renderMonthlyStatSection(site) {
  const state = contactStateFor(site.id);
  const contacts = selectedContacts(site); // [수정 #4] 차장 선택 반영
  const months = [...new Set(contacts.map(c => monthKeyOf(c.date)).filter(m => /^\d{4}-\d{2}$/.test(m)))].sort();
  if (!state.selectedStatMonth || !months.includes(state.selectedStatMonth)) {
    state.selectedStatMonth = months.length ? months[months.length - 1] : null;
  }

  const sel = document.getElementById("ctStatMonthSelect");
  if (!sel) return;
  sel.innerHTML = months.length
    ? months.map(m => `<option value="${m}" ${m === state.selectedStatMonth ? "selected" : ""}>${m}</option>`).join("")
    : `<option value="">데이터 없음</option>`;
  sel.onchange = () => { state.selectedStatMonth = sel.value; renderMonthlyStatSection(site); };

  const rows = computeMonthlyStatRows(contacts, state.selectedStatMonth);
  const cell = "text-align:right;padding:4px";
  const body = document.getElementById("ctStatBody");
  let html = rows.map(s => `
    <tr style="border-bottom:1px solid var(--slate-100)">
      <td style="padding:4px">${esc(s.chajang)}</td>
      <td style="${cell}">${fmtNum(s.headcount)}</td>
      <td style="${cell}">${fmtNum(s.상담)}</td>
      <td style="${cell}">${fmtNum(s.단순상담)}</td>
      <td style="${cell}">${fmtNum(s.TM)}</td>
      <td style="${cell};color:var(--slate-500)">${fmtNum(s.거부)}</td>
      <td style="${cell};color:var(--slate-500)">${fmtNum(s.부재)}</td>
      <td style="${cell};color:var(--slate-500)">${fmtNum(s.불명)}</td>
      <td style="${cell};font-weight:700">${fmtNum(s.total)}</td>
    </tr>`).join("");
  if (rows.length > 1) {
    const sum = k => rows.reduce((a, r) => a + r[k], 0);
    // 합계 인원은 차장 간 중복 인원을 뺀 실제 인원
    const monthContacts = contacts.filter(c => monthKeyOf(c.date) === state.selectedStatMonth && c.name);
    const uniq = new Set(monthContacts.map(personKey)).size;
    html += `
    <tr style="border-top:2px solid var(--slate-300);font-weight:700">
      <td style="padding:4px">합계</td>
      <td style="${cell}">${fmtNum(uniq)}</td>
      ${["상담", "단순상담", "TM", "거부", "부재", "불명", "total"].map(k => `<td style="${cell}">${fmtNum(sum(k))}</td>`).join("")}
    </tr>`;
  }
  body.innerHTML = html || `<tr><td colspan="9" style="padding:14px 4px;color:var(--slate-500)">이 월에 접촉 기록이 없습니다.</td></tr>`;

  rebuildMonthlyStatChart(site, rows);
}

function computeMonthlyStatRows(contacts, monthKey) {
  if (!monthKey) return [];
  const byChajang = {};
  contacts.filter(c => monthKeyOf(c.date) === monthKey).forEach(c => {
    const key = c.chajang || "(담당 미지정)";
    if (!byChajang[key]) byChajang[key] = { chajang: key, people: new Set(), counts: {} };
    if (c.name) byChajang[key].people.add(personKey(c));
    const m = c.method || "";
    byChajang[key].counts[m] = (byChajang[key].counts[m] || 0) + 1;
  });
  return Object.values(byChajang).map(g => ({
    chajang: g.chajang,
    headcount: g.people.size,
    상담: g.counts["상담"] || 0,
    단순상담: g.counts["단순상담"] || 0,
    TM: g.counts["TM"] || 0,
    거부: g.counts["거부"] || 0,
    부재: g.counts["부재"] || 0,
    불명: g.counts["불명"] || 0,
    total: Object.values(g.counts).reduce((s, v) => s + v, 0)
  })).sort((a, b) => a.chajang.localeCompare(b.chajang));
}

function rebuildMonthlyStatChart(site, rows) {
  if (typeof Chart === "undefined") return;
  const canvas = document.getElementById("ctMonthlyStatChart");
  if (!canvas) return;
  if (_contactCharts[site.id]?.monthly) _contactCharts[site.id].monthly.destroy();

  // [수정 #10] 접촉방법 데이터가 있으면 상담/단순상담/TM, 없으면 인원·총 건수로 표시
  const hasMethod = rows.some(s => s.상담 + s.단순상담 + s.TM > 0);
  const datasets = hasMethod
    ? [
        { label: "상담", data: rows.map(s => s.상담), backgroundColor: "#378add", borderRadius: 4 },
        { label: "단순상담", data: rows.map(s => s.단순상담), backgroundColor: "#eda100", borderRadius: 4 },
        { label: "TM", data: rows.map(s => s.TM), backgroundColor: "#1d9e75", borderRadius: 4 },
        ...(rows.some(s => s.total - s.상담 - s.단순상담 - s.TM - s.거부 - s.부재 - s.불명 > 0)
          ? [{ label: "구분없음(명부)", data: rows.map(s => s.total - s.상담 - s.단순상담 - s.TM - s.거부 - s.부재 - s.불명), backgroundColor: "#cbd5e1", borderRadius: 4 }]
          : [])
      ]
    : [
        { label: "인원", data: rows.map(s => s.headcount), backgroundColor: "#378add", borderRadius: 4 },
        { label: "총 건수", data: rows.map(s => s.total), backgroundColor: "#1d9e75", borderRadius: 4 }
      ];

  const chart = new Chart(canvas, {
    type: "bar",
    data: { labels: rows.map(s => s.chajang), datasets },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });

  if (!_contactCharts[site.id]) _contactCharts[site.id] = {};
  _contactCharts[site.id].monthly = chart;
}

/* =========================================================
   인원별 주차별/월별 접촉 현황 (개별 접촉기록 site.contacts 기준으로
   자동 집계 — 별도 엑셀 업로드 없이 "전체 명부 엑셀 업로드"로 들어온
   데이터에서 바로 계산됩니다)
   ========================================================= */
/* 주차 구분 (명부 KE~KI열과 같은 방식)
   - 월요일~일요일을 한 주로 봄
   - 1주 = 그 달 1일이 들어있는 주 (예: 9월 1주 = 8/31~9/6)
   - 마지막 주는 말일까지 */
function weekRangesOfMonth(monthKey) {
  if (!/^\d{4}-\d{2}$/.test(monthKey || "")) return [];
  const [y, m] = monthKey.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const start = new Date(first); start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const last = new Date(y, m, 0);
  const out = [];
  for (let s = new Date(start); s <= last; s.setDate(s.getDate() + 7)) {
    const e = new Date(s); e.setDate(e.getDate() + 6);
    out.push({ start: formatDateLocal(s), end: formatDateLocal(e > last ? last : e) });
  }
  return out;
}
function weekIndexIn(ranges, dateStr) {
  for (let i = 0; i < ranges.length; i++) if (dateStr >= ranges[i].start && dateStr <= ranges[i].end) return i + 1;
  return 0;
}
function shortMD(d) { return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`; }

function renderWeeklyPersonSection(site) {
  const monthSel = document.getElementById("ctWeeklyMonthSelect");
  if (!monthSel) return;

  const contacts = selectedContacts(site);
  const months = [...new Set(contacts.map(c => monthKeyOf(c.date)).filter(m => /^\d{4}-\d{2}$/.test(m)))].sort();
  const state = contactStateFor(site.id);
  if (!state.selectedWeeklyMonth || !months.includes(state.selectedWeeklyMonth)) {
    state.selectedWeeklyMonth = months.length ? months[months.length - 1] : null;
  }
  monthSel.innerHTML = months.length
    ? months.map(m => `<option value="${m}" ${m === state.selectedWeeklyMonth ? "selected" : ""}>${m}</option>`).join("")
    : `<option value="">데이터 없음</option>`;
  monthSel.onchange = () => { state.selectedWeeklyMonth = monthSel.value; renderWeeklyPersonSection(site); };

  const ranges = weekRangesOfMonth(state.selectedWeeklyMonth);
  const W = ranges.map((_, i) => i + 1);
  const wkLabel = i => `${i + 1}주`;
  const wkRange = i => `${shortMD(ranges[i].start)}~${shortMD(ranges[i].end)}`;
  document.getElementById("ctWeekRangeHint").textContent = ranges.length
    ? ranges.map((r, i) => `${i + 1}주 ${shortMD(r.start)}~${shortMD(r.end)}`).join(" · ") : "";

  const monthContacts = contacts
    .filter(c => isValidDateStr(c.date) && ranges.length && c.date >= ranges[0].start && c.date <= ranges[ranges.length - 1].end)
    .sort((a, b) => a.date.localeCompare(b.date));

  // 사람별로 묶기 (이름+생년월일)
  const byKey = {};
  monthContacts.forEach(c => {
    if (!c.name) return;
    const k = personKey(c);
    const p = (byKey[k] = byKey[k] || { key: k, name: personLabel(c, site.contacts), chajang: c.chajang, type: c.type, role: c.role, weeks: {}, methods: {}, total: 0 });
    const wk = weekIndexIn(ranges, c.date);
    p.weeks[wk] = (p.weeks[wk] || 0) + 1;
    (p.methods[wk] = p.methods[wk] || []).push(c.method || "");
    p.total += 1;
    p.chajang = c.chajang || p.chajang;
    p.type = c.type || p.type;
  });
  const people = Object.values(byKey).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  // 요약 카드
  const totalPeople = people.length;
  const totalCount = people.reduce((s, p) => s + p.total, 0);
  const leaseCount = people.filter(p => p.type === "임대의원").length;
  const card = (label, val, color) => `
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">${label}</div>
      <div style="font-size:20px;font-weight:800;${color ? `color:${color}` : ""}">${val}</div>
    </div>`;
  document.getElementById("ctWeeklyMetrics").innerHTML =
    card("이 달 접촉 인원", `${totalPeople}명`) +
    card("임대의원 / 조합원", `${leaseCount} / ${totalPeople - leaseCount}`) +
    card("총 접촉 건수", `${totalCount}건`, "var(--accent)");

  // ---- 담당별 주차별 요약표 (「염리4집계(주차별)」처럼) ----
  const byChajang = {};
  people.forEach(p => {
    const key = p.chajang || "(담당 미지정)";
    const g = byChajang[key] = byChajang[key] || { 임대의원: [], 조합원: [], wkPeople: {}, wkCount: {}, wkGood: {}, wkRefuse: {}, wkAbsent: {} };
    g[p.type === "임대의원" ? "임대의원" : "조합원"].push(p);
    W.forEach(w => {
      if (!p.weeks[w]) return;
      g.wkPeople[w] = (g.wkPeople[w] || 0) + 1;
      g.wkCount[w] = (g.wkCount[w] || 0) + p.weeks[w];
      const ms = p.methods[w] || [];
      if (ms.some(m => m === "상담" || m === "단순상담" || m === "TM")) g.wkGood[w] = (g.wkGood[w] || 0) + 1;
      else if (ms.includes("거부")) g.wkRefuse[w] = (g.wkRefuse[w] || 0) + 1;
      else if (ms.includes("부재")) g.wkAbsent[w] = (g.wkAbsent[w] || 0) + 1;
    });
  });
  const chajangNames = Object.keys(byChajang).sort((a, b) => a.localeCompare(b));

  // BB열(주차접촉) — 가장 최근 명부 기준 담당별 상담+단순+TM 인원
  const regDates = registryDates(site);
  const bb = {};
  if (regDates.length) registryRows(site, regDates[regDates.length - 1]).forEach(x => {
    if (["상담", "단순상담", "TM"].includes(x.weekMethod)) bb[x.chajang || "(담당 미지정)"] = (bb[x.chajang || "(담당 미지정)"] || 0) + 1;
  });

  const thS = "text-align:right;padding:5px 4px;color:var(--slate-500);white-space:nowrap";
  const sumW = f => W.map(w => chajangNames.reduce((s, n) => s + (byChajang[n][f][w] || 0), 0));
  const cellW = (g, w) => g.wkPeople[w]
    ? `<b>${g.wkPeople[w]}</b><span style="color:var(--slate-500);font-size:11px">명·${g.wkCount[w]}건</span>`
      + `<div style="font-size:10.5px;color:var(--slate-500)">접촉${g.wkGood[w] || 0}·거부${g.wkRefuse[w] || 0}·부재${g.wkAbsent[w] || 0}</div>`
    : `<span style="color:var(--slate-300)">-</span>`;
  const totP = sumW("wkPeople"), totC = sumW("wkCount"), totG = sumW("wkGood"), totR = sumW("wkRefuse"), totA = sumW("wkAbsent");
  document.getElementById("ctWeeklySummary").innerHTML = chajangNames.length ? `
    <div style="overflow-x:auto;margin-bottom:14px">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="border-bottom:1px solid var(--slate-300)">
          <th style="text-align:left;padding:5px 4px;color:var(--slate-500)">담당</th>
          ${W.map((w, i) => `<th style="${thS}">${wkLabel(i)}<div style="font-weight:400;font-size:10.5px">${wkRange(i)}</div></th>`).join("")}
          <th style="${thS}" title="이 달에 한 번이라도 접촉한 사람 수 (여러 번 만나도 1명)">${Number((state.selectedWeeklyMonth || "").slice(5, 7)) || ""}월 실접촉 인원<div style="font-weight:400;font-size:10.5px">중복 제외</div></th>
          ${regDates.length ? `<th style="${thS}" title="명부 BB열(주차접촉)이 상담·단순·TM인 인원">BB 주차접촉<div style="font-weight:400;font-size:10.5px">${regDates[regDates.length - 1]}</div></th>` : ""}
        </tr></thead>
        <tbody>
          ${chajangNames.map(n => {
            const g = byChajang[n];
            return `<tr style="border-bottom:1px solid var(--slate-100)">
              <td style="padding:4px;white-space:nowrap">${esc(n)}</td>
              ${W.map(w => `<td style="text-align:right;padding:4px">${cellW(g, w)}</td>`).join("")}
              <td style="text-align:right;padding:4px;font-weight:700">${g.임대의원.length + g.조합원.length}</td>
              ${regDates.length ? `<td style="text-align:right;padding:4px;color:var(--accent);font-weight:700">${bb[n] || 0}</td>` : ""}
            </tr>`;
          }).join("")}
          <tr style="border-top:2px solid var(--slate-300);font-weight:700">
            <td style="padding:4px">합계</td>
            ${W.map((w, i) => `<td style="text-align:right;padding:4px">${totP[i]}<span style="color:var(--slate-500);font-size:11px;font-weight:400">명·${totC[i]}건</span><div style="font-size:10.5px;color:var(--slate-500);font-weight:400">접촉${totG[i]}·거부${totR[i]}·부재${totA[i]}</div></td>`).join("")}
            <td style="text-align:right;padding:4px">${totalPeople}</td>
            ${regDates.length ? `<td style="text-align:right;padding:4px;color:var(--accent)">${Object.values(bb).reduce((a, b) => a + b, 0)}</td>` : ""}
          </tr>
        </tbody>
      </table>
    </div>` : `<p class="hint">이 달 접촉 기록이 없습니다.</p>`;

  // ---- 사람별 표 ----
  const weeksHtml = p => W.map(w => `<td style="text-align:right;padding:4px">${p.weeks[w] ? fmtNum(p.weeks[w]) : "-"}</td>`).join("");
  function miniTable(title, list) {
    const sum = list.reduce((s, p) => s + p.total, 0);
    const wkSum = W.map(w => list.reduce((s, p) => s + (p.weeks[w] || 0), 0));
    return `
      <div style="flex:1;min-width:300px">
        <div style="font-size:12.5px;font-weight:700;margin-bottom:6px">${title} <span style="color:var(--slate-500);font-weight:400">(${list.length}명 · ${sum}건)</span></div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:1px solid var(--slate-300)">
              <th style="text-align:left;padding:4px;color:var(--slate-500)">이름</th>
              ${W.map((w, i) => `<th style="text-align:right;padding:4px;color:var(--slate-500)" title="${wkRange(i)}">${wkLabel(i)}</th>`).join("")}
              <th style="text-align:right;padding:4px;color:var(--slate-500);font-weight:700">합계</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(p => `<tr style="border-bottom:1px solid var(--slate-100)"><td style="padding:4px">${esc(p.name)}${p.role && p.type === "임대의원" && p.role !== "임대의원" ? ` <span style="color:var(--slate-500);font-size:11px">${esc(p.role)}</span>` : ""}</td>${weeksHtml(p)}<td style="text-align:right;padding:4px;font-weight:700">${fmtNum(p.total)}</td></tr>`).join("")
              || `<tr><td colspan="${W.length + 2}" style="padding:8px 4px;color:var(--slate-500)">없음</td></tr>`}
            ${list.length > 1 ? `<tr style="border-top:1px solid var(--slate-300);font-weight:700"><td style="padding:4px">소계</td>${wkSum.map(v => `<td style="text-align:right;padding:4px">${v || "-"}</td>`).join("")}<td style="text-align:right;padding:4px">${sum}</td></tr>` : ""}
          </tbody>
        </table>
      </div>`;
  }
  document.getElementById("ctWeeklyByChajang").innerHTML = chajangNames.map(name => {
    const g = byChajang[name];
    return `
      <details style="border:1px solid var(--slate-100);border-radius:8px;padding:10px 12px;margin-bottom:10px" ${chajangNames.length === 1 ? "open" : ""}>
        <summary style="font-size:13.5px;font-weight:800;cursor:pointer">👤 ${esc(name)} <span style="font-weight:400;font-size:12px;color:var(--slate-500)">임대의원 ${g.임대의원.length}명 · 조합원 ${g.조합원.length}명</span></summary>
        <div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:10px">
          ${miniTable("임대의원", g.임대의원)}
          ${miniTable("조합원", g.조합원)}
        </div>
      </details>`;
  }).join("");

  rebuildWeeklyCharts(site, people, months, { W, ranges, byChajang, chajangNames });
}

function rebuildWeeklyCharts(site, people, months, wk) {
  if (typeof Chart === "undefined") return;
  const key = site.id;
  if (!_contactCharts[key]) _contactCharts[key] = {};
  ["weekly", "monthlyTrend", "weeklyByChajang"].forEach(k => { if (_contactCharts[key][k]) _contactCharts[key][k].destroy(); });
  const { W, ranges, byChajang, chajangNames } = wk;
  const WEEK_COLORS = ["#93c5fd", "#60a5fa", "#378add", "#1d6fb8", "#1e4f8a", "#0f2f57"];

  // 담당별 주차별 접촉 인원 (나란히 막대)
  _contactCharts[key].weeklyByChajang = new Chart(document.getElementById("ctWeeklyByChajangChart"), {
    type: "bar",
    data: {
      labels: chajangNames,
      datasets: W.map((w, i) => ({ label: `${w}주 (${shortMD(ranges[i].start)}~${shortMD(ranges[i].end)})`, data: chajangNames.map(n => byChajang[n].wkPeople[w] || 0), backgroundColor: WEEK_COLORS[i % WEEK_COLORS.length], borderRadius: 4 }))
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });

  const weekTotals = W.map(w => people.reduce((s, p) => s + (p.weeks[w] || 0), 0));
  const weekPeople = W.map(w => people.filter(p => p.weeks[w]).length);
  _contactCharts[key].weekly = new Chart(document.getElementById("ctWeeklyChart"), {
    type: "bar",
    data: {
      labels: W.map((w, i) => `${w}주 ${shortMD(ranges[i].start)}~`),
      datasets: [
        { label: "접촉 인원", data: weekPeople, backgroundColor: "#378add", borderRadius: 4 },
        { label: "접촉 건수", data: weekTotals, backgroundColor: "#1d9e75", borderRadius: 4 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });

  const sc = selectedContacts(site);
  const monthlyTotals = months.map(m => sc.filter(c => monthKeyOf(c.date) === m).length);
  _contactCharts[key].monthlyTrend = new Chart(document.getElementById("ctMonthlyTrendChart"), {
    type: "line",
    data: {
      labels: months,
      datasets: [{ label: "총 접촉 건수", data: monthlyTotals, borderColor: "#1d9e75", backgroundColor: "rgba(29,158,117,0.12)", fill: true, tension: 0.3, borderWidth: 2, pointRadius: 3 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });
}

function numAt(row, idx) {
  const v = row[idx];
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}


/* ---------- 집계 + 차트 (개별 접촉 기록 기준) ---------- */
function buildRangeKeys(dates, mode) {
  const valid = dates.filter(isValidDateStr);
  if (mode === "month") return buildMonthRange(valid);
  const keys = [...new Set(valid.map(d => groupKeyOf(d, mode)))].sort();
  return keys.length ? keys : [groupKeyOf(todayStr(), mode)];
}
/* 첫 달~마지막 달 사이 빈 달도 0으로 채워서 추이가 끊기지 않게 */
function buildMonthRange(dates) {
  const ms = [...new Set(dates.filter(isValidDateStr).map(monthKeyOf))].sort();
  if (!ms.length) return [monthKeyOf(todayStr())];
  const out = [];
  let [y, m] = ms[0].split("-").map(Number);
  const last = ms[ms.length - 1];
  while (true) {
    const k = `${y}-${pad2(m)}`;
    out.push(k);
    if (k >= last || out.length > 120) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function rebuildContactCharts(site) {
  if (typeof Chart === "undefined") return;
  const siteCharts = _contactCharts[site.id] || {};
  ["contact", "stance", "method", "sentiment", "intimacy", "event"].forEach(k => { if (siteCharts[k]) siteCharts[k].destroy(); });
  const charts = { ...siteCharts };
  const contacts = selectedContacts(site);
  const state = contactStateFor(site.id);

  // 성향/친밀도 관측값 (수정 #7)
  const obsByKey = observationsFor(site, contacts.filter(c => c.name));
  const personKeys = Object.keys(obsByKey);
  const latestOf = k => obsByKey[k][obsByKey[k].length - 1];

  // [수정 #14] 시공사 목록에 없는 성향 값도 차트에서 빠지지 않게
  const extraStances = [...new Set(personKeys.map(k => latestOf(k).stance).concat(
    ...personKeys.map(k => obsByKey[k].map(o => o.stance))))]
    .filter(s => s && s !== "미정" && !site.companies.includes(s));
  const stanceLabels = [...site.companies, ...extraStances, "미정"];

  const mainCompany = site.companies[0];
  const poscoLike = mainCompany ? personKeys.filter(k => latestOf(k).stance === mainCompany).length : 0;

  let up = 0, down = 0, same = 0, single = 0, noLevel = 0;
  personKeys.forEach(k => {
    const list = obsByKey[k].filter(o => o.level in CONTACT_LEVEL_RANK); // 친밀도가 입력된 기록만 비교
    if (!list.length) { noLevel++; return; }
    if (list.length < 2) {
      if (list[0].confirmedUntil && list[0].confirmedUntil > list[0].date) same++; // 다음 명부에서도 같았음
      else single++;
      return;
    }
    const d = CONTACT_LEVEL_RANK[list[list.length - 1].level] - CONTACT_LEVEL_RANK[list[0].level];
    if (d > 0) up++; else if (d < 0) down++; else same++;
  });
  const totalEvents = site.specialEvents.reduce((s, e) => s + (Number(e.count) || 0), 0);

  document.getElementById("ctMetrics").innerHTML = `
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">접촉 대상자 수</div>
      <div style="font-size:20px;font-weight:800">${personKeys.length}명</div>
    </div>
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">${esc(mainCompany || "-")} 지지</div>
      <div style="font-size:20px;font-weight:800;color:var(--accent)">${poscoLike}명${personKeys.length ? ` <span style="font-size:12px;color:var(--slate-500);font-weight:600">(${Math.round(poscoLike / personKeys.length * 100)}%)</span>` : ""}</div>
    </div>
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">친밀도 상승</div>
      <div style="font-size:20px;font-weight:800;color:var(--ok)">${up}명</div>
    </div>
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">누적 행사 인원</div>
      <div style="font-size:20px;font-weight:800">${totalEvents}명</div>
    </div>`;

  // [수정 #6] 개별 접촉 "인원" = 기간 내 중복 제외 인원
  const validContacts = contacts.filter(c => isValidDateStr(c.date));
  const rangeKeys = buildRangeKeys(validContacts.map(c => c.date), state.period);
  const peopleIn = (type, k) => new Set(validContacts
    .filter(c => c.type === type && groupKeyOf(c.date, state.period) === k)
    .map(c => c.name ? personKey(c) : c.id)).size;

  charts.contact = new Chart(document.getElementById("ctContactChart"), {
    type: "bar",
    data: {
      labels: rangeKeys.map(k => groupLabel(k, state.period)),
      datasets: [
        { label: "임대의원", data: rangeKeys.map(k => peopleIn("임대의원", k)), backgroundColor: "#378add", borderRadius: 4 },
        { label: "조합원", data: rangeKeys.map(k => peopleIn("조합원", k)), backgroundColor: "#d85a30", borderRadius: 4 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });

  const stanceCounts = stanceLabels.map(label => personKeys.filter(k => (latestOf(k).stance || "미정") === label).length);
  charts.stance = new Chart(document.getElementById("ctStanceChart"), {
    type: "doughnut",
    data: {
      labels: stanceLabels.map((l, i) => `${l} ${stanceCounts[i]}명`),
      datasets: [{ data: stanceCounts, backgroundColor: stanceLabels.map((l, i) => l === "미정" ? "#94a3b8" : EVENT_COLORS[i % EVENT_COLORS.length]), borderColor: "#fff", borderWidth: 2 }]
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: "60%" }
  });

  // 명부가 올라와 있으면 BA열(누계) 기준 "사람 수", 아니면 날짜별 기록의 건수
  const regDates = registryDates(site);
  let methodLabelsOut, methodDataOut, methodColors;
  const titleEl = document.getElementById("ctMethodTitle");
  if (regDates.length) {
    const d = regDates[regDates.length - 1];
    const rr = registryRows(site, d);
    methodLabelsOut = REG_STATUS;
    methodDataOut = REG_STATUS.map(k => rr.filter(x => (x.cumMethod || "미접촉") === k).length);
    methodColors = REG_STATUS.map(k => REG_COLORS[k]);
    if (titleEl) titleEl.textContent = `접촉방법 통계 (명부 BA열 누계 · ${d} 기준 · 인원)`;
  } else {
    const methodLabels = CONTACT_METHODS.filter(Boolean);
    methodLabelsOut = [...methodLabels, "구분없음"];
    methodDataOut = [...methodLabels.map(m => contacts.filter(c => c.method === m).length), contacts.filter(c => !c.method).length];
    methodColors = [...methodLabels.map(() => "#8b5cf6"), "#cbd5e1"];
    if (titleEl) titleEl.textContent = "접촉방법 통계 (날짜별 기록 건수)";
  }
  charts.method = new Chart(document.getElementById("ctMethodChart"), {
    type: "bar",
    data: {
      labels: methodLabelsOut,
      datasets: [{ label: regDates.length ? "인원" : "건수", data: methodDataOut, backgroundColor: methodColors, borderRadius: 4 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });

  // [수정 #6, #7] 월말 시점 기준, "그때까지 관측된 사람들"의 최신 성향 비율
  const obsDates = personKeys.flatMap(k => obsByKey[k].map(o => o.date)).filter(isValidDateStr);
  const contactMonths = buildMonthRange(validContacts.map(c => c.date).concat(obsDates));
  const monthStates = contactMonths.map(m => {
    const end = monthEndOf(m);
    return personKeys.map(k => stateAsOf(obsByKey[k], end)).filter(Boolean);
  });
  charts.sentiment = new Chart(document.getElementById("ctSentimentChart"), {
    type: "line",
    data: {
      labels: contactMonths,
      datasets: stanceLabels.map((label, i) => ({
        label,
        data: monthStates.map(list => list.length ? Math.round(list.filter(o => (o.stance || "미정") === label).length / list.length * 100) : null),
        borderColor: label === "미정" ? "#94a3b8" : EVENT_COLORS[i % EVENT_COLORS.length],
        backgroundColor: "transparent",
        tension: 0.3, borderWidth: 2, pointRadius: 3, spanGaps: true
      }))
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: 100, ticks: { callback: v => v + "%" } } } }
  });

  document.getElementById("ctIntimacyBoxes").innerHTML = `
    <div style="background:#e1f5ee;border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:#04342c">상승</div>
      <div style="font-size:20px;font-weight:800;color:#04342c">${up}명</div>
    </div>
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">변화 없음</div>
      <div style="font-size:20px;font-weight:800">${same}명</div>
    </div>
    <div style="background:#fcebeb;border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:#501313">하락</div>
      <div style="font-size:20px;font-weight:800;color:#501313">${down}명</div>
    </div>
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">비교 불가 (기록 1회)</div>
      <div style="font-size:20px;font-weight:800;color:var(--slate-500)">${single}명</div>
      <div style="font-size:11px;color:var(--slate-500);margin-top:2px">친밀도 미입력 ${noLevel}명</div>
    </div>`;

  // 월말 기준 친밀도 인원 분포 (건수가 아니라 사람 수)
  charts.intimacy = new Chart(document.getElementById("ctIntimacyChart"), {
    type: "bar",
    data: {
      labels: contactMonths,
      datasets: [
        { label: "상", data: monthStates.map(l => l.filter(o => o.level === "상").length), backgroundColor: "#1baf7a", borderRadius: 4 },
        { label: "중", data: monthStates.map(l => l.filter(o => o.level === "중").length), backgroundColor: "#eda100", borderRadius: 4 },
        { label: "하", data: monthStates.map(l => l.filter(o => o.level === "하").length), backgroundColor: "#e34948", borderRadius: 4 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } }
  });

  const eventMonths = buildMonthRange(site.specialEvents.map(e => e.date));
  const eventTypesUsed = [...new Set(site.specialEvents.map(e => e.type).filter(Boolean))];
  const typesForChart = eventTypesUsed.length ? eventTypesUsed : DEFAULT_EVENT_TYPES;
  charts.event = new Chart(document.getElementById("ctEventChart"), {
    type: "bar",
    data: {
      labels: eventMonths,
      datasets: typesForChart.map((t, i) => ({
        label: `${t} (참여인원)`,
        data: eventMonths.map(m => site.specialEvents.filter(e => e.type === t && monthKeyOf(e.date) === m).reduce((s, e) => s + (Number(e.count) || 0), 0)),
        backgroundColor: EVENT_COLORS[i % EVENT_COLORS.length],
        borderRadius: 4
      }))
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });

  _contactCharts[site.id] = charts;
}

/* ---------- 버튼 동작 ---------- */
function bindContactTabEvents(site) {
  document.getElementById("ctPrintOne")?.addEventListener("click", () => previewContactReport(site, "A4", buildOnePageReportHtml));
  document.getElementById("ctReportPreview")?.addEventListener("click", () => previewContactReport(site, "A4"));
  document.getElementById("ctPrintLease")?.addEventListener("click", () => previewContactReport(site, "A4", buildLeaseOnePageHtml));

  document.getElementById("ctMasterExcelUpload")?.addEventListener("click", () => {
    document.getElementById("ctMasterExcelFile").click();
  });
  document.getElementById("ctMasterExcelFile")?.addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      try { importMasterRegistryExcel(site, evt.target.result); }
      catch (err) { alert("엑셀 파일을 읽는 중 문제가 발생했습니다: " + err.message); }
    };
    reader.readAsBinaryString(file);
    e.target.value = "";
  });

  document.getElementById("ctAddCompany")?.addEventListener("click", () => {
    const name = prompt("추가할 시공사 이름을 입력하세요.");
    if (!name || !name.trim()) return;
    if (site.companies.includes(name.trim())) { alert("이미 있는 시공사입니다."); return; }
    site.companies.push(name.trim());
    persist();
    renderCompanyTags(site);
    renderContactTable(site);
    rebuildContactCharts(site);
  });

  document.getElementById("ctAddContact")?.addEventListener("click", () => {
    // [수정 #8] 차장 필터가 켜져 있으면 그 차장으로 미리 채워서 새 행이 바로 보이게
    const state = contactStateFor(site.id);
    const preset = state.selectedChajang.size === 1 ? [...state.selectedChajang][0] : "";
    site.contacts.push({
      id: uid(), date: todayStr(), chajang: preset, name: "", role: "", method: "",
      type: "조합원", stance: "미정", level: "하", source: "manual", ui: true
    });
    persist();
    refreshContactViews(site);
    // 새 행(가장 최근 날짜라 맨 위)의 이름 칸으로 이동
    const first = document.querySelector("#ctContactBody .ct-name");
    if (first) { first.scrollIntoView({ block: "center" }); first.focus(); }
  });

  document.getElementById("ctAddEvent")?.addEventListener("click", () => {
    site.specialEvents.push({ id: uid(), date: todayStr(), type: "투어", count: 0, note: "" });
    persist();
    renderEventTable(site);
    rebuildContactCharts(site);
  });

  document.getElementById("ctExcelTemplate")?.addEventListener("click", () => {
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([[
      "날짜", "이름", "생년월일", "담당차장", "구분", "직책", "연락처", "주소",
      "접촉방법", "성향", "친밀도", "특이사항", "설문조사참여", "갤러리투어참여"
    ]]);
    const ws3 = XLSX.utils.aoa_to_sheet([[
      "담당차장", "이름", "생년월일", "구분", "직책", "월", "1주", "2주", "3주", "4주", "5주", "성향", "친밀도"
    ]]);
    const ws2 = XLSX.utils.aoa_to_sheet([["날짜", "행사종류", "참여인원", "메모"]]);
    XLSX.utils.book_append_sheet(wb, ws1, "명단");
    XLSX.utils.book_append_sheet(wb, ws3, "주차별집계");
    XLSX.utils.book_append_sheet(wb, ws2, "행사이력");
    XLSX.writeFile(wb, "접촉현황_양식.xlsx");
  });

  document.getElementById("ctExcelExport")?.addEventListener("click", () => {
    const rows = site.contacts.slice().sort((a, b) => (a.date || "").localeCompare(b.date || "")).map(c => ({
      "날짜": c.date || "", "이름": c.name || "", "생년월일": c.birthDate || "",
      "담당차장": c.chajang || "", "구분": c.type || "", "직책": c.role || "",
      "연락처": c.phone || "", "주소": c.address || "", "접촉방법": c.method || "",
      "성향": c.stance || "", "친밀도": c.level || "", "특이사항": c.note || "",
      "설문조사참여": c.survey || "", "갤러리투어참여": c.galleryTour || ""
    }));
    const snapRows = site.stanceSnapshots.slice().sort((a, b) => (a.date || "").localeCompare(b.date || "")).map(x => ({
      "기준일": x.date || "", "이름": x.name || "", "생년월일": x.birthDate || "", "담당차장": x.chajang || "",
      "구분": x.type || "", "성향": x.stance || "", "친밀도": x.level || ""
    }));
    const eventRows = site.specialEvents.slice().sort((a, b) => (a.date || "").localeCompare(b.date || "")).map(e => ({
      "날짜": e.date || "", "행사종류": e.type || "", "참여인원": e.count || 0, "메모": e.note || ""
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "명단");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(eventRows), "행사이력");
    if (snapRows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snapRows), "성향스냅샷");
    XLSX.writeFile(wb, `${site.name || "현장"}_접촉현황_${todayStr()}.xlsx`);
  });

  document.getElementById("ctExcelUpload")?.addEventListener("click", () => {
    document.getElementById("ctExcelFile").click();
  });
  document.getElementById("ctExcelFile")?.addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        importContactExcel(site, evt.target.result);
      } catch (err) {
        alert("엑셀 파일을 읽는 중 문제가 발생했습니다: " + err.message);
      }
    };
    reader.readAsBinaryString(file);
    e.target.value = "";
  });
}

function normBirth(v) {
  if (typeof v === "number" && v > 1000 && v < 80000) return normalizeDateValue(v);
  return String(v ?? "").trim();
}

function importContactExcel(site, binary) {
  const wb = XLSX.read(binary, { type: "binary" });
  let addedContacts = 0, updatedContacts = 0, skippedDup = 0, addedEvents = 0, badDates = 0, replacedWeekly = 0, droppedWeek5 = 0;

  if (wb.SheetNames.includes("명단")) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["명단"], { defval: "", raw: true });
    const incomingList = [];
    rows.forEach(row => {
      const name = String(row["이름"] || "").trim();
      if (!name) return;
      // [수정 #5] 엑셀 날짜 일련번호(예: 46000) → 2025-12-09 형식으로 변환
      const date = normalizeDateValue(row["날짜"]);
      if (!isValidDateStr(date)) badDates++;
      const typeRaw = String(row["구분"] || "").trim();
      const levelRaw = String(row["친밀도"] || "").trim();
      incomingList.push({
        date, name,
        birthDate: normBirth(row["생년월일"]),
        chajang: String(row["담당차장"] || "").trim(),
        type: CONTACT_TYPES.includes(typeRaw) ? typeRaw : "조합원",
        role: String(row["직책"] || "").trim(),
        phone: String(row["연락처"] || "").trim(),
        address: String(row["주소"] || "").trim(),
        method: normalizeMethod(row["접촉방법"] || row["접촉방식"]),
        stance: cleanStance(row["성향"]),
        level: CONTACT_LEVELS.includes(levelRaw) ? levelRaw : "하",
        note: String(row["특이사항"] || "").trim(),
        survey: String(row["설문조사참여"] || "").trim(),
        galleryTour: String(row["갤러리투어참여"] || "").trim(),
        source: "manual"
      });
    });

    // [수정 #11] 중복은 한 번만 물어봄
    const findExisting = inc => site.contacts.find(c => personKey(c) === personKey(inc) && c.date === inc.date);
    const dupCount = incomingList.filter(findExisting).length;
    let overwrite = false;
    if (dupCount) {
      overwrite = confirm(`업로드한 명단 중 ${dupCount}건은 같은 사람·같은 날짜 기록이 이미 있습니다.\n\n확인: 기존 기록을 새 내용으로 덮어쓰기\n취소: 중복은 건너뛰고 새 기록만 추가`);
    }
    incomingList.forEach(inc => {
      const existing = findExisting(inc);
      if (existing) {
        if (overwrite) { Object.assign(existing, inc); updatedContacts++; }
        else skippedDup++;
      } else {
        site.contacts.push({ id: uid(), ...inc });
        addedContacts++;
      }
      if (inc.stance !== "미정" && !site.companies.includes(inc.stance)) site.companies.push(inc.stance);
    });
  }

  if (wb.SheetNames.includes("주차별집계")) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["주차별집계"], { defval: "", raw: true });
    rows.forEach(row => {
      const name = String(row["이름"] || "").trim();
      let month = row["월"];
      month = typeof month === "number" ? normalizeDateValue(month).slice(0, 7) : String(month || "").trim().replace(/[.\/]/g, "-");
      const mm = month.match(/^(\d{4})-(\d{1,2})/);
      if (!name || !mm) return;
      const y = Number(mm[1]), m = Number(mm[2]);
      const monthKey = `${y}-${pad2(m)}`;
      const lastDay = new Date(y, m, 0).getDate();
      const chajang = String(row["담당차장"] || "").trim();
      const typeRaw = String(row["구분"] || "").trim();
      const type = CONTACT_TYPES.includes(typeRaw) ? typeRaw : "조합원";
      const role = String(row["직책"] || "").trim();
      const stance = cleanStance(row["성향"]);
      const levelRaw = String(row["친밀도"] || "").trim();
      const level = CONTACT_LEVELS.includes(levelRaw) ? levelRaw : "하";
      const birthDate = normBirth(row["생년월일"]);
      const key = personKey({ name, birthDate });

      // 같은 사람·같은 달 주차별 기록은 새 파일 내용으로 교체 (다시 올려도 중복 안 됨)
      const before = site.contacts.length;
      site.contacts = site.contacts.filter(c => !(c.source === "weekly" && personKey(c) === key && monthKeyOf(c.date) === monthKey));
      replacedWeekly += before - site.contacts.length;

      [1, 2, 3, 4, 5].forEach(wk => {
        const count = Number(row[`${wk}주`]) || 0;
        // [수정 #2] 각 주차의 실제 날짜 범위 안에 배치 (5주 = 29일~말일)
        const start = (wk - 1) * 7 + 1;
        const end = Math.min(lastDay, wk * 7 + (wk === 5 ? 3 : 0));
        if (start > lastDay) { droppedWeek5 += count; return; }
        const span = end - start + 1;
        for (let i = 0; i < count; i++) {
          const day = start + (i % span);
          site.contacts.push({ id: uid(), date: `${monthKey}-${pad2(day)}`, name, birthDate, chajang, type, role, stance, level, source: "weekly" });
          addedContacts++;
        }
      });
      // 이 달 말 기준 성향/친밀도 스냅샷
      upsertSnapshot(site, { date: monthEndOf(monthKey) > todayStr() ? todayStr() : monthEndOf(monthKey), name, birthDate, chajang, type, role, stance, level, origin: "weekly" });
      if (stance !== "미정" && !site.companies.includes(stance)) site.companies.push(stance);
    });
  }

  if (wb.SheetNames.includes("행사이력")) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["행사이력"], { defval: "", raw: true });
    rows.forEach(row => {
      const date = normalizeDateValue(row["날짜"]);
      const type = String(row["행사종류"] || "").trim();
      if (!date || !type) return;
      if (site.specialEvents.some(e => e.date === date && e.type === type && (Number(e.count) || 0) === (Number(row["참여인원"]) || 0))) return;
      site.specialEvents.push({
        id: uid(), date, type,
        count: Number(row["참여인원"]) || 0,
        note: String(row["메모"] || "").trim()
      });
      addedEvents++;
    });
  }

  { const st = contactStateFor(site.id); st.selectedStatMonth = null; st.selectedWeeklyMonth = null; }
  persist();
  refreshContactViews(site, { companies: true, events: true });
  let msg = `명단 ${addedContacts}건 추가 / ${updatedContacts}건 갱신`;
  if (skippedDup) msg += ` / 중복 ${skippedDup}건 건너뜀`;
  if (replacedWeekly) msg += `\n(주차별집계: 기존 같은 달 기록 ${replacedWeekly}건은 새 내용으로 교체)`;
  msg += `\n행사 ${addedEvents}건 추가되었습니다.`;
  if (badDates) msg += `\n\n⚠ 날짜를 읽지 못한 행이 ${badDates}건 있습니다. 명단 표에서 빨간 테두리 날짜를 확인해주세요.`;
  if (droppedWeek5) msg += `\n\n⚠ 5주가 없는 달(2월 등)의 5주 값 ${droppedWeek5}건은 반영하지 않았습니다.`;
  alert(msg);
}

/* 같은 사람·같은 날짜 스냅샷은 덮어쓰기 */
function upsertSnapshot(site, snap) {
  const k = personKey(snap);
  const ex = site.stanceSnapshots.find(s => personKey(s) === k && s.date === snap.date);
  if (ex) Object.assign(ex, snap);
  else site.stanceSnapshots.push({ id: uid(), ...snap });
}

/* =========================================================
   전체 명부 엑셀(마스터 시트) 통합 업로드
   "성 명", "담당", "임대\n의원", 날짜별 칸, "시공사성향", "친밀도"
   헤더가 들어있는 시트를 자동으로 찾아서, 한 번에
   개별 접촉기록(site.contacts)으로 변환해 모든 그래프에 반영합니다.
   ========================================================= */
function cleanHeader(v) {
  return String(v ?? "").replace(/[\s\n\r]/g, "");
}
function findColByHeader(headerRows, predicate) {
  // 왼쪽(앞쪽)에 있는 진짜 항목을 먼저 찾도록, 줄 단위가 아니라 "칸(열) 번호" 기준으로 왼쪽부터 확인합니다.
  // (뒤쪽 열에 있는 무관한 항목에 같은 글자가 우연히 포함돼 있어도 잘못 짚지 않도록 하기 위함입니다.)
  const maxCols = Math.max(0, ...headerRows.map(r => (r ? r.length : 0)));
  for (let c = 0; c < maxCols; c++) {
    for (const row of headerRows) {
      if (row && predicate(cleanHeader(row[c]))) return c;
    }
  }
  return -1;
}
function findColExact(headerRows, text) {
  return findColByHeader(headerRows, v => v === text);
}
function pad2(n) { return String(n).padStart(2, "0"); }
function formatDateLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function formatDateUTC(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/* 929 → 929, "9/29" → 929, 날짜 일련번호 → 월*100+일 */
function toMonthDay(v) {
  if (typeof v === "number") {
    if (v >= 101 && v <= 1231 && v % 100 >= 1 && v % 100 <= 31) return Math.floor(v);
    if (v > 20000 && v < 80000) { const d = normalizeDateValue(v); return Number(d.slice(5, 7)) * 100 + Number(d.slice(8, 10)); }
    return 0;
  }
  const m = String(v ?? "").trim().match(/^(\d{1,2})[.\/\-월\s]+(\d{1,2})/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

function excelSerialToDate(serial) {
  const utcDays = Math.floor(serial - 25569);
  return new Date(utcDays * 86400 * 1000);
}

function importMasterRegistryExcel(site, binary) {
  const wb = XLSX.read(binary, { type: "binary", cellDates: false });

  // "시공사성향"과 "친밀도" 헤더가 둘 다 있는 시트를 자동으로 찾음
  let targetSheet = null, rows = null;
  for (const name of wb.SheetNames) {
    const r = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: true });
    const flat = r.slice(0, 6).map(row => row.map(cleanHeader).join("|")).join("|");
    if (flat.includes("시공사성향") && flat.includes("친밀도")) { targetSheet = name; rows = r; break; }
  }
  if (!rows) { alert('"시공사성향", "친밀도" 항목이 있는 시트를 찾지 못했습니다. 파일 구조를 확인해주세요.'); return; }

  const headerRows = [rows[0], rows[1], rows[2], rows[3]];

  const nameCol = findColByHeader(headerRows, v => v.includes("성명"));
  const noCol = findColExact(headerRows, "No");
  const unionCheckCol = noCol >= 0 ? noCol + 1 : -1;
  const deptCol = findColExact(headerRows, "담당");
  // [수정] 임대의원 열: "임대의원" 머리글 후보 열들 중에서 실제로 직책 값(대의원·이사·감사·조합장)이
  // 가장 많이 들어있는 열을 고름. "후보", "후보번호", "전직책" 열은 제외.
  const roleCol = (() => {
    const maxCols = Math.max(0, ...headerRows.map(r => (r ? r.length : 0)));
    let best = -1, bestCnt = -1;
    for (let c = 0; c < maxCols; c++) {
      const heads = headerRows.map(r => cleanHeader(r && r[c]));
      if (!heads.some(h => h.includes("임대의원") || h === "직책" || h === "직책등")) continue;
      if (heads.some(h => h.includes("후보") || h.includes("전직책"))) continue;
      let cnt = 0;
      for (let r = 4; r < rows.length; r++) if (rows[r] && leaseRoleOf(rows[r][c])) cnt++;
      if (cnt > bestCnt) { best = c; bestCnt = cnt; }
    }
    return best >= 0 ? best : findColByHeader(headerRows, v => v.includes("임대의원"));
  })();
  const stanceStart = findColExact(headerRows, "시공사성향");
  const intimacyStart = findColExact(headerRows, "친밀도");
  const surveyStart = findColExact(headerRows, "설문조사");
  const birthCol = findColByHeader(headerRows, v => v.includes("생년월일"));
  // "접촉방식/접촉방법" 열이 따로 있으면 날짜 칸에 방식이 없을 때 보조로 사용
  const methodCol = (() => {
    const a = findColByHeader(headerRows, v => v.includes("접촉방식") || v.includes("접촉방법"));
    return a >= 0 ? a : findColExact(headerRows, "접촉"); // 염리4 명부: BA "접촉" 열 = 누계(최근) 접촉현황
  })();
  const weekCol = findColExact(headerRows, "주차접촉"); // 염리4 명부: BB "주차 접촉" 열

  if ([nameCol, deptCol, roleCol, stanceStart, intimacyStart, unionCheckCol].some(v => v < 0)) {
    alert("필요한 열(No/성명/담당/임대의원/시공사성향/친밀도)을 모두 찾지 못했습니다. 시트 구조가 다른 것 같습니다.");
    return;
  }
  const intimacyEnd = surveyStart > intimacyStart ? surveyStart : intimacyStart + 3;


  // 날짜 칸: 헤더 행(1~4행)에서 "엑셀 날짜 일련번호로 보이는 숫자"(대략 2009~2064년 범위)를 가진 열을 모두 찾음.
  // (화면엔 "1","2"처럼 보여도 실제로는 날짜값인 경우까지 정확히 잡기 위해, 서식 자동판별에 의존하지 않고 직접 계산합니다.)
  let dateCols = [];
  let dateHeaderRowIdx = -1;
  for (let ri = 0; ri < headerRows.length; ri++) {
    const row = headerRows[ri];
    if (!row) continue;
    const found = [];
    row.forEach((v, c) => { if (typeof v === "number" && v > 40000 && v < 60000) found.push(c); });
    if (found.length > 5) { dateCols = found; dateHeaderRowIdx = ri; break; }
  }
  if (!dateCols.length) { alert("날짜별 접촉 칸을 찾지 못했습니다."); return; }
  const dateHeaderRow = headerRows[dateHeaderRowIdx];

  // 접촉방법이 "상담 / 단순 / TM / 거부 …" 머리글 칸에 표시(1, ○ 등)하는 형태일 때 그 칸들을 찾음
  const methodLabelCols = [];
  {
    const dateSet = new Set(dateCols);
    const maxCols = Math.max(0, ...headerRows.map(r => (r ? r.length : 0)));
    for (let c = 0; c < maxCols; c++) {
      if (dateSet.has(c)) continue;
      if (c >= stanceStart && c < intimacyEnd) continue; // 성향·친밀도 영역 제외
      for (const r of headerRows) {
        const m = r ? parseMethodStrict(cleanHeader(r[c])) : "";
        if (m) { methodLabelCols.push([c, m]); break; }
      }
    }
  }

  // [수정] 성향/친밀도 라벨 줄을 "라벨이 가장 많이 들어있는 줄"로 고름
  // (예전엔 첫 번째로 값이 있는 줄을 골라서, 날짜·숫자 줄을 라벨로 잘못 읽는 경우가 있었음)
  const isRealLabel = v => isValidStanceLabel(v);
  const pickLabelRow = (from, to, ok) => {
    let best = null, bestCnt = 0;
    headerRows.forEach(r => {
      if (!r) return;
      let cnt = 0;
      for (let c = from; c < to; c++) if (ok(r[c])) cnt++;
      if (cnt > bestCnt) { best = r; bestCnt = cnt; }
    });
    return best || [];
  };
  // 라벨이 머리글과 같은 열에 있을 수 있음 (예: "시공사성향" 열 아래 "P", "친밀도" 열 아래 "상")
  const stanceLabelRow = pickLabelRow(stanceStart, intimacyStart, isRealLabel);
  const intimacyLabelRow = pickLabelRow(intimacyStart, intimacyEnd, v => CONTACT_LEVELS.includes(String(v ?? "").trim()));


  // 이전 버전에서 잘못 읽힌 명부 데이터(포스코 "P"·친밀도 "상" 누락, 숫자 성향 등)를 한 번 정리
  let didReset = false;
  const hasOldImport = site.contacts.some(c => c.source === "import") || site.stanceSnapshots.length;
  if (hasOldImport && site.registryParserVersion !== REGISTRY_PARSER_VERSION) {
    if (confirm("명부 읽는 방식이 새로 바뀌었습니다.\n\n예전에 올린 명부 데이터에는 후보(당선/탈락)를 임대의원으로 잘못 읽는 등 틀린 값이 섞여 있습니다.\n\n확인: 예전 명부 업로드분을 지우고 이 파일로 새로 채우기 (권장, 직접 입력한 기록은 유지)\n취소: 지우지 않고 추가만 하기")) {
      var resetBackup = { contacts: JSON.parse(JSON.stringify(site.contacts)), snaps: JSON.parse(JSON.stringify(site.stanceSnapshots)) };
      site.contacts = site.contacts.filter(c => c.source !== "import");
      site.stanceSnapshots = site.stanceSnapshots.filter(x => x.origin === "weekly");
      resetBackup.reg = site.registryStats; site.registryStats = {};
      didReset = true;
    }
  }
  const backupContacts = didReset ? resetBackup.contacts : JSON.parse(JSON.stringify(site.contacts));
  const backupCompanies = site.companies.slice();
  const existingKeys = new Set(site.contacts.map(c => `${personKey(c)}__${c.date}`));
  let added = 0, peopleTouched = new Set();
  let methodFilled = 0, methodKnown = 0, excludedRows = 0;
  const unknownMethodVals = {}; // 인식 못한 날짜칸 값 → 건수 (안내용)
  const byKeyDate = {};
  site.contacts.forEach(c => { byKeyDate[`${personKey(c)}__${c.date}`] = c; });
  const personRows = []; // 스냅샷용 (수정 #7)
  const regRows = [];    // 담당별 접촉현황(BA/BB)용
  let maxContactDate = "";

  for (let r = 4; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    // 조합원 체크 칸: 1(또는 ○/V)만 인정. "?", "부", "비" 등은 조합원이 아니므로 제외
    const chk = row[unionCheckCol];
    const chkOk = typeof chk === "number" ? chk > 0 : ["1", "○", "O", "o", "V", "v", "✓", "Y", "y"].includes(String(chk ?? "").trim());
    if (!chkOk) { if (String(chk ?? "").trim()) excludedRows++; continue; }
    const name = String(row[nameCol] ?? "").trim();
    if (!name) continue;

    const dept = applyChajangAlias(site, row[deptCol]);
    const birthDate = birthCol >= 0 ? normBirth(row[birthCol]) : "";
    const role = leaseRoleOf(row[roleCol]);           // 직책 값만 인정 (당선/탈락 등은 무시)
    const type = role ? "임대의원" : "조합원";

    let stance = "미정";
    for (let c = stanceStart; c < intimacyStart; c++) {
      if (isMark(row[c]) && isRealLabel(stanceLabelRow[c]) && cleanHeader(stanceLabelRow[c]) !== "시공사성향") {
        stance = stanceFromLabel(stanceLabelRow[c]); break;
      }
    }
    // 친밀도 표시가 없으면 "하"로 넣지 않고 비워둠 (미입력)
    let level = "";
    for (let c = intimacyStart; c < intimacyEnd; c++) {
      const lv = String(intimacyLabelRow[c] ?? "").trim();
      if (isMark(row[c]) && CONTACT_LEVELS.includes(lv)) { level = lv; break; }
    }

    // 접촉방법 칸(상담/단순상담/TM/거부/부재/불명)에는 "마지막으로 그 방법으로 접촉한 날짜"(예: 929 = 9/29)가 들어있음
    const methodByDay = {};
    const methodKinds = new Set();
    methodLabelCols.forEach(([c, m]) => {
      const v = row[c];
      if (v === "" || v === null || v === undefined) return;
      methodKinds.add(m);
      const md = toMonthDay(v);
      if (md) methodByDay[md] = m;
    });
    const onlyKind = methodKinds.size === 1 ? [...methodKinds][0] : "";
    const latestMethod = methodCol >= 0 ? parseMethod(row[methodCol]) : "";

    let personHasContact = false;
    dateCols.forEach(c => {
      const v = row[c];
      if (!isMark(v)) return;
      const serial = dateHeaderRow[c];
      if (typeof serial !== "number") return;
      const dateStr = formatDateUTC(excelSerialToDate(serial));
      if (dateStr > maxContactDate) maxContactDate = dateStr;
      const key = `${personKey({ name, birthDate })}__${dateStr}`;
      // 접촉방법 결정 순서: ① 날짜 칸 글자 ② 방법칸의 같은 날짜 ③ 그 사람이 한 가지 방법만 있으면 그 방법 ④ "접촉" 열(최근 방법)
      const md = Number(dateStr.slice(5, 7)) * 100 + Number(dateStr.slice(8, 10));
      let method = parseMethod(v) || methodByDay[md] || onlyKind || latestMethod;
      if (method) methodKnown++;
      else { const sv = String(v).trim(); unknownMethodVals[sv] = (unknownMethodVals[sv] || 0) + 1; }
      if (existingKeys.has(key)) {
        // 이미 있는 기록인데 접촉방식이 비어 있으면 채워줌 (예전 업로드분 보정)
        const ex = byKeyDate[key];
        if (ex && method && ex.method !== method && (!ex.method || ex.source === "import")) { ex.method = method; methodFilled++; }
        return;
      }
      existingKeys.add(key);
      const rec = { id: uid(), date: dateStr, chajang: dept, name, birthDate, type, role, stance, level, method, source: "import" };
      site.contacts.push(rec);
      byKeyDate[key] = rec;
      added++;
      personHasContact = true;
    });
    if (personHasContact) peopleTouched.add(personKey({ name, birthDate }));
    personRows.push({ name, birthDate, chajang: dept, type, role, stance, level });
    regRows.push([dept, type === "임대의원" ? 1 : 0,
      REG_STATUS.indexOf(methodCol >= 0 ? regStatusOf(row[methodCol]) : "미접촉"),
      REG_STATUS.indexOf(weekCol >= 0 ? regStatusOf(row[weekCol]) : "미접촉"),
      personKey({ name, birthDate }), role, stance, level]);   // 차장별 명단 출력용

    if (stance !== "미정" && !site.companies.includes(stance)) site.companies.push(stance);
  }

  // [수정 #7] 명부의 성향/친밀도는 "파일 기준일" 시점의 현재 상태로 저장
  // 기준일 = 파일에 기록된 마지막 접촉일 (오늘보다 미래면 오늘)
  let asOf = maxContactDate && maxContactDate <= todayStr() ? maxContactDate : todayStr();
  const input = prompt(
    `명부의 성향·친밀도를 어느 날짜 기준 상태로 저장할까요?\n(기본값: 파일의 마지막 접촉일)\n\n이 날짜로 스냅샷이 저장되어, 다음에 명부를 다시 올리면 변화가 계산됩니다.`,
    asOf
  );
  if (input === null) {
    site.contacts = backupContacts;
    site.companies = backupCompanies;
    if (didReset) { site.stanceSnapshots = resetBackup.snaps; site.registryStats = resetBackup.reg; }
    alert("업로드를 취소했습니다. 아무것도 반영되지 않았습니다.");
    return;
  }
  const norm = normalizeDateValue(input.trim());
  if (isValidDateStr(norm)) asOf = norm;

  let changed = 0;
  // ---- 명부 기준으로 예전 기록 정리 ----
  // ① 생년월일 없이 들어간 예전 기록을 명부의 같은 사람과 합치고, 담당·임대의원 정보는 명부 값으로 맞춤
  // ② 같은 사람·같은 날짜 중복 기록 제거
  // ③ 명부(조합원 B열=1)에 없는 사람의 기록은 확인 후 삭제
  const regByKey = {}, regByName = {};
  personRows.forEach(p => { const k = personKey(p); if (!(regByKey[k] && regByKey[k].role && !p.role)) regByKey[k] = p; (regByName[p.name] = regByName[p.name] || []).push(p); });
  let mergedLegacy = 0, removedDup = 0, removedOrphan = 0;
  site.contacts.forEach(c => {
    if (!c.name) return;
    let p = regByKey[personKey(c)];
    if (!p && !c.birthDate) {
      const cand = (regByName[c.name] || []).filter((x, i, arr) => arr.findIndex(y => personKey(y) === personKey(x)) === i);
      if (cand.length === 1) { p = cand[0]; c.birthDate = p.birthDate; mergedLegacy++; }
    }
    if (p) { c.chajang = p.chajang; c.type = p.type; c.role = p.role; }
  });
  const keep = new Map();
  site.contacts.forEach(c => {
    const k = `${personKey(c)}__${c.date}`;
    const prev = keep.get(k);
    if (!prev) { keep.set(k, c); return; }
    removedDup++;
    // 이번 명부에서 들어온 기록을 남기고, 빠진 접촉방법만 보충
    const winner = c.source === "import" ? c : prev, loser = winner === c ? prev : c;
    if (!winner.method && loser.method) winner.method = loser.method;
    if (!winner.note && loser.note) winner.note = loser.note;
    keep.set(k, winner);
  });
  site.contacts = site.contacts.filter(c => !c.name || keep.get(`${personKey(c)}__${c.date}`) === c);
  const orphans = site.contacts.filter(c => c.name && !regByKey[personKey(c)]);
  if (orphans.length) {
    const names = [...new Set(orphans.map(c => c.name))];
    if (confirm(`명부(조합원)에 없는 사람의 접촉 기록이 ${orphans.length}건(${names.length}명) 남아 있습니다.\n예: ${names.slice(0, 8).join(", ")}${names.length > 8 ? " …" : ""}\n\n예전에 올린 데이터가 남아 있는 것으로 보입니다.\n\n확인: 삭제하기 (권장)\n취소: 그대로 두기`)) {
      const orphanSet = new Set(orphans);
      site.contacts = site.contacts.filter(c => !orphanSet.has(c));
      site.stanceSnapshots = site.stanceSnapshots.filter(x => regByKey[personKey(x)]);
      removedOrphan = orphans.length;
    }
  }

  // 이전 스냅샷(이전 명부 업로드)과 비교
  site.registryStats = site.registryStats || {};
  site.registryStats[asOf] = regRows;
  // 같은 사람(이름+생년월일)이 여러 행이면 하나로 — 직책 있는 행 우선
  {
    const m = new Map();
    personRows.forEach(p => { const k = personKey(p); const e = m.get(k); if (!e || (!e.role && p.role)) m.set(k, p); });
    personRows.length = 0; m.forEach(v => personRows.push(v));
  }
  const snapByKey = {};
  site.stanceSnapshots.forEach(x => (snapByKey[personKey(x)] = snapByKey[personKey(x)] || []).push(x));
  personRows.forEach(p => {
    const prev = (snapByKey[personKey(p)] || []).filter(x => x.date < asOf).sort((x, y) => x.date.localeCompare(y.date)).pop();
    if (prev && prev.stance === p.stance && (prev.level || "") === (p.level || "")) {
      // 변화 없으면 새로 저장하지 않고 "이 날짜에도 같았음"만 표시 (저장 용량 절약)
      if (!prev.confirmedUntil || prev.confirmedUntil < asOf) prev.confirmedUntil = asOf;
      prev.chajang = p.chajang;
      return;
    }
    if (prev) changed++;
    upsertSnapshot(site, { date: asOf, ...p, origin: "master" });
  });

  { const st = contactStateFor(site.id); st.selectedStatMonth = null; st.selectedWeeklyMonth = null; st.selectedRegDate = null; }
  site.registryParserVersion = REGISTRY_PARSER_VERSION;
  persist();
  refreshContactViews(site, { companies: true });
  const unk = Object.entries(unknownMethodVals).sort((a, b) => b[1] - a[1]);
  let methodMsg = `\n· 접촉방식 인식: ${methodKnown}건` + (methodLabelCols.length ? ` [머리글 칸: ${methodLabelCols.map(x => x[1]).join("/")}]` : "") + (methodFilled ? ` (기존 기록 ${methodFilled}건 접촉방식 보충)` : "");
  if (unk.length) methodMsg += `\n· 접촉방식을 알 수 없는 칸 값: ${unk.slice(0, 8).map(([v, n]) => `"${v}" ${n}건`).join(", ")}${unk.length > 8 ? " …" : ""}\n  → 이 값들은 "구분없음"으로 집계됩니다. 각 값이 어떤 방식인지 알려주시면 추가해 드릴게요.`;
  const extra = (didReset ? "\n· 예전 명부 업로드분을 지우고 새로 불러왔습니다." : "") +
    (mergedLegacy || removedDup || removedOrphan ? `\n· 예전 기록 정리: 같은 사람 합치기 ${mergedLegacy}건, 중복 삭제 ${removedDup}건, 명부에 없는 기록 삭제 ${removedOrphan}건` : "") +
    (excludedRows ? `\n· 조합원 칸이 1이 아닌 행(?, 부, 비 등) ${excludedRows}건은 제외` : "");
  alert(`"${targetSheet}" 시트 반영 완료${extra}\n\n· 새 접촉 기록: ${peopleTouched.size}명, ${added}건${added ? "" : " (이미 반영된 날짜만 있음)"}${methodMsg}\n· 성향/친밀도 스냅샷: ${personRows.length}명 (기준일 ${asOf})\n· 이전 대비 성향/친밀도가 바뀐 사람: ${changed}명`);
}
