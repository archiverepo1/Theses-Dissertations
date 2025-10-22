
const PROXY = "https://inquirybase.archiverepo1.workers.dev/?url=";
const PAGE_SIZE_DEFAULT = 100;

const SOURCES = [
  // DSpace 7 (OAI available)
  { name: "University of Cape Town (UCT)", country: "South Africa",
    home: "https://open.uct.ac.za/",
    oai:  "https://open.uct.ac.za/server/oai/request",
    type: "dspace" },
  { name: "Stellenbosch University (SUNScholar)", country: "South Africa",
    home: "https://scholar.sun.ac.za/",
    oai:  "https://scholar.sun.ac.za/server/oai/request",
    type: "dspace" },
  { name: "University of Pretoria (UPSpace)", country: "South Africa",
    home: "https://repository.up.ac.za/",
    oai:  "https://repository.up.ac.za/server/oai/request",
    type: "dspace" },
  { name: "Wits (WIReDSpace)", country: "South Africa",
    home: "https://wiredspace.wits.ac.za/",
    oai:  "https://wiredspace.wits.ac.za/server/oai/request",
    type: "dspace" },
  { name: "North-West University (NWU)", country: "South Africa",
    home: "https://repository.nwu.ac.za/",
    oai:  "https://repository.nwu.ac.za/server/oai/request",
    type: "dspace" },
  { name: "University of KwaZulu-Natal (UKZN)", country: "South Africa",
    home: "https://researchspace.ukzn.ac.za/",
    oai:  "https://researchspace.ukzn.ac.za/server/oai/request",
    type: "dspace" },
  { name: "University of the Free State (UFS)", country: "South Africa",
    home: "https://scholar.ufs.ac.za/",
    oai:  "https://scholar.ufs.ac.za/server/oai/request",
    type: "dspace" },
  { name: "University of the Western Cape (UWC)", country: "South Africa",
    home: "https://uwcscholar.uwc.ac.za/",
    oai:  "https://uwcscholar.uwc.ac.za/server/oai/request",
    type: "dspace" },
  { name: "University of South Africa (UNISA)", country: "South Africa",
    home: "https://uir.unisa.ac.za/",
    oai:  "https://uir.unisa.ac.za/server/oai/request",
    type: "dspace" },
  { name: "Central University of Technology (CUT)", country: "South Africa",
    home: "https://cutscholar.cut.ac.za/",
    oai:  "https://cutscholar.cut.ac.za/server/oai/request",
    type: "dspace" },
  { name: "Cape Peninsula University of Technology (CPUT)", country: "South Africa",
    home: "https://etd.cput.ac.za/",
    oai:  "https://etd.cput.ac.za/server/oai/request",
    type: "dspace" },

  // Unknown/Non-DSpace currently (listed, not harvested)
  { name: "University of Johannesburg (UJ)", country: "South Africa",
    home: "https://ujcontent.uj.ac.za/esploro/",
    oai:  "",
    type: "external", externalNote: "Esploro (Clarivate) – search on site" },

  { name: "Rhodes University (RU / SEALS iKamva)", country: "South Africa",
    home: "https://vital.seals.ac.za/",
    oai:  "", type: "external", externalNote: "SEALS / Vital – search on site" },

  { name: "Nelson Mandela University (NMU)", country: "South Africa",
    home: "https://commons.mandela.ac.za/",
    oai:  "", type: "external", externalNote: "Non-DSpace – search on site" },

  { name: "Durban University of Technology (DUT)", country: "South Africa",
    home: "https://openscholar.dut.ac.za/",
    oai:  "", type: "external", externalNote: "Non-DSpace – search on site" }
];

// Global state
let LOGOS = {};
let PAGE_SIZE = PAGE_SIZE_DEFAULT;
let SEARCH_TEXT = "";
let CURRENT_PAGE = 1;
let SELECTED_INSTITUTIONS = new Set(); // via cards or dropdown
let ALL_RECORDS = []; // unified pool
const CACHE = new Map(); // name -> { online, items, checked }

// Utils
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const trim = (s) => (s || "").trim();
const pick = (node, tag) =>
  Array.from(node.getElementsByTagNameNS("*", tag)).map(n => trim(n.textContent || ""));

