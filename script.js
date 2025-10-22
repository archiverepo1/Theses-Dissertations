
const PROXY = "https://inquirybase.archiverepo1.workers.dev/?url=";

/* DSpace endpoints (root; we will append ?verb=...) */
const INSTITUTIONS = [
  { name: "University of Cape Town (UCT)",           country:"South Africa", base:"https://open.uct.ac.za/server/oai/request" },
  { name: "Stellenbosch University (SUNScholar)",    country:"South Africa", base:"https://scholar.sun.ac.za/server/oai/request" }, // fixed
  { name: "University of Pretoria (UPSpace)",        country:"South Africa", base:"https://repository.up.ac.za/server/oai/request" },
  { name: "Wits (WIReDSpace)",                       country:"South Africa", base:"https://wiredspace.wits.ac.za/server/oai/request" },
  { name: "North-West University (NWU)",             country:"South Africa", base:"https://repository.nwu.ac.za/server/oai/request" },
  { name: "University of KwaZulu-Natal (UKZN)",      country:"South Africa", base:"https://researchspace.ukzn.ac.za/server/oai/request" },
  { name: "University of the Free State (UFS)",      country:"South Africa", base:"https://scholar.ufs.ac.za/server/oai/request" },
  { name: "University of the Western Cape (UWC)",    country:"South Africa", base:"https://etd.uwc.ac.za/server/oai/request" },
  { name: "University of South Africa (UNISA)",      country:"South Africa", base:"https://uir.unisa.ac.za/server/oai/request" },
  { name: "Cape Peninsula University of Technology (CPUT)", country:"South Africa", base:"https://etd.cput.ac.za/server/oai/request" },
  { name: "Central University of Technology (CUT)",  country:"South Africa", base:"https://cutscholar.cut.ac.za/server/oai/request" }
];

/* State */
let ALL_RECORDS = [];   
let CURRENT_PAGE = 1;
let PAGE_SIZE = 100;
let TYPE_FILTER = "";   
let SEARCH_TEXT = "";
let YEAR_FILTER = "";   

/* Helpers */
const $ = (id) => document.getElementById(id);
const q = (sel) => document.querySelector(sel);
const resultsEl = $("results");

function buildUrl(base, params) {
  const qs = new URLSearchParams(params);
  return `${base}?${qs.toString()}`;
}
async function getText(url) {
  const res = await fetch(PROXY + encodeURIComponent(url));
  return await res.text();
}
function xmlPick(nsRoot, tag) {
  return Array.from(nsRoot.getElementsByTagNameNS("*", tag)).map(n => (n.textContent || "").trim());
}
function pickLink(identifiers = []) {
  const http = identifiers.find(i => i.startsWith("http"));
  if (http) return http;
  const handle = identifiers.find(i => i.includes("hdl.handle.net"));
  if (handle) return handle.startsWith("http") ? handle : `https://${handle}`;
  const doi = identifiers.find(i => /^10\./.test(i));
  if (doi) return `https://doi.org/${doi}`;
  return "";
}
function looksThesis(types = [], desc = "") {
  const hay = (types.join(" ") + " " + desc).toLowerCase();
  return /thesis|dissertation|doctoral|masters|m\.?sc|mphil|dphil|ph\.?d/.test(hay);
}

/* UI: hero background */
(function initHeroBg(){
  const cvs = $("heroBg"); const ctx = cvs.getContext("2d");
  let W, H, pts;
  function resize() {
    W = cvs.width = window.innerWidth; H = cvs.height = 260;
    pts = Array.from({length:60},()=>({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.6,vy:(Math.random()-.5)*.6}));
  }
  function draw(){
    ctx.clearRect(0,0,W,H); ctx.fillStyle="#cde3ff";
    pts.forEach(p=>{
      p.x+=p.vx; p.y+=p.vy; if(p.x<0||p.x>W)p.vx*=-1; if(p.y<0||p.y>H)p.vy*=-1;
      ctx.beginPath(); ctx.arc(p.x,p.y,2,0,Math.PI*2); ctx.fill();
    });
    ctx.strokeStyle="rgba(205,227,255,.2)";
    for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++){
      const dx=pts[i].x-pts[j].x, dy=pts[i].y-pts[j].y, d=Math.hypot(dx,dy);
      if(d<100){ ctx.beginPath(); ctx.moveTo(pts[i].x,pts[i].y); ctx.lineTo(pts[j].x,pts[j].y); ctx.stroke(); }
    }
    requestAnimationFrame(draw);
  }
  resize(); window.addEventListener("resize", resize); draw();
})();

/* UI: build institution tiles (logos only) */
async function loadLogos() {
  const resp = await fetch("logos.json");
  return await resp.json();
}

