
const PROXY = "https://inquirybase.archiverepo1.workers.dev/?url=";

// DSpace OAI endpoints (Identify: base + ?verb=Identify)
// Use /server/oai for DSpace 7; /oai for older instances
const SOURCES = [
  {
    name: "University of Cape Town (UCT)",
    country: "South Africa",
    base: "https://open.uct.ac.za/oai/request",
    dspace: true
  },
  {
    name: "Stellenbosch University (SUNScholar)",
    country: "South Africa",
    base: "https://scholar.sun.ac.za/oai/request",
    dspace: true
  },
  {
    name: "University of Pretoria (UPSpace)",
    country: "South Africa",
    base: "https://repository.up.ac.za/server/oai/request",
    dspace: true
  },
  {
    name: "Wits (WIReDSpace)",
    country: "South Africa",
    base: "https://wiredspace.wits.ac.za/server/oai/request",
    dspace: true
  },
  {
    name: "North-West University (NWU)",
    country: "South Africa",
    base: "https://repository.nwu.ac.za/server/oai/request",
    dspace: true
  },
  {
    name: "University of KwaZulu-Natal (UKZN)",
    country: "South Africa",
    base: "https://researchspace.ukzn.ac.za/server/oai/request",
    dspace: true
  },
  {
    name: "University of the Free State (UFS)",
    country: "South Africa",
    base: "https://scholar.ufs.ac.za/server/oai/request",
    dspace: true
  },
  {
    name: "University of the Western Cape (UWC)",
    country: "South Africa",
    base: "https://uwcscholar.uwc.ac.za/server/oai/request",
    dspace: true
  },
  {
    name: "University of South Africa (UNISA)",
    country: "South Africa",
    base: "https://uir.unisa.ac.za/server/oai/request",
    dspace: true
  },
  {
    name: "Central University of Technology (CUT)",
    country: "South Africa",
    base: "https://cutscholar.cut.ac.za/server/oai/request",
    dspace: true
  },
  {
    name: "Cape Peninsula University of Technology (CPUT)",
    country: "South Africa",
    base: "https://etd.cput.ac.za/server/oai/request",
    dspace: true
  },
  {
    // Non-DSpace (Esploro) – card shown but harvesting disabled
    name: "University of Johannesburg (UJ)",
    country: "South Africa",
    base: "https://ujcontent.uj.ac.za/",
    dspace: false
  },
  {
    name: "Rhodes University (RU / SEALS iKamva)",
    country: "South Africa",
    base: "https://vital.seals.ac.za/oai/request",
    dspace: true
  }
];

// State
let LOGOS = {};
let ONLINE = new Map();  // name -> {online:boolean, msg:string}
let CACHE = new Map();   // name -> harvested items (first page)
let ALL = [];            // current result pool
let CURRENT_PAGE = 1;
let PAGE_SIZE = 100;

// Utilities
const sleep = ms => new Promise(r => setTimeout(r, ms));

