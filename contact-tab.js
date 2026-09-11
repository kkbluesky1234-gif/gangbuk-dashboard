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

/* 모든 막대/선 그래프 위에 숫자 값을 표시하는 공통 플러그인 (도넛 차트는 제외) */
if (typeof Chart !== "undefined" && !Chart._ctValueLabelsRegistered) {
  Chart.register({
    id: "ctValueLabels",
    afterDatasetsDraw(chart) {
      if (chart.config.type === "doughnut" || chart.config.type === "pie") return;
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
}

function monthKeyOf(dateStr) {
  return (dateStr || "").slice(0, 7);
}
function weekKeyOf(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
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

/* ---------- 메인 렌더 ---------- */
function renderContactTab(site) {
  ensureContactData(site);
  const panel = document.querySelector('#siteDetailPanel [data-panel="contact"]');
  if (!panel) return;

  const state = contactStateFor(site.id);
  const chajangList = [...new Set(site.contacts.map(c => c.chajang).filter(Boolean))].sort();
  if (state.selectedChajang === null) state.selectedChajang = new Set();

  panel.innerHTML = `
    <div class="detail-card" style="display:flex;justify-content:flex-end;gap:6px">
      <button id="ctPrintA4" class="btn btn-outline btn-sm">🖨 A4로 인쇄</button>
      <button id="ctPrintA3" class="btn btn-outline btn-sm">🖨 A3로 인쇄</button>
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
        <h4>월별 담당자 접촉현황 집계 (전체 명부/명단 데이터에서 자동 계산)</h4>
        <select id="ctStatMonthSelect" style="border:1px solid var(--slate-300);border-radius:6px;padding:5px 8px;font-size:12px"></select>
      </div>
      <p class="hint" style="margin-bottom:10px">별도 업로드 없이, 위에서 이미 올리신 접촉 기록에서 자동으로 계산돼요. (단, "전체 명부 업로드"로 들어온 기록은 접촉방법 구분이 원본에 없어서 상담/단순상담/TM은 0으로 나올 수 있어요 — 인원수·총 건수는 항상 정확해요.)</p>
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
        <h4>인원별 주차별 접촉 현황</h4>
        <select id="ctWeeklyMonthSelect" style="border:1px solid var(--slate-300);border-radius:6px;padding:5px 8px;font-size:12px"></select>
      </div>
      <div id="ctWeeklyMetrics" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px"></div>
      <div id="ctWeeklyByChajang" style="margin-bottom:14px"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div>
          <div class="hint" style="margin-bottom:6px">이 달 주차별 총 접촉 건수</div>
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
        <h4>개별 접촉 인원 추이</h4>
        <div id="ctPeriodPills" style="display:flex;gap:6px"></div>
      </div>
      <div style="position:relative;height:220px"><canvas id="ctContactChart"></canvas></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>현재 시공사 지지 분포</h4></div>
      <div style="position:relative;height:200px"><canvas id="ctStanceChart"></canvas></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>접촉방법 통계 (상담/단순상담/TM 등)</h4></div>
      <div style="position:relative;height:200px"><canvas id="ctMethodChart"></canvas></div>
    </div>

    <div class="detail-card">
      <div class="detail-card-head"><h4>시공사 지지 성향 변화 추이 (월별)</h4></div>
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
  renderMonthlyStatSection(site);
  renderWeeklyPersonSection(site);
  rebuildContactCharts(site);
  bindContactTabEvents(site);
}

/* ---------- 차장 필터 ---------- */
function renderChajangPills(site) {
  const box = document.getElementById("ctChajangPills");
  const state = contactStateFor(site.id);
  const chajangList = [...new Set(site.contacts.map(c => c.chajang).filter(Boolean))].sort();

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
      renderChajangPills(site);
      rebuildContactCharts(site);
      renderContactTable(site);
      renderWeeklyPersonSection(site);
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
    });
  });
}

function stanceOptionsHtml(site, val) {
  const opts = [...site.companies, "미정"];
  return opts.map(o => `<option ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("");
}

/* ---------- 접촉 대상자 명단 (개별 기록) ---------- */
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
      <td style="padding:5px 4px"><select class="ct-role" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 4px;font-size:12px">
        ${ROLE_OPTIONS.map(r => `<option value="${esc(r)}" ${r === (c.role || "") ? "selected" : ""}>${r || "-"}</option>`).join("")}
      </select></td>
      <td style="padding:5px 4px"><select class="ct-method" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 4px;font-size:12px">
        ${CONTACT_METHODS.map(m => `<option value="${esc(m)}" ${m === (c.method || "") ? "selected" : ""}>${m || "-"}</option>`).join("")}
      </select></td>
      <td style="padding:5px 4px"><select class="ct-stance" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 4px;font-size:12px">
        ${stanceOptionsHtml(site, c.stance)}
      </select></td>
      <td style="padding:5px 4px"><select class="ct-level" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 4px;font-size:12px">
        ${CONTACT_LEVELS.map(l => `<option ${l === c.level ? "selected" : ""}>${l}</option>`).join("")}
      </select></td>
      <td style="padding:5px 4px"><input type="text" class="ct-note" value="${esc(c.note || "")}" placeholder="특이사항" style="border:1px solid var(--slate-300);border-radius:5px;padding:3px 5px;font-size:12px;width:100px"></td>
      <td style="padding:5px 4px"><button class="ct-del admin-only" style="border:none;background:none;color:var(--slate-300);cursor:pointer">✕</button></td>
    </tr>`).join("") || `<tr><td colspan="10" style="padding:14px 4px;color:var(--slate-500)">표시할 접촉 기록이 없습니다.</td></tr>`;

  body.querySelectorAll("tr[data-id]").forEach(row => {
    const id = row.dataset.id;
    const contact = site.contacts.find(c => c.id === id);
    if (!contact) return;
    row.querySelector(".ct-date").addEventListener("change", e => { contact.date = e.target.value; persist(); rebuildContactCharts(site); renderChajangPills(site); renderWeeklyPersonSection(site); });
    row.querySelector(".ct-name").addEventListener("change", e => { contact.name = e.target.value.trim(); persist(); });
    row.querySelector(".ct-chajang").addEventListener("change", e => { contact.chajang = e.target.value.trim(); persist(); renderChajangPills(site); rebuildContactCharts(site); renderWeeklyPersonSection(site); });
    row.querySelector(".ct-type").addEventListener("change", e => { contact.type = e.target.value; persist(); rebuildContactCharts(site); renderWeeklyPersonSection(site); });
    row.querySelector(".ct-role").addEventListener("change", e => { contact.role = e.target.value; persist(); renderWeeklyPersonSection(site); });
    row.querySelector(".ct-method").addEventListener("change", e => { contact.method = e.target.value; persist(); rebuildContactCharts(site); });
    row.querySelector(".ct-stance").addEventListener("change", e => { contact.stance = e.target.value; persist(); rebuildContactCharts(site); });
    row.querySelector(".ct-level").addEventListener("change", e => { contact.level = e.target.value; persist(); rebuildContactCharts(site); });
    row.querySelector(".ct-note").addEventListener("change", e => { contact.note = e.target.value; persist(); });
    row.querySelector(".ct-del").addEventListener("click", () => {
      if (!confirm("이 접촉 기록을 삭제하시겠습니까?")) return;
      site.contacts = site.contacts.filter(c => c.id !== id);
      persist();
      renderChajangPills(site);
      renderContactTable(site);
      rebuildContactCharts(site);
      renderWeeklyPersonSection(site);
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

/* =========================================================
   월별 담당자 접촉현황 집계 (엑셀 "OO집계" 시트 업로드)
   ========================================================= */
function renderMonthlyStatSection(site) {
  const state = contactStateFor(site.id);
  const months = [...new Set(site.contacts.map(c => monthKeyOf(c.date)).filter(Boolean))].sort();
  if (!state.selectedStatMonth || !months.includes(state.selectedStatMonth)) {
    state.selectedStatMonth = months.length ? months[months.length - 1] : null;
  }

  const sel = document.getElementById("ctStatMonthSelect");
  sel.innerHTML = months.length
    ? months.map(m => `<option value="${m}" ${m === state.selectedStatMonth ? "selected" : ""}>${m}</option>`).join("")
    : `<option value="">데이터 없음</option>`;
  sel.onchange = () => { state.selectedStatMonth = sel.value; renderMonthlyStatSection(site); };

  const rows = computeMonthlyStatRows(site, state.selectedStatMonth);
  const body = document.getElementById("ctStatBody");
  body.innerHTML = rows.map(s => `
    <tr style="border-bottom:1px solid var(--slate-100)">
      <td style="padding:4px">${esc(s.chajang)}</td>
      <td style="text-align:right;padding:4px">${fmtNum(s.headcount)}</td>
      <td style="text-align:right;padding:4px">${fmtNum(s.상담)}</td>
      <td style="text-align:right;padding:4px">${fmtNum(s.단순상담)}</td>
      <td style="text-align:right;padding:4px">${fmtNum(s.TM)}</td>
      <td style="text-align:right;padding:4px;color:var(--slate-500)">${fmtNum(s.거부)}</td>
      <td style="text-align:right;padding:4px;color:var(--slate-500)">${fmtNum(s.부재)}</td>
      <td style="text-align:right;padding:4px;color:var(--slate-500)">${fmtNum(s.불명)}</td>
      <td style="text-align:right;padding:4px;font-weight:700">${fmtNum(s.total)}</td>
    </tr>`).join("") || `<tr><td colspan="9" style="padding:14px 4px;color:var(--slate-500)">이 월에 접촉 기록이 없습니다.</td></tr>`;

  rebuildMonthlyStatChart(site, rows);
}

function computeMonthlyStatRows(site, monthKey) {
  const byChajang = {};
  site.contacts.filter(c => monthKeyOf(c.date) === monthKey).forEach(c => {
    const key = c.chajang || "(담당 미지정)";
    if (!byChajang[key]) byChajang[key] = { chajang: key, names: new Set(), counts: {} };
    if (c.name) byChajang[key].names.add(c.name);
    const m = c.method || "";
    byChajang[key].counts[m] = (byChajang[key].counts[m] || 0) + 1;
  });
  return Object.values(byChajang).map(g => ({
    chajang: g.chajang,
    headcount: g.names.size,
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

  const chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: rows.map(s => s.chajang),
      datasets: [
        { label: "상담", data: rows.map(s => s.상담), backgroundColor: "#378add", borderRadius: 4 },
        { label: "단순상담", data: rows.map(s => s.단순상담), backgroundColor: "#eda100", borderRadius: 4 },
        { label: "TM", data: rows.map(s => s.TM), backgroundColor: "#1d9e75", borderRadius: 4 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
  });

  if (!_contactCharts[site.id]) _contactCharts[site.id] = {};
  _contactCharts[site.id].monthly = chart;
}

/* =========================================================
   인원별 주차별/월별 접촉 현황 (개별 접촉기록 site.contacts 기준으로
   자동 집계 — 별도 엑셀 업로드 없이 "전체 명부 엑셀 업로드"로 들어온
   데이터에서 바로 계산됩니다)
   ========================================================= */
function weekOfMonthNum(dateStr) {
  const day = Number(dateStr.slice(8, 10));
  return Math.min(5, Math.ceil(day / 7));
}
function roleLabel(c) {
  if (c.type === "임대의원") return c.role ? c.role : "임대의원";
  return "조합원";
}

function renderWeeklyPersonSection(site) {
  const monthSel = document.getElementById("ctWeeklyMonthSelect");
  if (!monthSel) return;

  const months = [...new Set(site.contacts.map(c => monthKeyOf(c.date)).filter(Boolean))].sort();
  const state = contactStateFor(site.id);
  if (!state.selectedWeeklyMonth || !months.includes(state.selectedWeeklyMonth)) {
    state.selectedWeeklyMonth = months.length ? months[months.length - 1] : null;
  }
  monthSel.innerHTML = months.length
    ? months.map(m => `<option value="${m}" ${m === state.selectedWeeklyMonth ? "selected" : ""}>${m}</option>`).join("")
    : `<option value="">데이터 없음</option>`;
  monthSel.onchange = () => { state.selectedWeeklyMonth = monthSel.value; renderWeeklyPersonSection(site); };

  const monthContacts = selectedContacts(site).filter(c => monthKeyOf(c.date) === state.selectedWeeklyMonth);

  // 사람별로 묶기
  const byName = {};
  monthContacts.forEach(c => {
    if (!c.name) return;
    (byName[c.name] = byName[c.name] || { chajang: c.chajang, type: c.type, role: c.role, weeks: {}, total: 0 });
    const wk = weekOfMonthNum(c.date);
    byName[c.name].weeks[wk] = (byName[c.name].weeks[wk] || 0) + 1;
    byName[c.name].total += 1;
    byName[c.name].chajang = c.chajang || byName[c.name].chajang;
  });
  const people = Object.entries(byName).map(([name, d]) => ({ name, ...d }));

  // 요약 카드
  const totalPeople = people.length;
  const totalCount = people.reduce((s, p) => s + p.total, 0);
  const leaseCount = people.filter(p => p.type === "임대의원").length;
  document.getElementById("ctWeeklyMetrics").innerHTML = `
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">이 달 접촉 인원</div>
      <div style="font-size:20px;font-weight:800">${totalPeople}명</div>
    </div>
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">임대의원 / 조합원</div>
      <div style="font-size:20px;font-weight:800">${leaseCount} / ${totalPeople - leaseCount}</div>
    </div>
    <div style="background:var(--paper);border-radius:8px;padding:10px 12px">
      <div style="font-size:11.5px;color:var(--slate-500)">총 접촉 건수</div>
      <div style="font-size:20px;font-weight:800;color:var(--accent)">${totalCount}건</div>
    </div>`;

  // 차장별로 묶고, 그 안에서 임대의원/조합원으로 나눔
  const byChajang = {};
  people.forEach(p => {
    const key = p.chajang || "(담당 미지정)";
    if (!byChajang[key]) byChajang[key] = { 임대의원: [], 조합원: [] };
    const bucket = p.type === "임대의원" ? "임대의원" : "조합원";
    byChajang[key][bucket].push(p);
  });
  const chajangNames = Object.keys(byChajang).sort((a, b) => a.localeCompare(b));

  function weeksHtml(p) {
    return [1, 2, 3, 4, 5].map(w => `<td style="text-align:right;padding:4px">${p.weeks[w] ? fmtNum(p.weeks[w]) : "-"}</td>`).join("");
  }
  function miniTable(title, list) {
    const sum = list.reduce((s, p) => s + p.total, 0);
    return `
      <div style="flex:1;min-width:280px">
        <div style="font-size:12.5px;font-weight:700;margin-bottom:6px">${title} <span style="color:var(--slate-500);font-weight:400">(${list.length}명 · ${sum}건)</span></div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:1px solid var(--slate-300)">
              <th style="text-align:left;padding:4px;color:var(--slate-500)">이름</th>
              ${[1, 2, 3, 4, 5].map(w => `<th style="text-align:right;padding:4px;color:var(--slate-500)">${w}주</th>`).join("")}
              <th style="text-align:right;padding:4px;color:var(--slate-500);font-weight:700">합계</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(p => `<tr style="border-bottom:1px solid var(--slate-100)"><td style="padding:4px">${esc(p.name)}</td>${weeksHtml(p)}<td style="text-align:right;padding:4px;font-weight:700">${fmtNum(p.total)}</td></tr>`).join("")
              || `<tr><td colspan="7" style="padding:8px 4px;color:var(--slate-500)">없음</td></tr>`}
          </tbody>
        </table>
      </div>`;
  }

  const container = document.getElementById("ctWeeklyByChajang");
  container.innerHTML = chajangNames.map(name => {
    const g = byChajang[name];
    return `
      <div style="border:1px solid var(--slate-100);border-radius:8px;padding:12px;margin-bottom:12px">
        <div style="font-size:13.5px;font-weight:800;margin-bottom:10px">👤 ${esc(name)}</div>
        <div style="display:flex;gap:20px;flex-wrap:wrap">
          ${miniTable("임대의원", g.임대의원)}
          ${miniTable("조합원", g.조합원)}
        </div>
      </div>`;
  }).join("") || `<p class="hint">이 달 접촉 기록이 없습니다.</p>`;

  rebuildWeeklyCharts(site, people, months);
}

function rebuildWeeklyCharts(site, people, months) {
  if (typeof Chart === "undefined") return;
  const key = site.id;
  if (!_contactCharts[key]) _contactCharts[key] = {};
  if (_contactCharts[key].weekly) _contactCharts[key].weekly.destroy();
  if (_contactCharts[key].monthlyTrend) _contactCharts[key].monthlyTrend.destroy();

  const weekTotals = [1, 2, 3, 4, 5].map(w => people.reduce((s, p) => s + (p.weeks[w] || 0), 0));
  _contactCharts[key].weekly = new Chart(document.getElementById("ctWeeklyChart"), {
    type: "bar",
    data: {
      labels: ["1주", "2주", "3주", "4주", "5주"],
      datasets: [{ label: "접촉 건수", data: weekTotals, backgroundColor: "#378add", borderRadius: 4 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
  });

  const monthlyTotals = months.map(m => selectedContacts(site).filter(c => monthKeyOf(c.date) === m).length);
  _contactCharts[key].monthlyTrend = new Chart(document.getElementById("ctMonthlyTrendChart"), {
    type: "line",
    data: {
      labels: months,
      datasets: [{ label: "총 접촉 건수", data: monthlyTotals, borderColor: "#1d9e75", backgroundColor: "rgba(29,158,117,0.12)", fill: true, tension: 0.3, borderWidth: 2, pointRadius: 3 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
  });
}

function numAt(row, idx) {
  const v = row[idx];
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}


/* ---------- 집계 + 차트 (개별 접촉 기록 기준) ---------- */
function buildRangeKeys(dates, mode) {
  const keys = [...new Set(dates.filter(Boolean).map(d => groupKeyOf(d, mode)))].sort();
  return keys.length ? keys : [groupKeyOf(new Date().toISOString().slice(0, 10), mode)];
}
function buildMonthRange(dates) {
  return buildRangeKeys(dates, "month");
}

function rebuildContactCharts(site) {
  if (typeof Chart === "undefined") return;
  const siteCharts = _contactCharts[site.id] || {};
  ["contact", "stance", "method", "sentiment", "intimacy", "event"].forEach(k => { if (siteCharts[k]) siteCharts[k].destroy(); });
  const charts = { ...siteCharts };
  const contacts = selectedContacts(site);
  const state = contactStateFor(site.id);

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

  const rangeKeys = buildRangeKeys(contacts.map(c => c.date), state.period);
  const rentData = rangeKeys.map(k => contacts.filter(c => c.type === "임대의원" && groupKeyOf(c.date, state.period) === k).length);
  const unionData = rangeKeys.map(k => contacts.filter(c => c.type === "조합원" && groupKeyOf(c.date, state.period) === k).length);

  charts.contact = new Chart(document.getElementById("ctContactChart"), {
    type: "bar",
    data: {
      labels: rangeKeys.map(k => groupLabel(k, state.period)),
      datasets: [
        { label: "임대의원", data: rentData, backgroundColor: "#378add", borderRadius: 4 },
        { label: "조합원", data: unionData, backgroundColor: "#d85a30", borderRadius: 4 }
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
  });

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

  const methodLabels = CONTACT_METHODS.filter(Boolean);
  const methodCounts = methodLabels.map(m => contacts.filter(c => c.method === m).length);
  charts.method = new Chart(document.getElementById("ctMethodChart"), {
    type: "bar",
    data: {
      labels: methodLabels,
      datasets: [{ label: "건수", data: methodCounts, backgroundColor: "#8b5cf6", borderRadius: 4 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
  });

  const contactMonths = buildMonthRange(contacts.map(c => c.date));
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
  document.getElementById("ctPrintA4")?.addEventListener("click", () => printContactTab("A4"));
  document.getElementById("ctPrintA3")?.addEventListener("click", () => printContactTab("A3"));

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
    site.contacts.push({
      id: uid(), date: todayStr(), chajang: "", name: "",
      type: "조합원", stance: "미정", level: "하"
    });
    persist();
    renderChajangPills(site);
    renderContactTable(site);
    rebuildContactCharts(site);
    renderWeeklyPersonSection(site);
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
      "담당차장", "이름", "구분", "직책", "월", "1주", "2주", "3주", "4주", "5주", "성향", "친밀도"
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
    const eventRows = site.specialEvents.slice().sort((a, b) => (a.date || "").localeCompare(b.date || "")).map(e => ({
      "날짜": e.date || "", "행사종류": e.type || "", "참여인원": e.count || 0, "메모": e.note || ""
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "명단");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(eventRows), "행사이력");
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
        birthDate: String(row["생년월일"] || "").trim(),
        chajang: String(row["담당차장"] || "").trim(),
        type: CONTACT_TYPES.includes(row["구분"]) ? row["구분"] : "조합원",
        role: String(row["직책"] || "").trim(),
        phone: String(row["연락처"] || "").trim(),
        address: String(row["주소"] || "").trim(),
        method: String(row["접촉방법"] || "").trim(),
        stance: String(row["성향"] || "미정").trim(),
        level: CONTACT_LEVELS.includes(row["친밀도"]) ? row["친밀도"] : "하",
        note: String(row["특이사항"] || "").trim(),
        survey: String(row["설문조사참여"] || "").trim(),
        galleryTour: String(row["갤러리투어참여"] || "").trim()
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

  if (wb.SheetNames.includes("주차별집계")) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["주차별집계"], { defval: "" });
    let addedWeekly = 0;
    rows.forEach(row => {
      const name = String(row["이름"] || "").trim();
      const month = String(row["월"] || "").trim();
      if (!name || !/^\d{4}-\d{2}$/.test(month)) return;
      const [y, m] = month.split("-").map(Number);
      const chajang = String(row["담당차장"] || "").trim();
      const type = CONTACT_TYPES.includes(row["구분"]) ? row["구분"] : "조합원";
      const role = String(row["직책"] || "").trim();
      const stance = String(row["성향"] || "미정").trim();
      const level = CONTACT_LEVELS.includes(row["친밀도"]) ? row["친밀도"] : "하";

      [1, 2, 3, 4, 5].forEach(wk => {
        const count = Number(row[`${wk}주`]) || 0;
        for (let i = 0; i < count; i++) {
          const day = Math.min(28, (wk - 1) * 7 + 1 + (i % 7)); // 주차 범위 안의 날짜로 분산 배치
          const date = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          site.contacts.push({ id: uid(), date, name, chajang, type, role, stance, level });
          addedWeekly++;
        }
      });
      if (stance && stance !== "미정" && !site.companies.includes(stance)) site.companies.push(stance);
    });
    addedContacts += addedWeekly;
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
  renderWeeklyPersonSection(site);
  alert(`명단 ${addedContacts}건 추가 / ${updatedContacts}건 갱신, 행사 ${addedEvents}건 추가되었습니다.`);
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
  const roleCol = findColByHeader(headerRows, v => v.includes("임대의원"));
  const stanceStart = findColExact(headerRows, "시공사성향");
  const intimacyStart = findColExact(headerRows, "친밀도");
  const surveyStart = findColExact(headerRows, "설문조사");

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

  const stanceLabelRow = headerRows[headerRows.findIndex(r => r && r[stanceStart + 1])] || headerRows[3] || [];
  const intimacyLabelRow = stanceLabelRow;
  const isRealLabel = v => {
    const s = String(v ?? "").trim();
    return s && !/^-?\d+(\.\d+)?$/.test(s); // 순수 숫자는 라벨이 아니라 잘못 읽힌 데이터일 가능성이 큼
  };

  const existingKeys = new Set(site.contacts.map(c => `${c.name}__${c.date}`));
  let added = 0, peopleTouched = new Set();

  for (let r = 4; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    if (!row[unionCheckCol]) continue; // 체크(1) 안 된 중복/부가 행은 건너뜀
    const name = String(row[nameCol] ?? "").trim();
    if (!name) continue;

    const dept = String(row[deptCol] ?? "").trim();
    const role = String(row[roleCol] ?? "").trim();
    const type = role ? "임대의원" : "조합원";

    let stance = "미정";
    for (let c = stanceStart + 1; c < intimacyStart; c++) {
      if (row[c] && isRealLabel(stanceLabelRow[c])) { stance = String(stanceLabelRow[c]).trim(); break; }
    }
    let level = "하";
    for (let c = intimacyStart + 1; c < intimacyEnd; c++) {
      if (row[c] && isRealLabel(intimacyLabelRow[c])) { level = String(intimacyLabelRow[c]).trim(); break; }
    }

    let personHasContact = false;
    dateCols.forEach(c => {
      const v = row[c];
      if (!v) return;
      const serial = dateHeaderRow[c];
      if (typeof serial !== "number") return;
      const dateStr = formatDateLocal(excelSerialToDate(serial));
      const key = `${name}__${dateStr}`;
      if (existingKeys.has(key)) return;
      existingKeys.add(key);
      site.contacts.push({ id: uid(), date: dateStr, chajang: dept, name, type, role, stance, level });
      added++;
      personHasContact = true;
    });
    if (personHasContact) peopleTouched.add(name);

    if (stance !== "미정" && !site.companies.includes(stance)) site.companies.push(stance);
  }

  if (!added) { alert("새로 추가할 접촉 기록이 없습니다 (이미 반영된 데이터일 수 있어요)."); return; }

  persist();
  renderChajangPills(site);
  renderCompanyTags(site);
  renderContactTable(site);
  rebuildContactCharts(site);
  renderWeeklyPersonSection(site);
  alert(`"${targetSheet}" 시트에서 ${peopleTouched.size}명, 총 ${added}건의 접촉 기록을 새로 불러왔습니다.`);
}
