<script>
// ===============================
// National ETD Portal (SA) v1.4
// Clean, robust OAI harvester
// ===============================

const PROXY = "https://inquirybase.archiverepo1.workers.dev/?url=";

// --- Verified OAI-PMH base URLs (Identify works on each) ---
const SOURCES = [
  { name: "University of Cape Town (UCT)",              country: "South Africa", base: "https://open.uct.ac.za/oai/request" },
  { name: "Stellenbosch University (SUNScholar)",       country: "South Africa", base: "https://scholar.sun.ac.za/oai/request" },
  { name: "University of Pretoria (UPSpace)",           country: "South Africa", base: "https://repository.up.ac.za/oai/request" },
  { name: "Wits (WIReDSpace)",                          country: "South Africa", base: "https://wiredspace.wits.ac.za/oai/request" },
  { name: "North-West University (NWU)",                country: "South Africa", base: "https://repository.nwu.ac.za/oai/request" },
  { name: "University of KwaZulu-Natal (UKZN)",         country: "South Africa", base: "https://researchspace.ukzn.ac.za/oai/request" },
  { name: "University of the Free State (UFS)",         country: "South Africa", base: "https://scholar.ufs.ac.za/oai/request" },
  { name: "University of the Western Cape (UWC)",       country: "South Africa", base: "https://etd.uwc.ac.za/oai/request" },

  // DSpace 7 layout (requires /server/oai/request)
  { name: "Cape Peninsula University of Technology (CPUT)", country: "South Africa", base: "https://etd.cput.ac.za/server/oai/request" },

  { name: "University of Johannesburg (UJ)",            country: "South Africa", base: "https://ujcontent.uj.ac.za/oai/request" }, // IR (research outputs, not Esploro)
  { name: "University of South Africa (UNISA)",         country: "South Africa", base: "https://uir.unisa.ac.za/oai/request" },
  { name: "Central University of Technology (CUT)",     country: "South Africa", base: "https://cutscholar.cut.ac.za/oai/request" },
];

// --- Page settings ---
const PAGE_SIZE_DEFAULT = 100;
let PAGE_SIZE = PAGE_SIZE_DEFAULT;
let CURRENT_PAGE = 1;

// --- State ---
let ALL = [];               // all harvested results (across clicked repos)
let CACHE = new Map();      // instName -> { items, online, info }
let SEARCH_TEXT = "";       // also supports a year embedded like 2021
let TYPE_FILTER = "";       // Thesis / Dissertation / All
let SELECTED_INSTITUTIONS = new Set(); // for multi-select filter

// --- Helpers ---
const $ = sel => document.querySelector(sel);
const create = (tag, cls) => { const el = document.createElement(tag); if (cls) el.className = cls; return el; };
const escape = s => (s || "").replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// Build OAI URL safely, preserving base, adding proper query
function oaiURL(base, params) {
  const u = new URL(base);
  // Ensure base is .../oai/request or .../server/oai/request already
  // Just append query params
  Object.entries(params).forEach(([k,v]) => u.searchParams.set(k, v));
  return u.toString();
}

async function proxyFetchText(url) {
  const res = await fetch(PROXY + encodeURIComponent(url));
  const text = await res.text();
  return { status: res.status, ok: res.ok, text, contentType: res.headers.get("content-type") || "" };
}

function pick(node, tag) {
  return Array.from(node.getElementsByTagNameNS("*", tag)).map(n => (n.textContent || "").trim());
}

function isThesis(types = [], description = "") {
  const hay = (types.join(" ") + " " + description).toLowerCase();
  return /thesis|dissertation|doctoral|masters|m\.?sc|ph\.?d/.test(hay);
}