function xmlPick(node, tag) {
  return Array.from(node.getElementsByTagNameNS("*", tag)).map(n => (n.textContent || "").trim());
}
function isThesisLike(types = [], desc = "", wantType = "") {
  const hay = (types.join(" ") + " " + desc).toLowerCase();
  const isTD = /thesis|dissertation|doctoral|masters|m\.sc|dphil/.test(hay);
  if (!wantType) return isTD;
  if (wantType === "thesis") return /thesis/.test(hay);
  if (wantType === "dissertation") return /dissertation/.test(hay);
  return isTD;
}
function bestLink(ids = []) {
  const http = ids.find(i => /^https?:\/\//i.test(i));
  if (http) return http;
  const handle = ids.find(i => /hdl\.handle\.net/i.test(i));
  if (handle) return handle.startsWith("http") ? handle : "https://" + handle;
  const doi = ids.find(i => /^10\./.test(i));
  if (doi) return `https://doi.org/${doi}`;
  return "";
}

// Proxy fetch with timeout
async function gfetch(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(PROXY + encodeURIComponent(url), { signal: controller.signal });
  clearTimeout(to);
  const text = await res.text();
  return { status: res.status, text };
}

// Identify each repository quickly
async function identifyRepo(src) {
  if (!src.dspace) {
    ONLINE.set(src.name, { online: false, msg: "Non-DSpace (coming soon)" });
    return;
  }
  const idUrl = `${src.base}?verb=Identify`;
  try {
    const { status, text } = await gfetch(idUrl, 9000);
    const ok = status >= 200 && status < 500 && /Identify|OAI-PMH/i.test(text);
    ONLINE.set(src.name, { online: ok, msg: ok ? "Online" : "Offline" });
  } catch (e) {
    ONLINE.set(src.name, { online: false, msg: "Timeout/Proxy" });
  }
}

// Harvest one page
async function harvestFirstPage(src, wantType = "", searchText = "", searchYear = "") {
  if (!src.dspace) return [];
  const url = `${src.base}?verb=ListRecords&metadataPrefix=oai_dc`;
  try {
    const { text } = await gfetch(url, 12000);
    const xml = new DOMParser().parseFromString(text, "text/xml");
    const recs = Array.from(xml.getElementsByTagNameNS("*", "record"));
    const items = [];
    recs.forEach(r => {
      const md = r.getElementsByTagNameNS("*", "metadata")[0];
      if (!md) return;

      const titles = xmlPick(md, "title");
      const creators = xmlPick(md, "creator");
      const descs = xmlPick(md, "description");
      const subjects = xmlPick(md, "subject");
      const types = xmlPick(md, "type");
      const dates = xmlPick(md, "date");
      const ids = xmlPick(md, "identifier");

      const title = titles[0] || "(Untitled)";
      const description = descs[0] || "";
      const year = (dates[0] || "").substring(0, 4);
      if (!isThesisLike(types, description, wantType)) return;

      // simple search filter
      const t = (title + " " + description + " " + creators.join(" ") + " " + subjects.join(" ")).toLowerCase();
      const okText = !searchText || t.includes(searchText);
      const okYear = !searchYear || year === searchYear;
      if (!okText || !okYear) return;

      items.push({
        title,
        creators,
        description,
        subjects,
        types,
        year,
        link: bestLink(ids),
        institution: src.name,
        country: src.country
      });
    });
    return items;
  } catch {
    return [];
  }
}

// Render repo tiles
function renderRepos() {
  const grid = document.getElementById("repoGrid");
  grid.innerHTML = "";
  SOURCES.forEach(src => {
    const status = ONLINE.get(src.name) || { online: false, msg: "…" };
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.name = src.name;

    const img = document.createElement("img");
    img.className = "logo";
    img.alt = `${src.name} logo`;
    img.src = LOGOS[src.name] || LOGOS._default;
    img.onerror = () => (img.src = LOGOS._default);

    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = src.name;
    const country = document.createElement("div");
    country.className = "country";
    country.textContent = src.country;

    const badge = document.createElement("span");
    badge.className = "badge" + (status.online ? "" : " off");
    badge.textContent = status.online ? "Online" : status.msg || "Offline";

    meta.appendChild(title);
    meta.appendChild(country);
    card.appendChild(img);
    card.appendChild(meta);
    card.appendChild(badge);

    if (!status.online) {
      card.style.opacity = ".7";
      card.style.cursor = "not-allowed";
    } else {
      card.addEventListener("click", async () => {
        document.getElementById("instSelect").value = src.name;
        await runSearch(); // harvest and show results
        window.scrollTo({ top: grid.offsetTop + grid.offsetHeight, behavior: "smooth" });
      });
    }

    grid.appendChild(card);
  });
}

// Render results
function renderResults(items) {
  const mount = document.getElementById("results");
  mount.innerHTML = "";
  if (!items.length) {
    mount.innerHTML = `<div class="card-result"><strong>No results found.</strong></div>`;
    updatePagination(0, 0);
    return;
  }
  const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);

  pageItems.forEach(it => {
    const el = document.createElement("div");
    el.className = "card-result";
    const subj = (it.subjects || []).slice(0, 6).map(s => `<span class="tag">${s}</span>`).join(" ");
    el.innerHTML = `
      <div class="meta">DSpace • ${it.institution}</div>
      <h3>${it.title}</h3>
      <div class="meta">
        ${it.creators?.length ? `<strong>Authors:</strong> ${it.creators.join(", ")}` : ""}
        ${it.year ? ` • <strong>Year:</strong> ${it.year}` : ""}
        ${it.types?.length ? ` • <strong>Type:</strong> ${it.types[0]}` : ""}
      </div>
      <p>${(it.description || "").slice(0, 260)}${(it.description || "").length > 260 ? "…" : ""}</p>
      ${subj ? `<div class="badges">${subj}</div>` : ""}
      ${it.link ? `<p><a href="${it.link}" target="_blank" rel="noopener">View Record ↗</a></p>` : ""}
    `;
    mount.appendChild(el);
  });

  updatePagination(CURRENT_PAGE, Math.max(1, Math.ceil(items.length / PAGE_SIZE)));
}

