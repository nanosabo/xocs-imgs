#!/usr/bin/env node
/**
 * Keeps this repository in sync with crossoutcore.ru:
 *   - images/items/<id>.webp  <- /images/items/<id>.webp
 *   - images/parts/<id>.png   <- /images/parts/<id>.png (the site serves WebP
 *                                bytes for parts, the app already expects that)
 *   - actual_parts.json       <- /building/ (initialPartsData)
 *
 * Manual corrections live in overrides/ and are applied after the site data,
 * so a bad value on the site cannot overwrite them:
 *   - overrides/parts.json          field overrides keyed by part id
 *   - overrides/images/parts/<id>.png
 *   - overrides/images/items/<id>.webp
 *
 * Usage:
 *   node scripts/sync.mjs           # apply changes
 *   node scripts/sync.mjs --check   # only report what would change
 *   node scripts/sync.mjs --force   # re-download and rewrite every image
 *
 * Environment:
 *   XOCS_SITE       primary site (default https://crossoutcore.ru)
 *   XOCS_MIRROR     optional fallback mirror, used on network errors / 5xx
 *   INCLUDE_FRAMES  1 to also sync category 2 ("Рамы"), default excluded
 *   PRUNE           1 to delete images that no longer exist on the site
 *   CONCURRENCY     parallel image downloads (default 8)
 *   TIMEOUT_MS      per-request timeout (default 20000)
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SITE = (process.env.XOCS_SITE || "https://crossoutcore.ru").replace(/\/$/, "");
const MIRROR = (process.env.XOCS_MIRROR || "").replace(/\/$/, "");

const CHECK = process.argv.includes("--check");
const FORCE = process.argv.includes("--force");
const INCLUDE_FRAMES = process.env.INCLUDE_FRAMES === "1";
const PRUNE = process.env.PRUNE === "1";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 8));
const TIMEOUT_MS = Math.max(1000, Number(process.env.TIMEOUT_MS || 20000));

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CATEGORY_NAMES = {
  1: "Конструкции",
  2: "Рамы",
  3: "Простреливаемые",
  4: "Контактные",
};

const ITEMS_DIR = path.join(ROOT, "images", "items");
const PARTS_DIR = path.join(ROOT, "images", "parts");
const PARTS_JSON = path.join(ROOT, "actual_parts.json");

const OVERRIDES_DIR = path.join(ROOT, "overrides");
const PARTS_OVERRIDES = path.join(OVERRIDES_DIR, "parts.json");
const OVERRIDE_PARTS_DIR = path.join(OVERRIDES_DIR, "images", "parts");
const OVERRIDE_ITEMS_DIR = path.join(OVERRIDES_DIR, "images", "items");

const stats = {
  parts: {
    site: 0,
    repo: 0,
    result: 0,
    added: [],
    removed: [],
    changed: [],
    excluded: [],
    pinned: [],
    orphanedOverrides: [],
    unchanged: 0,
  },
  items: {
    site: 0,
    repo: 0,
    added: [],
    updated: [],
    unchanged: 0,
    notFound: [],
    invalid: [],
    extra: [],
    pruned: 0,
    pinned: [],
    pinnedApplied: [],
  },
  partImages: {
    site: 0,
    repo: 0,
    added: [],
    updated: [],
    unchanged: 0,
    notFound: [],
    invalid: [],
    extra: [],
    pruned: 0,
    pinned: [],
    pinnedApplied: [],
  },
};

/* ------------------------------------------------------------------ utils */

const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
};

const fetchWithRetry = async (url, options = {}, attempts = 2) => {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options);

      if (response.status >= 500 && attempt < attempts - 1) {
        lastError = new Error(`HTTP ${response.status}`);
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }

  throw lastError;
};

/**
 * Fetches a path from the primary site and falls back to the mirror on network
 * errors / timeouts / 5xx / blocking responses. 404 responses are returned as-is
 * (e.g. images that do not exist on the site).
 */
const fetchPath = async (urlPath, options = {}) => {
  try {
    const response = await fetchWithRetry(SITE + urlPath, options);

    if (
      response.status < 500 &&
      response.status !== 403 &&
      response.status !== 429 &&
      response.status !== 451
    ) {
      return response;
    }

    if (!MIRROR) return response;
  } catch (error) {
    if (!MIRROR) throw error;
  }

  return fetchWithRetry(MIRROR + urlPath, options);
};

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const isWebp = (buffer) =>
  buffer.length >= 12 &&
  buffer.toString("latin1", 0, 4) === "RIFF" &&
  buffer.toString("latin1", 8, 12) === "WEBP";