// Hero animation
function initHeroBg() {
  const canvas = document.getElementById("heroBg");
  const ctx = canvas.getContext("2d");
  let w, h, pts;
  const resize = () => {
    w = canvas.width = window.innerWidth;
    h = canvas.height = 260;
    pts = Array.from({ length: 60 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - .5) * .6, vy: (Math.random() - .5) * .6
    }));
  };
  resize(); window.addEventListener("resize", resize);
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#cde3ff";
    pts.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
    });
    ctx.strokeStyle = "rgba(205,227,255,.2)";
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
        if (Math.sqrt(dx*dx + dy*dy) < 100) {
          ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
        }
      }
    requestAnimationFrame(draw);
  };
  draw();
}

// Health check (Identify)
async function checkIdentify(oaiBase) {
  try {
    const url = `${oaiBase}?verb=Identify`;
    const res = await fetch(PROXY + encodeURIComponent(url), { method: "GET" });
    if (!res.ok) return false;
    const xmlText = await res.text();
    return /<Identify/i.test(xmlText);
  } catch {
    return false;
  }
}

// Harvest first page (ListRecords oai_dc)
async function harvestFirstPage(source, typeFilter) {
  const out = [];
  try {
    const url = `${source.oai}?verb=ListRecords&metadataPrefix=oai_dc`;
    const res = await fetch(PROXY + encodeURIComponent(url));
    if (!res.ok) return out;
    const text = await res.text();
    const xml = new DOMParser().parseFromString(text, "text/xml");
    const recs = Array.from(xml.getElementsByTagNameNS("*", "record"));
    recs.forEach(r => {
      const md = r.getElementsByTagNameNS("*", "metadata")[0];
      if (!md) return;
      const titles = pick(md, "title");
      const creators = pick(md, "creator");
      const descs = pick(md, "description");
      const subjects = pick(md, "subject");
      const types = pick(md, "type");
      const dates = pick(md, "date");
      const ids = pick(md, "identifier");

      const title = titles[0] || "(Untitled)";
      const description = descs[0] || "";
      const joinTypes = types.join(" ").toLowerCase();

      let looksLike = /thesis|dissertation|doctoral|masters|phd|m\.?sc|m\s?thesis|dphil/.test(
        (types.join(" ") + " " + description).toLowerCase()
      );
      if (typeFilter === "thesis") looksLike = looksLike && /thesis|masters|m\.?sc|m\s?thesis/.test(joinTypes);
      if (typeFilter === "dissertation") looksLike = looksLike && /dissertation|phd|doctoral|dphil/.test(joinTypes);
      if (!looksLike && typeFilter) return; // stricter if user selected a type

      // best link
      const http = ids.find(i => /^https?:\/\//i.test(i)) || ids.find(i => /hdl\.handle\.net/i.test(i));
      const doi = ids.find(i => /^10\./.test(i));
      const link = http || (doi ? `https://doi.org/${doi}` : "");

      out.push({
        title,
        creators,
        description,
        subjects,
        types,
        date: dates[0] || "",
        link,
        institution: source.name,
        country: source.country
      });
    });
  } catch {
    // ignore
  }
  return out;
}

// Build dropdown & cards
function populateInstitutionFilter() {
  const sel = document.getElementById("institutionFilter");
  sel.innerHTML = "";
  SOURCES.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.name; opt.textContent = s.name;
    sel.appendChild(opt);
  });
}

function logoFor(name) {
  const src = LOGOS[name] || LOGOS._default || "";
  return src;
}

