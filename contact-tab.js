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
const CONTACT_TAB_VERSION = "2026-09-30 v14";

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
  // 예전에 "단순", "tm" 등으로 저장돼 통계에서 빠지던 접촉방법을 표준값으로 정리
  site.contacts.forEach(c => {
    if (!c.method) return;
    const m = normalizeMethod(c.method);
    if (m !== c.method) { c.method = m; migrated = true; }
  });
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
  if (!_contactState[siteId]) _contactState[siteId] = { selectedChajang: null, period: "month", selectedStatMonth: null, selectedWeeklyMonth: null };
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
  const regs = registryRows(site, regDate, true).filter(x => (x.chajang || "(담당 미지정)") === chajang);
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
    people = Object.values(m);
  }
  const order = s => { const i = REG_STATUS.indexOf(s); return i < 0 ? 99 : i; };
  people.sort((a, b) => (a.type === "임대의원" ? 0 : 1) - (b.type === "임대의원" ? 0 : 1) || order(a.cum) - order(b.cum) || a.key.localeCompare(b.key));
  const nameOf = k => { const [n, bd] = k.split("|"); return bd ? `${n} <span>(${bd.slice(0, 6)})</span>` : n; };
  const cls = s => ({ "상담": "g", "단순상담": "g", "TM": "g", "거부": "r", "부재": "a", "불명": "a", "미접촉": "n" }[s] || "");
  const shortM = s => s === "단순상담" ? "단순" : s;
  const rowsHtml = people.map((p, i) => {
    const wk = weeksByKey[p.key] || {};
    const tot = W.reduce((s, w) => s + (wk[w] || 0), 0);
    return `<tr><td class="c">${i + 1}</td><td>${nameOf(p.key)}</td><td class="c">${p.type === "임대의원" ? esc(p.role || "임대의원") : ""}</td>
      <td class="c m ${cls(p.cum)}">${esc(shortM(p.cum))}</td><td class="c m ${cls(p.week)}">${esc(shortM(p.week))}</td>
      <td class="c">${esc(p.stance && p.stance !== "미정" ? p.stance : "")}</td><td class="c">${esc(p.level || "")}</td>
      ${W.map(w => `<td class="c">${wk[w] || ""}</td>`).join("")}<td class="c em">${tot || ""}</td></tr>`;
  }).join("");
  const lease = people.filter(p => p.type === "임대의원").length;
  return {
    count: people.length, lease,
    html: `<table class="t list">
      <thead><tr><th>No</th><th>이름</th><th>임대의원</th><th>누계</th><th>주차</th><th>성향</th><th>친밀도</th>
        ${W.map((w, i) => `<th>${w}주<div>${shortMD(ranges[i].start)}~</div></th>`).join("")}<th>합계</th></tr></thead>
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

function buildContactReportHtml(site, size) {
  const state = contactStateFor(site.id);
  const charts = _contactCharts[site.id] || {};
  const single = state.selectedChajang.size === 1 ? [...state.selectedChajang][0] : "";
  const regDates = registryDates(site);
  const regDate = state.selectedRegDate || regDates[regDates.length - 1] || "";
  const printedAt = todayStr();
  const pct = (a, b) => b ? `${Math.round(a / b * 1000) / 10}%` : "-";
  const GOOD = ["상담", "단순상담", "TM"];

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
  const regRow = (g, cls) => `<tr class="${cls || ""}"><td>${esc(g.name)}</td><td>${g.total}</td>
    <td>${g.c["상담"] || 0}</td><td>${g.c["단순상담"] || 0}</td><td>${g.c["TM"] || 0}</td><td class="em">${good(g)}</td><td class="em">${pct(good(g), g.total)}</td>
    <td class="wk">${g.wGood}</td><td class="wk">${pct(g.wGood, g.total)}</td>
    <td>${g.c["거부"] || 0}</td><td>${g.c["부재"] || 0}</td><td>${g.c["불명"] || 0}</td><td>${g.c["미접촉"] || 0}</td><td>${g.lease}</td></tr>`;
  const regTable = glist.length ? `
    <table class="t">
      <thead>
        <tr><th rowspan="2">담당</th><th rowspan="2">인원</th><th colspan="5">누계 접촉</th><th colspan="2" class="wk">주차 접촉</th><th colspan="4">미접촉 사유</th><th rowspan="2">임대<br>의원</th></tr>
        <tr><th>상담</th><th>단순</th><th>TM</th><th>계</th><th>접촉률</th><th class="wk">계</th><th class="wk">접촉률</th><th>거부</th><th>부재</th><th>불명</th><th>미접촉</th></tr>
      </thead>
      <tbody>${glist.map(g => regRow(g)).join("")}${glist.length > 1 ? regRow(sum, "sum") : ""}</tbody>
    </table>` : `<p class="hint">명부가 업로드되지 않았습니다.</p>`;

  // ---- 그래프: 담당별 접촉 구성 (100% 누적 가로막대) ----
  const cats = [["접촉", g => good(g)], ["거부", g => g.c["거부"] || 0], ["부재", g => g.c["부재"] || 0], ["불명", g => g.c["불명"] || 0], ["미접촉", g => g.c["미접촉"] || 0]];
  const compImg = glist.length ? makeChartImage({
    type: "bar",
    data: {
      labels: glist.map(g => g.name),
      datasets: cats.map(([k, f]) => ({ label: k, data: glist.map(g => g.total ? Math.round(f(g) / g.total * 1000) / 10 : 0), backgroundColor: RPT_COLORS[k], barThickness: single ? 46 : undefined }))
    },
    options: {
      indexAxis: "y",
      plugins: { ctValueLabels: false, legend: { position: "top", labels: { boxWidth: 16 } },
        tooltip: { enabled: false } },
      scales: { x: { stacked: true, max: 100, ticks: { callback: v => v + "%" }, grid: { color: "#eef1f5" } }, y: { stacked: true, grid: { display: false } } }
    },
    plugins: [{ id: "pctInBar", afterDatasetsDraw(ch) {
      const ctx = ch.ctx; ctx.save(); ctx.font = "bold 13px Malgun Gothic, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ch.data.datasets.forEach((ds, di) => ch.getDatasetMeta(di).data.forEach((bar, i) => {
        const v = ds.data[i]; if (v < 7) return;
        ctx.fillStyle = di >= 3 ? "#334155" : "#fff";
        ctx.fillText(Math.round(v) + "%", (bar.x + bar.base) / 2, bar.y);
      })); ctx.restore(); } }]
  }, 1000, single ? 260 : Math.max(420, 60 + glist.length * 44)) : "";

  // ---- 시공사 지지 (그래프 대신 한 줄) ----
  const stanceCh = charts.stance;
  const stanceLine = stanceCh ? stanceCh.data.labels.map(l => String(l)).join(" · ") : "";

  // ---- 요약 ----
  const bad = (sum.c["거부"] || 0) + (sum.c["부재"] || 0) + (sum.c["불명"] || 0);
  const poscoMetric = [...document.querySelectorAll("#ctMetrics > div")].map(d => { const t = d.querySelectorAll("div"); return { l: t[0]?.textContent || "", v: t[1]?.textContent || "" }; }).find(m => /지지/.test(m.l));
  const kpi = sum.total ? [
    { label: single ? "담당 조합원" : "조합원", value: `${fmtNum(sum.total)}명`, sub: `임대의원 ${sum.lease}명` },
    { label: "누계 접촉", value: `${fmtNum(good(sum))}명`, sub: `접촉률 ${pct(good(sum), sum.total)}` },
    { label: "주차 접촉", value: `${fmtNum(sum.wGood)}명`, sub: `접촉률 ${pct(sum.wGood, sum.total)}` },
    { label: "거부 · 부재 · 불명", value: `${bad}명`, sub: `미접촉 ${sum.c["미접촉"] || 0}명` },
    ...(poscoMetric ? [{ label: poscoMetric.l, value: poscoMetric.v, sub: "" }] : [])
  ] : [];

  // ---- 주차별 표 (화면 표를 간단히 정리) ----
  const weekMonth = state.selectedWeeklyMonth || "";
  const weekHint = document.getElementById("ctWeekRangeHint")?.textContent || "";
  let weeklyTable = "";
  const wt = document.querySelector("#ctWeeklySummary table");
  if (wt) {
    const c = wt.cloneNode(true);
    c.querySelectorAll("td div").forEach(n => n.remove());
    c.querySelectorAll("th").forEach(th => { if (/BB|주차접촉/.test(th.textContent)) th.innerHTML = "주차 접촉"; });
    c.querySelectorAll("[style]").forEach(n => n.removeAttribute("style"));
    c.querySelectorAll("[title]").forEach(n => n.removeAttribute("title"));
    c.removeAttribute("style"); c.className = "t";
    const trs = c.querySelectorAll("tbody tr"); if (trs.length > 1) trs[trs.length - 1].className = "sum";
    weeklyTable = c.outerHTML;
  }
  const plist = single ? buildPersonListHtml(site, single, regDate, weekMonth) : null;

  // 주차 그래프들 (화면 그래프와 같은 데이터, 인쇄용 글씨 크기로)
  const W = charts.weeklyByChajang;
  const weekByChajangImg = W ? makeChartImage({ type: "bar",
    data: { labels: W.data.labels, datasets: W.data.datasets.map(d => ({ label: String(d.label).replace(/\s*\(.*\)/, ""), data: [...d.data], backgroundColor: d.backgroundColor, borderRadius: 3 })) },
    options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#eef1f5" } }, x: { grid: { display: false } } }, plugins: { legend: { labels: { boxWidth: 16 } } } } }, 1000, 520) : "";
  const WK = charts.weekly;
  const weekTotalImg = WK ? makeChartImage({ type: "bar",
    data: { labels: WK.data.labels, datasets: WK.data.datasets.map(d => ({ label: d.label, data: [...d.data], backgroundColor: d.backgroundColor === "#1d9e75" ? "#9bb7d6" : "#2f6fb5", borderRadius: 3 })) },
    options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#eef1f5" } }, x: { grid: { display: false } } }, plugins: { legend: { labels: { boxWidth: 16 } } } } }, 1000, 400) : "";

  const fig = (title, src, h) => src ? `<div class="fig"><div class="fig-t">${esc(title)}</div><img src="${src}" style="max-height:${h}mm"></div>` : "";
  const head = (title, meta) => `<div class="head"><h1>${title}</h1><div class="meta">${meta}</div></div>`;
  const who = single ? `${esc(single)} 차장` : "전체 담당";

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(site.name || "현장")} 접촉현황 보고</title>
<style>
  @page { size: ${size} landscape; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: "Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", sans-serif; color: #1f2937; font-size: 9pt; }
  .page { padding: 10mm 12mm 8mm; break-after: page; page-break-after: always; }
  .page:last-of-type { break-after: auto; page-break-after: auto; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1f3b5c; padding-bottom: 5px; margin-bottom: 8px; }
  .head h1 { font-size: 16pt; margin: 0; color: #1f3b5c; letter-spacing: -0.3px; }
  .head .meta { font-size: 8.5pt; color: #6b7280; text-align: right; line-height: 1.5; }
  h2 { font-size: 10.5pt; margin: 8px 0 5px; color: #1f3b5c; }
  h2:first-child { margin-top: 0; }
  .kpis { display: grid; grid-template-columns: repeat(${Math.max(1, kpi.length)}, 1fr); gap: 7px; margin-bottom: 9px; }
  .kpi { background: #f5f7fa; border-radius: 6px; padding: 6px 11px; }
  .kpi .l { font-size: 8pt; color: #6b7280; }
  .kpi .v { font-size: 14pt; font-weight: 800; color: #1f3b5c; line-height: 1.25; }
  .kpi .s { font-size: 8pt; color: #6b7280; }
  .cols { display: grid; grid-template-columns: 57% 1fr; gap: 12px; align-items: start; }
  .t { width: 100%; border-collapse: collapse; font-size: 8.3pt; }
  .t th, .t td { border-bottom: 1px solid #e5e7eb; padding: 2.5px 5px; text-align: right; white-space: nowrap; }
  .t thead th { background: #f1f4f8; color: #374151; font-weight: 700; text-align: center; border-bottom: 1px solid #cbd5e1; }
  .t thead tr:first-child th { border-top: 1.5px solid #1f3b5c; }
  .t th div { font-size: 6.8pt; font-weight: 400; color: #6b7280; }
  .t td:first-child { text-align: left; }
  .t .em { font-weight: 700; color: #1f3b5c; }
  .t .wk { background: #f6f9fd; }
  .t thead th.wk { background: #e8f0fa; }
  .t tr.sum td { font-weight: 800; background: #f1f4f8; border-top: 1.5px solid #1f3b5c; border-bottom: 1.5px solid #1f3b5c; }
  .t td span { font-size: 7pt; color: #6b7280; font-weight: 400; }
  .t.list { font-size: 7.6pt; }
  .t.list td { padding: 0 4px; line-height: 1.34; }
  .t.list td:nth-child(2) { text-align: left; }
  .t.list thead { display: table-header-group; }
  .t .c { text-align: center; }
  .t td.m.g { color: #1e4f8a; font-weight: 700; }
  .t td.m.r { color: #b42318; font-weight: 700; }
  .t td.m.a { color: #b45309; }
  .t td.m.n { color: #9ca3af; }
  .fig { break-inside: avoid; margin-bottom: 6px; }
  .fig-t { font-size: 9pt; font-weight: 700; margin-bottom: 3px; color: #1f3b5c; }
  .fig img { display: block; max-width: 100%; width: auto; margin: 0 auto; }
  .note { font-size: 8pt; color: #4b5563; background: #f5f7fa; border-radius: 5px; padding: 5px 9px; margin-top: 4px; }
  .foot { font-size: 7pt; color: #9ca3af; text-align: right; margin-top: 4px; }
</style></head><body>

<div class="page">
  ${head(`${esc(site.name || "현장")} 접촉현황 보고`, `${who} · 기준일 ${esc(regDate || printedAt)}`)}
  ${kpi.length ? `<div class="kpis">${kpi.map(k => `<div class="kpi"><div class="l">${esc(k.label)}</div><div class="v">${esc(k.value)}</div>${k.sub ? `<div class="s">${esc(k.sub)}</div>` : ""}</div>`).join("")}</div>` : ""}
  <div class="cols">
    <div>
      <h2>${single ? "접촉현황" : "담당별 접촉현황"}</h2>
      ${regTable}
      ${single ? `<h2>주차별 접촉 · ${esc(weekMonth)}</h2>${weeklyTable}${fig("", weekTotalImg, 50)}` : ""}
    </div>
    <div>
      ${fig(single ? "접촉 구성" : "담당별 접촉 구성", compImg, single ? 40 : 105)}
      ${single ? fig("주차별 접촉 인원", weekByChajangImg, 58) : ""}
      ${stanceLine ? `<div class="note"><b>시공사 지지</b> &nbsp; ${esc(stanceLine)}</div>` : ""}
    </div>
  </div>
  <div class="foot">1 / 2</div>
</div>

${single ? `
<div class="page">
  ${head(`${esc(single)} 차장 담당 조합원 명단`, `${plist.count}명 (임대의원 ${plist.lease}명) · 기준일 ${esc(regDate || printedAt)}<br>${esc(weekHint)}`)}
  ${plist.html}
  <div class="foot">2 / 2</div>
</div>` : `
<div class="page">
  ${head(`주차별 접촉 현황 · ${esc(weekMonth)}`, `${who}<br>${esc(weekHint)}`)}
  <div class="cols">
    <div>${weeklyTable || `<p>이 달 접촉 기록이 없습니다.</p>`}</div>
    <div>
      ${fig("담당별 주차 접촉 인원", weekByChajangImg, 80)}
      ${fig("주차별 접촉 인원 · 건수", weekTotalImg, 62)}
    </div>
  </div>
  <div class="foot">2 / 2</div>
</div>`}

</body></html>`;
}