async function renderInstitutionGrid() {
  const logos = await loadLogos();
  const grid = $("instGrid");
  grid.innerHTML = "";
  INSTITUTIONS.forEach(inst => {
    const card = document.createElement("div");
    card.className = "inst-card";
    card.title = `${inst.name} • Click to view`;
    card.tabIndex = 0;

    const logoUrl = logos[inst.name] || logos._default;
    const img = document.createElement("img");
    img.alt = `${inst.name} logo`;
    img.src = logoUrl;
    img.onerror = () => {
      img.remove();
      const fb = document.createElement("div");
      fb.className = "fallback";
      fb.textContent = inst.name;
      card.appendChild(fb);
    };
    card.appendChild(img);

    card.addEventListener("click", () => handleInstitutionClick(inst));
    card.addEventListener("keypress", (e) => { if (e.key === "Enter") handleInstitutionClick(inst); });
    grid.appendChild(card);
  });
}

/* Harvest: OAI ListRecords (first N pages on demand) */
async function fetchOAIPage(base, resumptionToken=null) {
  const params = resumptionToken
    ? { verb: "ListRecords", resumptionToken }
    : { verb: "ListRecords", metadataPrefix: "oai_dc" };
  const url = buildUrl(base, params);
  const xmlText = await getText(url);

  const xml = new DOMParser().parseFromString(xmlText, "text/xml");
  const errors = Array.from(xml.getElementsByTagNameNS("*", "error"));
  if (errors.length) throw new Error(errors[0].textContent || "OAI error");

  const recs = Array.from(xml.getElementsByTagNameNS("*", "record"));
  const tokenNode = xml.getElementsByTagNameNS("*", "resumptionToken")[0];
  const nextToken = tokenNode ? tokenNode.textContent.trim() : null;

  const items = recs.map(r => {
    const md = r.getElementsByTagNameNS("*", "metadata")[0];
    if (!md) return null;
    const titles = xmlPick(md, "title");
    const creators = xmlPick(md, "creator");
    const descs = xmlPick(md, "description");
    const subjects = xmlPick(md, "subject");
    const types = xmlPick(md, "type").map(t=>t.toLowerCase());
    const dates = xmlPick(md, "date");
    const ids = xmlPick(md, "identifier");

    const desc = descs[0] || "";
    // Only theses/dissertations by default unless user set All
    const passType = !TYPE_FILTER
      ? looksThesis(types, desc)
      : types.some(t => t.includes(TYPE_FILTER));

    const date = dates.find(d=>/^\d{4}/.test(d)) || dates[0] || "";
    const year = date ? (date.match(/\d{4}/)?.[0] || "") : "";

    if (!passType) return null;
    if (YEAR_FILTER && year !== YEAR_FILTER) return null;

    return {
      title: titles[0] || "(Untitled)",
      creators,
      description: desc,
      subjects,
      types,
      date,
      link: pickLink(ids)
    };
  }).filter(Boolean);

  return { items, nextToken };
}

/* UX helpers */
function spinner(message="Fetching records…") {
  resultsEl.innerHTML = `
    <div class="card" style="grid-column:1/-1; text-align:center;">
      <div style="font-weight:700; margin-bottom:.4rem">${message}</div>
      <div style="opacity:.7">This may take a few seconds…</div>
    </div>`;
  $("pagination").classList.add("hidden");
}
function clearResults() { resultsEl.innerHTML = ""; }

/* Render paginated cards */
function renderRecords(records, headingText) {
  ALL_RECORDS = records;
  CURRENT_PAGE = 1;
  const totalPages = Math.max(1, Math.ceil(ALL_RECORDS.length / PAGE_SIZE));
  if (!ALL_RECORDS.length) {
    resultsEl.innerHTML = `<div class="card" style="grid-column:1/-1;">
      <strong>No results found.</strong>
      <div style="margin-top:.35rem; color:#555">Try a different keyword or click a university logo to harvest its theses.</div>
    </div>`;
    $("pagination").classList.add("hidden");
    return;
  }
  const titleCard = document.createElement("div");
  titleCard.className = "card";
  titleCard.style.gridColumn = "1/-1";
  titleCard.innerHTML = `<strong>${headingText}</strong> · ${ALL_RECORDS.length} records`;
  resultsEl.innerHTML = "";
  resultsEl.appendChild(titleCard);

  function drawPage() {
    const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
    const pageItems = ALL_RECORDS.slice(start, start + PAGE_SIZE);
    Array.from(resultsEl.querySelectorAll(".result")).forEach(n=>n.remove());
    pageItems.forEach(it => {
      const el = document.createElement("div");
      el.className = "card result";
      const subjects = (it.subjects || []).slice(0,6).map(s=>`<span class="badge">${s}</span>`).join(" ");
      el.innerHTML = `
        <h3>${it.title}</h3>
        <div class="meta">
          ${it.creators?.length ? `<strong>Authors:</strong> ${it.creators.join(", ")}` : ""}
          ${it.date ? ` · <strong>Year:</strong> ${it.date.match(/\d{4}/)?.[0] || it.date}` : ""}
          ${it.types?.length ? ` · <strong>Type:</strong> ${it.types[0]}` : ""}
        </div>
        <p>${(it.description || "").slice(0,280)}${(it.description || "").length>280?"…":""}</p>
        ${subjects ? `<div class="badges">${subjects}</div>`:""}
        ${it.link ? `<p><a href="${it.link}" target="_blank" rel="noopener">View Record ↗</a></p>`:""}
      `;
      resultsEl.appendChild(el);
    });
    // pagination
    const p = $("pagination");
    const info = $("pageInfo");
    if (ALL_RECORDS.length <= PAGE_SIZE) { p.classList.add("hidden"); return; }
    p.classList.remove("hidden");
    info.textContent = `Page ${CURRENT_PAGE} of ${totalPages}`;
    $("prevPage").disabled = CURRENT_PAGE <= 1;
    $("nextPage").disabled = CURRENT_PAGE >= totalPages;
  }
  drawPage();
  $("prevPage").onclick = ()=>{ if (CURRENT_PAGE>1){ CURRENT_PAGE--; renderRecords(ALL_RECORDS, headingText);} };
  $("nextPage").onclick = ()=>{ const totalPages=Math.ceil(ALL_RECORDS.length/PAGE_SIZE); if (CURRENT_PAGE<totalPages){ CURRENT_PAGE++; renderRecords(ALL_RECORDS, headingText);} };
}

