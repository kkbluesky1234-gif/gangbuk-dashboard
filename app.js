/* =========================================================
   시장모니터링 대시보드 — app.js
   현장 데이터는 Firebase Firestore에 저장됩니다(로컬은 캐시용).
   비밀번호(관리자 / Guest)도 Firestore에 저장되어,
   관리자 화면에서 바꾸면 모든 기기에 즉시 반영됩니다.
   ========================================================= */

const STORAGE_KEY = "dashboard_sites_v1";
const OFFICE_KEY = "dashboard_office_name_v1";

/* 비밀번호 관련 --------------------------------------------
   아래 두 값은 "최초 1회"만 쓰이는 기본 비밀번호입니다.
   Firestore에 비밀번호가 저장되고 나면 이 값은 더 이상 사용되지 않습니다.
   첫 로그인 후 반드시 관리자 화면의 "비밀번호 변경"으로 바꾸세요. */
const DEFAULT_ADMIN_PW = "admin1234";
const DEFAULT_GUEST_PW = "guest1234";
const AUTH_CACHE_KEY = "dashboard_auth_cache_v1";
const AUTH_DOC_ID = "auth_v1";

/* 텔레그램 일지 서버 연동 (선택 사항)
   Render 등에 배포한 서버 주소를 넣으면, 현장 상세 패널을 열 때
   그 현장 이름(#태그)으로 올라온 텔레그램 일지를 자동으로 같이 보여줍니다.
   비워두면 로컬(붙여넣기로 추가한) 일지만 표시됩니다. */
const SERVER_BASE_URL = "https://telegram-journal-server.onrender.com";

const FIELD_ORDER = [
  ["name", "현장명"], ["city", "도시"], ["district", "구"], ["dong", "동"],
  ["office", "사업소(권역)"], ["pipelineStage", "파이프라인 단계"],
  ["stage", "단계"], ["status", "상태(사업방식 태그)"], ["area", "면적(m²)"],
  ["expectedOrder", "예상발주"], ["newUnits", "신축세대"], ["totalFloorArea", "연면적(m²)"],
  ["scale", "규모(층수 등)"], ["unionMembers", "조합원수"], ["lastLogDate", "최근 일지 날짜"],
  ["maintCo", "정비업체"], ["designCo", "설계업체"], ["trustCo", "신탁사"],
  ["manager", "담당자"], ["lat", "위도"], ["lng", "경도"], ["boundaryText", "구역 경계 좌표"],
  ["nextEventDate", "다음 일정 날짜"], ["nextEventNote", "다음 일정 메모"], ["note", "비고"],
  ["address", "위치(지번주소)"], ["bizType", "사업방식 상세"], ["zoneUse", "지역지구"],
  ["far", "용적률(%)"], ["bcr", "건폐율(%)"], ["parking", "주차대수"],
  ["rentalUnits", "임대세대"], ["ltRentUnits", "장기전세세대"], ["rentalTotal", "임대계"],
  ["currentBuilding", "현건축물 현황"], ["siteFeature", "입지특성"],
  ["unionOffice", "조합 사무실"], ["specialNote", "특이사항"], ["competitor", "타사활동"],
  ["meetingCo", "총회대행"], ["otherCo", "그외업체"]
];

const PIPELINE_STAGES = ["미관리", "모니터링", "스크린", "중점", "입찰", "수주", "타사선정"];
const DEFAULT_REGIONS = ["강서", "강북", "강남"];
const PROVINCES = ["서울특별시", "경기도", "인천광역시"];
const GYEONGGI_CITIES = [
  "수원시", "성남시", "고양시", "용인시", "부천시", "안산시", "안양시", "남양주시",
  "화성시", "평택시", "의정부시", "시흥시", "파주시", "김포시", "광명시", "광주시",
  "군포시", "이천시", "양주시", "오산시", "구리시", "안성시", "포천시", "의왕시",
  "하남시", "여주시", "양평군", "동두천시", "과천시", "가평군", "연천군"
];
const INCHEON_DISTRICTS = ["중구", "동구", "미추홀구", "연수구", "남동구", "부평구", "계양구", "서구", "강화군", "옹진군"];
let provinceDrilldown = null;
let mainGeocoder;

let sites = [];
let isAdmin = false;
let labelEditMode = false;
let districtFilter = "";
let managerFilterVal = "";
let pipelineFilter = "";
let regionFilter = "";
let provinceFilter = "";
let map, markerLayer = [];

function provinceOf(city) {
  if (!city) return "";
  if (city.includes("서울")) return "서울특별시";
  if (city.includes("인천")) return "인천광역시";
  if (city.includes("경기") || city.includes("의정부") || city.includes("고양") || city.includes("남양주") || city.includes("구리") || city.includes("하남")) return "경기도";
  return "";
}

/* ---------- 저장/로드 ---------- */
function boundaryToFirestore(boundary) {
  return (boundary || []).map(([la, ln]) => ({ lat: la, lng: ln }));
}
function boundaryFromFirestore(boundary) {
  return (boundary || []).map(b => Array.isArray(b) ? b : [b.lat, b.lng]);
}

async function loadSites() {
  try {
    const snap = await firestoreSitesDoc.get();
    if (snap.exists) {
      const raw = Array.isArray(snap.data().sites) ? snap.data().sites : [];
      sites = raw.map(s => ({ ...s, boundary: boundaryFromFirestore(s.boundary) }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sites)); // 오프라인 대비 캐시
      return;
    }
  } catch (e) {
    console.warn("Firebase에서 현장 데이터를 못 불러왔습니다. 로컬 캐시를 사용합니다.", e);
  }
  try { sites = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch (e) { sites = []; }
}

let _firestoreSyncTimer = null;
function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sites));
  clearTimeout(_firestoreSyncTimer);
  _firestoreSyncTimer = setTimeout(async () => {
    try {
      const sanitized = sites.map(s => ({ ...s, boundary: boundaryToFirestore(s.boundary) }));
      await firestoreSitesDoc.set({ sites: sanitized, updatedAt: new Date().toISOString() });
    } catch (e) {
      console.warn("Firebase에 현장 데이터 저장 실패(로컬에는 저장됨):", e);
    }
  }, 600);
}
function uid() {
  return "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* =========================================================
   비밀번호 설정 (Firestore 공유)
   dashboard/auth_v1 문서에 { adminPw, guestPw } 형태로 저장됩니다.
   ========================================================= */
let authConfig = { adminPw: DEFAULT_ADMIN_PW, guestPw: DEFAULT_GUEST_PW };
let authLoaded = false;

try {
  const cached = JSON.parse(localStorage.getItem(AUTH_CACHE_KEY));
  if (cached && cached.adminPw) authConfig = { ...authConfig, ...cached };
} catch (e) { /* 캐시 없음 */ }

function authDocRef() {
  try {
    if (typeof firestoreSitesDoc !== "undefined" && firestoreSitesDoc && firestoreSitesDoc.parent) {
      return firestoreSitesDoc.parent.doc(AUTH_DOC_ID);
    }
    return firebase.firestore().collection("dashboard").doc(AUTH_DOC_ID);
  } catch (e) {
    console.warn("Firebase 연결이 준비되지 않았습니다.", e);
    return null;
  }
}

async function loadAuthConfig() {
  const ref = authDocRef();
  if (!ref) { authLoaded = true; return; }
  try {
    const snap = await ref.get();
    if (snap.exists) {
      const d = snap.data() || {};
      authConfig = {
        adminPw: d.adminPw || DEFAULT_ADMIN_PW,
        guestPw: d.guestPw || DEFAULT_GUEST_PW
      };
      localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(authConfig));
    } else {
      // 최초 실행: 기본 비밀번호로 문서를 만들어 둡니다.
      await ref.set(authConfig);
      localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(authConfig));
      console.log("비밀번호 설정을 새로 만들었습니다. 관리자 화면에서 꼭 변경하세요.");
    }
  } catch (e) {
    console.warn("비밀번호 설정을 불러오지 못했습니다. 저장된 값/기본값을 사용합니다.", e);
  }
  authLoaded = true;
}

async function saveAuthConfig() {
  const ref = authDocRef();
  if (!ref) throw new Error("Firebase에 연결되어 있지 않습니다.");
  await ref.set(authConfig);
  localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(authConfig));
}

/* ---------- 로그인 ---------- */
const loginGate = document.getElementById("loginGate");
const pwBox = document.getElementById("pwBox");
const pwInput = document.getElementById("pwInput");
const pwError = document.getElementById("pwError");

let pendingRole = null; // "admin" 또는 "guest"

function openPwBox(role) {
  pendingRole = role;
  pwBox.classList.remove("hidden");
  pwError.classList.add("hidden");
  pwInput.value = "";
  pwInput.placeholder = role === "admin" ? "관리자 비밀번호" : "Guest 비밀번호";
  pwInput.focus();
}

document.getElementById("chooseGuest").addEventListener("click", () => openPwBox("guest"));
document.getElementById("chooseAdmin").addEventListener("click", () => openPwBox("admin"));

document.getElementById("pwCancel").addEventListener("click", () => {
  pwBox.classList.add("hidden");
  pwError.classList.add("hidden");
  pwInput.value = "";
  pendingRole = null;
});
document.getElementById("pwConfirm").addEventListener("click", tryLogin);
pwInput.addEventListener("keydown", e => { if (e.key === "Enter") tryLogin(); });

async function tryLogin() {
  if (!authLoaded) await loadAuthConfig();
  const expected = pendingRole === "admin" ? authConfig.adminPw : authConfig.guestPw;
  if (pwInput.value === expected) {
    pwError.classList.add("hidden");
    enterApp(pendingRole === "admin");
  } else {
    pwError.textContent = "비밀번호가 올바르지 않습니다.";
    pwError.classList.remove("hidden");
  }
}

function enterApp(admin) {
  isAdmin = admin;
  document.body.classList.toggle("is-admin", admin);
  document.getElementById("modeBadge").textContent = admin ? "관리자" : "Guest";
  document.getElementById("modeBadge").classList.toggle("admin", admin);
  loginGate.classList.add("hidden");
  pwBox.classList.add("hidden");
  pwInput.value = "";
  initMap();
}

document.getElementById("btnLogout").addEventListener("click", () => {
  loginGate.classList.remove("hidden");
  pwBox.classList.add("hidden");
  pwInput.value = "";
  pendingRole = null;
});

document.getElementById("btnRefreshData").addEventListener("click", async () => {
  const btn = document.getElementById("btnRefreshData");
  btn.disabled = true; btn.textContent = "새로고침 중...";
  await loadSites();
  refreshAll();
  btn.disabled = false; btn.textContent = "🔄 새로고침";
});

// 콘솔에서 비밀번호를 바꾸고 싶을 때: changeAdminPassword("새비밀번호") / changeGuestPassword("새비밀번호")
window.changeAdminPassword = async function (newPw) {
  authConfig.adminPw = newPw;
  await saveAuthConfig();
  console.log("관리자 비밀번호가 변경되었습니다.");
};
window.changeGuestPassword = async function (newPw) {
  authConfig.guestPw = newPw;
  await saveAuthConfig();
  console.log("Guest 비밀번호가 변경되었습니다.");
};

/* ---------- 텔레그램 일지 붙여넣기 ---------- */
const telegramImportModal = document.getElementById("telegramImportModal");
let tgParsedEntries = [];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseTelegramText(raw) {
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  const dateRe = /(\d{4}|\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/;
  return lines.map(line => {
    const m = line.match(dateRe);
    let date = "", text = line;
    if (m) {
      const y = m[1].length === 2 ? "20" + m[1] : m[1];
      const mo = m[2].padStart(2, "0");
      const d = m[3].padStart(2, "0");
      date = `${y}-${mo}-${d}`;
      text = (line.slice(0, m.index) + line.slice(m.index + m[0].length))
        .replace(/^[\[\]:,.\s]+|[\[\]:,.\s]+$/g, "").trim();
    }
    if (!text) text = line;
    return { date: date || todayStr(), text };
  }).filter(e => e.text);
}

function renderTgPreview() {
  const box = document.getElementById("tgPreviewList");
  box.innerHTML = tgParsedEntries.map((e, i) => `
    <div class="timeline-item" data-idx="${i}">
      <input type="date" class="tg-date" value="${e.date}">
      <input type="text" class="tg-text" value="${esc(e.text)}" style="flex:1">
      <button class="t-del">✕</button>
    </div>`).join("") || `<p class="hint">위 텍스트를 붙여넣고 "미리보기"를 눌러주세요.</p>`;

  box.querySelectorAll(".t-del").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.closest(".timeline-item").dataset.idx);
      tgParsedEntries.splice(idx, 1);
      renderTgPreview();
    });
  });
}

