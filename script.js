// =================
// SA ETD Harvester - FIXED
// =================

const PROXY = "https://theses-dissertations.archiverepo1.workers.dev/?url=";
const PAGE_SIZE_DEFAULT = 100;

const SOURCES = [
  { name: "University of Cape Town (UCT)", country: "South Africa", oai: "https://open.uct.ac.za/server/oai/request", type: "dspace" },
  { name: "Stellenbosch University (SUNScholar)", country: "South Africa", oai: "https://scholar.sun.ac.za/server/oai/request", type: "dspace" },
  { name: "University of Pretoria (UPSpace)", country: "South Africa", oai: "https://repository.up.ac.za/server/oai/request", type: "dspace" },
  { name: "Wits (WIReDSpace)", country: "South Africa", oai: "https://wiredspace.wits.ac.za/server/oai/request", type: "dspace" },
  { name: "North-West University (NWU)", country: "South Africa", oai: "https://repository.nwu.ac.za/server/oai/request", type: "dspace" },
  { name: "University of KwaZulu-Natal (UKZN)", country: "South Africa", oai: "https://researchspace.ukzn.ac.za/server/oai/request", type: "dspace" },
  { name: "University of the Free State (UFS)", country: "South Africa", oai: "https://scholar.ufs.ac.za/server/oai/request", type: "dspace" },
  { name: "University of the Western Cape (UWC)", country: "South Africa", oai: "https://uwcscholar.uwc.ac.za/server/oai/request", type: "dspace" },
  { name: "University of South Africa (UNISA)", country: "South Africa", oai: "https://uir.unisa.ac.za/server/oai/request", type: "dspace" },
  { name: "Central University of Technology (CUT)", country: "South Africa", oai: "https://cutscholar.cut.ac.za/server/oai/request", type: "dspace" },
  { name: "Cape Peninsula University of Technology (CPUT)", country: "South Africa", oai: "https://etd.cput.ac.za/server/oai/request", type: "dspace" }
];

let LOGOS = {};
let PAGE_SIZE = PAGE_SIZE_DEFAULT;
let SEARCH_TEXT = "";
let CURRENT_PAGE = 1;
let SELECTED_INST = new Set();
let ALL_RECORDS = [];
const CACHE = new Map();

const pick = (node, tag) => Array.from(node.getElementsByTagNameNS("*", tag)).map(n => n.textContent.trim());

async function checkIdentify(url) {
  url = url.trim();
  try {
    const res = await fetch(PROXY + encodeURIComponent(`${url}?verb=Identify`));
    if (!res.ok) return false;
    const txt = await res.text();
    return txt.includes("<Identify");
  } catch {
    return false;
  }
}

async function harvestFirst(url, typeFilter) {
  const items = [];
  url = url.trim();
  try {
    const res = await fetch(PROXY + encodeURIComponent(`${url}?verb=ListRecords&metadataPrefix=oai_dc`));
    if (!res.ok) return items;
    let txt = await res.text();

    // 🔥 Remove XML stylesheet declaration
    txt = txt.replace(/<\?xml-stylesheet[^?]*\?>/gi, '');

    const xml = new DOMParser().parseFromString(txt, "text/xml");
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
      const typeJoined = types.join(" ").toLowerCase();

      let good = /thesis|dissertation|doctoral|phd|masters/.test(typeJoined + " " + description.toLowerCase());
      if (typeFilter === "thesis") good = /thesis|masters/.test(typeJoined);
      if (typeFilter === "dissertation") good = /dissertation|phd|doctoral/.test(typeJoined);
      if (!good && typeFilter) return;

      const httpLink = ids.find(i => /^https?:\/\//i.test(i)) || ids.find(i => /hdl\.handle\.net/i.test(i));
      const doi = ids.find(i => /^10\./.test(i));
      const link = httpLink || (doi ? `https://doi.org/${doi}` : ""); // 🔥 Fixed spacing

      items.push({
        title, creators, description, subjects, types, date: dates[0] || "", link
      });
    });
  } catch (e) {
    console.warn("Harvest error", e);
  }
  return items;
}

function initHeroBg() {
  const canvas = document.getElementById("heroBg");
  const ctx = canvas.getContext("2d");
  let w, h, pts;
  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = 260;
    pts = Array.from({ length: 50 }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.5 }));
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
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  draw();
}

