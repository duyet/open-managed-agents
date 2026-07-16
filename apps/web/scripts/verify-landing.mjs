#!/usr/bin/env node
/**
 * Structural + built-output checks for the marketing landing.
 * Drives real shipped files under apps/web — not reimplemented expectations.
 *
 * Usage (from apps/web): node scripts/verify-landing.mjs
 * Optional: LANDING_URL=http://127.0.0.1:PORT node scripts/verify-landing.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};
const ok = (msg) => console.log("OK:", msg);

const BRAND_HEX = ["#141413", "#faf9f5", "#b0aea5", "#e8e6dc", "#d97757", "#6a9bcc", "#788c5d"];

// --- Source: global.css tokens ---
const cssPath = join(root, "src/styles/global.css");
const css = readFileSync(cssPath, "utf8");
// Brand fonts are now Geist (Cursor.com-style), self-hosted via fontsource.
if (!css.includes('"Geist Variable"') || !css.includes('"Geist Mono Variable"')) {
  fail("global.css must set Geist Variable (sans/display) + Geist Mono Variable");
} else {
  ok("global.css Geist Variable + Geist Mono tokens");
}
if (css.includes("Source Serif") || css.includes("DM Sans") || css.includes("Poppins") || css.includes("Lora")) {
  fail("global.css must not default marketing to Source Serif / DM Sans / Poppins / Lora");
} else {
  ok("no legacy Console/marketing font families as marketing default in global.css");
}
for (const hex of BRAND_HEX) {
  if (!css.toLowerCase().includes(hex.toLowerCase())) {
    fail(`missing brand color ${hex} in global.css`);
  }
}
if (!process.exitCode) ok("brand color anchors present in global.css");

// --- Source: Base.astro font load ---
const base = readFileSync(join(root, "src/layouts/Base.astro"), "utf8");
// Fonts are self-hosted (fontsource import in global.css) — no Google Fonts
// <link> for Poppins/Lora any more. Assert we dropped the legacy link and
// don't load Source Serif / DM Sans.
if (/fonts\.googleapis\.com\/css2\?family=Poppins|family=Lora/.test(base)) {
  fail("Base.astro still loads Google Fonts Poppins + Lora");
} else {
  ok("Base.astro no longer loads Google Fonts Poppins + Lora");
}
if (/Source\+Serif|DM\+Sans/.test(base)) {
  fail("Base.astro still loads Source Serif / DM Sans for marketing");
} else {
  ok("Base.astro free of Source Serif / DM Sans font URLs");
}
if (!base.includes("@fontsource-variable/geist")) {
  fail("Base.astro/global.css must self-host Geist via @fontsource-variable/geist");
}

// --- Source: index.astro sections ---
const index = readFileSync(join(root, "src/pages/index.astro"), "utf8");
const requiredHeadings = [
  "What Open Managed Agents is",
  "How it is designed",
  "System architecture layers",
  "Durable lifecycle loop",
  "Why Open Managed Agents",
  "Get started",
];
for (const h of requiredHeadings) {
  if (!index.includes(h)) fail(`landing missing section heading: ${h}`);
}
if (!index.includes("Agent") || !index.includes("Session") || !index.includes("Environment") || !index.includes("Vault")) {
  fail("landing must explain Agent / Session / Environment / Vault");
}
if (!index.includes("arch-stack") || !index.includes("lifecycle-track") || !index.includes("meta-harness-split")) {
  fail("landing must include architecture / lifecycle visual structure classes");
}
if (!index.includes("github.com/duyet/oma") || !index.includes("app.oma.duyet.net/login") || !index.includes("docs.oma.duyet.net")) {
  fail("primary CTAs (GitHub, hosted, docs) must remain");
}
if (!process.exitCode) ok("landing source sections + concepts + viz + CTAs");

// --- Built dist (if present) ---
const distIndex = join(root, "dist/index.html");
if (existsSync(distIndex)) {
  const html = readFileSync(distIndex, "utf8");
  // Geist is self-hosted: the built HTML references the fontsource CSS
  // (and the @font-face family name), not a Google Fonts URL.
  if (!/Geist/i.test(html)) {
    fail("built dist/index.html must reference Geist");
  } else {
    ok("dist/index.html references Geist");
  }
  if (!html.includes("What Open Managed Agents is") || !html.includes("How it is designed")) {
    fail("built HTML missing product/design explainer headings");
  } else {
    ok("built HTML has product + design explainers");
  }
  if (!html.includes("arch-stack") || !html.includes("lifecycle-track")) {
    fail("built HTML missing architecture viz structure");
  } else {
    ok("built HTML has architecture viz classes");
  }
} else {
  console.log("SKIP: dist/index.html not built yet (run build first for full check)");
}

// --- Optional live URL (dual-fetch caller can pass LANDING_URL) ---
const url = process.env.LANDING_URL;
if (url) {
  for (let i = 1; i <= 2; i++) {
    const res = await fetch(url);
    const body = await res.text();
    if (!res.ok) fail(`fetch #${i} ${url} → HTTP ${res.status}`);
    if (!/Open Managed Agents|oma/i.test(body)) fail(`fetch #${i}: missing product title`);
    if (!body.includes("How it is designed") && !body.includes("System architecture")) {
      fail(`fetch #${i}: missing design/architecture heading`);
    }
    if (!/Geist/i.test(body)) fail(`fetch #${i}: missing Geist font ref`);
    if (!process.exitCode) ok(`live fetch #${i} ${url} observables ok`);
  }
}

if (process.exitCode) {
  console.error("\nverify-landing: FAILED");
  process.exit(1);
}
console.log("\nverify-landing: PASSED");
