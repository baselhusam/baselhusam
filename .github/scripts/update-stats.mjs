// Refreshes the download / pull numbers in README.md straight from the public
// registries (npm, PyPI via Pepy, Docker Hub, GHCR, Grafana, GitHub Releases).
//
// Every source's last good count is kept in .github/stats.json. Lifetime
// counters only ever grow, so:
//   - a source that fails keeps its previous count, and
//   - a source that reports less than before (a cache, a stale mirror) is
//     ignored in favour of the higher, previously verified count.
// The README can therefore never regress or blank because a third party
// misbehaves.
//
// Only text between marker comments is rewritten:
//   <!-- stats:total -->…<!-- /stats:total -->                → "46K+"
//   <!-- stats:<project-id> -->…<!-- /stats:<project-id> -->  → badge(s)

import { readFile, writeFile } from "node:fs/promises";

const README = new URL("../../README.md", import.meta.url);
const STATE = new URL("../stats.json", import.meta.url);
const OWNER = "baselhusam";

// Same projects and sources as the "OS Downloads" card on baselhusam.com.
const PROJECTS = [
  { id: "daily-hub", repo: "daily-hub", npm: "@baselhusam/daily-hub", docker: "daily-hub", ghcr: "daily-hub" },
  { id: "icy-tower", repo: "icy-tower-reloaded", npm: "icy-tower-reloaded" },
  { id: "cvfuzz", repo: "CVFuzz", pypi: "cvfuzz" },
  { id: "visionstyle", repo: "visionstyle", pypi: "visionstyle" },
  { id: "qdrant", repo: "qdrant_exporter", docker: "qdrant-exporter", ghcr: "qdrant-exporter", grafana: "25152" },
  { id: "open-webui", repo: "open-webui-exporter", docker: "open-webui-exporter", ghcr: "open-webui-exporter", grafana: "25557" },
  { id: "damj", repo: "damj", pypi: "damj", docker: "damj" },
  { id: "streamlit-arabic", repo: "streamlit_arabic_support_wrapper", pypi: "streamlit-arabic-support-wrapper" },
  { id: "bareai", repo: "bareai-cli", releases: true },
];

// Grafana dashboard installs only get their own badge past this floor.
const DASHBOARD_FLOOR = 250;

// ---------------------------------------------------------------- fetching

async function get(url, json = true) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      "User-Agent": "baselhusam-profile-readme (+https://github.com/baselhusam)",
      Accept: json ? "application/json" : "text/html",
      ...(json && process.env.GITHUB_TOKEN && url.startsWith("https://api.github.com/")
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json ? res.json() : res.text();
}

function valid(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("not a valid count");
  return n;
}

const day = (d) => d.toISOString().slice(0, 10);