const isPng = (buffer) =>
  buffer.length >= 8 &&
  buffer[0] === 0x89 &&
  buffer[1] === 0x50 &&
  buffer[2] === 0x4e &&
  buffer[3] === 0x47;

const readFile = async (file) => {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
};

const listFiles = async (dir) => {
  try {
    return new Set(await fs.readdir(dir));
  } catch {
    return new Set();
  }
};

const mapLimit = async (items, limit, worker) => {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });

  await Promise.all(runners);
};

const shortList = (items, limit = 8) => {
  if (items.length === 0) return "—";
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown} … (+${items.length - limit})` : shown;
};

/* --------------------------------------------------------- parts data (RSC) */

const decodeRscPayload = (html) => {
  const pushRe = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let text = "";

  for (const match of html.matchAll(pushRe)) {
    try {
      text += JSON.parse(match[1]);
    } catch {
      /* ignore malformed chunks */
    }
  }

  return text;
};

const extractJsonArray = (text, key) => {
  const index = text.indexOf(key);
  if (index === -1) throw new Error(`Key ${key} not found in page payload`);

  const start = index + key.length - 1;
  let depth = 0;
  let inString = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (char === "\\") {
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth++;
    } else if (char === "]") {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }

  throw new Error(`Unterminated JSON array for ${key}`);
};

const fetchSiteParts = async () => {
  const response = await fetchPath("/building/", {
    headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
  });

  if (!response.ok) {
    throw new Error(`Failed to load /building/: HTTP ${response.status}`);
  }

  const html = await response.text();
  const payload = decodeRscPayload(html);

  return extractJsonArray(payload, '"initialPartsData":[');
};

const fetchItemIds = async () => {
  const response = await fetchPath("/sitemap.xml", {
    headers: { Accept: "application/xml,text/xml,*/*;q=0.8" },
  });

  if (!response.ok) {
    throw new Error(`Failed to load /sitemap.xml: HTTP ${response.status}`);
  }

  const xml = await response.text();
  const ids = new Set();

  for (const match of xml.matchAll(/\/item\/(\d+)\//g)) {
    ids.add(match[1]);
  }

  return Array.from(ids).sort((a, b) => Number(a) - Number(b));
};

const toRepoPart = (part) => ({
  id: part.id,
  category: CATEGORY_NAMES[part.category] ?? String(part.category),
  name: part.name_ru,
  power: part.power,
  durability: part.durability,
  weight: part.mass,
  maxCount: part.quantity,
  build_hp: part.build_hp,
  eng_name: part.name_en,
});

/**
 * The site publishes parts whose names end in "СХ" (Cyrillic) or "CX" (Latin).
 * They are not wanted in actual_parts.json at all, so they are skipped both
 * when rebuilding the list and when syncing part images.
 */
const isExcludedByName = (part) => /(?:^|\s)(?:СХ|CX)$/iu.test(part.name_ru ?? "");

const isAllowedPart = (part) =>
  (INCLUDE_FRAMES || part.category !== 2) && !isExcludedByName(part);

const loadPartOverrides = async () => {
  const buffer = await readFile(PARTS_OVERRIDES);
  if (!buffer) return {};

  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid overrides/parts.json: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("overrides/parts.json must contain an object keyed by part id");
  }

  return parsed;
};

const buildPartsJson = (siteParts, existing, partOverrides = {}) => {
  const allowed = siteParts.filter(isAllowedPart);
  const siteById = new Map(allowed.map((part) => [part.id, part]));

  const existingById = new Map(existing.map((part) => [part.id, part]));
  const orderedIds = [];

  for (const part of existing) {
    if (siteById.has(part.id)) orderedIds.push(part.id);
    else stats.parts.removed.push(part.id);
  }

  const existingIds = new Set(existing.map((part) => part.id));

  for (const part of allowed) {
    if (!existingIds.has(part.id)) {
      orderedIds.push(part.id);
      stats.parts.added.push(`${part.id} (${part.name_ru})`);
    }
  }

  const result = orderedIds.map((id) => toRepoPart(siteById.get(id)));

  // Manual corrections win over whatever the site currently reports.
  for (const part of result) {
    const override = partOverrides[part.id];
    if (!override) continue;

    const fields = Object.keys(override).filter((key) => key !== "id");
    if (fields.length === 0) continue;

    for (const key of fields) {
      if (!(key in part)) {
        throw new Error(
          `overrides/parts.json: unknown field "${key}" for part ${part.id}`,
        );
      }

      if (typeof override[key] !== typeof part[key]) {
        throw new Error(
          `overrides/parts.json: field "${key}" for part ${part.id} must be ` +
            `${typeof part[key]}, got ${typeof override[key]}`,
        );
      }

      part[key] = override[key];
    }

    stats.parts.pinned.push(`${part.id} (${fields.join(", ")})`);
  }

  for (const id of Object.keys(partOverrides)) {
    if (!siteById.has(id)) stats.parts.orphanedOverrides.push(id);
  }

  for (const part of result) {
    const previous = existingById.get(part.id);
    if (!previous) continue;

    const changedFields = Object.keys(part).filter(
      (key) => key !== "id" && previous[key] !== part[key],
    );

    if (changedFields.length > 0) {
      stats.parts.changed.push(
        `${part.id}: ${changedFields
          .map((key) => `${key} ${JSON.stringify(previous[key])}→${JSON.stringify(part[key])}`)
          .join(", ")}`,
      );
    } else {
      stats.parts.unchanged++;
    }
  }

  stats.parts.site = siteParts.length;
  stats.parts.repo = existing.length;
  stats.parts.result = result.length;
  stats.parts.excluded = siteParts
    .filter(isExcludedByName)
    .map((part) => `${part.id} (${part.name_ru})`);

  return result;
};

/* --------------------------------------------------------------- image sync */

const syncImages = async ({ kind, ids, dir, extension, accept, label, overridesDir }) => {
  const state = kind === "items" ? stats.items : stats.partImages;
  const localFiles = await listFiles(dir);
  const localIds = new Set(
    Array.from(localFiles)
      .map((name) => name.match(new RegExp(`^([0-9a-f]+)\\.${extension}$`))?.[1])
      .filter(Boolean),
  );

  const overrideFiles = overridesDir ? await listFiles(overridesDir) : new Set();
  const pinnedIds = new Set(
    Array.from(overrideFiles)
      .map((name) => name.match(new RegExp(`^([0-9a-f]+)\\.${extension}$`))?.[1])
      .filter(Boolean),
  );

  state.site = ids.length;
  state.repo = localIds.size;
  state.pinned = Array.from(pinnedIds).sort();

  let processed = 0;

  await mapLimit(ids, CONCURRENCY, async (id) => {
    const file = path.join(dir, `${id}.${extension}`);

    // A pinned image always wins over the site. This is how manual fixes to
    // broken site assets survive the daily sync.
    if (pinnedIds.has(id)) {
      const override = await readFile(path.join(overridesDir, `${id}.${extension}`));

      if (!override) {
        throw new Error(`${label}: override file for ${id} is missing`);
      }

      if (!accept(override)) {
        throw new Error(`${label}: override for ${id} is not a valid image`);
      }

      const previous = await readFile(file);

      if (previous && sha256(previous) === sha256(override)) {
        state.unchanged++;
        return;
      }

      if (!CHECK) {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(file, override);
      }

      state.pinnedApplied.push(id);
      processed++;
      return;
    }

    const urlPath = kind === "items" ? `/images/items/${id}.webp` : `/images/parts/${id}.png`;

    let response;

    try {
      response = await fetchPath(urlPath, { headers: { Accept: "image/*" } });
    } catch (error) {
      state.invalid.push(`${id} (request failed: ${error.message})`);
      return;
    }

    if (response.status === 404) {
      state.notFound.push(id);
      return;
    }

    if (!response.ok) {
      state.invalid.push(`${id} (HTTP ${response.status})`);
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (!accept(buffer)) {
      state.invalid.push(`${id} (not an image)`);
      return;
    }

    const previous = FORCE ? null : await readFile(file);
    const previousHash = previous ? sha256(previous) : null;
    const nextHash = sha256(buffer);

    if (previousHash === nextHash) {
      state.unchanged++;
      return;
    }

    if (previousHash === null) {
      state.added.push(id);
    } else {
      state.updated.push(id);
    }

    if (!CHECK) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, buffer);
    }

    processed++;
    if (processed % 100 === 0) {
      console.log(`  ${label}: ${processed} changed…`);
    }
  });

  state.extra = Array.from(localIds).filter(
    (id) => !ids.includes(id) && !pinnedIds.has(id),
  );

  if (PRUNE && !CHECK) {
    for (const id of state.extra) {
      await fs.rm(path.join(dir, `${id}.${extension}`), { force: true });
    }
    state.pruned = state.extra.length;
    state.extra = [];
  }
};

/* -------------------------------------------------------------------- main */

const main = async () => {
  console.log(`Source: ${SITE}`);
  console.log(`Mode:   ${CHECK ? "check (no writes)" : "sync"}${FORCE ? ", force" : ""}`);
  console.log(`Frames: ${INCLUDE_FRAMES ? "included" : "excluded"}\n`);

  console.log("Loading parts from /building/…");
  const siteParts = await fetchSiteParts();
  console.log(`  parts on site: ${siteParts.length}`);

  const previousPartsText = (await readFile(PARTS_JSON))?.toString("utf8");

  let existingParts = [];
  try {
    existingParts = previousPartsText ? JSON.parse(previousPartsText) : [];
  } catch {
    existingParts = [];
  }

  const partOverrides = await loadPartOverrides();
  console.log(`  overrides: ${Object.keys(partOverrides).length} part(s)`);

  const partsJson = buildPartsJson(siteParts, existingParts, partOverrides);
  const partsText = JSON.stringify(partsJson, null, 2);

  if (previousPartsText !== partsText) {
    if (!CHECK) await fs.writeFile(PARTS_JSON, partsText, "utf8");
    console.log("  actual_parts.json will be updated");
  } else {
    console.log("  actual_parts.json is up to date");
  }

  console.log("\nLoading item ids from /sitemap.xml…");
  const itemIds = await fetchItemIds();
  console.log(`  items on site: ${itemIds.length}`);

  console.log("\nSyncing item images…");
  await syncImages({
    kind: "items",
    ids: itemIds,
    dir: ITEMS_DIR,
    extension: "webp",
    accept: isWebp,
    label: "items",
    overridesDir: OVERRIDE_ITEMS_DIR,
  });

  const partIds = siteParts.filter(isAllowedPart).map((part) => part.id);

  console.log("\nSyncing part images…");
  await syncImages({
    kind: "partImages",
    ids: partIds,
    dir: PARTS_DIR,
    extension: "png",
    accept: (buffer) => isWebp(buffer) || isPng(buffer),
    label: "parts",
    overridesDir: OVERRIDE_PARTS_DIR,
  });

  /* --------------------------------------------------------------- report */

  console.log("\n================ PARTS DATA ================");
  console.log(
    `site ${stats.parts.site} | repo ${stats.parts.repo} | result ${stats.parts.result}`,
  );
  console.log(
    `new ${stats.parts.added.length} | removed ${stats.parts.removed.length} | changed ${stats.parts.changed.length} | excluded ${stats.parts.excluded.length} | pinned ${stats.parts.pinned.length} | unchanged ${stats.parts.unchanged}`,
  );
  if (stats.parts.added.length) console.log(`  new:     ${shortList(stats.parts.added, 10)}`);
  if (stats.parts.removed.length) console.log(`  removed: ${shortList(stats.parts.removed, 10)}`);
  if (stats.parts.changed.length) console.log(`  changed: ${shortList(stats.parts.changed, 5)}`);
  if (stats.parts.pinned.length) console.log(`  pinned:  ${shortList(stats.parts.pinned, 10)}`);
  if (stats.parts.orphanedOverrides.length) {
    console.log(
      `  overrides for missing parts: ${shortList(stats.parts.orphanedOverrides, 10)}`,
    );
  }
  if (stats.parts.excluded.length) {
    console.log(`  excluded by name (СХ/CX): ${shortList(stats.parts.excluded, 10)}`);
  }

  for (const [title, state] of [
    ["ITEM IMAGES", stats.items],
    ["PART IMAGES", stats.partImages],
  ]) {
    console.log(`\n================= ${title} =================`);
    console.log(`site ${state.site} | repo ${state.repo}`);
    console.log(
      `add ${state.added.length} | update ${state.updated.length} | unchanged ${state.unchanged} | pinned ${state.pinned.length} | 404 ${state.notFound.length} | invalid ${state.invalid.length} | extra ${state.extra.length}${state.pruned ? ` | pruned ${state.pruned}` : ""}`,
    );
    if (state.added.length) console.log(`  add:     ${shortList(state.added, 10)}`);
    if (state.updated.length) console.log(`  update:  ${shortList(state.updated, 10)}`);
    if (state.pinnedApplied.length) {
      console.log(`  pinned applied: ${shortList(state.pinnedApplied, 10)}`);
    }
    if (state.pinned.length) console.log(`  pinned:  ${shortList(state.pinned, 10)}`);
    if (state.notFound.length) console.log(`  404:     ${shortList(state.notFound, 10)}`);
    if (state.invalid.length) console.log(`  invalid: ${shortList(state.invalid, 10)}`);
    if (state.extra.length) console.log(`  extra:   ${shortList(state.extra, 10)}`);
  }

  console.log(
    `\n${CHECK ? "Check finished" : "Sync finished"}. ${PRUNE ? "Prune enabled." : "Prune disabled (PRUNE=1 to remove extras)."}`,
  );
};

main().catch((error) => {
  console.error(`\nSync failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
