// =======================================================
// InquiryBase — DSpace Theses & Dissertations Harvester
// =======================================================

const PROXY = "https://inquirybase.archiverepo1.workers.dev/?url=";

// Curated DSpace OAI-PMH endpoints (oai_dc). We'll add institutions only when they respond.
const DSPACE_ENDPOINTS = [
  // South Africa
  { name: "University of Cape Town (UCT)", url: "https://open.uct.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "Stellenbosch University (SUNScholar)", url: "https://scholar.sun.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of Pretoria (UPSpace)", url: "https://repository.up.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "Wits (WIReDSpace)", url: "https://wiredspace.wits.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "North-West University (NWU)", url: "https://repository.nwu.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of KwaZulu-Natal (UKZN)", url: "https://researchspace.ukzn.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of the Free State (UFS)", url: "https://scholar.ufs.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of the Western Cape (UWC)", url: "https://etd.uwc.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of Johannesburg (UJ)", url: "https://ujcontent.uj.ac.za/vital/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "UNISA (Institutional Repository)", url: "https://uir.unisa.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },

  // International sample
  { name: "DSpace@MIT", url: "https://dspace.mit.edu/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "USA" },
  { name: "Cambridge (Apollo)", url: "https://www.repository.cam.ac.uk/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "UK" },
  { name: "eCommons (Cornell)", url: "https://ecommons.cornell.edu/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "USA" }
];

const PAGE_SIZE_DEFAULT = 100;
let PAGE_SIZE = PAGE_SIZE_DEFAULT;

let SEARCH_TEXT = "";
let CURRENT_PAGE = 1;

let INST_CACHE = new Map();  // instName -> items[]
let INSTITUTIONS = [];

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const nowStamp = () => new Date().toLocaleString();

/** Utility to pull text values from DC nodes (any namespace) */
function pick(node, tag) {
  return Array.from(node.getElementsByTagNameNS("*", tag)).map(n => (n.textContent || "").trim());
}

/** Determine if a record looks like a thesis/dissertation based on dc:type (and sometimes dc:description) */
function isThesisLike(types = [], desc = "") {
  const hay = (types.join(" ") + " " + desc).toLowerCase();
  return /thesis|dissertation|doctoral|masters|phd|m\.sc|m\s?thesis|dphil/.test(hay);
}

/** Select a usable link from dc:identifier values (prefer http/https; fallback handle; else blank). */
function bestLink(identifiers = []) {
  const http = identifiers.find(i => i.startsWith("http"));
  if (http) return http;
  const handle = identifiers.find(i => i.includes("hdl.handle.net"));
  if (handle) return "https://" + handle.replace(/^https?:\/\//, "");
  const doi = identifiers.find(i => /^10\./.test(i));
  if (doi) return `https://doi.org/${doi}`;
  return "";
}

/** Fetch 1 OAI page for an institution (for speed) */
async function fetchInstitutionFirstPage(inst) {
  try {
    const url = inst.url;
    const res = await fetch(PROXY + encodeURIComponent(url));
    const text = await res.text();
    const xml = new DOMParser().parseFromString(text, "text/xml");

    const records = Array.from(xml.getElementsByTagNameNS("*", "record"));
    if (!records.length) return [];

    const items = records.map(r => {
      const md = r.getElementsByTagNameNS("*", "metadata")[0];
      if (!md) return null;
      // dc fields
      const titles = pick(md, "title");
      const creators = pick(md, "creator");
      const descs = pick(md, "description");
      const subjects = pick(md, "subject");
      const types = pick(md, "type");
      const dates = pick(md, "date");
      const ids = pick(md, "identifier");

      const description = descs[0] || "";
      if (!isThesisLike(types, description)) return null;

      return {
        title: titles[0] || "(Untitled)",
        creators,
        description,
        subjects,
        types,
        date: dates[0] || "",
        link: bestLink(ids),
        institution: inst.name,
        country: inst.country
      };
    }).filter(Boolean);

    console.log(`✅ ${inst.name}: ${items.length} thesis-like records (first page)`);
    return items;
  } catch (e) {
    console.warn(`⚠️ Failed to fetch ${inst.name}`, e);
    return [];
  }
}

/** Fade out spinner once we have content */
function fadeOutSpinner() {
  const spinner = document.getElementById("loadingSpinner");
  if (spinner) spinner.classList.add("fade-out");
  setTimeout(() => spinner?.remove(), 700);
}

/** Build/refresh filters */
function buildFilters() {
  const instSel = document.getElementById("institutionFilter");
  instSel.innerHTML = `<option value="">All</option>` + INSTITUTIONS.map(n => `<option value="${n}">${n}</option>`).join("");
  instSel.addEventListener("change", () => { CURRENT_PAGE = 1; render(); });

  const pageSel = document.getElementById("pageSizeSelect");
  PAGE_SIZE = parseInt(pageSel.value, 10) || PAGE_SIZE_DEFAULT;
  pageSel.addEventListener("change", () => {
    PAGE_SIZE = parseInt(pageSel.value, 10) || PAGE_SIZE_DEFAULT;
    CURRENT_PAGE = 1; render();
  });

  const searchBox = document.getElementById("searchInput");
  searchBox.addEventListener("input", e => { SEARCH_TEXT = e.target.value.toLowerCase(); CURRENT_PAGE = 1; render(); });
  searchBox.addEventListener("keypress", e => { if (e.key === "Enter") render(); });
}

/** Compute filtered pool from INST_CACHE + filters/search */
function filteredItems() {
  const instSel = document.getElementById("institutionFilter")?.value || "";
  const text = SEARCH_TEXT;

  let pool = [];
  INST_CACHE.forEach((items, name) => {
    if (!instSel || instSel === name) pool.push(...items);
  });

  if (!text) return pool;

  return pool.filter(it => {
    const t = (it.title || "").toLowerCase();
    const d = (it.description || "").toLowerCase();
    const a = (it.creators || []).join(" ").toLowerCase();
    const s = (it.subjects || []).join(" ").toLowerCase();
    const inst = (it.institution || "").toLowerCase();
    return t.includes(text) || d.includes(text) || a.includes(text) || s.includes(text) || inst.includes(text);
  });
}

/** Render cards + pagination + overview */
function render() {
  const mount = document.getElementById("results");
  mount.innerHTML = "";

  const items = filteredItems();
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  CURRENT_PAGE = Math.min(CURRENT_PAGE, totalPages);

  const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);

  if (!pageItems.length) {
    mount.innerHTML = `<div class="loading">No results found.</div>`;
  } else {
    pageItems.forEach(it => {
      const card = document.createElement("div");
      card.className = "card";

      const subjBadges = (it.subjects || []).slice(0, 6).map(s => `<span class="badge">${s}</span>`).join(" ");

      card.innerHTML = `
        <div class="source-tag">DSpace • ${it.institution}</div>
        <h3>${it.title}</h3>
        <div class="meta">
          ${it.creators?.length ? `<strong>Authors:</strong> ${it.creators.join(", ")}` : ""}
          ${it.date ? ` • <strong>Year:</strong> ${it.date.substring(0,4)}` : ""}
          ${it.types?.length ? ` • <strong>Type:</strong> ${it.types[0]}` : ""}
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

  updateOverview();
  fadeOutSpinner();
}

/** Overview panel: totals, top subjects, top types */
function updateOverview() {
  const panel = document.getElementById("overview");
  const all = Array.from(INST_CACHE.values()).flat();
  const total = all.length;
  const instCount = INSTITUTIONS.length;

  document.getElementById("countTotal").textContent = total;
  document.getElementById("countInst").textContent = instCount;

  const subjFreq = {};
  const typeFreq = {};
  all.forEach(it => {
    (it.subjects || []).forEach(s => { if (!s) return; subjFreq[s] = (subjFreq[s] || 0) + 1; });
    (it.types || []).forEach(t => { if (!t) return; typeFreq[t] = (typeFreq[t] || 0) + 1; });
  });

  const topSubjects = Object.entries(subjFreq).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const topTypes = Object.entries(typeFreq).sort((a,b)=>b[1]-a[1]).slice(0,5);

  document.getElementById("topSubjects").innerHTML = topSubjects.map(([s,n])=>`<li>${s} (${n})</li>`).join("");
  document.getElementById("topTypes").innerHTML = topTypes.map(([t,n])=>`<li>${t} (${n})</li>`).join("");

  document.getElementById("stamp").textContent = `Last updated: ${nowStamp()}`;
  panel.classList.remove("hidden");
}

/** Hero background animation */
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

/** Main load */
async function load() {
  initHeroBg();

  // Build empty filters & pagination events
  buildFilters();

  document.getElementById("prevPage").addEventListener("click", () => {
    if (CURRENT_PAGE > 1) { CURRENT_PAGE--; render(); }
  });
  document.getElementById("nextPage").addEventListener("click", () => {
    CURRENT_PAGE++; render();
  });

  document.getElementById("homeBtn").addEventListener("click", () => {
    const instSel = document.getElementById("institutionFilter");
    const search = document.getElementById("searchInput");
    instSel.value = ""; search.value = ""; SEARCH_TEXT = ""; CURRENT_PAGE = 1;
    render(); window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // Harvest: small first page from each repo (fast)
  for (const inst of DSPACE_ENDPOINTS) {
    // Stagger requests lightly to be kind to servers
    // (and avoid proxy queueing)
    // eslint-disable-next-line no-await-in-loop
    await delay(120);

    fetchInstitutionFirstPage(inst).then(items => {
      if (items.length > 0) {
        INST_CACHE.set(inst.name, items);
        if (!INSTITUTIONS.includes(inst.name)) INSTITUTIONS.push(inst.name);
        INSTITUTIONS.sort((a, b) => a.localeCompare(b));
        buildFilters();
        render();
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", load);
