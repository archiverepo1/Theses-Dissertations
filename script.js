const PROXY = "https://inquirybase.archiverepo1.workers.dev/?url=";
const LOGOS_URL = "logos.json";

// South African DSpace OAI-PMH endpoints (oai_dc)
const DSPACE_ENDPOINTS = [
  { name: "University of the Free State (UFS)", url: "https://scholar.ufs.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of Cape Town (UCT)", url: "https://open.uct.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "Stellenbosch University (SUNScholar)", url: "https://scholar.sun.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of Pretoria (UPSpace)", url: "https://repository.up.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "Wits (WIReDSpace)", url: "https://wiredspace.wits.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "North-West University (NWU)", url: "https://repository.nwu.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of KwaZulu-Natal (UKZN)", url: "https://researchspace.ukzn.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of Johannesburg (UJ)", url: "https://ujcontent.uj.ac.za/vital/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of the Western Cape (UWC)", url: "https://etd.uwc.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of South Africa (UNISA)", url: "https://uir.unisa.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "Central University of Technology (CUT)", url: "https://cutscholar.cut.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "Rhodes University (RU)", url: "https://vital.seals.ac.za/vital/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" }
];

const PAGE_SIZE_DEFAULT = 100;
let PAGE_SIZE = PAGE_SIZE_DEFAULT;

// UI State
let CURRENT_MODE = "cards"; // "cards" | "list"
let CURRENT_INSTITUTION = ""; // name when in list mode
let SEARCH_TEXT = "";
let CURRENT_PAGE = 1;

// Data caches
let LOGO_MAP = new Map(); // name -> logoURL
const INST_CACHE = new Map(); // name -> { items:[], nextToken:null, busy:false }

// Helpers
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function el(id) { return document.getElementById(id); }
function pick(node, tag) {
  return Array.from(node.getElementsByTagNameNS("*", tag)).map(n => (n.textContent || "").trim());
}
function pickTags(node, tags) {
  let out = [];
  tags.forEach(t => { out = out.concat(pick(node, t)); });
  return out;
}
function bestLink(identifiers = []) {
  const http = identifiers.find(i => /^https?:\/\//i.test(i));
  if (http) return http;
  const handle = identifiers.find(i => /hdl\.handle\.net/i.test(i));
  if (handle) return handle.startsWith("http") ? handle : `https://${handle}`;
  const doi = identifiers.find(i => /^10\./.test(i));
  return doi ? `https://doi.org/${doi}` : "";
}
function isThesisLike(types = [], desc = "") {
  const hay = (types.join(" ") + " " + desc).toLowerCase();
  return /thesis|dissertation|doctoral|masters|m\.sc|m\s?thesis|dphil|phd/.test(hay);
}
function normalizeYear(dates = []) {
  for (const d of dates) {
    const m = d && d.match(/\b(19|20)\d{2}\b/);
    if (m) return m[0];
  }
  return "";
}
function typeBucket(types = []) {
  const t = (types.join(" ") || "").toLowerCase();
  if (/dissertation|doctoral|phd|dphil/.test(t)) return "dissertation";
  if (/thesis|masters|m\.sc|m\s?thesis/.test(t)) return "thesis";
  return "";
}

// =====================
// University Cards View
// =====================
async function loadLogos() {
  try {
    const logos = await fetch(LOGOS_URL).then(r => r.json());
    LOGO_MAP = new Map(logos.map(x => [x.name, x.logo]));
  } catch (e) {
    console.warn("logos.json load failed:", e);
    LOGO_MAP = new Map();
  }
}

function renderUniversityCards() {
  CURRENT_MODE = "cards";
  CURRENT_INSTITUTION = "";
  el("pagination")?.classList.add("hidden");

  // Reset/disable institution/type/year controls while in cards mode
  el("institutionFilter").innerHTML = `<option value="">All</option>`;
  el("typeFilter").value = "";
  el("yearFilter").value = "";
  el("searchInput").value = "";
  SEARCH_TEXT = "";
  CURRENT_PAGE = 1;

  // Show Back button only in list mode; ensure hidden now
  ensureBackButton(false);

  const mount = el("results");
  mount.innerHTML = "";

  DSPACE_ENDPOINTS.forEach(({ name }) => {
    const card = document.createElement("div");
    card.className = "card";

    const logoUrl = LOGO_MAP.get(name) || "";
    const logoImg = logoUrl ? `<img class="logo" src="${logoUrl}" alt="${name} logo" onerror="this.style.display='none'">` : "";

    card.innerHTML = `
      ${logoImg}
      <h3>${name}</h3>
      <p>Explore theses and dissertations from this repository.</p>
      <p><a href="#" data-inst="${name}">View Records ↗</a></p>
    `;
    card.querySelector("a").addEventListener("click", (e) => {
      e.preventDefault();
      openInstitution(name);
    });
    mount.appendChild(card);
  });
}

// ======================
// Institution List View
// ======================
async function openInstitution(instName) {
  CURRENT_MODE = "list";
  CURRENT_INSTITUTION = instName;
  CURRENT_PAGE = 1;

  // Set institution dropdown to current and disable it (to reinforce focused view)
  const instSel = el("institutionFilter");
  instSel.innerHTML = `<option value="${instName}" selected>${instName}</option>`;
  instSel.disabled = true;

  ensureBackButton(true);

  // Ensure cache entry
  if (!INST_CACHE.has(instName)) {
    INST_CACHE.set(instName, { items: [], nextToken: null, busy: false });
  }

  // If nothing fetched yet, fetch initial batch (up to 5 OAI pages)
  const entry = INST_CACHE.get(instName);
  if (!entry.items.length && !entry.busy) {
    await fetchInstitutionPages(instName, 5);
  }

  // Populate type/year/search events
  bindListFilters();

  // Render results
  renderList();
}

function ensureBackButton(show) {
  let btn = el("backBtn");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "backBtn";
    btn.textContent = "← Back to Universities";
    btn.style.marginLeft = "8px";
    btn.style.background = "#6b7280";
    btn.style.color = "#fff";
    btn.style.border = "none";
    btn.style.borderRadius = "5px";
    btn.style.padding = "6px 10px";
    btn.style.cursor = "pointer";
    btn.addEventListener("click", () => {
      // enable institution dropdown again
      el("institutionFilter").disabled = false;
      renderUniversityCards();
    });
    // attach to filters bar
    const filtersBar = document.querySelector(".controls .filters");
    if (filtersBar) filtersBar.appendChild(btn);
  }
  btn.style.display = show ? "inline-block" : "none";
}

async function fetchInstitutionPages(instName, maxPages = 5) {
  const inst = DSPACE_ENDPOINTS.find(e => e.name === instName);
  if (!inst) return;

  const entry = INST_CACHE.get(instName);
  if (!entry || entry.busy) return;

  entry.busy = true;

  let url = entry.nextToken
    ? `${inst.url.split("?")[0]}?verb=ListRecords&resumptionToken=${encodeURIComponent(entry.nextToken)}`
    : inst.url;

  let page = 0;

  try {
    while (url && page < maxPages) {
      page++;
      const res = await fetch(PROXY + encodeURIComponent(url));
      const text = await res.text();
      const xml = new DOMParser().parseFromString(text, "text/xml");

      const records = Array.from(xml.getElementsByTagNameNS("*", "record"));
      const tokenNode = xml.getElementsByTagNameNS("*", "resumptionToken")[0];
      const nextToken = tokenNode ? tokenNode.textContent.trim() : null;

      records.forEach(r => {
        const md = r.getElementsByTagNameNS("*", "metadata")[0];
        if (!md) return;

        // core DC fields
        const titles = pick(md, "title");
        const creators = pick(md, "creator");
        // Many repos use dc:description AND dc:abstract (qualified)
        const descriptions = pickTags(md, ["description", "abstract"]);
        const subjects = pick(md, "subject");
        const types = pick(md, "type");
        const dates = pick(md, "date");
        const identifiers = pick(md, "identifier");

        // Advisors/supervisors (some expose as qualified DC)
        const advisors = pickTags(md, ["contributor.advisor", "advisor", "contributor"]);
        const supervisors = pickTags(md, ["contributor.supervisor", "supervisor", "contributor"]);

        const description = descriptions[0] || "";
        if (!isThesisLike(types, description)) return;

        const item = {
          title: titles[0] || "(Untitled)",
          creators,
          description,
          subjects,
          advisors,
          supervisors,
          types,
          year: normalizeYear(dates),
          link: bestLink(identifiers),
          institution: instName
        };

        entry.items.push(item);
      });

      entry.nextToken = nextToken || null;
      url = nextToken
        ? `${inst.url.split("?")[0]}?verb=ListRecords&resumptionToken=${encodeURIComponent(nextToken)}`
        : null;

      // be polite to repos
      await delay(200);
    }
  } catch (e) {
    console.warn(`Fetch failed for ${instName}:`, e);
  } finally {
    entry.busy = false;
  }
}

function bindListFilters() {
  const pageSel = el("pageSizeSelect");
  PAGE_SIZE = parseInt(pageSel.value, 10) || PAGE_SIZE_DEFAULT;
  pageSel.onchange = () => {
    PAGE_SIZE = parseInt(pageSel.value, 10) || PAGE_SIZE_DEFAULT;
    CURRENT_PAGE = 1; renderList();
  };

  const typeSel = el("typeFilter");
  typeSel.onchange = () => { CURRENT_PAGE = 1; renderList(); };

  const yearSel = el("yearFilter");
  yearSel.oninput = () => { CURRENT_PAGE = 1; renderList(); };

  const searchBox = el("searchInput");
  searchBox.oninput = (e) => { SEARCH_TEXT = e.target.value.toLowerCase(); CURRENT_PAGE = 1; renderList(); };
  searchBox.onkeypress = (e) => { if (e.key === "Enter") renderList(); };

  // Prev/Next paging
  el("prevPage").onclick = () => { if (CURRENT_PAGE > 1) { CURRENT_PAGE--; renderList(); } };
  el("nextPage").onclick = () => { CURRENT_PAGE++; renderList(); };
}

function currentFilteredItems() {
  const entry = INST_CACHE.get(CURRENT_INSTITUTION) || { items: [] };
  const items = entry.items;

  const q = (SEARCH_TEXT || "").trim();
  const y = (el("yearFilter")?.value || "").trim();
  const typeVal = (el("typeFilter")?.value || "").trim(); // "thesis" | "dissertation" | ""

  return items.filter(it => {
    // search across title, description/abstract, authors, subjects, advisors/supervisors
    const t = (it.title || "").toLowerCase();
    const d = (it.description || "").toLowerCase();
    const a = (it.creators || []).join(" ").toLowerCase();
    const s = (it.subjects || []).join(" ").toLowerCase();
    const adv = (it.advisors || []).join(" ").toLowerCase();
    const sup = (it.supervisors || []).join(" ").toLowerCase();

    const textOK = !q || t.includes(q) || d.includes(q) || a.includes(q) || s.includes(q) || adv.includes(q) || sup.includes(q);
    const yearOK = !y || (it.year === y);
    const bucket = typeBucket(it.types || []);
    const typeOK = !typeVal || bucket === typeVal;

    return textOK && yearOK && typeOK;
  });
}

function renderList() {
  const mount = el("results");
  mount.innerHTML = "";

  // hide spinner (if still visible)
  el("loadingSpinner")?.remove();

  const items = currentFilteredItems();

  // Pagination
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  if (CURRENT_PAGE > totalPages) CURRENT_PAGE = totalPages;
  const sliceStart = (CURRENT_PAGE - 1) * PAGE_SIZE;
  const pageItems = items.slice(sliceStart, sliceStart + PAGE_SIZE);

  if (!pageItems.length) {
    mount.innerHTML = `<div class="loading">No results found.</div>`;
  } else {
    pageItems.forEach(it => {
      const card = document.createElement("div");
      card.className = "card";

      const logoUrl = LOGO_MAP.get(CURRENT_INSTITUTION) || "";
      const logoImg = logoUrl ? `<img class="logo" src="${logoUrl}" alt="${CURRENT_INSTITUTION} logo" onerror="this.style.display='none'">` : "";

      const authors = it.creators?.length ? `<strong>Authors:</strong> ${it.creators.join(", ")}` : "";
      const yr = it.year ? ` • <strong>Year:</strong> ${it.year}` : "";
      const tb = typeBucket(it.types || []);
      const typed = tb ? ` • <strong>Type:</strong> ${tb[0].toUpperCase() + tb.slice(1)}` : "";

      // advisor/supervisor (compact)
      let advsup = "";
      const advList = (it.advisors || []).filter(Boolean).slice(0, 2);
      const supList = (it.supervisors || []).filter(Boolean).slice(0, 2);
      const parts = [];
      if (advList.length) parts.push(`<strong>Advisor:</strong> ${advList.join(", ")}`);
      if (supList.length) parts.push(`<strong>Supervisor:</strong> ${supList.join(", ")}`);
      if (parts.length) advsup = ` • ${parts.join(" • ")}`;

      card.innerHTML = `
        ${logoImg}
        <div class="source-tag">${CURRENT_INSTITUTION}</div>
        <h3>${it.title}</h3>
        <div class="meta">
          ${authors}${yr}${typed}${advsup}
        </div>
        <p>${(it.description || "").slice(0, 260)}${(it.description || "").length > 260 ? "…" : ""}</p>
        ${it.link ? `<p><a href="${it.link}" target="_blank" rel="noopener">View Record ↗</a></p>` : ""}
      `;
      mount.appendChild(card);
    });
  }

  // Show pagination controls
  const pagination = el("pagination");
  const info = el("pageInfo");
  if (items.length <= PAGE_SIZE) {
    pagination.classList.add("hidden");
  } else {
    pagination.classList.remove("hidden");
    info.textContent = `Page ${CURRENT_PAGE} of ${totalPages}`;
    el("prevPage").disabled = CURRENT_PAGE <= 1;
    el("nextPage").disabled = CURRENT_PAGE >= totalPages;
  }

  // If we’re near the end of what we’ve fetched and the repo has more pages, prefetch next pages
  const entry = INST_CACHE.get(CURRENT_INSTITUTION);
  const nearEnd = sliceStart + PAGE_SIZE >= entry.items.length - Math.floor(PAGE_SIZE / 2);
  if (entry?.nextToken && !entry.busy && nearEnd) {
    // Fetch 3 more OAI pages in background for smoother browsing
    fetchInstitutionPages(CURRENT_INSTITUTION, 3).then(() => {
      // No immediate re-render; user will hit Next and see more
    });
  }
}

// ==================
// Hero Background BG
// ==================
function initHeroBg() {
  const canvas = document.getElementById("heroBg");
  if (!canvas) return;
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

// ============
// Main Loader
// ============
function bindGlobalFilters() {
  // In cards mode: the institution dropdown is not used; in list mode, we disable it
  const searchBox = el("searchInput");
  searchBox.addEventListener("keypress", e => { if (e.key === "Enter" && CURRENT_MODE === "list") renderList(); });

  el("homeBtn").addEventListener("click", () => {
    el("institutionFilter").disabled = false;
    el("typeFilter").value = "";
    el("yearFilter").value = "";
    el("searchInput").value = "";
    SEARCH_TEXT = "";
    CURRENT_PAGE = 1;
    renderUniversityCards();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

async function load() {
  initHeroBg();
  bindGlobalFilters();
  await loadLogos();
  renderUniversityCards();
}

document.addEventListener("DOMContentLoaded", load);
