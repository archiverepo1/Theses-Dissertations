const PROXY = "https://inquirybase.archiverepo1.workers.dev/?url=";

/** South African DSpace OAI endpoints (server endpoint preferred; fallback to /oai/request) */
const DSPACE_ENDPOINTS = [
  { name: "University of Cape Town (UCT)",           primary: "https://open.uct.ac.za/oai/request",                        fallback: null, country: "South Africa" },
  { name: "Stellenbosch University (SUNScholar)",    primary: "https://scholar.sun.ac.za/server/oai/request",             fallback: "https://scholar.sun.ac.za/oai/request", country: "South Africa" },
  { name: "University of Pretoria (UPSpace)",        primary: "https://repository.up.ac.za/server/oai/request",           fallback: "https://repository.up.ac.za/oai/request", country: "South Africa" },
  { name: "Wits (WIReDSpace)",                       primary: "https://wiredspace.wits.ac.za/server/oai/request",         fallback: "https://wiredspace.wits.ac.za/oai/request", country: "South Africa" },
  { name: "North-West University (NWU)",             primary: "https://repository.nwu.ac.za/server/oai/request",          fallback: "https://repository.nwu.ac.za/oai/request", country: "South Africa" },
  { name: "University of KwaZulu-Natal (UKZN)",      primary: "https://researchspace.ukzn.ac.za/server/oai/request",      fallback: "https://researchspace.ukzn.ac.za/oai/request", country: "South Africa" },
  { name: "University of the Free State (UFS)",      primary: "https://scholar.ufs.ac.za/server/oai/request",             fallback: "https://scholar.ufs.ac.za/oai/request", country: "South Africa" },
  { name: "University of the Western Cape (UWC)",    primary: "https://etd.uwc.ac.za/server/oai/request",                 fallback: "https://etd.uwc.ac.za/oai/request", country: "South Africa" },
  { name: "University of Johannesburg (UJ)",         primary: "https://ujcontent.uj.ac.za/vital/oai/request",             fallback: null, country: "South Africa" },
  { name: "Central University of Technology (CUT)",  primary: "https://cutscholar.cut.ac.za/server/oai/request",          fallback: "https://cutscholar.cut.ac.za/oai/request", country: "South Africa" },
  { name: "Rhodes University (RU / SEALS Vital)",    primary: "https://vital.seals.ac.za/vital/oai/request",              fallback: null, country: "South Africa" },
];

const PAGE_SIZE_DEFAULT = 100;
let PAGE_SIZE = PAGE_SIZE_DEFAULT;

let SEARCH_TEXT = "";
let YEAR_FILTER = "";      // extracted from query if 4-digit present
let TYPE_FILTER = "";      // 'thesis' | 'dissertation' | ''
let CURRENT_PAGE = 1;

const SELECTED_INSTITUTIONS = new Set(); // multi-select state
const INST_CACHE = new Map();            // name -> items[]
let INSTITUTIONS = [];                   // all known names

// UI nodes
const resultsMount = () => document.getElementById("results");
const instGrid = () => document.getElementById("instGrid");

const delay = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------------- Utilities ---------------------- */
function pick(node, tag) {
  return Array.from(node.getElementsByTagNameNS("*", tag)).map(n => (n.textContent || "").trim());
}

function stringIncludes(hay, needle) {
  return hay.toLowerCase().includes(needle.toLowerCase());
}

