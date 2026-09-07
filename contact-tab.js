/* =========================================================
   접촉현황 탭 — contact-tab.js
   현장별로 차장이 임대의원/조합원을 얼마나 만났는지,
   시공사 지지 성향이 어떻게 바뀌는지, 친밀도(상/중/하) 변화,
   투어/간담회/설문조사 같은 특별행사 이력을 관리합니다.

   이 파일은 app.js 전역 변수/함수(esc, fmtNum, persist, sites,
   currentDetailId, isAdmin)를 그대로 사용합니다. app.js보다
   반드시 뒤에 로드되어야 합니다.
   ========================================================= */

const CONTACT_LEVELS = ["상", "중", "하"];
const CONTACT_LEVEL_RANK = { "상": 2, "중": 1, "하": 0 };
const CONTACT_TYPES = ["임대의원", "조합원"];
const DEFAULT_EVENT_TYPES = ["투어", "간담회", "설문조사"];
const EVENT_COLORS = ["#378add", "#d85a30", "#1d9e75", "#8b5cf6", "#f59e0b"];

const _contactCharts = {}; // siteId -> { contact, stance, sentiment, intimacy, event }
const _contactState = {}; // siteId -> { selectedChajang: Set }

function ensureContactData(site) {
  site.contacts = site.contacts || [];
  site.companies = site.companies || ["포스코"];
  site.specialEvents = site.specialEvents || [];
}

function monthKeyOf(dateStr) {
  return (dateStr || "").slice(0, 7);
}

function contactStateFor(siteId) {
  if (!_contactState[siteId]) _contactState[siteId] = { selectedChajang: null };
  return _contactState[siteId];
}

function destroyContactCharts(siteId) {
  const c = _contactCharts[siteId];
  if (!c) return;
  Object.values(c).forEach(ch => { if (ch) ch.destroy(); });
  delete _contactCharts[siteId];
}

/* ---------- 메인 렌더 ---------- */
function renderContactTab(site) {
  ensureContactData(site);
  const panel = document.querySelector('#siteDetailPanel [data-panel="contact"]');
  if (!panel) return;

  const state = contactStateFor(site.id);
  const chajangList = [...new Set(site.contacts.map(c => c.chajang).filter(Boolean))].sort();
  if (state.selectedChajang === null) state.selectedChajang = new Set(chajangList);

  panel.innerHTML = `
    <div class="detail-card">
      <div class="detail-card-head"><h4>차장 선택</h4></div>
      <div id="ctChajangPills" style="display:flex;gap:6px;flex-wrap:wrap"></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>요약</h4></div>
      <div id="ctMetrics" style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px"></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>월별 접촉 인원</h4></div>
      <div style="position:relative;height:200px"><canvas id="ctContactChart"></canvas></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>현재 시공사 지지 분포</h4></div>
      <div style="position:relative;height:200px"><canvas id="ctStanceChart"></canvas></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>시공사 지지 성향 변화 추이</h4></div>
      <div style="position:relative;height:210px"><canvas id="ctSentimentChart"></canvas></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>친밀도 변화 집계 (최초 → 최근)</h4></div>
      <div id="ctIntimacyBoxes" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px"></div>
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
        <h4>접촉 대상자 명단</h4>
        <div style="display:flex;gap:6px">
          <button id="ctExcelUpload" class="btn btn-outline btn-sm admin-only">엑셀 업로드</button>
          <button id="ctExcelTemplate" class="btn btn-ghost btn-sm">양식 다운로드</button>
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
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">성향</th>
              <th style="text-align:left;padding:6px 4px;color:var(--slate-500)">친밀도</th>
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
  renderCompanyTags(site);
  renderContactTable(site);
  renderEventTable(site);
  rebuildContactCharts(site);
  bindContactTabEvents(site);
}

/* ---------- 차장 필터 ---------- */
function renderChajangPills(site) {
  const box = document.getElementById("ctChajangPills");
  const state = contactStateFor(site.id);
  const chajangList = [...new Set(site.contacts.map(c => c.chajang).filter(Boolean))].sort();

  if (!chajangList.length) {
    box.innerHTML = `<p class="hint">등록된 접촉 기록이 없습니다. 아래에서 접촉 기록을 추가해보세요.</p>`;
    return;
  }
  box.innerHTML = chajangList.map(name => {
    const on = state.selectedChajang.has(name);
    return `<button class="btn ${on ? "btn-primary" : "btn-outline"} btn-sm ct-pill" data-name="${esc(name)}">${esc(name)}</button>`;
  }).join("");

  box.querySelectorAll(".ct-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.name;
      if (state.selectedChajang.has(name)) state.selectedChajang.delete(name);
      else state.selectedChajang.add(name);
      renderChajangPills(site);
      rebuildContactCharts(site);
      renderContactTable(site);
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
    });
  });
}

function stanceOptionsHtml(site, val) {
  const opts = [...site.companies, "미정"];
  return opts.map(o => `<option ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("");
}

