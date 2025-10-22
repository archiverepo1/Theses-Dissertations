// =======================================================
// National ETD Portal (SA) — DSpace Harvester (script.js)
// =======================================================

/*
  Features:
  - Institution cards with logos (grey if offline; tooltip on hover/tap with contact)
  - Multi-select institution filter (panel) + card click
  - Single search across title/authors/abstract/subjects/institution/year
  - Type filter (Thesis/Dissertation) + Page size
  - Pagination (Prev/Next)
  - Wrong-repository hint: detects and redirects to the correct repo if title found elsewhere
  - Progressive harvest: first page for all; deep harvest on selection/click
*/

const PROXY = "https://inquirybase.archiverepo1.workers.dev/?url=";

// ---- South African DSpace endpoints ----
const DSPACE_ENDPOINTS = [
  { name: "University of Cape Town (UCT)", url: "https://open.uct.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "Stellenbosch University (SUNScholar)", url: "https://scholar.sun.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of Pretoria (UPSpace)", url: "https://repository.up.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "Wits (WIReDSpace)", url: "https://wiredspace.wits.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "North-West University (NWU)", url: "https://repository.nwu.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of KwaZulu-Natal (UKZN)", url: "https://researchspace.ukzn.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  // UFS note: uses /server/oai/request for newer DSpace 7
  { name: "University of the Free State (UFS)", url: "https://scholar.ufs.ac.za/server/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of the Western Cape (UWC)", url: "https://etd.uwc.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  // UJ is VITAL; OAI endpoint is different; if it fails we’ll mark offline gracefully
  { name: "University of Johannesburg (UJ)", url: "https://ujcontent.uj.ac.za/vital/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  // Rhodes runs SEALS Vital; OAI may be at ikamva/seals; include and mark offline if not responding
  { name: "Rhodes University (RU / SEALS iKamva)", url: "https://vital.seals.ac.za/vital/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  // CUT
  { name: "Central University of Technology (CUT)", url: "https://cutscholar.cut.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" }
];

// ---- Config ----
const PAGE_SIZE_DEFAULT = 100;
const FIRST_PASS_PAGES = 1;      // first page for everyone (speed)
const DEEP_PASS_MAX_PAGES = 12;  // when focused (selection/click)
const BETWEEN_REQUEST_MS = 180;

// ---- State ----
let PAGE_SIZE = PAGE_SIZE_DEFAULT;
let SEARCH_TEXT = "";
let CURRENT_PAGE = 1;
let TYPE_FILTER = "";                 // "thesis" | "dissertation" | ""
let SELECTED_INSTITUTIONS = new Set();// multi-select filter

// Cache: institution -> { items:[], loadedPages, done, status:'ok'|'down', email }
const INST_CACHE = new Map();

// Logos cached from logos.json
const LOGOS = new Map();

// UI refs
const resultsMount = () => document.getElementById("results");
const gridMount = () => document.getElementById("instGrid");
const hintBar = () => document.getElementById("hintBar");

// ------------------------------------------------------
// Utilities
// ------------------------------------------------------

const delay = ms => new Promise(r => setTimeout(r, ms));
const nowStamp = () => new Date().toLocaleString();

function pick(node, tag) {
  return Array.from(node.getElementsByTagNameNS("*", tag)).map(n => (n.textContent || "").trim());
}

function containsThesisType(types = [], desc = "") {
  const hay = (types.join(" ") + " " + desc).toLowerCase();
  return /thesis|dissertation|doctoral|masters|m\.?sc|m\s?thesis|phd|dphil/.test(hay);
}

function bestLink(identifiers = []) {
  const http = identifiers.find(i => /^https?:\/\//i.test(i));
  if (http) return http;
  const handle = identifiers.find(i => i.includes("hdl.handle.net"));
  if (handle) return handle.startsWith("http") ? handle : "https://" + handle;
  const doi = identifiers.find(i => /^10\./.test(i));
  if (doi) return `https://doi.org/${doi}`;
  return "";
}

function normalizeType(types = []) {
  const t = (types.join(" ") || "").toLowerCase();
  if (/dissertation/.test(t)) return "Dissertation";
  if (/thesis/.test(t)) return "Thesis";
  return types[0] || "";
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// ------------------------------------------------------
// Logo loader
// ------------------------------------------------------
async function loadLogos() {
  try {
    const res = await fetch("logos.json");
    const json = await res.json();
    Object.entries(json).forEach(([k, v]) => LOGOS.set(k, v));
  } catch (e) {
    console.warn("logos.json not found; using defaults");
  }
}
function logoFor(instName) {
  return LOGOS.get(instName) || LOGOS.get("_default") || "https://upload.wikimedia.org/wikipedia/commons/1/15/SA_Open_Access_Logo.png";
}

// ------------------------------------------------------
// Identify endpoint to check status + get adminEmail
// ------------------------------------------------------
async function checkIdentify(baseListRecordsURL) {
  // Replace query with ?verb=Identify
  const identifyURL = baseListRecordsURL.replace(/verb=ListRecords.*$/i, "verb=Identify");
  try {
    const res = await fetch(PROXY + encodeURIComponent(identifyURL));
    if (!res.ok) throw new Error(res.status + "");
    const text = await res.text();
    const xml = new DOMParser().parseFromString(text, "text/xml");
    const email = xml.getElementsByTagName("adminEmail")[0]?.textContent?.trim() || "";
    return { status: "ok", email };
  } catch (e) {
    return { status: "down", email: "" };
  }
}

// ------------------------------------------------------
// Harvesting
// ------------------------------------------------------
async function fetchOAIPage(listURL) {
  const res = await fetch(PROXY + encodeURIComponent(listURL));
  const text = await res.text();
  const xml = new DOMParser().parseFromString(text, "text/xml");

  const records = Array.from(xml.getElementsByTagNameNS("*", "record"));
  const tokenNode = xml.getElementsByTagNameNS("*", "resumptionToken")[0];
  const nextToken = tokenNode ? tokenNode.textContent.trim() : null;

  const items = records.map(r => {
    const md = r.getElementsByTagNameNS("*", "metadata")[0];
    if (!md) return null;

    const titles = pick(md, "title");
    const creators = pick(md, "creator");
    const descs = pick(md, "description");
    const subjects = pick(md, "subject");
    const types = pick(md, "type");
    const dates = pick(md, "date");
    const ids = pick(md, "identifier");

    const description = descs[0] || "";
    // thesis-like check (we only keep theses/dissertations)
    if (!containsThesisType(types, description)) return null;

    return {
      title: titles[0] || "(Untitled)",
      creators,
      description,
      subjects,
      types,
      normType: normalizeType(types),
      date: dates[0] || "",
      year: (dates[0] || "").substring(0, 4),
      link: bestLink(ids)
    };
  }).filter(Boolean);

  return { items, nextToken };
}

// shallow pass: 1 page
async function harvestFirstPage(inst) {
  const { name, url } = inst;
  if (!INST_CACHE.has(name)) {
    INST_CACHE.set(name, { items: [], loadedPages: 0, done: false, status: "checking", email: "" });
  }
  const entry = INST_CACHE.get(name);

  // identify check
  const id = await checkIdentify(url);
  entry.status = id.status;
  entry.email = id.email;

  if (id.status === "down") {
    INST_CACHE.set(name, entry);
    return entry;
  }

  try {
    const p1 = await fetchOAIPage(url);
    entry.items = p1.items;
    entry.loadedPages = 1;
    entry.done = !p1.nextToken;
    // store token for deep pass
    entry._nextToken = p1.nextToken || null;
  } catch (e) {
    entry.status = "down";
  }
  INST_CACHE.set(name, entry);
  return entry;
}

// deep pass: continue with resumptionToken up to maxPages
async function deepHarvest(inst, maxPages = DEEP_PASS_MAX_PAGES) {
  const entry = INST_CACHE.get(inst.name) || { items: [], loadedPages: 0, done: false, status: "ok" };
  if (entry.status !== "ok" || entry.done) return;

  let token = entry._nextToken || null;
  let pageCount = entry.loadedPages;

  while (token && pageCount < maxPages) {
    const tokenURL = token.includes("verb=ListRecords")
      ? token
      : `${inst.url.split("?")[0]}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`;

    await delay(BETWEEN_REQUEST_MS);
    try {
      const p = await fetchOAIPage(tokenURL);
      entry.items.push(...p.items);
      pageCount += 1;
      entry.loadedPages = pageCount;
      entry._nextToken = p.nextToken || null;
      entry.done = !p.nextToken;
    } catch (e) {
      break;
    }
    token = entry._nextToken;
  }
  INST_CACHE.set(inst.name, entry);
}

// ------------------------------------------------------
// UI: Institution Grid
// ------------------------------------------------------
function renderInstGrid() {
  const mount = gridMount();
  mount.innerHTML = "";

  DSPACE_ENDPOINTS.forEach(inst => {
    const entry = INST_CACHE.get(inst.name) || { status: "checking" };
    const logo = logoFor(inst.name);

    const card = document.createElement("div");
    card.className = "inst-card" + (entry.status === "down" ? " offline" : "");
    card.setAttribute("data-inst", inst.name);

    // Tooltip logic (offline)
    if (entry.status === "down") {
      const tip = entry.email
        ? `Repository temporarily unavailable — contact: ${entry.email}`
        : "Repository temporarily unavailable — contact repository manager.";
      card.setAttribute("data-tooltip", tip);
      // mobile tap to show tooltip for 3s
      card.addEventListener("click", (e) => {
        e.stopPropagation();
        card.classList.add("show-tip");
        setTimeout(() => card.classList.remove("show-tip"), 3000);
      });
    } else {
      // Open that repo’s records
      card.addEventListener("click", async () => {
        // toggle selection in multi-select
        SELECTED_INSTITUTIONS.clear();
        SELECTED_INSTITUTIONS.add(inst.name);
        updateInstTriggerLabel();
        await focusInstitutions(Array.from(SELECTED_INSTITUTIONS));
      });
    }

    card.innerHTML = `
      <img class="inst-logo" alt="${inst.name} logo" src="${logo}" />
      <div class="inst-meta">
        <div class="inst-name">${inst.name}</div>
        <div class="inst-sub">${inst.country}</div>
      </div>
      <span class="ribbon ${entry.status === "down" ? "down" : "ok"}">${entry.status === "down" ? "Offline" : "Online"}</span>
    `;
    mount.appendChild(card);
  });
}

// ------------------------------------------------------
// UI: Inst Multi-select Panel
// ------------------------------------------------------
function updateInstTriggerLabel() {
  const btn = document.getElementById("instTrigger");
  if (!btn) return;
  if (SELECTED_INSTITUTIONS.size === 0) btn.textContent = "All";
  else if (SELECTED_INSTITUTIONS.size === 1) btn.textContent = Array.from(SELECTED_INSTITUTIONS)[0];
  else btn.textContent = `${SELECTED_INSTITUTIONS.size} selected`;
}

function openInstPanel() {
  const panel = document.getElementById("instPanel");
  const body = document.getElementById("instChecklist");
  panel.classList.remove("hidden");
  body.innerHTML = "";

  DSPACE_ENDPOINTS.forEach(inst => {
    const entry = INST_CACHE.get(inst.name) || { status: "checking" };
    const id = `inst_${slug(inst.name)}`;
    const checked = SELECTED_INSTITUTIONS.size === 0 || SELECTED_INSTITUTIONS.has(inst.name);

    const row = document.createElement("div");
    row.className = "inst-row";
    row.innerHTML = `
      <input type="checkbox" id="${id}" data-inst="${inst.name}" ${checked ? "checked" : ""}>
      <label for="${id}">
        <strong>${inst.name}</strong>
        <div style="color:#6b7280;font-size:.85rem">${entry.status === "down" ? "Offline" : "Online"}</div>
      </label>
    `;
    body.appendChild(row);
  });
}

function closeInstPanel() {
  document.getElementById("instPanel").classList.add("hidden");
}

function bindInstPanelEvents() {
  document.getElementById("instTrigger").addEventListener("click", () => {
    openInstPanel();
  });
  document.getElementById("instClose").addEventListener("click", closeInstPanel);
  document.getElementById("instSelectAll").addEventListener("click", () => {
    SELECTED_INSTITUTIONS = new Set();
    const checks = document.querySelectorAll("#instChecklist input[type=checkbox]");
    checks.forEach(c => c.checked = true);
  });
  document.getElementById("instApply").addEventListener("click", async () => {
    const checks = document.querySelectorAll("#instChecklist input[type=checkbox]");
    const picked = [];
    checks.forEach(c => { if (c.checked) picked.push(c.dataset.inst); });
    SELECTED_INSTITUTIONS = new Set(picked.length === DSPACE_ENDPOINTS.length ? [] : picked);
    updateInstTriggerLabel();
    closeInstPanel();
    await focusInstitutions(Array.from(SELECTED_INSTITUTIONS));
  });
}

// ------------------------------------------------------
// Filters and Search
// ------------------------------------------------------
function bindFilters() {
  const typeSel = document.getElementById("typeFilter");
  const pageSel = document.getElementById("pageSizeSelect");
  const search = document.getElementById("searchInput");

  TYPE_FILTER = typeSel.value || "";
  PAGE_SIZE = parseInt(pageSel.value, 10) || PAGE_SIZE_DEFAULT;

  typeSel.addEventListener("change", () => {
    TYPE_FILTER = typeSel.value || "";
    CURRENT_PAGE = 1;
    renderResults();
  });

  pageSel.addEventListener("change", () => {
    PAGE_SIZE = parseInt(pageSel.value, 10) || PAGE_SIZE_DEFAULT;
    CURRENT_PAGE = 1;
    renderResults();
  });

  search.addEventListener("input", e => {
    SEARCH_TEXT = e.target.value.toLowerCase();
    CURRENT_PAGE = 1;
    renderResults();
  });
  search.addEventListener("keypress", e => {
    if (e.key === "Enter") {
      SEARCH_TEXT = search.value.toLowerCase();
      CURRENT_PAGE = 1;
      renderResults(true /* check wrong-repo */);
    }
  });

  document.getElementById("prevPage").addEventListener("click", () => {
    if (CURRENT_PAGE > 1) {
      CURRENT_PAGE--;
      renderResults();
    }
  });
  document.getElementById("nextPage").addEventListener("click", () => {
    CURRENT_PAGE++;
    renderResults();
  });
}

// ------------------------------------------------------
// Pool builder + Wrong repository detection
// ------------------------------------------------------
function combinedPool() {
  // if none selected => all online repos (data we have)
  const chosen = SELECTED_INSTITUTIONS.size
    ? Array.from(SELECTED_INSTITUTIONS)
    : DSPACE_ENDPOINTS.map(d => d.name);

  const items = [];
  chosen.forEach(name => {
    const entry = INST_CACHE.get(name);
    if (entry && entry.status === "ok" && entry.items?.length) {
      entry.items.forEach(it => items.push({ ...it, institution: name, country: "South Africa" }));
    }
  });
  return items;
}

function applyFilters(items) {
  const text = SEARCH_TEXT;
  const typeWanted = (TYPE_FILTER || "").toLowerCase();

  return items.filter(it => {
    // type filter
    if (typeWanted) {
      const t = (it.normType || "").toLowerCase();
      if (!t.includes(typeWanted)) return false;
    }
    // search across title, authors, abstract, subjects, institution, year
    if (text) {
      const hay = [
        it.title || "",
        (it.creators || []).join(" "),
        it.description || "",
        (it.subjects || []).join(" "),
        it.institution || "",
        it.year || ""
      ].join(" ").toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
}

function showHint(msg) {
  const bar = hintBar();
  bar.textContent = msg;
  bar.classList.remove("hidden");
  bar.style.opacity = "1";
  setTimeout(() => {
    bar.style.opacity = "0";
    setTimeout(() => bar.classList.add("hidden"), 400);
  }, 3000);
}

/**
 * When user searches a specific title but picked wrong repo, try to find it in other repos
 * If found, switch selection to that repo and notify
 */
function detectWrongRepoAndRedirect(allItems) {
  const q = (SEARCH_TEXT || "").trim();
  if (!q || q.length < 6) return false;

  // Perfect/near-perfect title match search across all known items
  const lowQ = q.toLowerCase();
  const found = [];
  DSPACE_ENDPOINTS.forEach(inst => {
    const entry = INST_CACHE.get(inst.name);
    if (!entry || entry.status !== "ok" || !entry.items?.length) return;
    for (const it of entry.items) {
      const ttl = (it.title || "").toLowerCase();
      if (ttl === lowQ || (ttl.includes(lowQ) && lowQ.length > 12)) {
        found.push({ inst: inst.name, item: it });
      }
    }
  });

  if (found.length) {
    const targetInst = found[0].inst;
    const wasSelected = SELECTED_INSTITUTIONS.size ? SELECTED_INSTITUTIONS.has(targetInst) : true;
    // if not currently selected, switch to it
    if (!wasSelected) {
      SELECTED_INSTITUTIONS.clear();
      SELECTED_INSTITUTIONS.add(targetInst);
      updateInstTriggerLabel();
      showHint(`Found in ${targetInst} — switching repository…`);
      renderResults();
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------
// Rendering results
// ------------------------------------------------------
function renderResults(checkWrongRepo = false) {
  const mount = resultsMount();
  mount.innerHTML = "";

  // Ensure grid stays visible at top
  // (we keep grid always; results under it)
  const pool = combinedPool();
  const filtered = applyFilters(pool);

  if (checkWrongRepo && !filtered.length) {
    // try to detect wrong repo and auto-redirect
    const redirected = detectWrongRepoAndRedirect(pool);
    if (redirected) return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  CURRENT_PAGE = Math.min(CURRENT_PAGE, totalPages);
  const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);

  if (!pageItems.length) {
    mount.innerHTML = `<div class="loading">No results found.</div>`;
  } else {
    pageItems.forEach(it => {
      const card = document.createElement("div");
      card.className = "card";
      const creators = it.creators?.length ? `<strong>Authors:</strong> ${it.creators.join(", ")}` : "";
      const yr = it.year ? ` • <strong>Year:</strong> ${it.year}` : "";
      const typ = it.normType ? ` • <strong>Type:</strong> ${it.normType}` : "";
      const subs = (it.subjects || []).slice(0, 6).map(s => `<span class="badge">${s}</span>`).join(" ");
      card.innerHTML = `
        <div class="source-tag">DSpace • ${it.institution}</div>
        <h3>${it.title}</h3>
        <div class="meta">${creators}${yr}${typ}</div>
        <p>${(it.description || "").slice(0, 260)}${(it.description || "").length > 260 ? "…" : ""}</p>
        ${subs ? `<div class="badges">${subs}</div>` : ""}
        ${it.link ? `<p><a href="${it.link}" target="_blank" rel="noopener">View Record ↗</a></p>` : ""}
      `;
      mount.appendChild(card);
    });
  }

  // Pagination
  const pagination = document.getElementById("pagination");
  const info = document.getElementById("pageInfo");
  if (filtered.length <= PAGE_SIZE) {
    pagination.classList.add("hidden");
  } else {
    pagination.classList.remove("hidden");
    info.textContent = `Page ${CURRENT_PAGE} of ${totalPages}`;
    document.getElementById("prevPage").disabled = CURRENT_PAGE <= 1;
    document.getElementById("nextPage").disabled = CURRENT_PAGE >= totalPages;
  }
}

// ------------------------------------------------------
// Focus institutions (deep-harvest selected repos)
// ------------------------------------------------------
async function focusInstitutions(instNames) {
  // If none chosen → show all shallow
  if (!instNames || !instNames.length) {
    renderResults();
    return;
  }
  // Deepen harvest for selected
  for (const name of instNames) {
    const inst = DSPACE_ENDPOINTS.find(d => d.name === name);
    if (!inst) continue;
    const entry = INST_CACHE.get(name);
    if (!entry || entry.status !== "ok") continue;
    if (entry.done || (entry.loadedPages || 0) >= 3) continue; // already fairly deep
    await deepHarvest(inst, DEEP_PASS_MAX_PAGES);
    renderResults();
    await delay(60);
  }
  renderResults();
}

// ------------------------------------------------------
// Hero background
// ------------------------------------------------------
function initHeroBg() {
  const canvas = document.getElementById("heroBg");
  const ctx = canvas.getContext("2d");
  let w, h, pts;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = 260;
    pts = Array.from({ length: 64 }, () => ({
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
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
      if (Math.sqrt(dx * dx + dy * dy) < 96) {
        ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
}

// ------------------------------------------------------
// Boot
// ------------------------------------------------------
async function boot() {
  initHeroBg();
  await loadLogos();

  // Prepare caches
  DSPACE_ENDPOINTS.forEach(d => {
    if (!INST_CACHE.has(d.name)) INST_CACHE.set(d.name, { items: [], loadedPages: 0, done: false, status: "checking", email: "" });
  });

  // Bind controls
  bindInstPanelEvents();
  bindFilters();

  // Harvest 1st page for all repos (progressive)
  for (const inst of DSPACE_ENDPOINTS) {
    await delay(BETWEEN_REQUEST_MS);
    await harvestFirstPage(inst);
    renderInstGrid();
    renderResults();
  }

  // Hide initial spinner if still visible
  const spinner = document.getElementById("loadingSpinner");
  if (spinner) {
    spinner.style.opacity = "0";
    setTimeout(() => spinner.remove(), 500);
  }
}

document.addEventListener("DOMContentLoaded", boot);

