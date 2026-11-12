// Refreshes the download / pull numbers in README.md from the same live
// collector that powers the "OS Downloads" card on baselhusam.com, so the
// profile and the portfolio never disagree.
//
// It only rewrites text between marker comments:
//   <!-- stats:total -->…<!-- /stats:total -->          → "46K+"
//   <!-- stats:<project-id> -->…<!-- /stats:<project-id> --> → badge(s)
//
// If the endpoint is down or returns nothing usable, the README is left
// untouched and the script exits 0 — a third party being down must never
// blank the profile.

import { readFile, writeFile } from "node:fs/promises";

const ENDPOINT = "https://baselhusam.com/preview/downloads/bridge/api/metrics";
const README = new URL("../../README.md", import.meta.url);

// Grafana dashboard installs only get their own badge past this floor.
const DASHBOARD_FLOOR = 250;

const PACKAGE = new Set(["npm", "pypi"]);
const CONTAINER = new Set(["dockerhub", "ghcr"]);

async function fetchMetrics() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        headers: { Accept: "application/json", "User-Agent": "baselhusam-profile-readme" },
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) return await res.json();
      console.warn(`attempt ${attempt}: HTTP ${res.status}`);
    } catch (error) {
      console.warn(`attempt ${attempt}: ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
  return null;
}

/** 10808 → "10.8K", 1002 → "1K", 688 → "688". */
function compact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

/** 46526 → "46K+" — rounded down so the claim is always true. */
function floorK(n) {
  return n >= 1000 ? `${Math.floor(n / 1000)}K+` : `${n}+`;
}

function badge({ label, value, color, logo, href, alt }) {
  const enc = (s) => encodeURIComponent(s).replace(/-/g, "--");
  const logoPart = logo ? `&logo=${logo}&logoColor=white` : "";
  const src = `https://img.shields.io/badge/${enc(label)}-${enc(value)}-${color}?style=flat-square${logoPart}`;
  return `<a href="${href}"><img src="${src}" alt="${alt}" /></a>`;
}

function badgesFor(project) {
  const ok = (project.metrics ?? []).filter((m) => typeof m.total === "number");
  const sum = (set) => ok.filter((m) => set.has(m.provider)).reduce((a, m) => a + m.total, 0);
  const packages = sum(PACKAGE);
  const containers = sum(CONTAINER);
  const dashboards = ok.filter((m) => m.provider === "grafana").reduce((a, m) => a + m.total, 0);
  const href = "https://baselhusam.com";
  const out = [];

  if (packages + containers > 0) {
    const label = packages === 0 ? "pulls" : "downloads";
    const lead = [...ok]
      .filter((m) => PACKAGE.has(m.provider) || CONTAINER.has(m.provider))
      .sort((a, b) => b.total - a.total)[0].provider;
    const logo = { npm: "npm", pypi: "pypi", dockerhub: "docker", ghcr: "docker" }[lead];
    const color = { npm: "CB3837", pypi: "3775A9", dockerhub: "2496ED", ghcr: "2496ED" }[lead];
    out.push(badge({ label, value: compact(packages + containers), color, logo, href, alt: `${label}` }));
  }
  if (dashboards >= DASHBOARD_FLOOR) {
    out.push(badge({ label: "Grafana installs", value: compact(dashboards), color: "F46800", logo: "grafana", href, alt: "Grafana dashboard installs" }));
  }
  return out.join(" ");
}

const data = await fetchMetrics();
const total = data?.summary?.total;
if (!data || typeof total !== "number" || total <= 0 || !data.summary.available) {
  console.warn("No usable metrics — leaving README unchanged.");
  process.exit(0);
}

const byId = new Map((data.projects ?? []).map((p) => [p.id, p]));
let readme = await readFile(README, "utf8");
const before = readme;

readme = readme.replace(
  /(<!-- stats:([\w-]+) -->)([\s\S]*?)(<!-- \/stats:\2 -->)/g,
  (match, open, id, _body, close) => {
    if (id === "total") return `${open}${floorK(total)}${close}`;
    const project = byId.get(id);
    if (!project) return match;
    const html = badgesFor(project);
    return html ? `${open}${html}${close}` : match;
  }
);

if (readme === before) {
  console.log(`Numbers unchanged (total ${total}).`);
} else {
  await writeFile(README, readme);
  console.log(`README updated (total ${total}, ${data.summary.available}/${data.summary.totalSources} sources live).`);
}