document.getElementById("btnTelegramImport").addEventListener("click", () => {
  const sel = document.getElementById("tgSiteSelect");
  sel.innerHTML = sites.slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("") ||
    `<option value="">(등록된 현장 없음)</option>`;
  document.getElementById("tgRawText").value = "";
  tgParsedEntries = [];
  renderTgPreview();
  telegramImportModal.classList.remove("hidden");
});
document.getElementById("tgImportClose").addEventListener("click", () => telegramImportModal.classList.add("hidden"));
document.getElementById("tgImportCancel").addEventListener("click", () => telegramImportModal.classList.add("hidden"));

document.getElementById("tgParseBtn").addEventListener("click", () => {
  tgParsedEntries = parseTelegramText(document.getElementById("tgRawText").value);
  renderTgPreview();
});

document.getElementById("tgImportConfirm").addEventListener("click", () => {
  document.querySelectorAll("#tgPreviewList .timeline-item").forEach((row, i) => {
    tgParsedEntries[i].date = row.querySelector(".tg-date").value;
    tgParsedEntries[i].text = row.querySelector(".tg-text").value.trim();
  });
  tgParsedEntries = tgParsedEntries.filter(e => e.text);

  const siteId = document.getElementById("tgSiteSelect").value;
  const site = sites.find(s => s.id === siteId);
  if (!site) { alert("현장을 선택하세요."); return; }
  if (!tgParsedEntries.length) { alert("추가할 내용이 없습니다. 먼저 '미리보기'를 눌러주세요."); return; }

  site.milestones = site.milestones || [];
  tgParsedEntries.forEach(e => site.milestones.push({ date: e.date, text: e.text, source: "telegram" }));
  site.updatedAt = new Date().toISOString();
  persist();
  telegramImportModal.classList.add("hidden");
  refreshAll();
  alert(`${tgParsedEntries.length}건을 "${site.name}" 일지에 추가했습니다.`);
});

/* ---------- 구역 색상 설정 ---------- */
const regionColorModal = document.getElementById("regionColorModal");

document.getElementById("btnRegionColors").addEventListener("click", () => {
  const regions = allRegions();
  const rows = document.getElementById("regionColorRows");
  rows.innerHTML = regions.map(r => `
    <div class="region-color-row" data-office="${esc(r)}">
      <span>${esc(r)}</span>
      <input type="color" value="${getRegionColor(r)}">
    </div>`).join("") || `<p class="hint">등록된 사업소(권역)가 없습니다.</p>`;
  regionColorModal.classList.remove("hidden");
});
document.getElementById("regionColorClose").addEventListener("click", () => regionColorModal.classList.add("hidden"));
document.getElementById("regionColorCancel").addEventListener("click", () => regionColorModal.classList.add("hidden"));

document.getElementById("regionColorSave").addEventListener("click", () => {
  document.querySelectorAll("#regionColorRows .region-color-row").forEach(row => {
    customRegionColors[row.dataset.office] = row.querySelector("input[type=color]").value;
  });
  localStorage.setItem(REGION_COLOR_KEY, JSON.stringify(customRegionColors));
  regionColorModal.classList.add("hidden");
  renderMarkers();
  renderRegionButtons();
});
document.getElementById("regionColorReset").addEventListener("click", () => {
  if (!confirm("모든 구역 색상을 기본값으로 되돌릴까요?")) return;
  customRegionColors = {};
  localStorage.removeItem(REGION_COLOR_KEY);
  Object.keys(regionColorCache).forEach(k => delete regionColorCache[k]);
  regionColorModal.classList.add("hidden");
  renderMarkers();
  renderRegionButtons();
});

/* ---------- 사업소 이름 정리 (통합) ---------- */
const officeCleanModal = document.getElementById("officeCleanModal");