function bestLink(identifiers = []) {
  const http = identifiers.find(i => /^https?:\/\//i.test(i));
  if (http) return http;
  const handle = identifiers.find(i => i.includes("hdl.handle.net"));
  if (handle) return "https://" + handle.replace(/^https?:\/\//, "");
  const doi = identifiers.find(i => /^10\./.test(i));
  if (doi) return `https://doi.org/${doi}`;
  return "";
}

function normalizeType(types = []) {
  const s = (types.join(" ") || "").toLowerCase();
  if (s.includes("dissertation")) return "dissertation";
  if (s.includes("thesis")) return "thesis";
  return "";
}

function advisorList(contribs = []) {
  // try to keep only entries that hint advisor/supervisor
  return contribs.filter(c => /advisor|supervisor/i.test(c));
}

function extractYear(dates = [], description = "") {
  // prefer dc.date.issued / first dc:date 4-digit
  const all = [...dates, description];
  for (const v of all) {
    const m = (v || "").match(/\b(19|20)\d{2}\b/);
    if (m) return m[0];
  }
  return "";
}

/* ---------------------- Fetchers ---------------------- */
async function fetchOAIListRecords(baseUrl, metadataPrefix = "oai_dc", resumptionToken = "") {
  const url = resumptionToken
    ? `${baseUrl}?verb=ListRecords&resumptionToken=${encodeURIComponent(resumptionToken)}`
    : `${baseUrl}?verb=ListRecords&metadataPrefix=${metadataPrefix}`;

  const res = await fetch(PROXY + encodeURIComponent(url));
  if (!res.ok) throw new Error(`OAI error ${res.status}`);
  const text = await res.text();
  return new DOMParser().parseFromString(text, "text/xml");
}

async function harvestInstitution(inst, maxPages = 8) {
  // avoid duplicate harvests
  if (INST_CACHE.has(inst.name) && INST_CACHE.get(inst.name).length) return;

  const base = inst.primary || inst.fallback;
  let currentBase = base;
  let token = "";
  let page = 0;
  const out = [];

  async function pageOnce() {
    const xml = await fetchOAIListRecords(currentBase, "oai_dc", token);
    const recs = Array.from(xml.getElementsByTagNameNS("*", "record"));

    recs.forEach(r => {
      const md = r.getElementsByTagNameNS("*", "metadata")[0];
      if (!md) return;
      const titles   = pick(md, "title");
      const creators = pick(md, "creator");
      const descs    = pick(md, "description");
      const subjects = pick(md, "subject");
      const types    = pick(md, "type");
      const dates    = pick(md, "date");
      const ids      = pick(md, "identifier");
      const contribs = pick(md, "contributor");

      // include only thesis-like
      const combined = (types.join(" ") + " " + descs.join(" ")).toLowerCase();
      if (!/thesis|dissertation/.test(combined)) return;

      const typeNorm = normalizeType(types);
      out.push({
        title: titles[0] || "(Untitled)",
        creators,
        description: descs[0] || "",
        subjects,
        advisors: advisorList(contribs),
        types,
        typeNorm,                                  // normalized thesis/dissertation
        date: extractYear(dates, descs.join(" ")),
        link: bestLink(ids),
        institution: inst.name,
        country: inst.country
      });
    });

    // next token
    const tNode = xml.getElementsByTagNameNS("*", "resumptionToken")[0];
    token = tNode ? (tNode.textContent || "").trim() : "";
  }

  while (page < maxPages) {
    page++;
    try {
      await pageOnce();
      if (!token) break;
      // polite delay
      await delay(250);
    } catch (e) {
      // if primary fails and fallback exists, try once from page 1 on fallback
      if (currentBase === inst.primary && inst.fallback) {
        currentBase = inst.fallback;
        token = "";
        page = 0;
        continue;
      }
      console.warn(`Harvest failed for ${inst.name}:`, e.message);
      break;
    }
  }

  INST_CACHE.set(inst.name, out);
}

/* ---------------------- UI: Inst cards + logos ---------------------- */
async function loadLogos() {
  try {
    const res = await fetch("logos.json");
    if (!res.ok) throw new Error("logos.json not found");
    return await res.json();
  } catch {
    return []; // continue gracefully without logos
  }
}

function renderInstCards(logoMap) {
  const grid = instGrid();
  grid.innerHTML = "";
  INSTITUTIONS.forEach(name => {
    const logo = logoMap.find(l => l.name === name);
    const card = document.createElement("div");
    card.className = "inst-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `View records for ${name}`);

    card.innerHTML = `
      <img src="${logo?.logo || ""}" alt="${name} logo" onerror="this.style.display='none'">
      <div class="name">${name}</div>
    `;

    card.addEventListener("click", async () => {
      // select only this institution
      SELECTED_INSTITUTIONS.clear();
      SELECTED_INSTITUTIONS.add(name);
      updateInstButtonLabel();
      await ensureSelectedLoaded();
      // show results and scroll
      render();
      window.scrollTo({ top: grid.offsetTop - 10, behavior: "smooth" });
    });

    grid.appendChild(card);
  });
}

/* ---------------------- Filters (multi-select) ---------------------- */
function updateInstButtonLabel() {
  const btn = document.getElementById("instToggle");
  if (!SELECTED_INSTITUTIONS.size || SELECTED_INSTITUTIONS.size === INSTITUTIONS.length) {
    btn.textContent = "All";
  } else if (SELECTED_INSTITUTIONS.size === 1) {
    btn.textContent = [...SELECTED_INSTITUTIONS][0];
  } else {
    btn.textContent = `${SELECTED_INSTITUTIONS.size} selected`;
  }
}

function buildInstitutionDropdown() {
  const list = document.getElementById("instList");
  list.innerHTML = "";

  // Select all
  const rowAll = document.createElement("div");
  rowAll.className = "row";
  rowAll.innerHTML = `<input type="checkbox" id="inst_all" ${SELECTED_INSTITUTIONS.size ? "" : "checked"}> <label for="inst_all"><strong>Select all</strong></label>`;
  rowAll.addEventListener("click", (e) => {
    const input = rowAll.querySelector("input");
    const willCheck = !input.checked;
    input.checked = willCheck;
    SELECTED_INSTITUTIONS.clear();
    if (!willCheck) {
      // none selected
    } else {
      // all selected => clear set (means 'All')
    }
    updateInstButtonLabel();
    render();
    e.stopPropagation();
  });
  list.appendChild(rowAll);

  // Institutions
  INSTITUTIONS.forEach(name => {
    const id = `inst_${btoa(name).replace(/=+/g,"")}`;
    const row = document.createElement("div");
    row.className = "row";
    const checked = SELECTED_INSTITUTIONS.has(name) ? "checked" : "";
    row.innerHTML = `<input type="checkbox" id="${id}" ${checked}> <label for="${id}">${name}</label>`;
    row.addEventListener("click", (e) => {
      const input = row.querySelector("input");
      input.checked = !input.checked;
      if (input.checked) SELECTED_INSTITUTIONS.add(name);
      else SELECTED_INSTITUTIONS.delete(name);
      updateInstButtonLabel();
      render();
      e.stopPropagation();
    });
    list.appendChild(row);
  });

  // Toggle handler
  const toggle = document.getElementById("instToggle");
  const panel = document.getElementById("instList");
  toggle.addEventListener("click", (e) => {
    const isOpen = panel.classList.contains("open");
    panel.classList.toggle("open", !isOpen);
    toggle.setAttribute("aria-expanded", String(!isOpen));
    e.stopPropagation();
  });
  document.addEventListener("click", () => panel.classList.remove("open"));
}

/* ---------------------- Search & filters ---------------------- */
function parseSearchQuery(raw) {
  const s = (raw || "").trim();
  if (!s) { SEARCH_TEXT = ""; YEAR_FILTER = ""; return; }

  // Simple heuristic: grab the first standalone 4-digit year.
  const m = s.match(/\b(19|20)\d{2}\b/);
  YEAR_FILTER = m ? m[0] : "";
  SEARCH_TEXT = s;
}

function buildFilters() {
  // Type
  const typeSel = document.getElementById("typeFilter");
  TYPE_FILTER = typeSel.value || "";
  typeSel.addEventListener("change", () => {
    TYPE_FILTER = typeSel.value || "";
    CURRENT_PAGE = 1; render();
  });

  // Page size
  const pageSel = document.getElementById("pageSizeSelect");
  PAGE_SIZE = parseInt(pageSel.value, 10) || PAGE_SIZE_DEFAULT;
  pageSel.addEventListener("change", () => {
    PAGE_SIZE = parseInt(pageSel.value, 10) || PAGE_SIZE_DEFAULT;
    CURRENT_PAGE = 1; render();
  });

  // Unified search
  const searchBox = document.getElementById("searchInput");
  parseSearchQuery(searchBox.value);
  searchBox.addEventListener("input", e => { parseSearchQuery(e.target.value); CURRENT_PAGE = 1; render(); });
  searchBox.addEventListener("keypress", e => { if (e.key === "Enter") render(); });

  // Institution multi-select control
  buildInstitutionDropdown();
  updateInstButtonLabel();
}

/* ---------------------- Render ---------------------- */
function filteredItems() {
  // collect pooled items based on selected institutions
  let pool = [];
  if (!SELECTED_INSTITUTIONS.size) {
    // 'All': merge all caches
    INST_CACHE.forEach(items => pool.push(...items));
  } else {
    SELECTED_INSTITUTIONS.forEach(name => {
      const items = INST_CACHE.get(name) || [];
      pool.push(...items);
    });
  }

  // apply filters
  const txt = (SEARCH_TEXT || "").toLowerCase();
  const yr = YEAR_FILTER;
  const type = TYPE_FILTER;

  return pool.filter(it => {
    // type
    if (type && it.typeNorm && it.typeNorm !== type) return false;
    // year
    if (yr && it.date && it.date.substring(0,4) !== yr) return false;

    if (!txt) return true;

    const t  = (it.title || "").toLowerCase();
    const d  = (it.description || "").toLowerCase();
    const a  = (it.creators || []).join(" ").toLowerCase();
    const s  = (it.subjects || []).join(" ").toLowerCase();
    const adv = (it.advisors || []).join(" ").toLowerCase();
    const inst = (it.institution || "").toLowerCase();

    return t.includes(txt) || d.includes(txt) || a.includes(txt) || s.includes(txt) || adv.includes(txt) || inst.includes(txt);
  });
}

function render() {
  const mount = resultsMount();
  mount.innerHTML = "";

  const items = filteredItems();
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  CURRENT_PAGE = Math.min(CURRENT_PAGE, totalPages);
  const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);

  if (!pageItems.length) {
    mount.innerHTML = `<div class="card"><div>No results found.</div></div>`;
  } else {
    pageItems.forEach(it => {
      const card = document.createElement("div");
      card.className = "card";

      const subjBadges = (it.subjects || []).slice(0, 6).map(s => `<span class="badge">${s}</span>`).join(" ");
      const advisorText = (it.advisors && it.advisors.length) ? ` • <strong>Advisor:</strong> ${it.advisors.join(", ")}` : "";

      card.innerHTML = `
        <div class="source-tag">DSpace • ${it.institution}</div>
        <h3>${it.title}</h3>
        <div class="meta">
          ${it.creators?.length ? `<strong>Authors:</strong> ${it.creators.join(", ")}` : ""}
          ${it.date ? ` • <strong>Year:</strong> ${it.date.substring(0,4)}` : ""}
          ${it.typeNorm ? ` • <strong>Type:</strong> ${it.typeNorm[0].toUpperCase()}${it.typeNorm.slice(1)}` : ""}
          ${advisorText}
        </div>
        <p>${(it.description || "").slice(0, 260)}${(it.description || "").length > 260 ? "…" : ""}</p>
        ${subjBadges ? `<div class="badges">${subjBadges}</div>` : ""}
        ${it.link ? `<p><a href="${it.link}" target="_blank" rel="noopener">View Record ↗</a></p>` : ""}
      `;
      mount.appendChild(card);
    });
  }

  // Pagination controls
  const pagination = document.getElementById("pagination");
  const info = document.getElementById("pageInfo");
  if (items.length <= PAGE_SIZE) {
    pagination.classList.add("hidden");
  } else {
    pagination.classList.remove("hidden");
    info.textContent = `Page ${CURRENT_PAGE} of ${totalPages}`;
    document.getElementById("prevPage").disabled = CURRENT_PAGE <= 1;
    document.getElementById("nextPage").disabled = CURRENT_PAGE >= totalPages;
  }
}

/* ---------------------- Ensure data for selected institutions ---------------------- */
async function ensureSelectedLoaded() {
  const targets = (!SELECTED_INSTITUTIONS.size ? INSTITUTIONS : Array.from(SELECTED_INSTITUTIONS));
  for (const name of targets) {
    const inst = DSPACE_ENDPOINTS.find(d => d.name === name);
    if (!inst) continue;
    if (!INST_CACHE.has(name) || !INST_CACHE.get(name).length) {
      // limit pages moderately; adjust as needed
      await harvestInstitution(inst, 8);
    }
  }
}

/* ---------------------- Hero Background Animation ---------------------- */
function initHeroBg() {
  const canvas = document.getElementById("heroBg");
  const ctx = canvas.getContext("2d");
  let w, h, pts;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = 260;
    pts = Array.from({ length: 60 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6
    }));
  }
  resize();
  window.addEventListener("resize", resize);

  function draw() {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#cde3ff";
    pts.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
    });
    ctx.strokeStyle = "rgba(205,227,255,0.2)";
    for (let i=0;i<pts.length;i++) for (let j=i+1;j<pts.length;j++) {
      const dx = pts[i].x-pts[j].x, dy = pts[i].y-pts[j].y;
      if (Math.sqrt(dx*dx+dy*dy) < 100) { ctx.beginPath(); ctx.moveTo(pts[i].x,pts[i].y); ctx.lineTo(pts[j].x,pts[j].y); ctx.stroke(); }
    }
    requestAnimationFrame(draw);
  }
  draw();
}