function bestLink(ids = []) {
  const http = ids.find(i => /^https?:\/\//i.test(i));
  if (http) return http;
  const handle = ids.find(i => /hdl\.handle\.net/i.test(i));
  if (handle) return "https://" + handle.replace(/^https?:\/\//i, "");
  const doi = ids.find(i => /^10\./.test(i));
  if (doi) return `https://doi.org/${doi}`;
  return "";
}

// --- Identify -> mark online/offline, attach info ---
async function identifyRepo(src) {
  const url = oaiURL(src.base, { verb: "Identify" });
  const { ok, status, text, contentType } = await proxyFetchText(url);
  const entry = CACHE.get(src.name) || { items: [], online: false, info: "" };

  if (!ok || !/xml|text\/xml/i.test(contentType)) {
    entry.online = false;
    entry.info = `Identify failed (HTTP ${status})`;
    CACHE.set(src.name, entry);
    return entry;
  }
  // basic parse
  try {
    const xml = new DOMParser().parseFromString(text, "text/xml");
    const repoName = pick(xml, "repositoryName")[0] || "";
    const baseURL  = pick(xml, "baseURL")[0] || "";
    entry.online = true;
    entry.info = `${repoName || src.name}\n${baseURL}`;
  } catch {
    entry.online = true; // still xml, assume OK
  }
  CACHE.set(src.name, entry);
  return entry;
}

// --- Harvest first page of ListRecords (lazy: on click) ---
async function harvestFirstPage(src) {
  const entry = CACHE.get(src.name) || { items: [], online: false, info: "" };
  if (!entry.online) return entry;

  if (entry.items && entry.items.length) return entry; // already harvested
  const url = oaiURL(src.base, { verb: "ListRecords", metadataPrefix: "oai_dc" });
  const { ok, status, text, contentType } = await proxyFetchText(url);

  if (!ok || !/xml|text\/xml/i.test(contentType)) {
    entry.info = `ListRecords failed (HTTP ${status})`;
    CACHE.set(src.name, entry);
    return entry;
  }

  const xml = new DOMParser().parseFromString(text, "text/xml");
  const recs = Array.from(xml.getElementsByTagNameNS("*", "record"));
  const items = [];

  for (const r of recs) {
    const md = r.getElementsByTagNameNS("*", "metadata")[0];
    if (!md) continue;

    const titles  = pick(md, "title");
    const creators= pick(md, "creator");
    const descs   = pick(md, "description");
    const subjects= pick(md, "subject");
    const types   = pick(md, "type");
    const dates   = pick(md, "date");
    const ids     = pick(md, "identifier");

    const description = descs[0] || "";
    // Keep only thesis-like
    if (!isThesis(types, description)) continue;

    items.push({
      title: titles[0] || "(Untitled)",
      creators, description, subjects, types,
      date: dates[0] || "",
      link: bestLink(ids),
      institution: src.name, country: src.country
    });
  }

  entry.items = items;
  CACHE.set(src.name, entry);
  return entry;
}

// ---------------- UI BUILD ----------------

async function buildCards() {
  const grid = $("#repoGrid");
  grid.innerHTML = "";

  // identify all (in parallel)
  await Promise.all(SOURCES.map(src => identifyRepo(src)));

  SOURCES.forEach(src => {
    const entry = CACHE.get(src.name) || { online:false, items: [] };

    const card = create("div", "repo-card" + (entry.online ? "" : " offline"));
    card.dataset.name = src.name;

    const logo = create("img", "repo-logo");
    logo.alt = `${src.name} logo`;
    logo.src = logos[src.name] || logos["_default"];

    const title = create("h3");
    title.textContent = src.name;

    const country = create("div", "repo-country");
    country.textContent = src.country;

    const pill = create("span", "status " + (entry.online ? "ok" : "no"));
    pill.textContent = entry.online ? "Online" : "Offline";

    const btn = create("button", "view-btn");
    btn.textContent = "View records";
    btn.disabled = !entry.online;

    const msg = create("div", "repo-msg");
    if (!entry.online && entry.info) msg.textContent = entry.info;

    btn.addEventListener("click", async () => {
      // lazy harvest
      const spinner = create("div", "mini-spinner");
      btn.replaceWith(spinner);
      const data = await harvestFirstPage(src);
      spinner.replaceWith(btn);
      if (!data.items?.length) {
        msg.textContent = data.info || "No thesis records found on first page.";
      }
      // mark selected inst
      SELECTED_INSTITUTIONS.clear();
      SELECTED_INSTITUTIONS.add(src.name);
      // merge items into ALL without duplicates
      const mk = new Map(ALL.map(i => [i.link || (i.title + "|" + i.institution + "|" + i.date), i]));
      data.items.forEach(i => {
        const key = i.link || (i.title + "|" + i.institution + "|" + i.date);
        mk.set(key, i);
      });
      ALL = Array.from(mk.values());
      CURRENT_PAGE = 1;
      renderResults();
      window.scrollTo({ top: $("#results").offsetTop - 20, behavior: "smooth" });
    });

    card.append(logo, title, country, pill, btn, msg);
    grid.appendChild(card);
  });
}

function filteredPool() {
  let pool = ALL.slice();

  // institution filter (multi-select)
  if (SELECTED_INSTITUTIONS.size) {
    pool = pool.filter(i => SELECTED_INSTITUTIONS.has(i.institution));
  }

  // type filter
  if (TYPE_FILTER && TYPE_FILTER !== "All") {
    pool = pool.filter(i => (i.types || []).some(t => new RegExp(TYPE_FILTER, "i").test(t)));
  }

  // combined search/year
  if (SEARCH_TEXT) {
    const yrMatch = SEARCH_TEXT.match(/\b(19|20)\d{2}\b/);
    const yr = yrMatch ? yrMatch[0] : "";
    const q = SEARCH_TEXT.toLowerCase();

    pool = pool.filter(it => {
      const t = (it.title || "").toLowerCase();
      const d = (it.description || "").toLowerCase();
      const a = (it.creators || []).join(" ").toLowerCase();
      const s = (it.subjects || []).join(" ").toLowerCase();
      const inst = (it.institution || "").toLowerCase();
      const year = (it.date || "").slice(0,4);

      const textOK = t.includes(q) || d.includes(q) || a.includes(q) || s.includes(q) || inst.includes(q);
      const yearOK = !yr || year === yr;
      return textOK && yearOK;
    });
  }

  return pool;
}

function renderResults() {
  const mount = $("#results");
  mount.innerHTML = "";

  const pool = filteredPool();
  const totalPages = Math.max(1, Math.ceil(pool.length / PAGE_SIZE));
  CURRENT_PAGE = Math.min(CURRENT_PAGE, totalPages);
  const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
  const items = pool.slice(start, start + PAGE_SIZE);

  if (!items.length) {
    mount.innerHTML = `<div class="empty">No results found.</div>`;
  } else {
    items.forEach(it => {
      const card = create("div", "item-card");
      const meta = create("div", "meta");
      meta.innerHTML = `
        <span class="tag">DSpace • ${escape(it.institution)}</span>
        ${it.date ? `<span class="sep">•</span><span><strong>Year:</strong> ${escape(it.date.slice(0,4))}</span>` : ""}
        ${(it.types && it.types[0]) ? `<span class="sep">•</span><span><strong>Type:</strong> ${escape(it.types[0])}</span>` : ""}
      `;

      const title = create("h4");
      title.textContent = it.title;

      const authors = (it.creators && it.creators.length) ? `<div class="authors"><strong>Authors:</strong> ${escape(it.creators.join(", "))}</div>` : "";

      const desc = create("p");
      desc.textContent = (it.description || "").slice(0, 280) + ((it.description || "").length > 280 ? "…" : "");

      const link = it.link ? `<p><a href="${escape(it.link)}" target="_blank" rel="noopener">View Record ↗</a></p>` : "";

      card.innerHTML = "";
      card.append(meta, title);
      if (authors) card.insertAdjacentHTML("beforeend", authors);
      card.append(desc);
      if (link) card.insertAdjacentHTML("beforeend", link);
      mount.appendChild(card);
    });
  }

  // pagination
  const p = $("#pagination");
  const info = $("#pageInfo");
  if (pool.length <= PAGE_SIZE) {
    p.classList.add("hidden");
  } else {
    p.classList.remove("hidden");
    info.textContent = `Page ${CURRENT_PAGE} of ${totalPages}`;
    $("#prevPage").disabled = CURRENT_PAGE <= 1;
    $("#nextPage").disabled = CURRENT_PAGE >= totalPages;
  }
}

// ------------- Controls ---------------

function bindControls() {
  // multi-select dropdown
  const instSel = $("#institutionSelect");
  instSel.innerHTML = "";
  SOURCES.forEach(s => {
    const opt = create("option");
    opt.value = s.name;
    opt.textContent = s.name;
    instSel.appendChild(opt);
  });

  $("#applyInst").addEventListener("click", () => {
    const picks = Array.from(instSel.selectedOptions).map(o => o.value);
    SELECTED_INSTITUTIONS = new Set(picks);
    CURRENT_PAGE = 1;
    renderResults();
  });
  $("#clearInst").addEventListener("click", () => {
    SELECTED_INSTITUTIONS.clear();
    instSel.selectedIndex = -1;
    CURRENT_PAGE = 1;
    renderResults();
  });

  $("#typeFilter").addEventListener("change", e => {
    TYPE_FILTER = e.target.value;
    CURRENT_PAGE = 1;
    renderResults();
  });

  $("#pageSize").addEventListener("change", e => {
    PAGE_SIZE = parseInt(e.target.value || PAGE_SIZE_DEFAULT, 10);
    CURRENT_PAGE = 1;
    renderResults();
  });

  const searchBox = $("#searchBox");
  searchBox.addEventListener("input", e => { SEARCH_TEXT = e.target.value.trim(); CURRENT_PAGE = 1; renderResults(); });
  searchBox.addEventListener("keypress", e => { if (e.key === "Enter") { SEARCH_TEXT = searchBox.value.trim(); CURRENT_PAGE = 1; renderResults(); } });

  $("#prevPage").addEventListener("click", () => { if (CURRENT_PAGE > 1) { CURRENT_PAGE--; renderResults(); } });
  $("#nextPage").addEventListener("click", () => { CURRENT_PAGE++; renderResults(); });
}

// ------------- Logos (loaded via logos.json) -------------
let logos = {"_default":"https://upload.wikimedia.org/wikipedia/commons/1/15/SA_Open_Access_Logo.png"}; // fallback
async function loadLogos() {
  try {
    const res = await fetch("logos.json", { cache: "no-store" });
    const data = await res.json();
    logos = data || logos;
  } catch {}
}

// ------------- Boot -------------
async function boot() {
  await loadLogos();
  bindControls();
  await buildCards();
}
document.addEventListener("DOMContentLoaded", boot);
</script>
