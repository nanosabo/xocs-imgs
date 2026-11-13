#!/usr/bin/env node
/**
 * Pulls donation comments from the owner's Monobank jar into donations.json.
 *
 * The personal token is read from MONOBANK_TOKEN and is never written to disk
 * or printed. GitHub Pages serves the JSON, so the file keeps only the fields
 * that belong on a public donation list.
 *
 * Each run requests the last 14 days (one statement call) and merges those
 * donations into the file by id. Older entries already stored stay in place.
 *
 * Environment:
 *   MONOBANK_TOKEN   personal token from https://api.monobank.ua/ (required)
 *   MONOBANK_JAR_ID  sendId, the part after /jar/ in the share link, or the
 *                    whole send.monobank.ua URL. Required when the token has
 *                    more than one jar
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "donations.json");

const API = "https://api.monobank.ua";
const LOOKBACK_SECONDS = 14 * 24 * 60 * 60;
const RATE_LIMIT_MS = 61_000;
const REQUEST_TIMEOUT_MS = 20_000;

const token = (process.env.MONOBANK_TOKEN || "").trim();
const wantedJar = (process.env.MONOBANK_JAR_ID || "").trim();

if (!token) {
  console.error(
    "MONOBANK_TOKEN is not set. Add it as a repository Actions secret and do not paste it into the workflow file.",
  );
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastCallAt = 0;

const monoGet = async (pathname) => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const elapsed = Date.now() - lastCallAt;
    if (lastCallAt !== 0 && elapsed < RATE_LIMIT_MS) {
      const wait = RATE_LIMIT_MS - elapsed;
      console.log(`Waiting ${Math.ceil(wait / 1000)}s for the Monobank rate limit`);
      await sleep(wait);
    }

    const response = await fetch(`${API}${pathname}`, {
      headers: { "X-Token": token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    lastCallAt = Date.now();
    const text = await response.text();

    if (response.status === 429 || response.status >= 500) {
      console.log(
        `Monobank HTTP ${response.status} on attempt ${attempt}: ${text.slice(0, 160)}`,
      );
      continue;
    }

    if (!response.ok) {
      throw new Error(`Monobank HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Monobank returned invalid JSON: ${error.message}`);
    }
  }

  throw new Error("Monobank kept refusing the request after 5 attempts");
};

const iso = (unixSeconds) => new Date(unixSeconds * 1000).toISOString();

// client-info returns a jar sendId like "jar/abcd", while the share link is
// https://send.monobank.ua/jar/abcd. Accept the raw id, the sendId, and the URL.
const jarKey = (value) => {
  const text = value.trim();
  let path = text;
  try {
    path = new URL(text).pathname;
  } catch {
    // A bare id or sendId, not a URL.
  }
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? text;
};

const selectJar = (jars) => {
  const list = jars.map((jar) => `${jar.title} [${jar.sendId}]`).join(", ");

  if (wantedJar) {
    const wantedKey = jarKey(wantedJar);
    const found = jars.find(
      (jar) => jarKey(jar.id) === wantedKey || jarKey(jar.sendId) === wantedKey,
    );
    if (!found) {
      throw new Error(
        `MONOBANK_JAR_ID does not match a jar on this token. Available: ${list || "none"}`,
      );
    }
    return found;
  }

  if (jars.length === 1) return jars[0];
  if (jars.length === 0) {
    throw new Error(
      "This token has no jars. Personal jars show up here; jars owned by an organisation are not available through the personal API.",
    );
  }

  throw new Error(
    `This token has several jars. Set the MONOBANK_JAR_ID secret to a sendId: ${list}`,
  );
};

const toDonation = (item) => {
  if (!item || typeof item.id !== "string" || item.hold) return null;
  if (typeof item.amount !== "number" || item.amount <= 0) return null;
  if (typeof item.time !== "number") return null;

  return {
    id: item.id,
    time: iso(item.time),
    amount: item.amount,
    comment: typeof item.comment === "string" ? item.comment.trim() : "",
  };
};

const loadState = async () => {
  let text;
  try {
    text = await fs.readFile(OUTPUT, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { jar: null, donations: [] };
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`donations.json is not valid JSON: ${error.message}`);
  }

  if (!parsed || !Array.isArray(parsed.donations)) {
    throw new Error("donations.json must contain a donations array");
  }

  return { jar: parsed.jar ?? null, donations: parsed.donations };
};

const publicJar = (jar) => ({
  sendId: jar.sendId,
  title: jar.title,
  currencyCode: jar.currencyCode,
  balance: jar.balance,
  goal: jar.goal,
});

const donationKey = (donation) =>
  JSON.stringify([donation.id, donation.time, donation.amount, donation.comment ?? ""]);

const main = async () => {
  const previous = await loadState();
  const info = await monoGet("/personal/client-info");
  const jar = selectJar(Array.isArray(info.jars) ? info.jars : []);
  const now = Math.floor(Date.now() / 1000);
  const from = now - LOOKBACK_SECONDS;

  console.log(`Jar: ${jar.title} [${jar.sendId}]`);
  console.log(`Statement: ${iso(from).slice(0, 10)} .. ${iso(now).slice(0, 10)}`);

  const statement = await monoGet(
    `/personal/statement/${encodeURIComponent(jar.id)}/${from}/${now}`,
  );
  if (!Array.isArray(statement)) {
    throw new Error("Monobank statement response was not a list");
  }

  const byId = new Map(previous.donations.map((donation) => [donation.id, donation]));
  let incoming = 0;
  for (const item of statement) {
    const donation = toDonation(item);
    if (!donation) continue;
    incoming += 1;
    byId.set(donation.id, donation);
  }

  const donations = [...byId.values()].sort((left, right) => {
    if (left.time !== right.time) return left.time < right.time ? 1 : -1;
    return left.id < right.id ? -1 : 1;
  });

  const withComment = donations.filter((donation) => donation.comment).length;
  console.log(
    `Incoming in this window: ${incoming}. Stored: ${donations.length}, with a comment: ${withComment}`,
  );

  const jarSnapshot = publicJar(jar);
  const previousKeys = previous.donations.map(donationKey).join("\n");
  const nextKeys = donations.map(donationKey).join("\n");
  const sameDonations =
    previous.donations.length === donations.length && previousKeys === nextKeys;
  const sameJar = JSON.stringify(previous.jar) === JSON.stringify(jarSnapshot);
  if (sameDonations && sameJar) {
    console.log("donations.json is unchanged");
    return;
  }

  const next = {
    updatedAt: iso(now),
    amountUnit: "kopecks",
    jar: jarSnapshot,
    donations,
  };

  await fs.writeFile(OUTPUT, `${JSON.stringify(next, null, 2)}\n`);
  console.log("donations.json updated");
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