/* ---------------------- Main ---------------------- */
async function load() {
  initHeroBg();

  // Prep institution names list
  INSTITUTIONS = DSPACE_ENDPOINTS.map(d => d.name);

  // Build filters (empty state first)
  buildFilters();

  // Load logos & build cards
  const logos = await loadLogos();
  renderInstCards(logos);

  // Hook up pagination + home reset
  document.getElementById("prevPage").addEventListener("click", () => { if (CURRENT_PAGE > 1) { CURRENT_PAGE--; render(); }});
  document.getElementById("nextPage").addEventListener("click", () => { CURRENT_PAGE++; render(); });
  document.getElementById("homeBtn").addEventListener("click", () => {
    SELECTED_INSTITUTIONS.clear();
    updateInstButtonLabel();
    document.getElementById("searchInput").value = "";
    SEARCH_TEXT = ""; YEAR_FILTER = ""; TYPE_FILTER = "";
    document.getElementById("typeFilter").value = "";
    CURRENT_PAGE = 1;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // OPTIONAL: Light background prefetch (first page) to make initial searches quick.
  // Comment out if you prefer fetch-on-demand only.
  for (const inst of DSPACE_ENDPOINTS) {
    // first page only (fast), then render; deeper pages are loaded when needed
    if (!INST_CACHE.has(inst.name)) {
      harvestInstitution(inst, 1).then(() => {
        render();
      }).catch(()=>{});
      await delay(120);
    }
  }
}

document.addEventListener("DOMContentLoaded", load);