/* ---------- 접촉 대상자 명단 ---------- */
function renderContactTable(site) {
  const body = document.getElementById("ctContactBody");
  const rows = selectedContacts(site).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  body.innerHTML = rows.map(c => `
    <tr data-id="${c.id}" style="border-bottom:1px solid var(--slate-100)">
      <td style="padding:5px 4px"><input type="date" class="ct-date" value="${c.date || ""}" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px"></td>
      <td style="padding:5px 4px"><input type="text" class="ct-name" value="${esc(c.name || "")}" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px;width:64px"></td>
      <td style="padding:5px 4px"><input type="text" class="ct-chajang" value="${esc(c.chajang || "")}" placeholder="담당차장" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px;width:64px"></td>
      <td style="padding:5px 4px"><select class="ct-type" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 4px;font-size:12px">
        ${CONTACT_TYPES.map(t => `<option ${t === c.type ? "selected" : ""}>${t}</option>`).join("")}
      </select></td>
      <td style="padding:5px 4px"><select class="ct-stance" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 4px;font-size:12px">
        ${stanceOptionsHtml(site, c.stance)}
      </select></td>
      <td style="padding:5px 4px"><select class="ct-level" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 4px;font-size:12px">
        ${CONTACT_LEVELS.map(l => `<option ${l === c.level ? "selected" : ""}>${l}</option>`).join("")}
      </select></td>
      <td style="padding:5px 4px"><button class="ct-del admin-only" style="border:none;background:none;color:var(--slate-300);cursor:pointer">✕</button></td>
    </tr>`).join("") || `<tr><td colspan="7" style="padding:14px 4px;color:var(--slate-500)">표시할 접촉 기록이 없습니다.</td></tr>`;

  body.querySelectorAll("tr[data-id]").forEach(row => {
    const id = row.dataset.id;
    const contact = site.contacts.find(c => c.id === id);
    if (!contact) return;
    row.querySelector(".ct-date").addEventListener("change", e => { contact.date = e.target.value; persist(); rebuildContactCharts(site); renderChajangPills(site); });
    row.querySelector(".ct-name").addEventListener("change", e => { contact.name = e.target.value.trim(); persist(); });
    row.querySelector(".ct-chajang").addEventListener("change", e => { contact.chajang = e.target.value.trim(); persist(); renderChajangPills(site); rebuildContactCharts(site); });
    row.querySelector(".ct-type").addEventListener("change", e => { contact.type = e.target.value; persist(); rebuildContactCharts(site); });
    row.querySelector(".ct-stance").addEventListener("change", e => { contact.stance = e.target.value; persist(); rebuildContactCharts(site); });
    row.querySelector(".ct-level").addEventListener("change", e => { contact.level = e.target.value; persist(); rebuildContactCharts(site); });
    row.querySelector(".ct-del").addEventListener("click", () => {
      if (!confirm("이 접촉 기록을 삭제하시겠습니까?")) return;
      site.contacts = site.contacts.filter(c => c.id !== id);
      persist();
      renderChajangPills(site);
      renderContactTable(site);
      rebuildContactCharts(site);
    });
  });
}