function drawInstCards() {
  const mount = document.getElementById("instCards");
  mount.innerHTML = "";
  SOURCES.forEach(src => {
    const card = document.createElement("div");
    card.className = "inst-card";
    const logo = document.createElement("img");
    logo.className = "inst-logo";
    logo.src = logoFor(src.name);
    logo.alt = `${src.name} logo`;
    logo.onerror = () => { logo.src = LOGOS._default; };

    const meta = document.createElement("div");
    meta.className = "inst-meta";
    const h = document.createElement("h3");
    h.className = "inst-name"; h.textContent = src.name;
    const p = document.createElement("p");
    p.className = "inst-country"; p.textContent = src.country;

    const badge = document.createElement("span");
    badge.className = "badge"; badge.textContent = "Checking…";

    meta.appendChild(h); meta.appendChild(p);
    card.appendChild(logo); card.appendChild(meta); card.appendChild(badge);
    mount.appendChild(card);

    if (src.type === "dspace" && src.oai) {
      // status check async
      checkIdentify(src.oai).then(ok => {
        badge.textContent = ok ? "Online" : "Offline";
        card.classList.toggle("offline", !ok);
        const cache = CACHE.get(src.name) || {};
        CACHE.set(src.name, { ...cache, online: ok, checked: true });
      }).catch(() => {
        badge.textContent = "Offline";
        card.classList.add("offline");
        const cache = CACHE.get(src.name) || {};
        CACHE.set(src.name, { ...cache, online: false, checked: true });
      });
    } else {
      badge.textContent = "External";
      card.classList.add("offline");
      const cache = CACHE.get(src.name) || {};
      CACHE.set(src.name, { ...cache, online: false, checked: true });
    }

    // click to select + fetch if needed
    card.addEventListener("click", async () => {
      toggleInstitutionSelection(src.name);
      await ensureHarvestSelected();
      render();
      document.getElementById("results").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

// Selection logic
function toggleInstitutionSelection(name) {
  if (SELECTED_INSTITUTIONS.has(name)) SELECTED_INSTITUTIONS.delete(name);
  else SELECTED_INSTITUTIONS.add(name);

  // reflect in <select multiple>
  const sel = document.getElementById("institutionFilter");
  Array.from(sel.options).forEach(o => {
    if (SELECTED_INSTITUTIONS.size === 0) {
      o.selected = false;
    } else {
      o.selected = SELECTED_INSTITUTIONS.has(o.value);
    }
  });
}

// Prefetch logic
async function ensureHarvestSelected() {
  const typeFilter = (document.getElementById("typeFilter").value || "").toLowerCase();
  const toHarvest = SOURCES.filter(s =>
    (SELECTED_INSTITUTIONS.size === 0 || SELECTED_INSTITUTIONS.has(s.name)) &&
    s.type === "dspace" && s.oai
  );

  for (const src of toHarvest) {
    const cache = CACHE.get(src.name) || {};
    if (cache.items) continue; // already harvested
    // Only harvest if online
    if (cache.checked && cache.online === false) continue;

    const items = await harvestFirstPage(src, typeFilter);
    CACHE.set(src.name, { ...cache, items });
  }

  // merge unified pool of selected only
  ALL_RECORDS = [];
  CACHE.forEach((v, k) => {
    if (SELECTED_INSTITUTIONS.size === 0 || SELECTED_INSTITUTIONS.has(k)) {
      if (v.items && v.items.length) ALL_RECORDS.push(...v.items);
    }
  });
}

// Filtering + render
function filteredItems() {
  const text = (SEARCH_TEXT || "").toLowerCase();
  const year = (text.match(/\b(19|20)\d{2}\b/) || [])[0] || "";
  const typeFilter = (document.getElementById("typeFilter").value || "").toLowerCase();

  return ALL_RECORDS.filter(it => {
    const t = (it.title || "").toLowerCase();
    const d = (it.description || "").toLowerCase();
    const a = (it.creators || []).join(" ").toLowerCase();
    const s = (it.subjects || []).join(" ").toLowerCase();
    const inst = (it.institution || "").toLowerCase();
    const y = (it.date || "").substring(0, 4);

    const textOK = !text || t.includes(text) || d.includes(text) || a.includes(text) || s.includes(text) || inst.includes(text);
    const yearOK = !year || y === year;

    let typeOK = true;
    if (typeFilter === "thesis") typeOK = /thesis|masters|m\.?sc|m\s?thesis/.test((it.types || []).join(" ").toLowerCase());
    if (typeFilter === "dissertation") typeOK = /dissertation|phd|doctoral|dphil/.test((it.types || []).join(" ").toLowerCase());

    return textOK && yearOK && typeOK;
  });
}

function render() {
  const mount = document.getElementById("results");
  mount.innerHTML = "";
  const items = filteredItems();
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  CURRENT_PAGE = Math.min(CURRENT_PAGE, totalPages);
  const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);

  if (!pageItems.length) {
    const div = document.createElement("div");
    div.className = "loading";
    div.textContent = SELECTED_INSTITUTIONS.size ? "No results found." : "Select one or more institutions above to view records.";
    mount.appendChild(div);
  } else {
    pageItems.forEach(it => {
      const card = document.createElement("div");
      card.className = "card";
      const badges = (it.subjects || []).slice(0, 6).map(s => `<span class="badge">${s}</span>`).join(" ");
      card.innerHTML = `
        <div class="badge">DSpace • ${it.institution}</div>
        <h3>${it.title}</h3>
        <div class="meta">
          ${it.creators?.length ? `<strong>Authors:</strong> ${it.creators.join(", ")}` : ""}
          ${it.date ? ` • <strong>Year:</strong> ${it.date.substring(0,4)}` : ""}
          ${it.types?.length ? ` • <strong>Type:</strong> ${it.types[0]}` : ""}
        </div>
        <p>${(it.description || "").slice(0, 260)}${(it.description || "").length > 260 ? "…" : ""}</p>
        ${badges ? `<div style="margin-top:.4rem">${badges}</div>` : ""}
        ${it.link ? `<p><a href="${it.link}" target="_blank" rel="noopener">View Record ↗</a></p>` : ""}
      `;
      mount.appendChild(card);
    });
  }

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

// “Found in another repo” hint (exact title matches)
function crossRepoHintIfNeeded() {
  const q = (SEARCH_TEXT || "").trim();
  if (!q || q.length < 6) return;
  const lower = q.toLowerCase();
  const matches = [];
  CACHE.forEach((v, k) => {
    (v.items || []).forEach(it => {
      if ((it.title || "").toLowerCase() === lower) matches.push({ repo: k, title: it.title });
    });
  });
  if (matches.length) {
    const repos = Array.from(new Set(matches.map(m => m.repo)));
    if (SELECTED_INSTITUTIONS.size && !repos.some(r => SELECTED_INSTITUTIONS.has(r))) {
      alert(`This title was found in: ${repos.join(", ")}.\nYour current selection does not include that repository.`);
    }
  }
}

// Events
function bindControls() {
  document.getElementById("pageSizeSelect").addEventListener("change", e => {
    PAGE_SIZE = parseInt(e.target.value, 10) || PAGE_SIZE_DEFAULT;
    CURRENT_PAGE = 1; render();
  });

  document.getElementById("typeFilter").addEventListener("change", async () => {
    // reharvest selected with the type filter applied
    // clear cached items to force re-filter from source page
    Array.from(SELECTED_INSTITUTIONS).forEach(name => {
      const c = CACHE.get(name);
      if (c) c.items = null;
    });
    await ensureHarvestSelected();
    CURRENT_PAGE = 1; render();
  });

  const sel = document.getElementById("institutionFilter");
  sel.addEventListener("change", async () => {
    SELECTED_INSTITUTIONS = new Set(Array.from(sel.selectedOptions).map(o => o.value));
    await ensureHarvestSelected();
    CURRENT_PAGE = 1; render();
  });

  const searchBox = document.getElementById("searchInput");
  searchBox.addEventListener("input", async e => {
    SEARCH_TEXT = e.target.value;
    CURRENT_PAGE = 1; render();
    crossRepoHintIfNeeded();
  });
  searchBox.addEventListener("keypress", e => {
    if (e.key === "Enter") { SEARCH_TEXT = e.target.value; CURRENT_PAGE = 1; render(); crossRepoHintIfNeeded(); }
  });

  document.getElementById("prevPage").addEventListener("click", () => {
    if (CURRENT_PAGE > 1) { CURRENT_PAGE--; render(); }
  });
  document.getElementById("nextPage").addEventListener("click", () => {
    CURRENT_PAGE++; render();
  });
}

// Main
async function load() {
  initHeroBg();

  try {
    const logosRes = await fetch("logos.json");
    LOGOS = await logosRes.json();
  } catch { LOGOS = { _default: "https://upload.wikimedia.org/wikipedia/commons/1/15/SA_Open_Access_Logo.png" }; }

  populateInstitutionFilter();
  drawInstCards();
  bindControls();

  document.getElementById("loadingSpinner")?.remove();

  // Precheck online status quietly; harvest only after selection
  for (const src of SOURCES) {
    if (src.type === "dspace" && src.oai) {
      if (!CACHE.has(src.name)) CACHE.set(src.name, {});
      // Identify already performed on card mount
      await delay(80);
    } else {
      if (!CACHE.has(src.name)) CACHE.set(src.name, {});
    }
  }

  render();
}

document.addEventListener("DOMContentLoaded", load);