function printContactReport(site, size) {
  const html = buildContactReportHtml(site, size);
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
function previewContactReport(site, size) {
  const w = window.open("", "_blank");
  if (!w) { alert("팝업이 차단되었습니다. 브라우저 주소창 오른쪽에서 팝업 허용 후 다시 눌러주세요."); return; }
  w.document.open(); w.document.write(buildContactReportHtml(site, size).replace("</body>",
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
      <button id="ctReportPreview" class="btn btn-outline btn-sm">👁 보고서 미리보기</button>
      <button id="ctPrintA4" class="btn btn-primary btn-sm">📄 보고서 출력 (A4 가로)</button>
      <button id="ctPrintA3" class="btn btn-outline btn-sm">📄 A3 가로</button>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>차장 선택 (아래 모든 표·그래프가 이 선택 기준으로 바뀝니다)</h4></div>
      <div id="ctChajangPills" style="display:flex;gap:6px;flex-wrap:wrap"></div>
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
  renderRegistryStatusSection(site);
  renderMonthlyStatSection(site);
  renderWeeklyPersonSection(site);
  rebuildContactCharts(site);
  bindContactTabEvents(site);
}

/* ---------- 차장 필터 ---------- */
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
  if (!state.selectedChajang.size) return site.contacts;
  return site.contacts.filter(c => state.selectedChajang.has(c.chajang));
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
    .filter(x => ignoreFilter || !state.selectedChajang.size || state.selectedChajang.has(x.chajang));
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
          <th style="${thS}">이 달 인원</th>
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
  document.getElementById("ctPrintA4")?.addEventListener("click", () => printContactReport(site, "A4"));
  document.getElementById("ctPrintA3")?.addEventListener("click", () => printContactReport(site, "A3"));
  document.getElementById("ctReportPreview")?.addEventListener("click", () => previewContactReport(site, "A4"));

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
      type: "조합원", stance: "미정", level: "하", source: "manual"
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

    const dept = String(row[deptCol] ?? "").trim();
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
  // 이전 스냅샷(이전 명부 업로드)과 비교
  site.registryStats = site.registryStats || {};
  site.registryStats[asOf] = regRows;
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
    (excludedRows ? `\n· 조합원 칸이 1이 아닌 행(?, 부, 비 등) ${excludedRows}건은 제외` : "");
  alert(`"${targetSheet}" 시트 반영 완료${extra}\n\n· 새 접촉 기록: ${peopleTouched.size}명, ${added}건${added ? "" : " (이미 반영된 날짜만 있음)"}${methodMsg}\n· 성향/친밀도 스냅샷: ${personRows.length}명 (기준일 ${asOf})\n· 이전 대비 성향/친밀도가 바뀐 사람: ${changed}명`);
}
