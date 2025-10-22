
const PROXY = "https://thesesdissertations.archiverepo1.workers.dev/?url=";

// ===== Verified South African DSpace OAI-PMH Repositories =====
const DSPACE_ENDPOINTS = [
  { name: "University of Cape Town (UCT)", url: "https://open.uct.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "Stellenbosch University (SUNScholar)", url: "https://scholar.sun.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of Pretoria (UPSpace)", url: "https://repository.up.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "Wits (WIReDSpace)", url: "https://wiredspace.wits.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "North-West University (NWU)", url: "https://repository.nwu.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of KwaZulu-Natal (UKZN)", url: "https://researchspace.ukzn.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of the Free State (UFS)", url: "https://scholar.ufs.ac.za/server/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of the Western Cape (UWC)", url: "https://etd.uwc.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of Johannesburg (UJ)", url: "https://ujcontent.uj.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "Rhodes University (RU / SEALS iKamva)", url: "https://vital.seals.ac.za/vital/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "Central University of Technology (CUT)", url: "https://cutscholar.cut.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" },
  { name: "University of South Africa (UNISA)", url: "https://uir.unisa.ac.za/oai/request?verb=ListRecords&metadataPrefix=oai_dc", country: "South Africa" }
];

// ====== Core Variables ======
const PAGE_SIZE_DEFAULT = 100;
let PAGE_SIZE = PAGE_SIZE_DEFAULT;
let SEARCH_TEXT = "";
let CURRENT_PAGE = 1;
let SELECTED_INSTITUTIONS = new Set();
let INST_CACHE = new Map();
let LOGOS = {};
let TYPE_FILTER = "All";
let YEAR_FILTER = "";

// ====== Utilities ======
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const nowStamp = () => new Date().toLocaleString();

function pick(node, tag) {
  return Array.from(node.getElementsByTagNameNS("*", tag)).map((n) => (n.textContent || "").trim());
}

function isThesisLike(types = [], desc = "") {
  const hay = (types.join(" ") + " " + desc).toLowerCase();
  return /thesis|dissertation|doctoral|masters|phd|m\.sc|m\s?thesis|dphil/.test(hay);
}

function bestLink(identifiers = []) {
  const http = identifiers.find((i) => i.startsWith("http"));
  if (http) return http;
  const handle = identifiers.find((i) => i.includes("hdl.handle.net"));
  if (handle) return "https://" + handle.replace(/^https?:\/\//, "");
  const doi = identifiers.find((i) => /^10\./.test(i));
  if (doi) return `https://doi.org/${doi}`;
  return "";
}

// ===== Fetch Logo File =====
async function loadLogos() {
  try {
    const res = await fetch("logos.json");
    LOGOS = await res.json();
  } catch (e) {
    console.error("⚠️ Unable to load logos.json", e);
  }
}

// ====== Repository Fetch ======
async function fetchInstitution(inst) {
  const url = inst.url;
  try {
    const res = await fetch(PROXY + encodeURIComponent(url));
    const text = await res.text();
    const xml = new DOMParser().parseFromString(text, "text/xml");

    const records = Array.from(xml.getElementsByTagNameNS("*", "record"));
    if (!records.length) throw new Error("No records returned");

    const items = records.map((r) => {
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

    console.log(`✅ ${inst.name}: ${items.length} theses`);
    return { items, online: true };
  } catch (e) {
    console.warn(`⚠️ ${inst.name} repository seems offline or blocked`);
    return { items: [], online: false };
  }
}

// ===== Spinner =====
function fadeOutSpinner() {
  const spinner = document.getElementById("loadingSpinner");
  if (spinner) spinner.classList.add("fade-out");
  setTimeout(() => spinner?.remove(), 700);
}

// ===== Filters & Events =====
function buildFilters() {
  const instSelect = document.getElementById("institutionFilter");
  instSelect.innerHTML = `<option value="">All</option>` + DSPACE_ENDPOINTS.map(i => `<option value="${i.name}">${i.name}</option>`).join("");
  instSelect.addEventListener("change", (e) => {
    const val = e.target.value;
    SELECTED_INSTITUTIONS = val ? new Set([val]) : new Set();
    CURRENT_PAGE = 1;
    render();
  });

  const typeSel = document.getElementById("typeFilter");
  typeSel.addEventListener("change", (e) => {
    TYPE_FILTER = e.target.value;
    CURRENT_PAGE = 1;
    render();
  });

  const searchBox = document.getElementById("searchInput");
  searchBox.addEventListener("input", (e) => {
    SEARCH_TEXT = e.target.value.toLowerCase();
    CURRENT_PAGE = 1;
    render();
  });
  searchBox.addEventListener("keypress", (e) => {
    if (e.key === "Enter") render();
  });

  const yearBox = document.getElementById("yearFilter");
  yearBox.addEventListener("input", (e) => {
    YEAR_FILTER = e.target.value;
    CURRENT_PAGE = 1;
    render();
  });
}

// ===== Search & Filter Logic =====
function filteredItems() {
  let pool = [];
  INST_CACHE.forEach((items, name) => {
    if (!SELECTED_INSTITUTIONS.size || SELECTED_INSTITUTIONS.has(name)) pool.push(...items);
  });

  return pool.filter(it => {
    const t = (it.title || "").toLowerCase();
    const d = (it.description || "").toLowerCase();
    const a = (it.creators || []).join(" ").toLowerCase();
    const s = (it.subjects || []).join(" ").toLowerCase();
    const inst = (it.institution || "").toLowerCase();
    const y = (it.date || "").substring(0, 4);

    const textOK = !SEARCH_TEXT || t.includes(SEARCH_TEXT) || d.includes(SEARCH_TEXT) || a.includes(SEARCH_TEXT) || s.includes(SEARCH_TEXT) || inst.includes(SEARCH_TEXT);
    const typeOK = TYPE_FILTER === "All" || (it.types.join(" ").toLowerCase().includes(TYPE_FILTER.toLowerCase()));
    const yearOK = !YEAR_FILTER || y === YEAR_FILTER;
    return textOK && typeOK && yearOK;
  });
}

// ===== Render Cards =====
function render() {
  const results = document.getElementById("results");
  results.innerHTML = "";

  const items = filteredItems();
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  CURRENT_PAGE = Math.min(CURRENT_PAGE, totalPages);
  const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);

  if (!pageItems.length) {
    results.innerHTML = `<div class="loading">No results found.</div>`;
  } else {
    pageItems.forEach(it => {
      const card = document.createElement("div");
      card.className = "card";
      const subjBadges = (it.subjects || []).slice(0, 5).map(s => `<span class="badge">${s}</span>`).join(" ");
      card.innerHTML = `
        <div class="source-tag">DSpace • ${it.institution}</div>
        <h3>${it.title}</h3>
        <div class="meta">
          ${it.creators?.length ? `<strong>Authors:</strong> ${it.creators.join(", ")}` : ""}
          ${it.date ? ` • <strong>Year:</strong> ${it.date.substring(0, 4)}` : ""}
          ${it.types?.length ? ` • <strong>Type:</strong> ${it.types[0]}` : ""}
        </div>
        <p>${(it.description || "").slice(0, 250)}${(it.description || "").length > 250 ? "…" : ""}</p>
        ${subjBadges ? `<div class="badges">${subjBadges}</div>` : ""}
        ${it.link ? `<p><a href="${it.link}" target="_blank" rel="noopener">View Record ↗</a></p>` : ""}
      `;
      results.appendChild(card);
    });
  }

  fadeOutSpinner();
}

// ===== Institution Grid =====
async function renderInstitutions() {
  const grid = document.getElementById("institutionGrid");
  grid.innerHTML = "";
  for (const inst of DSPACE_ENDPOINTS) {
    const div = document.createElement("div");
    div.className = "inst-card";
    const logo = LOGOS[inst.name] || LOGOS._default;
    div.innerHTML = `
      <img src="${logo}" alt="${inst.name} logo" class="inst-logo">
      <h4>${inst.name}</h4>
      <p>${inst.country}</p>
      <span class="status" id="status-${inst.name.replace(/\W+/g, '')}">Checking…</span>
    `;
    div.addEventListener("click", () => {
      SELECTED_INSTITUTIONS = new Set([inst.name]);
      render();
    });
    grid.appendChild(div);

    // Check repository status
    fetchInstitution(inst).then(({ items, online }) => {
      const statusEl = document.getElementById(`status-${inst.name.replace(/\W+/g, '')}`);
      if (online) {
        statusEl.textContent = "Online";
        statusEl.classList.add("online");
        INST_CACHE.set(inst.name, items);
      } else {
        statusEl.textContent = "Offline";
        statusEl.classList.add("offline");
      }
    });
    await delay(150);
  }
}

// ===== Main Load =====
async function load() {
  await loadLogos();
  buildFilters();
  renderInstitutions();
}

document.addEventListener("DOMContentLoaded", load);