/* ---------- 특별행사 이력 ---------- */
function renderEventTable(site) {
  const body = document.getElementById("ctEventBody");
  const rows = site.specialEvents.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  body.innerHTML = rows.map(ev => `
    <tr data-id="${ev.id}" style="border-bottom:1px solid var(--slate-100)">
      <td style="padding:5px 4px"><input type="date" class="ev-date" value="${ev.date || ""}" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px"></td>
      <td style="padding:5px 4px"><input type="text" class="ev-type" list="ctEventTypeList" value="${esc(ev.type || "")}" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px;width:80px"></td>
      <td style="padding:5px 4px"><input type="number" min="0" class="ev-count" value="${ev.count || 0}" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px;width:56px"></td>
      <td style="padding:5px 4px"><input type="text" class="ev-note" value="${esc(ev.note || "")}" placeholder="메모" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px;width:160px"></td>
      <td style="padding:5px 4px"><button class="ev-del admin-only" style="border:none;background:none;color:var(--slate-300);cursor:pointer">✕</button></td>
    </tr>`).join("") || `<tr><td colspan="5" style="padding:14px 4px;color:var(--slate-500)">등록된 행사가 없습니다.</td></tr>`;

  if (!document.getElementById("ctEventTypeList")) {
    const dl = document.createElement("datalist");
    dl.id = "ctEventTypeList";
    document.body.appendChild(dl);
  }
  document.getElementById("ctEventTypeList").innerHTML = DEFAULT_EVENT_TYPES.map(t => `<option value="${t}">`).join("");

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

/* ---------- 집계 + 차트 ---------- */
function buildMonthRange(dates) {
  const keys = [...new Set(dates.filter(Boolean).map(monthKeyOf))].sort();
  return keys.length ? keys : [new Date().toISOString().slice(0, 7)];
}

function rebuildContactCharts(site) {
  if (typeof Chart === "undefined") return;
  destroyContactCharts(site.id);
  const charts = {};
  const contacts = selectedContacts(site);

  // 요약 카드
  const metricsBox = document.getElementById("ctMetrics");
  const uniqueNames = new Set(contacts.map(c => c.name).filter(Boolean));
  let poscoLike = 0, upCount = 0;
  const byName = {};
  contacts.forEach(c => { if (c.name) (byName[c.name] = byName[c.name] || []).push(c); });
  Object.values(byName).forEach(list => {
    list.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const first = list[0], last = list[list.length - 1];
    if (last && site.companies[0] && last.stance === site.companies[0]) poscoLike++;
    if (first && last && CONTACT_LEVEL_RANK[last.level] > CONTACT_LEVEL_RANK[first.level]) upCount++;
  });
  const totalEvents = site.specialEvents.reduce((s, e) => s + (e.count || 0), 0);

  metricsBox.innerHTML = `
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">접촉 대상자 수</div>
      <div style="font-size:20px;font-weight:800">${uniqueNames.size}</div>
    </div>
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">${esc(site.companies[0] || "-")} 지지</div>
      <div style="font-size:20px;font-weight:800;color:var(--accent)">${poscoLike}명</div>
    </div>
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">친밀도 상승</div>
      <div style="font-size:20px;font-weight:800;color:var(--ok)">${upCount}명</div>
    </div>
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">누적 행사 인원</div>
      <div style="font-size:20px;font-weight:800">${totalEvents}명</div>
    </div>`;

  // 월별 접촉 인원 (구분별)
  const contactMonths = buildMonthRange(contacts.map(c => c.date));
  const rentData = contactMonths.map(m => contacts.filter(c => c.type === "임대의원" && monthKeyOf(c.date) === m).length);
  const unionData = contactMonths.map(m => contacts.filter(c => c.type === "조합원" && monthKeyOf(c.date) === m).length);

  charts.contact = new Chart(document.getElementById("ctContactChart"), {
    type: "bar",
    data: {
      labels: contactMonths,
      datasets: [
        { label: "임대의원", data: rentData, backgroundColor: "#378add", borderRadius: 4 },
        { label: "조합원", data: unionData, backgroundColor: "#d85a30", borderRadius: 4 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
  });

  // 현재 시공사 지지 분포 (인원별 최신 기록 기준)
  const latestStance = {};
  Object.entries(byName).forEach(([name, list]) => {
    const sorted = list.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    latestStance[name] = sorted[sorted.length - 1].stance || "미정";
  });
  const stanceLabels = [...site.companies, "미정"];
  const stanceCounts = stanceLabels.map(label => Object.values(latestStance).filter(s => s === label).length);
  charts.stance = new Chart(document.getElementById("ctStanceChart"), {
    type: "doughnut",
    data: {
      labels: stanceLabels,
      datasets: [{ data: stanceCounts, backgroundColor: stanceLabels.map((_, i) => EVENT_COLORS[i % EVENT_COLORS.length]), borderColor: "#fff", borderWidth: 2 }]
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: "60%" }
  });

  // 성향 변화 추이 (월별 비중)
  charts.sentiment = new Chart(document.getElementById("ctSentimentChart"), {
    type: "line",
    data: {
      labels: contactMonths,
      datasets: stanceLabels.map((label, i) => ({
        label,
        data: contactMonths.map(m => {
          const inMonth = contacts.filter(c => monthKeyOf(c.date) === m);
          if (!inMonth.length) return 0;
          return Math.round(inMonth.filter(c => (c.stance || "미정") === label).length / inMonth.length * 100);
        }),
        borderColor: EVENT_COLORS[i % EVENT_COLORS.length],
        backgroundColor: "transparent",
        tension: 0.3, borderWidth: 2, pointRadius: 3
      }))
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: 100, ticks: { callback: v => v + "%" } } } }
  });

  // 친밀도 변화 집계
  let up = 0, down = 0, same = 0;
  Object.values(byName).forEach(list => {
    if (list.length < 2) { same++; return; }
    const sorted = list.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const d = CONTACT_LEVEL_RANK[sorted[sorted.length - 1].level] - CONTACT_LEVEL_RANK[sorted[0].level];
    if (d > 0) up++; else if (d < 0) down++; else same++;
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
    </div>`;

  const intimacyData = contactMonths.map(m => {
    const inMonth = contacts.filter(c => monthKeyOf(c.date) === m);
    return {
      상: inMonth.filter(c => c.level === "상").length,
      중: inMonth.filter(c => c.level === "중").length,
      하: inMonth.filter(c => c.level === "하").length
    };
  });
  charts.intimacy = new Chart(document.getElementById("ctIntimacyChart"), {
    type: "bar",
    data: {
      labels: contactMonths,
      datasets: [
        { label: "상", data: intimacyData.map(d => d.상), backgroundColor: "#1baf7a", borderRadius: 4 },
        { label: "중", data: intimacyData.map(d => d.중), backgroundColor: "#eda100", borderRadius: 4 },
        { label: "하", data: intimacyData.map(d => d.하), backgroundColor: "#e34948", borderRadius: 4 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } }
  });

  // 월별 행사 개최 현황
  const eventMonths = buildMonthRange(site.specialEvents.map(e => e.date));
  const eventTypesUsed = [...new Set(site.specialEvents.map(e => e.type).filter(Boolean))];
  const typesForChart = eventTypesUsed.length ? eventTypesUsed : DEFAULT_EVENT_TYPES;
  charts.event = new Chart(document.getElementById("ctEventChart"), {
    type: "bar",
    data: {
      labels: eventMonths,
      datasets: typesForChart.map((t, i) => ({
        label: t,
        data: eventMonths.map(m => site.specialEvents.filter(e => e.type === t && monthKeyOf(e.date) === m).length),
        backgroundColor: EVENT_COLORS[i % EVENT_COLORS.length],
        borderRadius: 4
      }))
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
  });

  _contactCharts[site.id] = charts;
}

/* ---------- 버튼 동작 ---------- */
function bindContactTabEvents(site) {
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
    site.contacts.push({
      id: uid(), date: todayStr(), chajang: "", name: "",
      type: "조합원", stance: "미정", level: "하"
    });
    persist();
    renderChajangPills(site);
    renderContactTable(site);
    rebuildContactCharts(site);
  });

  document.getElementById("ctAddEvent")?.addEventListener("click", () => {
    site.specialEvents.push({ id: uid(), date: todayStr(), type: "투어", count: 0, note: "" });
    persist();
    renderEventTable(site);
    rebuildContactCharts(site);
  });

  document.getElementById("ctExcelTemplate")?.addEventListener("click", () => {
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([["날짜", "이름", "담당차장", "구분", "성향", "친밀도"]]);
    const ws2 = XLSX.utils.aoa_to_sheet([["날짜", "행사종류", "참여인원", "메모"]]);
    XLSX.utils.book_append_sheet(wb, ws1, "명단");
    XLSX.utils.book_append_sheet(wb, ws2, "행사이력");
    XLSX.writeFile(wb, "접촉현황_양식.xlsx");
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

function importContactExcel(site, binary) {
  const wb = XLSX.read(binary, { type: "binary" });
  let addedContacts = 0, updatedContacts = 0, addedEvents = 0;

  if (wb.SheetNames.includes("명단")) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["명단"], { defval: "" });
    rows.forEach(row => {
      const name = String(row["이름"] || "").trim();
      const date = String(row["날짜"] || "").trim();
      if (!name) return;
      const existing = site.contacts.find(c => c.name === name && c.date === date);
      const incoming = {
        date, name,
        chajang: String(row["담당차장"] || "").trim(),
        type: CONTACT_TYPES.includes(row["구분"]) ? row["구분"] : "조합원",
        stance: String(row["성향"] || "미정").trim(),
        level: CONTACT_LEVELS.includes(row["친밀도"]) ? row["친밀도"] : "하"
      };
      if (existing) {
        const ok = confirm(`"${name}" (${date}) 기록이 이미 있습니다.\n확인: 덮어쓰기 / 취소: 새 기록으로 추가`);
        if (ok) { Object.assign(existing, incoming); updatedContacts++; }
        else { site.contacts.push({ id: uid(), ...incoming }); addedContacts++; }
      } else {
        site.contacts.push({ id: uid(), ...incoming });
        addedContacts++;
      }
      if (incoming.stance && incoming.stance !== "미정" && !site.companies.includes(incoming.stance)) {
        site.companies.push(incoming.stance);
      }
    });
  }

  if (wb.SheetNames.includes("행사이력")) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["행사이력"], { defval: "" });
    rows.forEach(row => {
      const date = String(row["날짜"] || "").trim();
      const type = String(row["행사종류"] || "").trim();
      if (!date || !type) return;
      site.specialEvents.push({
        id: uid(), date, type,
        count: Number(row["참여인원"]) || 0,
        note: String(row["메모"] || "").trim()
      });
      addedEvents++;
    });
  }

  persist();
  renderChajangPills(site);
  renderCompanyTags(site);
  renderContactTable(site);
  renderEventTable(site);
  rebuildContactCharts(site);
  alert(`명단 ${addedContacts}건 추가 / ${updatedContacts}건 갱신, 행사 ${addedEvents}건 추가되었습니다.`);
}