document.getElementById("btnCleanOffice").addEventListener("click", () => {
  const counts = {};
  sites.forEach(s => { if (s.office) counts[s.office] = (counts[s.office] || 0) + 1; });
  const found = Object.keys(counts).sort();
  const targets = [...new Set([...DEFAULT_REGIONS, ...found])];

  const rows = document.getElementById("officeCleanRows");
  if (!found.length) {
    rows.innerHTML = `<p class="hint">사업소 값이 입력된 현장이 아직 없습니다.</p>`;
  } else {
    rows.innerHTML = found.map(name => `
      <div class="office-clean-row" data-from="${esc(name)}">
        <span>${esc(name)} <span class="oc-count">(${counts[name]}개)</span></span>
        <span class="oc-arrow">→</span>
        <select>
          ${targets.map(t => `<option value="${esc(t)}" ${t === name ? "selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
      </div>`).join("");
  }
  officeCleanModal.classList.remove("hidden");
});
document.getElementById("officeCleanClose").addEventListener("click", () => officeCleanModal.classList.add("hidden"));
document.getElementById("officeCleanCancel").addEventListener("click", () => officeCleanModal.classList.add("hidden"));

document.getElementById("officeCleanApply").addEventListener("click", () => {
  const rows = document.querySelectorAll("#officeCleanRows .office-clean-row");
  let changed = 0;
  rows.forEach(row => {
    const from = row.dataset.from;
    const to = row.querySelector("select").value;
    if (from === to) return;
    sites.forEach(s => { if (s.office === from) { s.office = to; s.updatedAt = new Date().toISOString(); changed++; } });
  });
  if (changed) {
    persist();
    refreshAll();
    alert(`${changed}개 현장의 사업소 이름을 정리했습니다.`);
  }
  officeCleanModal.classList.add("hidden");
});

/* ---------- 비밀번호 변경 (관리자 모드 내) ----------
   관리자 비밀번호 / Guest 비밀번호를 골라서 바꿀 수 있습니다.
   변경 시 반드시 "현재 관리자 비밀번호"를 입력해야 합니다.
   저장하면 Firestore에 반영되어 모든 기기에 즉시 적용됩니다. */
const pwChangeModal = document.getElementById("pwChangeModal");
const pwChangeMsg = document.getElementById("pwChangeMsg");

function ensurePwTargetSelect() {
  if (document.getElementById("pwTarget")) return;
  const oldInput = document.getElementById("pwOld");
  if (!oldInput) return;

  const wrap = document.createElement("div");
  wrap.style.marginBottom = "12px";
  wrap.innerHTML = `
    <label style="display:block;font-size:13px;margin-bottom:4px;font-weight:600">변경할 비밀번호</label>
    <select id="pwTarget" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px">
      <option value="admin">관리자 비밀번호</option>
      <option value="guest">Guest 비밀번호</option>
    </select>`;

  let anchor = oldInput;
  const prev = oldInput.previousElementSibling;
  if (prev && prev.tagName === "LABEL") anchor = prev;
  anchor.parentElement.insertBefore(wrap, anchor);
}

document.getElementById("btnChangePw").addEventListener("click", () => {
  ensurePwTargetSelect();
  document.getElementById("pwOld").value = "";
  document.getElementById("pwNew").value = "";
  document.getElementById("pwNew2").value = "";
  const t = document.getElementById("pwTarget");
  if (t) t.value = "admin";
  pwChangeMsg.classList.add("hidden");
  pwChangeModal.classList.remove("hidden");
});
document.getElementById("pwChangeCancel").addEventListener("click", () => {
  pwChangeModal.classList.add("hidden");
});
document.getElementById("pwChangeConfirm").addEventListener("click", async () => {
  const target = document.getElementById("pwTarget")?.value || "admin";
  const oldVal = document.getElementById("pwOld").value;
  const newVal = document.getElementById("pwNew").value;
  const newVal2 = document.getElementById("pwNew2").value;

  const showMsg = (text) => { pwChangeMsg.textContent = text; pwChangeMsg.classList.remove("hidden"); };

  if (oldVal !== authConfig.adminPw) { showMsg("현재 관리자 비밀번호가 틀렸습니다."); return; }
  if (!newVal || newVal.length < 4) { showMsg("새 비밀번호는 4자 이상이어야 합니다."); return; }
  if (newVal !== newVal2) { showMsg("새 비밀번호 확인이 일치하지 않습니다."); return; }

  const backup = { ...authConfig };
  if (target === "admin") authConfig.adminPw = newVal;
  else authConfig.guestPw = newVal;

  try {
    await saveAuthConfig();
  } catch (e) {
    authConfig = backup;
    showMsg("저장에 실패했습니다. 인터넷 연결을 확인해주세요.");
    return;
  }

  pwChangeModal.classList.add("hidden");
  alert(`${target === "admin" ? "관리자" : "Guest"} 비밀번호가 변경되었습니다.\n모든 기기에서 다음 로그인부터 새 비밀번호를 사용하세요.`);
});

/* ---------- 지도 초기화 ---------- */
async function initMap() {
  document.getElementById("map").innerHTML = '<div style="padding:40px;font-size:14px;color:#64748b">불러오는 중...</div>';
  await loadSites();
  if (typeof kakao === "undefined" || !kakao.maps) {
    document.getElementById("map").innerHTML =
      '<div style="padding:40px;font-size:14px;color:#64748b">카카오맵 API 키가 설정되지 않았거나 이 주소가 카카오 디벨로퍼스에 도메인 등록되지 않았습니다.<br>(카카오 디벨로퍼스 → 내 애플리케이션 → 플랫폼 → Web 도메인 등록 필요)</div>';
    populateFilters();
    renderRegionButtons();
    renderProvincePanel();
    renderTabsBar();
    renderStatsBar();
    renderUpcoming();
    renderSiteList();
    return;
  }
  kakao.maps.load(() => {
    map = new kakao.maps.Map(document.getElementById("map"), {
      center: new kakao.maps.LatLng(37.5665, 126.9780),
      level: 8
    });
    refreshAll();
  });
}

/* 데이터가 바뀔 때마다 이 함수 하나만 호출하면 화면 전체가 갱신됩니다. */
function refreshAll() {
  populateFilters();
  renderRegionButtons();
  renderProvincePanel();
  renderTabsBar();
  renderStatsBar();
  renderUpcoming();
  renderMarkers();
  renderSiteList();
  if (currentDetailId) {
    if (sites.some(s => s.id === currentDetailId)) renderSiteDetail();
    else closeSiteDetail();
  }
}

/* ---------- 필터 옵션 채우기 ---------- */
function populateFilters() {
  const managerSel = document.getElementById("managerFilter");
  const districtSel = document.getElementById("districtSelect");
  const managerList = document.getElementById("managerDatalist");
  const districtList = document.getElementById("districtDatalist");

  const managers = [...new Set(sites.map(s => s.manager).filter(Boolean))].sort();
  const districts = [...new Set(sites.map(s => s.district).filter(Boolean))].sort();

  managerSel.innerHTML = '<option value="">담당자 전체</option>' +
    managers.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  districtSel.innerHTML = '<option value="">구 선택</option>' +
    districts.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
  managerList.innerHTML = managers.map(m => `<option value="${esc(m)}">`).join("");
  districtList.innerHTML = districts.map(d => `<option value="${esc(d)}">`).join("");

  const offices = [...new Set([...DEFAULT_REGIONS, ...sites.map(s => s.office).filter(Boolean)])];
  const officeSel = document.getElementById("f_office");
  officeSel.innerHTML = offices.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
}

function allRegions() {
  return [...new Set([...DEFAULT_REGIONS, ...sites.map(s => s.office).filter(Boolean)])];
}
function regionScopedSites() {
  return sites.filter(s => !regionFilter || s.office === regionFilter);
}

document.getElementById("managerFilter").addEventListener("change", e => {
  managerFilterVal = e.target.value; renderMarkers(); renderSiteList();
});
document.getElementById("districtSelect").addEventListener("change", e => {
  districtFilter = e.target.value; renderMarkers(); renderSiteList();
  fitMapToVisibleSites();
});
document.getElementById("clearDistrictFilter").addEventListener("click", () => {
  districtFilter = ""; document.getElementById("districtSelect").value = "";
  provinceFilter = ""; provinceDrilldown = null;
  renderProvincePanel();
  renderMarkers(); renderSiteList();
});

function visibleSites() {
  return sites.filter(s =>
    (!districtFilter || s.district === districtFilter) &&
    (!managerFilterVal || s.manager === managerFilterVal) &&
    (!pipelineFilter || s.pipelineStage === pipelineFilter) &&
    (!regionFilter || s.office === regionFilter) &&
    (!provinceFilter || provinceOf(s.city) === provinceFilter)
  );
}

/* ---------- 시도 선택 (지도 우측 상단) ---------- */
function renderProvincePanel() {
  const titleEl = document.getElementById("provinceTitle");
  const box = document.getElementById("provinceButtons");

  if (!provinceDrilldown) {
    titleEl.textContent = "시도 선택";
    box.className = "province-buttons";
    box.innerHTML = PROVINCES.map(p =>
      `<button class="${provinceFilter === p ? "active" : ""} ${p === "인천광역시" ? "span2" : ""}" data-p="${esc(p)}">${esc(p)}</button>`
    ).join("");
    box.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", () => {
        provinceFilter = btn.dataset.p;
        provinceDrilldown = btn.dataset.p;
        renderProvincePanel();
        renderMarkers(); renderSiteList();
      });
    });
    return;
  }

  // 드릴다운: 선택한 시/도의 구·시 목록을 보여줌
  titleEl.innerHTML = `<button id="provinceBack" class="province-back">← 시도 선택</button> &gt; ${esc(provinceDrilldown)}`;

  let list = [];
  if (provinceDrilldown === "서울특별시") {
    list = (window.SEOUL_DISTRICTS || []).map(d => d.name).slice().sort();
  } else if (provinceDrilldown === "경기도") {
    list = GYEONGGI_CITIES;
  } else if (provinceDrilldown === "인천광역시") {
    list = INCHEON_DISTRICTS;
  }

  box.className = "province-buttons district-grid";
  box.innerHTML = list.map(name =>
    `<button class="${districtFilter === name ? "active" : ""}" data-d="${esc(name)}">${esc(name)}</button>`
  ).join("");

  document.getElementById("provinceBack").addEventListener("click", () => {
    provinceDrilldown = null;
    renderProvincePanel();
  });
  box.querySelectorAll("button[data-d]").forEach(btn => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.d;
      districtFilter = districtFilter === name ? "" : name;
      const sel = document.getElementById("districtSelect");
      if (sel) sel.value = districtFilter;
      renderProvincePanel();
      renderMarkers(); renderSiteList();
      if (districtFilter) navigateToDistrict(provinceDrilldown, name);
    });
  });
}

/* 구/시 버튼을 누르면 그 지역으로 지도를 이동합니다. */
function navigateToDistrict(province, name) {
  if (!map) return;
  if (province === "서울특별시" && window.SEOUL_DISTRICTS) {
    const d = window.SEOUL_DISTRICTS.find(x => x.name === name);
    if (d) {
      const bounds = new kakao.maps.LatLngBounds();
      d.path.forEach(([la, ln]) => bounds.extend(new kakao.maps.LatLng(la, ln)));
      map.setBounds(bounds);
      return;
    }
  }
  if (!mainGeocoder) mainGeocoder = new kakao.maps.services.Geocoder();
  mainGeocoder.addressSearch(`${province} ${name}`, (result, status) => {
    if (status === kakao.maps.services.Status.OK) {
      map.setCenter(new kakao.maps.LatLng(result[0].y, result[0].x));
      map.setLevel(8);
    }
  });
}

/* 지역(사업소) 버튼을 눌렀을 때, 그 지역에 해당하는 현장들이 모두 화면에 들어오도록 지도를 맞춥니다. */
function fitMapToVisibleSites() {
  if (!map) return;
  const vis = visibleSites();
  if (!vis.length) return;
  const bounds = new kakao.maps.LatLngBounds();
  vis.forEach(s => {
    const [lat, lng] = resolveLatLng(s);
    bounds.extend(new kakao.maps.LatLng(lat, lng));
    if (s.boundary && s.boundary.length > 2) {
      s.boundary.forEach(([la, ln]) => bounds.extend(new kakao.maps.LatLng(la, ln)));
    }
  });
  map.setBounds(bounds);
}

/* ---------- 지역(사업소) 빠른 필터 버튼 ---------- */
function renderRegionButtons() {
  const box = document.getElementById("regionButtons");
  const regions = ["전체", ...allRegions()];
  box.innerHTML = regions.map(r => {
    const val = r === "전체" ? "" : r;
    const active = regionFilter === val;
    return `<button class="region-btn ${active ? "active" : ""}" data-region="${esc(val)}">${esc(r)}</button>`;
  }).join("");
  box.querySelectorAll(".region-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      regionFilter = btn.dataset.region;
      renderRegionButtons(); renderTabsBar(); renderStatsBar();
      renderMarkers(); renderSiteList();
      fitMapToVisibleSites();
    });
  });
}

/* ---------- 파이프라인 단계 탭 ---------- */
function renderTabsBar() {
  const box = document.getElementById("tabsBar");
  const scoped = regionScopedSites();
  const counts = {};
  PIPELINE_STAGES.forEach(st => counts[st] = 0);
  scoped.forEach(s => { if (s.pipelineStage) counts[s.pipelineStage] = (counts[s.pipelineStage] || 0) + 1; });

  const tabs = [{ label: "전체", val: "", count: scoped.length }, ...PIPELINE_STAGES.map(st => ({ label: st, val: st, count: counts[st] || 0 }))];
  box.innerHTML = tabs.map(t => `
    <button class="stage-tab ${pipelineFilter === t.val ? "active" : ""}" data-val="${esc(t.val)}">
      ${esc(t.label)} <span class="count">${t.count}</span>
    </button>`).join("");
  box.querySelectorAll(".stage-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      pipelineFilter = btn.dataset.val;
      renderTabsBar(); renderMarkers(); renderSiteList();
    });
  });
}

/* ---------- 통계바 ---------- */
function renderStatsBar() {
  const scoped = regionScopedSites();
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const updatedThisMonth = scoped.filter(s => s.updatedAt && s.updatedAt.startsWith(ym)).length;
  const needVisit = scoped.filter(s => {
    const ref = s.updatedAt || s.lastLogDate;
    if (!ref) return true;
    const days = (now - new Date(ref)) / 86400000;
    return days > 60;
  }).length;

  document.getElementById("statTotal").textContent = scoped.length;
  document.getElementById("statUpdatedThisMonth").textContent = updatedThisMonth;
  document.getElementById("statNeedVisit").textContent = needVisit;

  const counts = PIPELINE_STAGES.map(st => scoped.filter(s => s.pipelineStage === st).length);
  const max = Math.max(1, ...counts);
  document.getElementById("miniChart").innerHTML = counts.map((c, i) =>
    `<div class="bar" data-empty="${c === 0 ? 1 : 0}" style="height:${Math.max(2, (c / max) * 30)}px" title="${PIPELINE_STAGES[i]}: ${c}"></div>`
  ).join("");
}

/* ---------- 다가오는 일정(3개월) ---------- */
function renderUpcoming() {
  const now = new Date();
  const in3mo = new Date(now); in3mo.setMonth(in3mo.getMonth() + 3);
  const scoped = regionScopedSites();
  const upcoming = scoped
    .filter(s => s.nextEventDate && new Date(s.nextEventDate) >= now && new Date(s.nextEventDate) <= in3mo)
    .sort((a, b) => new Date(a.nextEventDate) - new Date(b.nextEventDate));

  const badge = document.getElementById("upcomingBadge");
  badge.textContent = upcoming.length ? `${upcoming.length}건` : "없음";
  badge.classList.toggle("has-items", upcoming.length > 0);

  const panel = document.getElementById("upcomingPanel");
  panel.innerHTML = upcoming.length
    ? upcoming.map(s => `
        <div class="upcoming-item" data-id="${s.id}">
          <span class="ue-date">${s.nextEventDate}</span>${esc(s.name)}
          ${s.nextEventNote ? ` — ${esc(s.nextEventNote)}` : ""}
        </div>`).join("")
    : `<div class="upcoming-empty">예정된 일정이 없습니다.</div>`;

  panel.querySelectorAll(".upcoming-item").forEach(item => {
    item.addEventListener("click", () => {
      const site = sites.find(s => s.id === item.dataset.id);
      if (!site) return;
      panel.classList.add("hidden");
      focusSite(site);
      openSiteDetail(site.id);
    });
  });
}
document.getElementById("upcomingToggle").addEventListener("click", () => {
  document.getElementById("upcomingPanel").classList.toggle("hidden");
});
document.addEventListener("click", e => {
  const widget = document.getElementById("upcomingWidget");
  if (!widget.contains(e.target)) document.getElementById("upcomingPanel").classList.add("hidden");
});

/* ---------- 대략적인 구 중심좌표 (위경도 미입력 시 사용) ---------- */
const DISTRICT_FALLBACK = { // 필요한 구를 계속 추가하며 쓰면 됩니다.
  "강서구": [37.5509, 126.8495], "양천구": [37.5170, 126.8666],
  "마포구": [37.5663, 126.9019], "은평구": [37.6027, 126.9291],
  "서대문구": [37.5791, 126.9368], "종로구": [37.5730, 126.9794],
  "중구": [37.5641, 126.9979], "용산구": [37.5324, 126.9905],
  "성북구": [37.5894, 127.0167], "강북구": [37.6396, 127.0257],
  "도봉구": [37.6688, 127.0471], "노원구": [37.6542, 127.0568],
  "동대문구": [37.5744, 127.0396], "중랑구": [37.6063, 127.0925],
  "성동구": [37.5633, 127.0371], "광진구": [37.5384, 127.0822],
  "구로구": [37.4954, 126.8874], "금천구": [37.4519, 126.9020],
  "영등포구": [37.5264, 126.8963], "동작구": [37.5124, 126.9393],
  "관악구": [37.4784, 126.9516], "서초구": [37.4836, 127.0327],
  "강남구": [37.5172, 127.0473], "송파구": [37.5145, 127.1058],
  "강동구": [37.5301, 127.1238], "의정부시": [37.7381, 127.0337]
};

function resolveLatLng(site) {
  if (site.lat && site.lng) return [Number(site.lat), Number(site.lng)];
  const fb = DISTRICT_FALLBACK[site.district];
  if (fb) return fb;
  return [37.5665, 126.9780];
}

/* 현장 목록/일정에서 현장을 클릭했을 때, 지도를 그 현장 위치로 부드럽게 이동하며 확대합니다. */
function focusSite(site) {
  if (!map) return;
  if (site.boundary && site.boundary.length > 2) {
    const bounds = new kakao.maps.LatLngBounds();
    site.boundary.forEach(([la, ln]) => bounds.extend(new kakao.maps.LatLng(la, ln)));
    map.setBounds(bounds);
  } else {
    const [lat, lng] = resolveLatLng(site);
    map.panTo(new kakao.maps.LatLng(lat, lng));
    map.setLevel(3);
  }
}

/* ---------- 마커 렌더링 ---------- */
/* ---------- 서울시 자치구 경계 + 권역 색상 + 현장 수 라벨 ---------- */
let districtLayer = [];
const REGION_PALETTE = ["#8b5cf6", "#f59e0b", "#3b82f6", "#10b981", "#ec4899", "#64748b"];
const REGION_COLOR_KEY = "dashboard_region_colors_v1";
let customRegionColors = {};
try { customRegionColors = JSON.parse(localStorage.getItem(REGION_COLOR_KEY)) || {}; } catch (e) { customRegionColors = {}; }
const regionColorCache = { ...customRegionColors };
function getRegionColor(office) {
  if (!office) return "#cbd5e1";
  if (customRegionColors[office]) return customRegionColors[office];
  if (!regionColorCache[office]) {
    const used = Object.keys(regionColorCache).length;
    regionColorCache[office] = REGION_PALETTE[used % REGION_PALETTE.length];
  }
  return regionColorCache[office];
}
function dominantOffice(districtName) {
  const counts = {};
  sites.filter(s => s.district === districtName && s.office).forEach(s => {
    counts[s.office] = (counts[s.office] || 0) + 1;
  });
  const entries = Object.entries(counts);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}
function centroidOf(path) {
  let sx = 0, sy = 0;
  path.forEach(([la, ln]) => { sx += la; sy += ln; });
  return [sx / path.length, sy / path.length];
}
function renderDistrictOverlay() {
  if (!map || typeof window.SEOUL_DISTRICTS === "undefined") return;
  districtLayer.forEach(o => o.setMap(null));
  districtLayer = [];

  const vis = visibleSites();
  const NEUTRAL_COLOR = "#94a3b8";

  window.SEOUL_DISTRICTS.forEach(d => {
    const path = d.path.map(([la, ln]) => new kakao.maps.LatLng(la, ln));
    const office = dominantOffice(d.name);
    const isHighlighted = regionFilter ? (office === regionFilter) : !!office;
    const color = isHighlighted ? getRegionColor(office) : NEUTRAL_COLOR;

    const polygon = new kakao.maps.Polygon({
      path,
      strokeWeight: isHighlighted ? 2.5 : 1.5,
      strokeColor: "#ffffff", strokeOpacity: 1,
      fillColor: color, fillOpacity: isHighlighted ? 0.65 : 0.4,
      zIndex: isHighlighted ? 1 : 0
    });
    polygon.setMap(map);
    districtLayer.push(polygon);

    const count = vis.filter(s => s.district === d.name).length;
    if (count > 0) {
      const [cla, cln] = centroidOf(d.path);
      const badge = document.createElement("div");
      badge.className = "district-badge";
      badge.textContent = `${d.name} ${count}`;
      const overlay = new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(cla, cln), content: badge, yAnchor: 0.5, xAnchor: 0.5, zIndex: 1
      });
      overlay.setMap(map);
      districtLayer.push(overlay);
    }
  });
}

function renderMarkers() {
  if (!map) return;
  renderDistrictOverlay();
  markerLayer.forEach(m => m.overlay.setMap(null));
  markerLayer = [];

  visibleSites().forEach(site => {
    const [lat, lng] = resolveLatLng(site);
    const pos = new kakao.maps.LatLng(lat, lng);

    const dot = document.createElement("div");
    dot.className = "site-dot";

    const dotOverlay = new kakao.maps.CustomOverlay({ position: pos, content: dot, yAnchor: 0.5, xAnchor: 0.5, zIndex: 2 });
    dotOverlay.setMap(map);

    const label = document.createElement("div");
    label.className = "site-label";
    label.textContent = site.name;
    label.addEventListener("click", () => openSiteDetail(site.id));

    const offset = site.labelOffset || { x: 0, y: -34 };
    const labelPos = new kakao.maps.LatLng(lat, lng);
    const labelOverlay = new kakao.maps.CustomOverlay({
      position: labelPos, content: label, yAnchor: 1, xAnchor: 0.5, zIndex: 3
    });
    labelOverlay.setMap(map);
    // simple pixel offset via CSS transform since Kakao CustomOverlay has no native px offset param pre-set
    label.style.transform = `translate(${offset.x}px, ${offset.y}px)`;

    if (labelEditMode && isAdmin) {
      label.classList.add("draggable");
      makeLabelDraggable(label, site);
    }

    if (site.boundary && site.boundary.length > 2) {
      const path = site.boundary.map(([la, ln]) => new kakao.maps.LatLng(la, ln));
      const polygon = new kakao.maps.Polygon({
        path, strokeWeight: 3, strokeColor: "#1e293b", strokeOpacity: 0.9,
        fillColor: "#ffffff", fillOpacity: 0.55, zIndex: 2
      });
      polygon.setMap(map);
      markerLayer.push({ overlay: polygon });
    }

    markerLayer.push({ overlay: dotOverlay });
    markerLayer.push({ overlay: labelOverlay, site });
  });
}

function makeLabelDraggable(labelEl, site) {
  let dragging = false, startX, startY, startOffset;
  labelEl.addEventListener("mousedown", e => {
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startOffset = site.labelOffset || { x: 0, y: -34 };
    e.preventDefault();
  });
  window.addEventListener("mousemove", e => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    labelEl.style.transform = `translate(${startOffset.x + dx}px, ${startOffset.y + dy}px)`;
  });
  window.addEventListener("mouseup", e => {
    if (!dragging) return;
    dragging = false;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    site.labelOffset = { x: startOffset.x + dx, y: startOffset.y + dy };
    persist();
  });
}

document.getElementById("btnLabelEdit").addEventListener("click", () => {
  labelEditMode = !labelEditMode;
  document.getElementById("btnLabelEdit").classList.toggle("active", labelEditMode);
  document.getElementById("btnLabelEdit").textContent = labelEditMode ? "🔒 라벨 위치 저장" : "🔓 라벨 위치 편집";
  renderMarkers();
});

/* ---------- 사이드 목록 ---------- */
let selectedIds = new Set();

function renderSiteList() {
  const list = document.getElementById("siteList");
  const vis = visibleSites();
  document.getElementById("siteCount").textContent = `${vis.length}개 현장`;

  // 필터가 바뀌어 화면에서 사라진 항목은 선택 해제
  const visIds = new Set(vis.map(s => s.id));
  selectedIds.forEach(id => { if (!visIds.has(id)) selectedIds.delete(id); });

  list.innerHTML = vis.map(s => `
    <div class="site-card stage-${esc(s.pipelineStage || "미관리")}" data-id="${s.id}">
      <div class="site-card-top">
        <input type="checkbox" class="site-card-check admin-only" ${selectedIds.has(s.id) ? "checked" : ""}>
        <div class="site-card-name">${esc(s.name)}</div>
      </div>
      <div class="site-card-tags">
        ${s.pipelineStage ? `<span class="tag pipe-${esc(s.pipelineStage)}">${esc(s.pipelineStage)}</span>` : ""}
        ${s.stage ? `<span class="tag stage">${esc(s.stage)}</span>` : ""}
        ${s.status ? `<span class="tag">${esc(s.status)}</span>` : ""}
      </div>
      <div class="site-card-actions admin-only">
        <button class="edit">수정</button>
        <button class="del">삭제</button>
      </div>
    </div>`).join("") || `<div class="site-list-empty">표시할 현장이 없습니다.</div>`;

  list.querySelectorAll(".site-card").forEach(card => {
    const id = card.dataset.id;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".site-card-actions") || e.target.classList.contains("site-card-check")) return;
      const site = sites.find(s => s.id === id);
      if (!site) return;
      focusSite(site);
      openSiteDetail(site.id);
    });
    card.querySelector(".site-card-check")?.addEventListener("change", e => {
      if (e.target.checked) selectedIds.add(id); else selectedIds.delete(id);
      updateBulkBar();
    });
    card.querySelector(".edit")?.addEventListener("click", e => { e.stopPropagation(); openSiteModal(id); });
    card.querySelector(".del")?.addEventListener("click", e => {
      e.stopPropagation();
      if (!confirm("이 현장을 삭제하시겠습니까?")) return;
      sites = sites.filter(s => s.id !== id);
      selectedIds.delete(id);
      persist();
      refreshAll();
    });
  });

  updateBulkBar();
}

/* ---------- 현장 일괄 삭제 ---------- */
function updateBulkBar() {
  const bar = document.getElementById("bulkBar");
  const count = selectedIds.size;
  bar.classList.toggle("hidden", count === 0);
  document.getElementById("bulkSelectedCount").textContent = `${count}개 선택`;
  const vis = visibleSites();
  document.getElementById("selectAllBox").checked = vis.length > 0 && vis.every(s => selectedIds.has(s.id));
}
document.getElementById("selectAllBox").addEventListener("change", e => {
  const vis = visibleSites();
  if (e.target.checked) vis.forEach(s => selectedIds.add(s.id));
  else vis.forEach(s => selectedIds.delete(s.id));
  renderSiteList();
});
document.getElementById("btnBulkDelete").addEventListener("click", () => {
  const count = selectedIds.size;
  if (!count) return;
  if (!confirm(`선택한 ${count}개 현장을 삭제하시겠습니까? 되돌릴 수 없습니다.`)) return;
  sites = sites.filter(s => !selectedIds.has(s.id));
  selectedIds.clear();
  persist();
  refreshAll();
});

/* ---------- 현장 상세 패널 (클릭 시 목록 자리에 표시) ---------- */
let currentDetailId = null;

function openSiteDetail(id) {
  const site = sites.find(s => s.id === id);
  if (!site) return;
  currentDetailId = id;
  document.getElementById("siteDetailPanel").classList.remove("hidden");
  renderSiteDetail();
}
function closeSiteDetail() {
  currentDetailId = null;
  document.getElementById("siteDetailPanel").classList.add("hidden");
  updateBulkBar();
}
const serverJournalCache = {}; // siteName -> [{date,text,id}] 캐시 (매번 재요청 방지)

async function fetchServerJournal(siteName) {
  if (!SERVER_BASE_URL) return [];
  try {
    const res = await fetch(`${SERVER_BASE_URL}/api/journal?site=${encodeURIComponent(siteName)}`);
    if (!res.ok) return [];
    return await res.json(); // [{id, site, date, text, source, author, ...}]
  } catch (e) {
    console.warn("서버 일지 불러오기 실패:", e);
    return [];
  }
}

/* 로컬(수동/붙여넣기)과 서버(텔레그램 실시간) 항목을 합쳐서 하나의 리스트로 만듦. */
function buildCombinedTimeline(site) {
  const local = (site.milestones || []).map(m => ({ date: m.date, text: m.text, source: m.source, local: true, ref: m }));
  const remote = (serverJournalCache[site.name] || []).map(r => ({
    date: r.date, text: r.text, source: "telegram", local: false, remoteId: r.id,
    fieldsJson: r.fields_json, summary: r.summary
  }));
  return [...local, ...remote].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

function renderTimelineList(listEl, entries, site, { emptyText }) {
  listEl.innerHTML = entries.map((m, i) => `
    <div class="timeline-item" data-idx="${i}">
      <span class="t-date">${esc(m.date || "")}</span>
      <span>${m.source === "telegram" ? '<span class="tg-badge">\ud83d\udce9</span> ' : ""}${esc(m.text || "")}</span>
      ${isAdmin ? `<button class="t-del">\u2715</button>` : ""}
    </div>`).join("") || `<p class="hint">${emptyText}</p>`;

  listEl.querySelectorAll(".t-del").forEach((btn, i) => {
    btn.addEventListener("click", async () => {
      const entry = entries[i];
      if (entry.local) {
        site.milestones = (site.milestones || []).filter(m => m !== entry.ref);
        persist();
      } else if (SERVER_BASE_URL && entry.remoteId) {
        try { await fetch(`${SERVER_BASE_URL}/api/journal/${entry.remoteId}`, { method: "DELETE" }); }
        catch (e) { alert("\uc11c\ubc84 \uc77c\uc9c0 \uc0ad\uc81c\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4."); return; }
        serverJournalCache[site.name] = (serverJournalCache[site.name] || []).filter(r => r.id !== entry.remoteId);
      }
      renderJournalPanel(site);
      renderProgressPanel(site);
    });
  });
}

function renderProgressPanel(site) {
  const panel = document.getElementById("siteDetailPanel");
  const listEl = panel.querySelector('[data-panel="progress"] .timeline-list');
  if (!listEl) return;
  const entries = buildCombinedTimeline(site).filter(e => e.source !== "telegram");
  renderTimelineList(listEl, entries, site, { emptyText: "\ub4f1\ub85d\ub41c \ucd94\uc9c4 \uacbd\uacfc\uac00 \uc5c6\uc2b5\ub2c8\ub2e4." });
}

/* \uc77c\uc9c0(\ud154\ub808\uadf8\ub7a8) \ud56d\ubaa9: \uad6c\uc870\ud654\ub41c \uc0c1\ub2f4 \ud544\ub4dc\uac00 \uc788\uc73c\uba74 \ub77c\ubca8\ubcc4\ub85c \ubcf4\uae30 \uc88b\uac8c \ud45c\uc2dc, \uc218\uc815 \uac00\ub2a5 */
function renderJournalPanel(site) {
  const panel = document.getElementById("siteDetailPanel");
  const listEl = panel.querySelector('[data-panel="journal"] .timeline-list');
  if (!listEl) return;
  const entries = buildCombinedTimeline(site).filter(e => e.source === "telegram");

  const emptyMsg = `\uc544\uc9c1 \ub4f1\ub85d\ub41c \uc77c\uc9c0\uac00 \uc5c6\uc2b5\ub2c8\ub2e4. \ud154\ub808\uadf8\ub7a8\uc5d0 #${esc(site.name)} \ud0dc\uadf8\ub85c \uba54\uc2dc\uc9c0\ub97c \uc62c\ub824\ubcf4\uc138\uc694.`;

  listEl.innerHTML = entries.map((m, i) => {
    let fields = null;
    if (m.fieldsJson) { try { fields = JSON.parse(m.fieldsJson); } catch (e) { fields = null; } }
    const fieldRows = fields ? Object.entries(fields).filter(([k]) => k !== "\ud604\uc7a5\uba85") : [];

    if (fieldRows.length) {
      return `
        <div class="journal-card" data-idx="${i}">
          <div class="journal-card-top">
            <span class="t-date">${esc(m.date || "")}</span>
            ${isAdmin ? `<div class="journal-actions"><button class="j-edit">\uc218\uc815</button><button class="t-del">\u2715</button></div>` : ""}
          </div>
          ${m.summary ? `<div class="journal-summary">\ud83d\udca1 ${esc(m.summary)}</div>` : ""}
          <div class="journal-fields">
            ${fieldRows.map(([k, v]) => `<div class="jf-row"><span class="jf-k">${esc(k)}</span><span class="jf-v">${esc(v)}</span></div>`).join("")}
          </div>
          <div class="journal-raw-wrap hidden"><textarea class="journal-raw-edit" rows="6"></textarea></div>
        </div>`;
    }
    return `
      <div class="timeline-item" data-idx="${i}">
        <span class="t-date">${esc(m.date || "")}</span>
        <span><span class="tg-badge">\ud83d\udce9</span> ${esc(m.text || "")}</span>
        ${isAdmin ? `<button class="j-edit">\uc218\uc815</button><button class="t-del">\u2715</button>` : ""}
      </div>`;
  }).join("") || `<p class="hint">${emptyMsg}</p>`;

  const countEl = panel.querySelector(".dtab-journal-count");
  if (countEl) countEl.textContent = entries.length;

  listEl.querySelectorAll(".t-del").forEach((btn, i) => {
    btn.addEventListener("click", async () => {
      const entry = entries[i];
      if (entry.local) {
        site.milestones = (site.milestones || []).filter(m => m !== entry.ref);
        persist();
      } else if (SERVER_BASE_URL && entry.remoteId) {
        try { await fetch(`${SERVER_BASE_URL}/api/journal/${entry.remoteId}`, { method: "DELETE" }); }
        catch (e) { alert("\uc11c\ubc84 \uc77c\uc9c0 \uc0ad\uc81c\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4."); return; }
        serverJournalCache[site.name] = (serverJournalCache[site.name] || []).filter(r => r.id !== entry.remoteId);
      }
      renderJournalPanel(site);
    });
  });

  listEl.querySelectorAll(".j-edit").forEach((btn, i) => {
    btn.addEventListener("click", () => startJournalEdit(site, entries[i], btn.closest(".journal-card, .timeline-item")));
  });
}

function startJournalEdit(site, entry, containerEl) {
  const original = containerEl.innerHTML;
  containerEl.innerHTML = `
    <textarea class="journal-edit-textarea" rows="6">${esc(entry.text || "")}</textarea>
    <div class="journal-edit-actions">
      <button class="btn btn-outline btn-sm j-cancel">\ucde8\uc18c</button>
      <button class="btn btn-primary btn-sm j-save">\uc800\uc7a5</button>
    </div>`;
  containerEl.querySelector(".j-cancel").addEventListener("click", () => { containerEl.innerHTML = original; });
  containerEl.querySelector(".j-save").addEventListener("click", async () => {
    const newText = containerEl.querySelector(".journal-edit-textarea").value.trim();
    if (!newText) { alert("\ub0b4\uc6a9\uc744 \uc785\ub825\ud558\uc138\uc694."); return; }
    if (entry.local) {
      entry.ref.text = newText;
      persist();
      renderJournalPanel(site);
    } else if (SERVER_BASE_URL && entry.remoteId) {
      try {
        const res = await fetch(`${SERVER_BASE_URL}/api/journal/${entry.remoteId}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: newText, date: entry.date })
        });
        if (!res.ok) throw new Error("\uc11c\ubc84 \uc751\ub2f5 \uc624\ub958");
      } catch (e) { alert("\uc218\uc815\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4: " + e.message); return; }
      refreshServerJournal(site);
    }
  });
}

function refreshServerJournal(site) {
  if (!SERVER_BASE_URL) return;
  fetchServerJournal(site.name).then(rows => {
    serverJournalCache[site.name] = rows;
    if (currentDetailId === site.id) renderJournalPanel(site);
  });
}

/* ---------- 영업 메모 (영업 탭) ---------- */
function renderSalesPanel(site) {
  const panel = document.getElementById("siteDetailPanel");
  const listEl = panel.querySelector('[data-panel="sales"] .timeline-list');
  if (!listEl) return;
  const notes = (site.salesNotes || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  listEl.innerHTML = notes.map((n, i) => `
    <div class="timeline-item" data-idx="${i}">
      <span class="t-date">${esc(n.date || "")}</span><span>${esc(n.text || "")}</span>
      ${isAdmin ? `<button class="t-del">✕</button>` : ""}
    </div>`).join("") || `<p class="hint">등록된 영업 메모가 없습니다.</p>`;

  listEl.querySelectorAll(".t-del").forEach((btn, i) => {
    btn.addEventListener("click", () => {
      site.salesNotes = (site.salesNotes || []).filter(n => n !== notes[i]);
      persist();
      renderSalesPanel(site);
    });
  });
}

/* ---------- 공고 (공고 탭, PDF/한글 파일 업로드) ---------- */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

async function fetchServerAnnouncements(siteName) {
  if (!SERVER_BASE_URL) return [];
  try {
    const res = await fetch(`${SERVER_BASE_URL}/api/announcements?site=${encodeURIComponent(siteName)}`);
    if (!res.ok) return [];
    return await res.json(); // [{id, filename, size, uploaded_at, ...}]
  } catch (e) {
    console.warn("서버 공고 목록 불러오기 실패:", e);
    return [];
  }
}

async function renderNoticePanel(site) {
  const panel = document.getElementById("siteDetailPanel");
  const listEl = panel.querySelector('[data-panel="notice"] .notice-list');
  if (!listEl) return;

  if (SERVER_BASE_URL) {
    listEl.innerHTML = `<p class="hint">불러오는 중...</p>`;
    const files = await fetchServerAnnouncements(site.name);
    if (currentDetailId !== site.id) return; // 그 사이 다른 현장으로 이동했으면 무시
    listEl.innerHTML = files.map(f => `
      <div class="notice-item" data-id="${f.id}">
        <span class="notice-icon">📄</span>
        <a href="${SERVER_BASE_URL}/api/announcements/${f.id}" class="notice-name" target="_blank" rel="noopener">${esc(f.filename)}</a>
        <span class="notice-size">${formatFileSize(f.size || 0)}</span>
        ${isAdmin ? `<button class="t-del">✕</button>` : ""}
      </div>`).join("") || `<p class="hint">업로드된 공고 파일이 없습니다.</p>`;

    listEl.querySelectorAll(".t-del").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.closest(".notice-item").dataset.id;
        try { await fetch(`${SERVER_BASE_URL}/api/announcements/${id}`, { method: "DELETE" }); }
        catch (e) { alert("삭제에 실패했습니다."); return; }
        renderNoticePanel(site);
      });
    });
    return;
  }

  // 서버 미연결: 브라우저 저장(localStorage, base64)으로 폴백
  const files = (site.announcements || []).slice().sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""));
  listEl.innerHTML = files.map((f, i) => `
    <div class="notice-item" data-idx="${i}">
      <span class="notice-icon">📄</span>
      <a href="${f.dataUrl}" download="${esc(f.name)}" class="notice-name">${esc(f.name)}</a>
      <span class="notice-size">${formatFileSize(f.size || 0)}</span>
      ${isAdmin ? `<button class="t-del">✕</button>` : ""}
    </div>`).join("") || `<p class="hint">업로드된 공고 파일이 없습니다.</p>`;

  listEl.querySelectorAll(".t-del").forEach((btn, i) => {
    btn.addEventListener("click", () => {
      site.announcements = (site.announcements || []).filter(f => f !== files[i]);
      persist();
      renderNoticePanel(site);
    });
  });
}

function renderSiteDetail() {
  const site = sites.find(s => s.id === currentDetailId);
  if (!site) { closeSiteDetail(); return; }
  const panel = document.getElementById("siteDetailPanel");

  const stageIdx = Math.max(0, PIPELINE_STAGES.indexOf(site.pipelineStage || "미관리"));
  const stepperHtml = PIPELINE_STAGES.map((st, i) => {
    const cls = i < stageIdx ? "done" : i === stageIdx ? "current" : "";
    return `<div class="stepper-step ${cls} ${isAdmin ? "admin-clickable" : ""}" data-idx="${i}">
      <div class="stepper-line"></div>
      <div class="stepper-dot" title="${esc(st)}"></div>
      <div class="stepper-label">${esc(st)}</div>
    </div>`;
  }).join("");

  panel.innerHTML = `
    <div class="detail-top">
      <button class="detail-back">← 목록으로</button>
      <button class="detail-card-print">📄 현장카드 인쇄</button>
      <button class="detail-print">🖨 인쇄</button>
    </div>
    <div class="detail-tags">
      ${site.pipelineStage ? `<span class="tag pipe-${esc(site.pipelineStage)}">${esc(site.pipelineStage)}</span>` : ""}
      ${site.status ? `<span class="tag">${esc(site.status)}</span>` : ""}
    </div>
    <div class="detail-title">${esc(site.name)}</div>
    <div class="detail-sub">${esc(site.city || "")} ${esc(site.district || "")} ${esc(site.dong || "")}</div>

    <div class="stepper">${stepperHtml}</div>

    <div class="detail-tabs">
      <button class="dtab active" data-tab="overview">개요</button>
      <button class="dtab" data-tab="sales">영업</button>
      <button class="dtab" data-tab="progress">추진경과</button>
      <button class="dtab" data-tab="journal">일지 <span class="dtab-count dtab-journal-count">0</span></button>
      <button class="dtab" data-tab="notice">공고</button>
    </div>

    <div class="dtab-panel" data-panel="overview">
      <div class="detail-card">
        <div class="detail-card-head">
          <h4>사업 현황</h4>
          <button id="detailEditBtn" class="btn btn-ghost btn-sm admin-only">수정</button>
        </div>
        <div class="detail-fields">
          <div class="detail-field"><span class="k">구역면적</span><span class="v">${site.area ? fmtNum(site.area) + " m²" : "-"}</span></div>
          <div class="detail-field"><span class="k">연면적</span><span class="v">${site.totalFloorArea ? fmtNum(site.totalFloorArea) + " m²" : "-"}</span></div>
          <div class="detail-field"><span class="k">규모</span><span class="v">${esc(site.scale || "-")}</span></div>
          <div class="detail-field"><span class="k">조합원수</span><span class="v">${esc(site.unionMembers || "-")}</span></div>
          <div class="detail-field"><span class="k">신축세대</span><span class="v">${esc(site.newUnits || "-")}</span></div>
          <div class="detail-field"><span class="k">정비업체</span><span class="v">${esc(site.maintCo || "-")}</span></div>
          <div class="detail-field"><span class="k">설계업체</span><span class="v">${esc(site.designCo || "-")}</span></div>
          <div class="detail-field"><span class="k">신탁사</span><span class="v">${esc(site.trustCo || "-")}</span></div>
          <div class="detail-field"><span class="k">담당자</span><span class="v">${esc(site.manager || "-")}</span></div>
          <div class="detail-field"><span class="k">최근 일지 날짜</span><span class="v">${esc(site.lastLogDate || "-")}</span></div>
        </div>
      </div>
    </div>

    <div class="dtab-panel hidden" data-panel="sales">
      <div class="detail-card">
        <div class="detail-card-head"><h4>영업 메모</h4></div>
        <div class="timeline-list"></div>
        <div class="timeline-add admin-only">
          <input type="date" id="salesDate">
          <input type="text" id="salesText" placeholder="예: 조합장 통화, 관심도 확인">
          <button id="salesAdd" class="btn btn-primary btn-sm">추가</button>
        </div>
      </div>
    </div>

    <div class="dtab-panel hidden" data-panel="progress">
      <div class="detail-card">
        <div class="detail-card-head"><h4>추진 경과</h4></div>
        <div class="timeline-list"></div>
        <div class="timeline-add admin-only">
          <input type="date" id="milestoneDate">
          <input type="text" id="milestoneText" placeholder="예: 2차 입찰공고">
          <button id="milestoneAdd" class="btn btn-primary btn-sm">추가</button>
        </div>
      </div>
    </div>

    <div class="dtab-panel hidden" data-panel="journal">
      <div class="detail-card">
        <div class="detail-card-head">
          <h4>일지</h4>
          ${SERVER_BASE_URL ? `<span class="hint">📩 텔레그램 실시간 연동됨</span>` : `<span class="hint">텔레그램 서버 미연결</span>`}
        </div>
        <div class="timeline-list"></div>
        <p class="hint" style="margin-top:8px">텔레그램 그룹에 <b>#${esc(site.name)}</b> 태그로 메시지를 올리면 자동으로 여기 표시됩니다.</p>
      </div>
    </div>

    <div class="dtab-panel hidden" data-panel="notice">
      <div class="detail-card">
        <div class="detail-card-head"><h4>공고</h4></div>
        <div class="notice-list"></div>
        <div class="notice-upload admin-only">
          <input type="file" id="noticeFileInput" accept=".pdf,.hwp,.hwpx,.doc,.docx">
          <p class="hint">${SERVER_BASE_URL
      ? "PDF·한글(hwp)·워드 파일을 올릴 수 있어요. 서버에 저장되며 15MB까지 가능합니다."
      : "PDF·한글(hwp)·워드 파일을 올릴 수 있어요. 브라우저 저장공간에 저장되니 너무 큰 파일(수 MB 이상)은 피해주세요."}</p>
        </div>
      </div>
    </div>
  `;

  renderSalesPanel(site);
  renderProgressPanel(site);
  renderJournalPanel(site);
  renderNoticePanel(site);
  refreshServerJournal(site);

  panel.querySelector(".detail-back").addEventListener("click", closeSiteDetail);
  panel.querySelector(".detail-print").addEventListener("click", () => window.print());
  panel.querySelector(".detail-card-print").addEventListener("click", () => printSiteCard(site));
  panel.querySelector("#detailEditBtn")?.addEventListener("click", () => openSiteModal(site.id));

  panel.querySelectorAll(".dtab").forEach(tabBtn => {
    tabBtn.addEventListener("click", () => {
      panel.querySelectorAll(".dtab").forEach(b => b.classList.remove("active"));
      panel.querySelectorAll(".dtab-panel").forEach(p => p.classList.add("hidden"));
      tabBtn.classList.add("active");
      panel.querySelector(`[data-panel="${tabBtn.dataset.tab}"]`).classList.remove("hidden");
    });
  });

  panel.querySelectorAll(".stepper-step").forEach(el => {
    el.addEventListener("click", () => {
      if (!isAdmin) return;
      const idx = Number(el.dataset.idx);
      site.pipelineStage = PIPELINE_STAGES[idx];
      site.updatedAt = new Date().toISOString();
      persist();
      renderSiteDetail();
      renderTabsBar(); renderStatsBar(); renderMarkers(); renderSiteList();
    });
  });

  panel.querySelector("#salesAdd")?.addEventListener("click", () => {
    const date = document.getElementById("salesDate").value;
    const text = document.getElementById("salesText").value.trim();
    if (!text) { alert("내용을 입력하세요."); return; }
    site.salesNotes = site.salesNotes || [];
    site.salesNotes.push({ date, text });
    persist();
    document.getElementById("salesDate").value = "";
    document.getElementById("salesText").value = "";
    renderSalesPanel(site);
  });

  panel.querySelector("#milestoneAdd")?.addEventListener("click", () => {
    const date = document.getElementById("milestoneDate").value;
    const text = document.getElementById("milestoneText").value.trim();
    if (!text) { alert("내용을 입력하세요."); return; }
    site.milestones = site.milestones || [];
    site.milestones.push({ date, text });
    persist();
    document.getElementById("milestoneDate").value = "";
    document.getElementById("milestoneText").value = "";
    renderProgressPanel(site);
  });

  panel.querySelector("#noticeFileInput")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (SERVER_BASE_URL) {
      if (file.size > 15 * 1024 * 1024) {
        alert("파일이 너무 큽니다 (15MB 이하로 올려주세요).");
        e.target.value = "";
        return;
      }
      const fd = new FormData();
      fd.append("site", site.name);
      fd.append("file", file);
      try {
        const res = await fetch(`${SERVER_BASE_URL}/api/announcements`, { method: "POST", body: fd });
        if (!res.ok) throw new Error("업로드 실패");
        renderNoticePanel(site);
      } catch (err) {
        alert("서버 업로드에 실패했습니다: " + err.message);
      }
      e.target.value = "";
      return;
    }

    // 서버 미연결: 로컬(base64)로 폴백
    if (file.size > 4 * 1024 * 1024) {
      alert("파일이 너무 큽니다 (4MB 이하로 올려주세요). 브라우저 저장공간 한계 때문에 큰 파일은 저장이 안 될 수 있어요.");
      e.target.value = "";
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      site.announcements = site.announcements || [];
      site.announcements.push({ name: file.name, type: file.type, size: file.size, dataUrl, uploadedAt: new Date().toISOString() });
      persist();
      renderNoticePanel(site);
    } catch (err) {
      alert("파일을 저장하는 데 실패했습니다: " + err.message);
    }
    e.target.value = "";
  });
}

/* ---------- 현장 추가/수정 모달 ---------- */
const siteModal = document.getElementById("siteModal");
let editingId = null;

document.getElementById("btnAddSite").addEventListener("click", () => openSiteModal(null));
document.getElementById("siteModalClose").addEventListener("click", closeSiteModal);
document.getElementById("siteCancel").addEventListener("click", closeSiteModal);

function openSiteModal(id) {
  editingId = id;
  const site = id ? sites.find(s => s.id === id) : null;
  document.getElementById("siteModalTitle").textContent = site ? "현장 수정" : "현장 추가";
  document.getElementById("siteDelete").classList.toggle("hidden", !site);

  const set = (elId, val) => document.getElementById(elId).value = val ?? "";
  set("f_name", site?.name); set("f_city", site?.city); set("f_district", site?.district);
  set("f_dong", site?.dong); set("f_office", site?.office);
  set("f_pipelineStage", site?.pipelineStage || "미관리");
  set("f_stage", site?.stage || "예정구역"); set("f_status", site?.status || "재개발");
  set("f_area", site?.area); set("f_expectedOrder", site?.expectedOrder);
  set("f_newUnits", site?.newUnits); set("f_totalFloorArea", site?.totalFloorArea);
  set("f_scale", site?.scale); set("f_unionMembers", site?.unionMembers);
  set("f_lastLogDate", site?.lastLogDate); set("f_maintCo", site?.maintCo);
  set("f_designCo", site?.designCo); set("f_trustCo", site?.trustCo);
  set("f_manager", site?.manager); set("f_lat", site?.lat); set("f_lng", site?.lng);
  set("f_nextEventDate", site?.nextEventDate); set("f_nextEventNote", site?.nextEventNote);
  set("f_note", site?.note);
  set("f_boundary", (site?.boundary || []).map(p => p.join(",")).join("\n"));

  // 현장카드(인쇄 양식)용 항목
  set("f_address", site?.address); set("f_bizType", site?.bizType); set("f_zoneUse", site?.zoneUse);
  set("f_far", site?.far); set("f_bcr", site?.bcr); set("f_parking", site?.parking);
  set("f_rentalUnits", site?.rentalUnits); set("f_ltRentUnits", site?.ltRentUnits);
  set("f_rentalTotal", site?.rentalTotal);
  set("f_currentBuilding", site?.currentBuilding); set("f_siteFeature", site?.siteFeature);
  set("f_unionOffice", site?.unionOffice);
  set("f_meetingCo", site?.meetingCo); set("f_otherCo", site?.otherCo);
  set("f_specialNote", site?.specialNote); set("f_competitor", site?.competitor);
  renderExecRows(site?.executives || []);

  siteModal.classList.remove("hidden");
}

/* ---------- 집행부 입력 행 (여러 명 등록) ---------- */
function renderExecRows(list) {
  const box = document.getElementById("execRows");
  if (!box) return;
  box.innerHTML = (list || []).map((e, i) => execRowHtml(e, i)).join("");
  bindExecRowDelete();
}
function execRowHtml(e, i) {
  e = e || {};
  return `<div class="exec-row" data-idx="${i}" style="display:flex;gap:4px;margin-bottom:4px;align-items:center">
    <input class="ex-name" placeholder="성명/직위" value="${esc(e.name || "")}" style="flex:1;min-width:0">
    <input class="ex-company" placeholder="업체" value="${esc(e.company || "")}" style="flex:1;min-width:0">
    <input class="ex-phone" placeholder="연락처" value="${esc(e.phone || "")}" style="flex:1;min-width:0">
    <input class="ex-note" placeholder="특이사항" value="${esc(e.note || "")}" style="flex:1;min-width:0">
    <button type="button" class="ex-del btn btn-outline btn-sm">✕</button>
  </div>`;
}
function bindExecRowDelete() {
  document.querySelectorAll("#execRows .ex-del").forEach(btn => {
    btn.onclick = () => { btn.closest(".exec-row").remove(); };
  });
}
function collectExecRows() {
  return [...document.querySelectorAll("#execRows .exec-row")].map(r => ({
    name: r.querySelector(".ex-name").value.trim(),
    company: r.querySelector(".ex-company").value.trim(),
    phone: r.querySelector(".ex-phone").value.trim(),
    note: r.querySelector(".ex-note").value.trim()
  })).filter(e => e.name || e.company || e.phone || e.note);
}
document.getElementById("btnAddExec")?.addEventListener("click", () => {
  const box = document.getElementById("execRows");
  box.insertAdjacentHTML("beforeend", execRowHtml({}, box.children.length));
  bindExecRowDelete();
});
function closeSiteModal() { siteModal.classList.add("hidden"); editingId = null; }

document.getElementById("siteSave").addEventListener("click", () => {
  const name = document.getElementById("f_name").value.trim();
  const city = document.getElementById("f_city").value.trim();
  const district = document.getElementById("f_district").value.trim();
  if (!name || !city || !district) { alert("현장명, 도시, 구는 필수입니다."); return; }

  const boundaryText = document.getElementById("f_boundary").value.trim();
  const boundary = boundaryText ? boundaryText.split("\n").map(line => {
    const [la, ln] = line.split(",").map(v => Number(v.trim()));
    return [la, ln];
  }).filter(([la, ln]) => !isNaN(la) && !isNaN(ln)) : [];

  const data = {
    name, city, district,
    dong: document.getElementById("f_dong").value.trim(),
    office: document.getElementById("f_office").value.trim(),
    pipelineStage: document.getElementById("f_pipelineStage").value,
    stage: document.getElementById("f_stage").value,
    status: document.getElementById("f_status").value,
    area: document.getElementById("f_area").value,
    expectedOrder: document.getElementById("f_expectedOrder").value.trim(),
    newUnits: document.getElementById("f_newUnits").value,
    totalFloorArea: document.getElementById("f_totalFloorArea").value,
    scale: document.getElementById("f_scale").value.trim(),
    unionMembers: document.getElementById("f_unionMembers").value,
    lastLogDate: document.getElementById("f_lastLogDate").value,
    maintCo: document.getElementById("f_maintCo").value.trim(),
    designCo: document.getElementById("f_designCo").value.trim(),
    trustCo: document.getElementById("f_trustCo").value.trim(),
    manager: document.getElementById("f_manager").value.trim(),
    lat: document.getElementById("f_lat").value,
    lng: document.getElementById("f_lng").value,
    nextEventDate: document.getElementById("f_nextEventDate").value,
    nextEventNote: document.getElementById("f_nextEventNote").value.trim(),
    note: document.getElementById("f_note").value.trim(),
    boundary,
    // 현장카드(인쇄 양식)용 항목
    address: document.getElementById("f_address").value.trim(),
    bizType: document.getElementById("f_bizType").value.trim(),
    zoneUse: document.getElementById("f_zoneUse").value.trim(),
    far: document.getElementById("f_far").value.trim(),
    bcr: document.getElementById("f_bcr").value.trim(),
    parking: document.getElementById("f_parking").value,
    rentalUnits: document.getElementById("f_rentalUnits").value,
    ltRentUnits: document.getElementById("f_ltRentUnits").value,
    rentalTotal: document.getElementById("f_rentalTotal").value,
    currentBuilding: document.getElementById("f_currentBuilding").value.trim(),
    siteFeature: document.getElementById("f_siteFeature").value.trim(),
    unionOffice: document.getElementById("f_unionOffice").value.trim(),
    meetingCo: document.getElementById("f_meetingCo").value.trim(),
    otherCo: document.getElementById("f_otherCo").value.trim(),
    specialNote: document.getElementById("f_specialNote").value.trim(),
    competitor: document.getElementById("f_competitor").value.trim(),
    executives: collectExecRows()
  };

  data.updatedAt = new Date().toISOString();

  if (editingId) {
    const idx = sites.findIndex(s => s.id === editingId);
    sites[idx] = { ...sites[idx], ...data };
  } else {
    sites.push({ id: uid(), labelOffset: { x: 0, y: -34 }, ...data });
  }
  persist();
  refreshAll();
  closeSiteModal();
});

document.getElementById("siteDelete").addEventListener("click", () => {
  if (!editingId) return;
  if (!confirm("이 현장을 삭제하시겠습니까?")) return;
  sites = sites.filter(s => s.id !== editingId);
  persist();
  refreshAll();
  closeSiteModal();
});

/* ---------- 백업 저장/복원 (JSON) ---------- */
document.getElementById("btnSaveBackup").addEventListener("click", () => {
  const payload = {
    savedAt: new Date().toISOString(),
    officeName: document.getElementById("officeName").value,
    sites
  };
  downloadFile(`대시보드_백업_${dateStamp()}.json`, JSON.stringify(payload, null, 2), "application/json");
});

document.getElementById("btnRestoreBackup").addEventListener("click", () => {
  document.getElementById("backupFileInput").click();
});
document.getElementById("backupFileInput").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = evt => {
    try {
      const payload = JSON.parse(evt.target.result);
      if (!Array.isArray(payload.sites)) throw new Error("형식이 올바르지 않습니다.");
      if (!confirm(`현재 데이터를 백업 파일(${payload.sites.length}개 현장)로 덮어쓸까요?`)) return;
      sites = payload.sites;
      if (payload.officeName) {
        document.getElementById("officeName").value = payload.officeName;
        localStorage.setItem(OFFICE_KEY, payload.officeName);
      }
      persist();
      refreshAll();
      alert("백업을 복원했습니다.");
    } catch (err) {
      alert("백업 파일을 읽을 수 없습니다: " + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

/* ---------- 엑셀 업로드 / 양식 다운로드 ---------- */
document.getElementById("btnExcelUpload").addEventListener("click", () => {
  document.getElementById("excelFileInput").click();
});
document.getElementById("excelFileInput").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = evt => {
    const wb = XLSX.read(evt.target.result, { type: "binary" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    let added = 0;
    rows.forEach(row => {
      const name = String(row["현장명"] || "").trim();
      const city = String(row["도시"] || "").trim();
      const district = String(row["구"] || "").trim();
      if (!name || !city || !district) return;
      const site = { id: uid(), labelOffset: { x: 0, y: -34 }, updatedAt: new Date().toISOString() };
      FIELD_ORDER.forEach(([key, label]) => {
        site[key] = row[label] !== undefined ? row[label] : "";
      });
      site.name = name; site.city = city; site.district = district;

      // "구역 경계 좌표" 열: "위도,경도" 쌍을 세미콜론(;) 또는 줄바꿈으로 구분해 입력.
      const boundaryRaw = String(site.boundaryText || "").trim();
      site.boundary = boundaryRaw
        ? boundaryRaw.split(/[;\n]/).map(pair => {
            const [la, ln] = pair.split(",").map(v => Number(String(v).trim()));
            return (isNaN(la) || isNaN(ln)) ? null : [la, ln];
          }).filter(Boolean)
        : [];
      delete site.boundaryText;
      sites.push(site);
      added++;
    });
    persist();
    refreshAll();
    alert(`${added}개 현장을 추가했습니다.`);
  };
  reader.readAsBinaryString(file);
  e.target.value = "";
});

document.getElementById("btnTemplateDownload").addEventListener("click", () => {
  const headers = FIELD_ORDER.map(([, label]) => label);
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "현장양식");
  XLSX.writeFile(wb, "현장추가_양식.xlsx");
});

/* ---------- 인쇄 ---------- */
document.getElementById("btnPrint").addEventListener("click", () => window.print());

/* ---------- 사무실명 저장 ---------- */
const officeInput = document.getElementById("officeName");
officeInput.value = localStorage.getItem(OFFICE_KEY) || officeInput.value;
officeInput.addEventListener("change", () => localStorage.setItem(OFFICE_KEY, officeInput.value));

/* ---------- 유틸 ---------- */
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtNum(n) {
  const num = Number(n);
  if (isNaN(num)) return esc(n);
  return num.toLocaleString("ko-KR");
}
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/* =========================================================
   구역 좌표 추출 모달
   ========================================================= */
let bpMap, bpPolygon, bpMarkers = [], bpPoints = [], bpGeocoder;
let bpCadastralOn = false;
let bpAllZones = null;

document.getElementById("bpGeojsonLoadBtn").addEventListener("click", () => {
  document.getElementById("bpGeojsonFile").click();
});
document.getElementById("bpGeojsonFile").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = evt => {
    try {
      bpAllZones = JSON.parse(evt.target.result);
      document.getElementById("bpGeojsonStatus").textContent =
        `${bpAllZones.features.length}개 구역 불러옴 — 위에서 구역명으로 검색하세요`;
    } catch (err) {
      alert("파일을 읽지 못했습니다: " + err.message);
    }
  };
  reader.readAsText(file, "utf-8");
});

document.getElementById("bpZoneSearch").addEventListener("input", () => {
  const q = document.getElementById("bpZoneSearch").value.trim();
  const box = document.getElementById("bpZoneResults");
  box.innerHTML = "";
  if (!bpAllZones) {
    if (q) box.innerHTML = '<div class="hint">먼저 "정비구역 geojson 불러오기"로 파일을 불러오세요.</div>';
    return;
  }
  if (!q) return;
  const hits = bpAllZones.features.filter(f => (f.properties.name || "").includes(q)).slice(0, 30);
  if (hits.length === 0) {
    box.innerHTML = '<div class="hint">일치하는 구역이 없습니다.</div>';
    return;
  }
  hits.forEach(f => {
    const row = document.createElement("div");
    row.className = "bp-zonehit";
    row.innerHTML = `${esc(f.properties.name)}<div class="bp-cat">${esc(f.properties.category || "")}</div>`;
    row.addEventListener("click", () => bpLoadZoneFromGeojson(f));
    box.appendChild(row);
  });
});

function bpLoadZoneFromGeojson(feature) {
  const ring = feature.geometry.coordinates[0]; // [lng, lat]
  bpPoints = ring.map(([lng, lat]) => new kakao.maps.LatLng(lat, lng));
  bpRedraw();
  const bounds = new kakao.maps.LatLngBounds();
  bpPoints.forEach(p => bounds.extend(p));
  bpMap.setBounds(bounds);
}

const boundaryPickerModal = document.getElementById("boundaryPickerModal");

async function bpEnsureZonesLoaded() {
  if (bpAllZones) return;
  document.getElementById("bpGeojsonStatus").textContent = "정비구역 데이터 불러오는 중...";
  try {
    const res = await fetch("seoul-zones.geojson");
    if (!res.ok) throw new Error("not found");
    bpAllZones = await res.json();
    document.getElementById("bpGeojsonStatus").textContent =
      `${bpAllZones.features.length}개 구역 자동 로딩됨 (2026.03.04 기준)`;
  } catch (err) {
    document.getElementById("bpGeojsonStatus").textContent =
      "자동 로딩 실패 — 아래 버튼으로 직접 불러오세요";
  }
}

function openBoundaryPicker() {
  boundaryPickerModal.classList.remove("hidden");
  bpEnsureZonesLoaded();

  // 기존에 입력돼 있던 좌표가 있으면 그대로 불러와서 이어서 수정 가능
  const existingText = document.getElementById("f_boundary").value.trim();
  bpPoints = existingText
    ? existingText.split("\n").map(line => {
        const [la, ln] = line.split(",").map(v => Number(v.trim()));
        return (isNaN(la) || isNaN(ln)) ? null : new kakao.maps.LatLng(la, ln);
      }).filter(Boolean)
    : [];

  if (!bpMap) {
    bpMap = new kakao.maps.Map(document.getElementById("boundaryPickerMap"), {
      center: new kakao.maps.LatLng(37.5665, 126.9780),
      level: 4
    });
    bpGeocoder = new kakao.maps.services.Geocoder();
    kakao.maps.event.addListener(bpMap, "click", e => {
      bpPoints.push(e.latLng);
      bpRedraw();
    });
  }

  // 폼에 위도/경도가 이미 있으면 그 위치로, 기존 좌표가 있으면 그 범위로 이동
  const fLat = Number(document.getElementById("f_lat").value);
  const fLng = Number(document.getElementById("f_lng").value);
  if (bpPoints.length) {
    const bounds = new kakao.maps.LatLngBounds();
    bpPoints.forEach(p => bounds.extend(p));
    bpMap.setBounds(bounds);
  } else if (fLat && fLng) {
    bpMap.setCenter(new kakao.maps.LatLng(fLat, fLng));
    bpMap.setLevel(4);
  }

  bpRedraw();
}

function closeBoundaryPicker() {
  boundaryPickerModal.classList.add("hidden");
}

function bpRedraw() {
  bpMarkers.forEach(m => m.setMap(null));
  bpMarkers = [];
  if (bpPolygon) bpPolygon.setMap(null);

  bpPoints.forEach(p => {
    const marker = new kakao.maps.Marker({ position: p, map: bpMap });
    bpMarkers.push(marker);
  });

  if (bpPoints.length >= 2) {
    bpPolygon = new kakao.maps.Polygon({
      path: bpPoints,
      strokeWeight: 3, strokeColor: "#2f6fed", strokeOpacity: 0.9,
      fillColor: "#2f6fed", fillOpacity: 0.35
    });
    bpPolygon.setMap(bpMap);
  }

  document.getElementById("bpCount").textContent = bpPoints.length;
}

document.getElementById("btnBoundaryPicker").addEventListener("click", openBoundaryPicker);
document.getElementById("boundaryPickerClose").addEventListener("click", closeBoundaryPicker);
document.getElementById("boundaryPickerCancel").addEventListener("click", closeBoundaryPicker);

document.getElementById("bpUndo").addEventListener("click", () => { bpPoints.pop(); bpRedraw(); });
document.getElementById("bpClear").addEventListener("click", () => { bpPoints = []; bpRedraw(); });

document.getElementById("bpCadastral").addEventListener("click", () => {
  if (!bpMap) return;
  if (bpCadastralOn) bpMap.removeOverlayMapTypeId(kakao.maps.MapTypeId.USE_DISTRICT);
  else bpMap.addOverlayMapTypeId(kakao.maps.MapTypeId.USE_DISTRICT);
  bpCadastralOn = !bpCadastralOn;
});

function bpDoSearch() {
  const q = document.getElementById("bpSearch").value.trim();
  if (!q || !bpGeocoder) return;
  bpGeocoder.addressSearch(q, (result, status) => {
    if (status === kakao.maps.services.Status.OK) {
      bpMap.setCenter(new kakao.maps.LatLng(result[0].y, result[0].x));
      bpMap.setLevel(3);
    } else {
      const places = new kakao.maps.services.Places();
      places.keywordSearch(q, (data, status2) => {
        if (status2 === kakao.maps.services.Status.OK && data.length > 0) {
          bpMap.setCenter(new kakao.maps.LatLng(data[0].y, data[0].x));
          bpMap.setLevel(3);
        } else {
          alert("검색 결과가 없습니다.");
        }
      });
    }
  });
}
document.getElementById("bpSearchBtn").addEventListener("click", bpDoSearch);
document.getElementById("bpSearch").addEventListener("keydown", e => { if (e.key === "Enter") bpDoSearch(); });

document.getElementById("boundaryPickerApply").addEventListener("click", () => {
  if (bpPoints.length < 3) {
    alert("점을 3개 이상 찍어야 구역 도형이 만들어집니다.");
    return;
  }
  const text = bpPoints.map(p => `${p.getLat().toFixed(6)},${p.getLng().toFixed(6)}`).join("\n");
  document.getElementById("f_boundary").value = text;
  closeBoundaryPicker();
});

/* ---------- 시작 시 비밀번호 설정 불러오기 ---------- */
loadAuthConfig();

/* =========================================================
   현장카드 인쇄 (A4 가로 1장)
   상세 패널의 "현장카드 인쇄" 버튼에서 호출됩니다.
   ========================================================= */
let _printMapObj = null;

function pcNum(v) {
  if (v === undefined || v === null || v === "") return "";
  const n = Number(v);
  return isNaN(n) ? String(v) : n.toLocaleString("ko-KR");
}
function pcVal(v) { return (v === undefined || v === null || v === "") ? "" : esc(String(v)); }
function pyeong(m2) {
  const n = Number(m2);
  if (!n || isNaN(n)) return "";
  return `<span class="pc-sub">평수 : ${Math.round(n / 3.305785).toLocaleString("ko-KR")}</span>`;
}

function buildSiteCardHtml(site) {
  const loc = [site.city, site.district, site.dong].filter(Boolean).join(" ");
  const address = site.address || loc || "";

  const subUnits = [];
  if (site.rentalUnits) subUnits.push(`임대 ${pcNum(site.rentalUnits)}세대`);
  if (site.ltRentUnits) subUnits.push(`장기전세 ${pcNum(site.ltRentUnits)}세대`);
  if (site.rentalTotal) subUnits.push(`계 ${pcNum(site.rentalTotal)}세대`);
  const unitsHtml = `${site.newUnits ? pcNum(site.newUnits) + "세대" : ""}` +
    (subUnits.length ? `<span class="pc-sub">[${esc(subUnits.join(" / "))}]</span>` : "");

  const progress = (site.milestones || [])
    .filter(m => m.source !== "telegram")
    .slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const progressHtml = progress.length
    ? `<table class="pc-progtbl">${progress.map(m => `<tr>
        <td class="pc-prog-date">${pcVal(m.date)}</td>
        <td class="pc-prog-text">${pcVal(m.text)}</td>
      </tr>`).join("")}</table>`
    : `<div class="pc-empty">등록된 추진 경과가 없습니다.</div>`;

  const execs = site.executives || [];
  const execRowsHtml = execs.length
    ? execs.map(e => `<tr>
        <th class="pc-lbl">집행부</th>
        <td class="pc-l" colspan="3">${pcVal([e.name, e.company].filter(Boolean).join(" : "))}${e.phone ? `<span class="pc-sub">${pcVal(e.phone)}</span>` : ""}${e.note ? `<span class="pc-sub">${pcVal(e.note)}</span>` : ""}</td>
      </tr>`).join("")
    : `<tr><th class="pc-lbl">집행부</th><td class="pc-l" colspan="3"></td></tr>`;

  const unionRowCount = 5 + Math.max(1, execs.length);

  const hasBoundary = site.boundary && site.boundary.length > 2;
  const mapHtml = hasBoundary || (site.lat && site.lng)
    ? `<div class="pc-map-wrap"><div class="pc-mapbox" id="printCardMap"></div></div>`
    : `<div class="pc-map-wrap"><div class="pc-mapbox pc-mapbox-empty">구역 경계 좌표가 없습니다.</div></div>`;

  return `
<div class="pc-sheet">
  <div class="pc-head">
    <div>현장명: ${pcVal(site.name)}</div>
    <div class="pc-manager">담당: ${pcVal(site.manager)}</div>
  </div>

  <div class="pc-body">
    <div class="pc-col">
      <table class="pc-main">
        <colgroup>
          <col style="width:26px"><col style="width:78px"><col>
          <col style="width:70px"><col style="width:110px">
        </colgroup>

        <tr class="pc-pj">
          <th colspan="2">PJ 명</th>
          <td>${pcVal(site.name)}</td>
          <td colspan="2">${pcVal(site.bizType || site.status)}</td>
        </tr>

        <tr>
          <th class="pc-grp" rowspan="6">사업개요</th>
          <th class="pc-lbl">위 치</th>
          <td class="pc-c" colspan="3">${pcVal(address)}</td>
        </tr>
        <tr>
          <th class="pc-lbl">지역지구</th>
          <td class="pc-c" colspan="3">${pcVal(site.zoneUse)}</td>
        </tr>
        <tr>
          <th class="pc-lbl">구역면적<span class="pc-sub">(m²)</span></th>
          <td class="pc-c">${pcNum(site.area)}${pyeong(site.area)}</td>
          <th class="pc-lbl">조합원수</th>
          <td class="pc-c">${pcVal(site.unionMembers)}</td>
        </tr>
        <tr>
          <th class="pc-lbl">연 면 적<span class="pc-sub">(m²)</span></th>
          <td class="pc-c">${pcNum(site.totalFloorArea)}${pyeong(site.totalFloorArea)}</td>
          <th class="pc-lbl">용 적 률</th>
          <td class="pc-c">${pcVal(site.far)}</td>
        </tr>
        <tr>
          <th class="pc-lbl">신축세대</th>
          <td class="pc-c">${unitsHtml}</td>
          <th class="pc-lbl">건 폐 율</th>
          <td class="pc-c">${pcVal(site.bcr)}</td>
        </tr>
        <tr>
          <th class="pc-lbl">주차대수</th>
          <td class="pc-c">${pcVal(site.parking)}</td>
          <th class="pc-lbl">기 타</th>
          <td class="pc-c">${pcVal(site.scale)}</td>
        </tr>

        <tr>
          <th class="pc-grp" rowspan="2">현황</th>
          <th class="pc-lbl">현건축물<br>현황</th>
          <td class="pc-c" colspan="3">${pcVal(site.currentBuilding)}</td>
        </tr>
        <tr>
          <th class="pc-lbl">입지특성</th>
          <td class="pc-l" colspan="3">${pcVal(site.siteFeature)}</td>
        </tr>

        <tr>
          <th class="pc-grp" rowspan="${unionRowCount}">조합</th>
          <th class="pc-lbl-y">구 분</th>
          <th class="pc-lbl-y" colspan="2">성명 / 업체명 / 연락처</th>
          <th class="pc-lbl-y">특이사항</th>
        </tr>
        <tr>
          <th class="pc-lbl">사무실</th>
          <td class="pc-l" colspan="3">${pcVal(site.unionOffice)}</td>
        </tr>
        ${execRowsHtml}
        <tr>
          <th class="pc-lbl">정비업체</th>
          <td class="pc-l">${pcVal(site.maintCo)}</td>
          <th class="pc-lbl-y">총회대행</th>
          <td class="pc-l">${pcVal(site.meetingCo)}</td>
        </tr>
        <tr>
          <th class="pc-lbl">설계업체</th>
          <td class="pc-l" colspan="3">${pcVal(site.designCo)}</td>
        </tr>
        <tr>
          <th class="pc-lbl">그외업체</th>
          <td class="pc-l" colspan="3">${pcVal(site.otherCo)}</td>
        </tr>
      </table>
    </div>

    <div class="pc-col">
      <div class="pc-secthead">사업진행현황</div>
      <div class="pc-prog">${progressHtml}</div>
      ${mapHtml}
    </div>

    <div class="pc-col">
      <div class="pc-secthead">그외</div>
      <div class="pc-note-block">
        <div class="pc-note-title">▣ 특이사항</div>
        <div class="pc-note-body">${pcVal(site.specialNote)}</div>
        <div class="pc-note-title">▣ 타사활동</div>
        <div class="pc-note-body">${pcVal(site.competitor)}</div>
        ${site.note ? `<div class="pc-note-title">▣ 비고</div><div class="pc-note-body">${pcVal(site.note)}</div>` : ""}
      </div>
    </div>
  </div>
</div>`;
}

function printSiteCard(site) {
  const box = document.getElementById("printCard");
  if (!box) { alert("인쇄 영역을 찾을 수 없습니다. index.html이 최신인지 확인해주세요."); return; }

  box.innerHTML = buildSiteCardHtml(site);
  box.style.display = "block"; // 지도 렌더링을 위해 잠시 화면에 올림
  box.style.position = "fixed";
  box.style.left = "-9999px";
  box.style.top = "0";

  const mapEl = document.getElementById("printCardMap");
  const hasBoundary = site.boundary && site.boundary.length > 2;

  const finish = () => {
    box.style.position = "";
    box.style.left = "";
    box.style.top = "";
    box.style.display = "";
    window.print();
  };

  if (mapEl && typeof kakao !== "undefined" && kakao.maps) {
    // 화면 밖에 두면 타일이 안 그려지므로, 인쇄 직전에만 화면 안쪽으로 옮김
    box.style.left = "0";
    box.style.top = "0";
    box.style.zIndex = "-1";
    box.style.opacity = "0.01";

    _printMapObj = new kakao.maps.Map(mapEl, {
      center: new kakao.maps.LatLng(37.5665, 126.9780), level: 5
    });

    if (hasBoundary) {
      const path = site.boundary.map(([la, ln]) => new kakao.maps.LatLng(la, ln));
      new kakao.maps.Polygon({
        path, strokeWeight: 3, strokeColor: "#d32f2f", strokeOpacity: 1,
        fillColor: "#d32f2f", fillOpacity: 0.15
      }).setMap(_printMapObj);
      const bounds = new kakao.maps.LatLngBounds();
      path.forEach(p => bounds.extend(p));
      _printMapObj.setBounds(bounds);
    } else {
      const [lat, lng] = resolveLatLng(site);
      _printMapObj.setCenter(new kakao.maps.LatLng(lat, lng));
      _printMapObj.setLevel(4);
    }

    // 타일이 다 그려질 시간을 준 뒤 인쇄
    setTimeout(() => {
      _printMapObj.relayout();
      setTimeout(() => {
        box.style.zIndex = "";
        box.style.opacity = "";
        finish();
      }, 900);
    }, 400);
  } else {
    finish();
  }
}