/* Actions */
async function handleInstitutionClick(inst) {
  PAGE_SIZE = parseInt($("pageSizeSelect").value,10) || 100;
  TYPE_FILTER = ($("typeSelect").value || "").toLowerCase();
  const term = $("searchInput").value.trim();
  YEAR_FILTER = (term.match(/\b(\d{4})\b/) || [,""])[1]; // 4-digit token used as year if present

  spinner(`Fetching ${inst.name}…`);
  try {
    // Identify check (quiet)
    await getText(buildUrl(inst.base, { verb:"Identify" }));
  } catch(e) {
    resultsEl.innerHTML = `<div class="card" style="grid-column:1/-1;">
      <strong>${inst.name}</strong> appears <em>unreachable</em> right now.
      <div style="margin-top:.35rem;color:#555">Please try again later or contact the repository owner.</div>
    </div>`;
    $("pagination").classList.add("hidden");
    return;
  }

  // Harvest first 2 pages (quick, snappy)
  const collected = [];
  let token = null;
  for (let i=0;i<2;i++){
    const { items, nextToken } = await fetchOAIPage(inst.base, token);
    // term search across fields (if a term is given)
    const t = term.toLowerCase();
    const filtered = !t ? items : items.filter(it=>{
      const hay = [
        it.title||"",
        (it.creators||[]).join(" "),
        it.description||"",
        (it.subjects||[]).join(" ")
      ].join(" ").toLowerCase();
      return hay.includes(t);
    });
    collected.push(...filtered);
    if (!nextToken) break;
    token = nextToken;
  }
  renderRecords(collected, inst.name);
}

async function runSearchAll() {
  PAGE_SIZE = parseInt($("pageSizeSelect").value,10) || 100;
  TYPE_FILTER = ($("typeSelect").value || "").toLowerCase();
  const term = $("searchInput").value.trim();
  SEARCH_TEXT = term.toLowerCase();
  YEAR_FILTER = (term.match(/\b(\d{4})\b/) || [,""])[1];

  if (!term) {
    clearResults();
    return;
  }
  spinner(`Searching across ${INSTITUTIONS.length} repositories…`);

  const combined = [];
  for (const inst of INSTITUTIONS) {
    try {
      // quick pass: first page only for search
      const { items } = await fetchOAIPage(inst.base, null);
      const matches = items.filter(it=>{
        const hay = [
          it.title||"",
          (it.creators||[]).join(" "),
          it.description||"",
          (it.subjects||[]).join(" ")
        ].join(" ").toLowerCase();
        return hay.includes(SEARCH_TEXT);
      }).map(x => ({...x, _inst:inst.name}));
      combined.push(...matches);
    } catch (e) {
      // ignore individual repo failure during global search
    }
  }
  renderRecords(combined, `Search results`);
}

/* Wire controls */
function wireControls() {
  $("pageSizeSelect").addEventListener("change", ()=>{ if (ALL_RECORDS.length) renderRecords(ALL_RECORDS, "Results"); });
  $("typeSelect").addEventListener("change", ()=>{
    // re-run last action: if we have results, refilter with type; else do nothing
    if (ALL_RECORDS.length) {
      // force user to re-search or click again (data needs re-harvest by type)
      runSearchAll();
    }
  });
  $("searchBtn").addEventListener("click", runSearchAll);
  $("searchInput").addEventListener("keypress", e => { if (e.key === "Enter") runSearchAll(); });
}

/* Init */
async function init() {
  wireControls();
  await renderInstitutionGrid();
  clearResults(); // nothing until user acts
}
document.addEventListener("DOMContentLoaded", init);