function updatePagination(page, total) {
  const wrap = document.getElementById("pagination");
  const info = document.getElementById("pageInfo");
  if (total <= 1) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  info.textContent = `Page ${page} of ${total}`;
  document.getElementById("prevPage").disabled = page <= 1;
  document.getElementById("nextPage").disabled = page >= total;
}

// Search runner
async function runSearch() {
  const inst = document.getElementById("instSelect").value;
  const type = document.getElementById("typeSelect").value;       // "", "thesis", "dissertation"
  PAGE_SIZE = parseInt(document.getElementById("pageSize").value, 10) || 100;

  const raw = (document.getElementById("searchBox").value || "").trim();
  const yearMatch = raw.match(/\b(19|20)\d{2}\b/);
  const searchYear = yearMatch ? yearMatch[0] : "";
  const searchText = raw.toLowerCase();

  const onlineList = SOURCES.filter(s => (ONLINE.get(s.name)?.online));
  const chosen = inst ? onlineList.filter(s => s.name === inst) : onlineList;

  // Use cache where available; otherwise harvest first page
  const results = [];
  for (const src of chosen) {
    let items = CACHE.get(src.name);
    if (!items) {
      items = await harvestFirstPage(src, type, "", ""); // pre-harvest without search to cache
      CACHE.set(src.name, items);
      await sleep(120); // polite
    }
    // Apply search filters on cached items
    const filtered = items.filter(it => {
      const t = (it.title + " " + it.description + " " + (it.creators||[]).join(" ") + " " + (it.subjects||[]).join(" ")).toLowerCase();
      const okText = !searchText || t.includes(searchText);
      const okYear = !searchYear || it.year === searchYear;
      const okType = !type || isThesisLike(it.types || [], it.description || "", type);
      return okText && okYear && okType;
    });
    results.push(...filtered);
  }

  ALL = results;
  CURRENT_PAGE = 1;
  renderResults(ALL);
}

// Populate controls
function populateControls() {
  const sel = document.getElementById("instSelect");
  SOURCES.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
}

// Hero background
function initHero() {
  const canvas = document.getElementById("heroBg");
  const ctx = canvas.getContext("2d");
  let w, h, pts;
  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = 260;
    pts = Array.from({ length: 60 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - .5) * .6, vy: (Math.random() - .5) * .6
    }));
  }
  resize();
  window.addEventListener("resize", resize);
  (function draw(){
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = "#cde3ff";
    pts.forEach(p=>{
      p.x+=p.vx;p.y+=p.vy;
      if(p.x<0||p.x>w)p.vx*=-1;
      if(p.y<0||p.y>h)p.vy*=-1;
      ctx.beginPath();ctx.arc(p.x,p.y,2,0,Math.PI*2);ctx.fill();
    });
    ctx.strokeStyle="rgba(205,227,255,.2)";
    for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++){
      const dx=pts[i].x-pts[j].x,dy=pts[i].y-pts[j].y;
      if(Math.hypot(dx,dy)<100){ctx.beginPath();ctx.moveTo(pts[i].x,pts[i].y);ctx.lineTo(pts[j].x,pts[j].y);ctx.stroke();}
    }
    requestAnimationFrame(draw);
  })();
}

// Main
async function boot() {
  initHero();
  populateControls();

  // Load logos.json
  try {
    const resp = await fetch("logos.json");
    LOGOS = await resp.json();
  } catch { LOGOS = { _default: "https://upload.wikimedia.org/wikipedia/commons/1/15/SA_Open_Access_Logo.png" }; }

  // Identify all repositories (in parallel but shown immediately)
  await Promise.allSettled(SOURCES.map(identifyRepo));
  renderRepos();

  // Wire controls
  document.getElementById("pageSize").addEventListener("change", () => { CURRENT_PAGE = 1; renderResults(ALL); });
  document.getElementById("prevPage").addEventListener("click", () => { if (CURRENT_PAGE > 1) { CURRENT_PAGE--; renderResults(ALL); } });
  document.getElementById("nextPage").addEventListener("click", () => { CURRENT_PAGE++; renderResults(ALL); });

  // Run search on Enter or when leaving input (mobile)
  const searchBox = document.getElementById("searchBox");
  searchBox.addEventListener("keypress", e => { if (e.key === "Enter") runSearch(); });
  searchBox.addEventListener("change", runSearch);
  document.getElementById("instSelect").addEventListener("change", runSearch);
  document.getElementById("typeSelect").addEventListener("change", runSearch);

  // Initial: show nothing in results until user searches/clicks
  ALL = [];
  renderResults(ALL);
}

document.addEventListener("DOMContentLoaded", boot);