async function populate() {
  try {
    const resp = await fetch("logos.json");
    LOGOS = await resp.json();
  } catch {
    LOGOS = { _default: "https://upload.wikimedia.org/wikipedia/commons/1/15/SA_Open_Access_Logo.png" };
  }

  const selInst = document.getElementById("institutionFilter");
  SOURCES.forEach(src => {
    const opt = document.createElement("option");
    opt.value = src.name;
    opt.textContent = src.name;
    selInst.appendChild(opt);
    CACHE.set(src.name, { online: false, items: null, checked: false });
  });

  const instDiv = document.getElementById("instCards");
  for (const src of SOURCES) {
    const card = document.createElement("div");
    card.className = "inst-card";
    const img = document.createElement("img");
    img.className = "inst-logo";
    img.src = LOGOS[src.name] || LOGOS._default;
    img.alt = src.name + " logo";
    const meta = document.createElement("div");
    meta.className = "inst-meta";
    const h3 = document.createElement("h3");
    h3.className = "inst-name";
    h3.textContent = src.name;
    const p = document.createElement("p");
    p.className = "inst-country";
    p.textContent = src.country;
    meta.append(h3, p);
    card.append(img, meta);
    card.dataset.name = src.name;
    card.addEventListener("click", async () => {
      const name = src.name;
      if (SELECTED_INST.has(name)) SELECTED_INST.delete(name);
      else SELECTED_INST.add(name);
      selInst.value = null;
      Array.from(selInst.options).forEach(o => {
        o.selected = SELECTED_INST.has(o.value);
      });
      await harvestAndRender();
    });
    instDiv.append(card);
  }

  document.getElementById("typeFilter").addEventListener("change", harvestAndRender);
  document.getElementById("pageSizeSelect").addEventListener("change", e => {
    PAGE_SIZE = parseInt(e.target.value, 10) || PAGE_SIZE_DEFAULT;
    CURRENT_PAGE = 1;
    render();
  });
  document.getElementById("searchInput").addEventListener("input", e => {
    SEARCH_TEXT = e.target.value;
    CURRENT_PAGE = 1;
    render();
  });
  document.getElementById("institutionFilter").addEventListener("change", async e => {
    SELECTED_INST = new Set(Array.from(e.target.selectedOptions).map(o => o.value));
    await harvestAndRender();
  });
  document.getElementById("prevPage").addEventListener("click", () => {
    if (CURRENT_PAGE > 1) { CURRENT_PAGE--; render(); }
  });
  document.getElementById("nextPage").addEventListener("click", () => {
    CURRENT_PAGE++; render();
  });
}

async function harvestAndRender() {
  const typeFilter = document.getElementById("typeFilter").value.toLowerCase();
  ALL_RECORDS = [];
  for (const src of SOURCES) {
    if (SELECTED_INST.size === 0 || SELECTED_INST.has(src.name)) {
      const cache = CACHE.get(src.name);
      if (src.oai) {
        if (!cache.checked) {
          const ok = await checkIdentify(src.oai);
          cache.online = ok;
          cache.checked = true;
          CACHE.set(src.name, cache);
        }
        if (cache.online && !cache.items) {
          const items = await harvestFirst(src.oai, typeFilter);
          items.forEach(it => {
            it.institution = src.name;
            it.country = src.country;
          });
          cache.items = items;
          CACHE.set(src.name, cache);
        }
        if (cache.items) ALL_RECORDS.push(...cache.items);
      }
    }
  }
  CURRENT_PAGE = 1;
  render();
}

function filtered() {
  const text = (SEARCH_TEXT || "").toLowerCase();
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : "";
  const typeFilter = document.getElementById("typeFilter").value.toLowerCase();

  return ALL_RECORDS.filter(it => {
    const title = (it.title || "").toLowerCase();
    const desc = (it.description || "").toLowerCase();
    const authors = (it.creators || []).join(" ").toLowerCase();
    const subj = (it.subjects || []).join(" ").toLowerCase();
    const inst = (it.institution || "").toLowerCase();
    const dateY = (it.date || "").substring(0, 4);

    const matchesText = !text || title.includes(text) || desc.includes(text) || authors.includes(text) || subj.includes(text) || inst.includes(text);
    const matchesYear = !year || dateY === year;
    let matchesType = true;
    if (typeFilter === "thesis") matchesType = /thesis|masters/.test((it.types || []).join(" ").toLowerCase());
    if (typeFilter === "dissertation") matchesType = /dissertation|phd|doctoral/.test((it.types || []).join(" ").toLowerCase());

    return matchesText && matchesYear && matchesType;
  });
}

function render() {
  const mount = document.getElementById("results");
  mount.innerHTML = "";
  const items = filtered();
  const totalPages = Math.max(1, Math.ceil(items.length / (PAGE_SIZE || PAGE_SIZE_DEFAULT)));
  CURRENT_PAGE = Math.min(CURRENT_PAGE, totalPages);
  const start = (CURRENT_PAGE - 1) * (PAGE_SIZE || PAGE_SIZE_DEFAULT);
  const pageItems = items.slice(start, start + (PAGE_SIZE || PAGE_SIZE_DEFAULT));

  if (pageItems.length === 0) {
    const div = document.createElement("div");
    div.className = "loading";
    div.textContent = SELECTED_INST.size ? "No results found." : "Select one or more institutions above.";
    mount.append(div);
  } else {
    pageItems.forEach(it => {
      const card = document.createElement("div");
      card.className = "card";
      const year = it.date ? it.date.substring(0, 4) : "";
      const type = (it.types && it.types[0]) ? it.types[0] : "";
      card.innerHTML = `
        <div class="meta"><strong>${it.institution}</strong> • Year: ${year} • Type: ${type}</div>
        <h3>${it.title}</h3>
        <p>${(it.description || "").slice(0, 260)}${(it.description || "").length > 260 ? "…" : ""}</p>
        ${it.link ? `<p><a href="${it.link}" target="_blank" rel="noopener">View Record ↗</a></p>` : ""}
      `;
      mount.append(card);
    });
  }

  const pagination = document.getElementById("pagination");
  const info = document.getElementById("pageInfo");
  if (items.length <= (PAGE_SIZE || PAGE_SIZE_DEFAULT)) {
    pagination.classList.add("hidden");
  } else {
    pagination.classList.remove("hidden");
    info.textContent = `Page ${CURRENT_PAGE} of ${totalPages}`;
    document.getElementById("prevPage").disabled = (CURRENT_PAGE <= 1);
    document.getElementById("nextPage").disabled = (CURRENT_PAGE >= totalPages);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initHeroBg();
  populate();
});