async function npmTotal(pkg) {
  const meta = await get(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`);
  const created = meta.time?.created?.slice(0, 10);
  const { end } = await get(`https://api.npmjs.org/downloads/point/last-month/${pkg}`);
  if (!created || !end) throw new Error("npm dates missing");
  // npm caps one query at 18 months: sum non-overlapping yearly chunks.
  let cursor = new Date(`${created}T00:00:00Z`);
  let total = 0;
  while (day(cursor) <= end) {
    const stop = new Date(cursor);
    stop.setUTCDate(stop.getUTCDate() + 364);
    const until = day(stop) < end ? day(stop) : end;
    const part = await get(`https://api.npmjs.org/downloads/point/${day(cursor)}:${until}/${pkg}`);
    total += valid(part.downloads);
    cursor = new Date(`${until}T00:00:00Z`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return total;
}

function objectAt(text, start) {
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("incomplete project data");
}

async function pepyTotal(pkg) {
  // Pepy's project page embeds the exact lifetime total in its Next.js stream.
  const html = await get(`https://pepy.tech/projects/${pkg}`, false);
  for (const m of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)) {
    let stream;
    try { stream = JSON.parse(m[1]); } catch { continue; }
    const text = stream[1];
    if (typeof text !== "string") continue;
    const at = text.indexOf('"project":{');
    if (at < 0) continue;
    const data = objectAt(text, at + '"project":'.length);
    if (data.name === pkg) return valid(data.totalDownloads);
  }
  throw new Error("exact count not found on Pepy");
}

async function ghcrTotal(repo, pkg) {
  const html = await get(`https://github.com/${OWNER}/${repo}/pkgs/container/${pkg}`, false);
  const m = html.match(/Total downloads<\/span>\s*<h3\b[^>]*title="([\d,]+)"/i);
  if (!m) throw new Error("GHCR counter not found");
  return valid(Number(m[1].replaceAll(",", "")));
}

async function releasesTotal(repo) {
  let total = 0;
  for (let page = 1; ; page++) {
    const releases = await get(`https://api.github.com/repos/${OWNER}/${repo}/releases?per_page=100&page=${page}`);
    for (const r of releases) for (const a of r.assets ?? []) total += valid(a.download_count);
    if (releases.length < 100) return total;
  }
}

function sources(p) {
  const list = [];
  if (p.npm) list.push({ key: `${p.id}:npm`, kind: "npm", load: () => npmTotal(p.npm) });
  if (p.pypi) list.push({ key: `${p.id}:pypi`, kind: "pypi", load: () => pepyTotal(p.pypi) });
  if (p.docker) list.push({
    key: `${p.id}:dockerhub`, kind: "dockerhub",
    load: async () => valid((await get(`https://hub.docker.com/v2/repositories/${OWNER}/${p.docker}/`)).pull_count),
  });
  if (p.ghcr) list.push({ key: `${p.id}:ghcr`, kind: "ghcr", load: () => ghcrTotal(p.repo, p.ghcr) });
  if (p.grafana) list.push({
    key: `${p.id}:grafana`, kind: "grafana",
    load: async () => valid((await get(`https://grafana.com/api/dashboards/${p.grafana}`)).downloads),
  });
  if (p.releases) list.push({ key: `${p.id}:releases`, kind: "releases", load: () => releasesTotal(p.repo) });
  return list;
}

async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

// ---------------------------------------------------------------- formatting

/** 10808 → "10.8K", 1002 → "1K", 688 → "688". */
function compact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

/** 46526 → "46K+" — rounded down so the claim is always true. */
const floorK = (n) => (n >= 1000 ? `${Math.floor(n / 1000)}K+` : `${n}+`);

function badge({ label, value, color, logo, alt }) {
  const enc = (s) => encodeURIComponent(s).replace(/-/g, "--");
  const src = `https://img.shields.io/badge/${enc(label)}-${enc(value)}-${color}?style=flat-square&logo=${logo}&logoColor=white`;
  return `<a href="https://baselhusam.com"><img src="${src}" alt="${alt}" /></a>`;
}

const PACKAGE = new Set(["npm", "pypi"]);
const CONTAINER = new Set(["dockerhub", "ghcr"]);
const STYLE = {
  npm: ["npm", "CB3837"], pypi: ["pypi", "3775A9"],
  dockerhub: ["docker", "2496ED"], ghcr: ["docker", "2496ED"],
};

function badgesFor(entries) {
  const sum = (set) => entries.filter((e) => set.has(e.kind)).reduce((a, e) => a + e.total, 0);
  const packages = sum(PACKAGE);
  const containers = sum(CONTAINER);
  const dashboards = sum(new Set(["grafana"]));
  const out = [];
  if (packages + containers > 0) {
    const label = packages === 0 ? "pulls" : "downloads";
    const lead = entries
      .filter((e) => PACKAGE.has(e.kind) || CONTAINER.has(e.kind))
      .sort((a, b) => b.total - a.total)[0].kind;
    const [logo, color] = STYLE[lead];
    out.push(badge({ label, value: compact(packages + containers), color, logo, alt: label }));
  }
  if (dashboards >= DASHBOARD_FLOOR) {
    out.push(badge({ label: "Grafana installs", value: compact(dashboards), color: "F46800", logo: "grafana", alt: "Grafana dashboard installs" }));
  }
  return out.join(" ");
}

// ---------------------------------------------------------------- main

let state = {};
try { state = JSON.parse(await readFile(STATE, "utf8")); } catch { /* first run */ }

const perProject = new Map();
let live = 0, kept = 0, failed = 0;

await Promise.all(PROJECTS.map(async (project) => {
  const entries = [];
  for (const source of sources(project)) {
    const previous = state[source.key]?.total ?? 0;
    let total = previous;
    try {
      const fetched = await withRetry(source.load);
      if (fetched >= previous) {
        total = fetched;
        live++;
      } else {
        kept++;
        console.warn(`${source.key}: source reported ${fetched} < verified ${previous}; keeping ${previous}`);
      }
    } catch (error) {
      failed++;
      console.warn(`${source.key}: ${error.message}; keeping ${previous}`);
    }
    if (total > 0) {
      entries.push({ kind: source.kind, total });
      if (total !== previous) state[source.key] = { total, checkedAt: new Date().toISOString() };
    }
  }
  perProject.set(project.id, entries);
}));

const total = [...perProject.values()].flat().reduce((a, e) => a + e.total, 0);
console.log(`sources: ${live} live, ${kept} kept (lower), ${failed} failed · total ${total}`);
if (total <= 0) {
  console.warn("Nothing usable — leaving README unchanged.");
  process.exit(0);
}

let readme = await readFile(README, "utf8");
const before = readme;
readme = readme.replace(
  /(<!-- stats:([\w-]+) -->)([\s\S]*?)(<!-- \/stats:\2 -->)/g,
  (match, open, id, _body, close) => {
    if (id === "total") return `${open}${floorK(total)}${close}`;
    const entries = perProject.get(id);
    const html = entries?.length ? badgesFor(entries) : "";
    return html ? `${open}${html}${close}` : match;
  }
);

const sorted = Object.fromEntries(Object.entries(state).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(STATE, `${JSON.stringify(sorted, null, 2)}\n`);
if (readme !== before) {
  await writeFile(README, readme);
  console.log("README updated.");
} else {
  console.log("README numbers unchanged.");
}
