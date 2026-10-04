/**
 * Generate a local copy of the LWS v1 JSON-LD context document.
 *
 * The context served as https://www.w3.org/ns/lws/v1 is not published yet,
 * so instead of a hand-written stub the suite keeps the real document,
 * regenerated from the upstream vocab sources:
 *
 *   https://github.com/w3c/lws-protocol/tree/main/lws10-vocab
 *
 * (same directory whose README documents the canonical regeneration command,
 * `npx yml2vocab`). The script fetches vocabulary.yml + template.html from
 * the raw GitHub URLs, runs yml2vocab (via bunx), and saves the produced
 * vocabulary.context.jsonld as ./lws-v1.context.json, which the suite's
 * documentLoader serves under https://www.w3.org/ns/lws/v1.
 *
 * Usage: bun scripts/generate-lws-v1-context.ts
 */
import { $ } from "bun";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RAW_BASE = "https://raw.githubusercontent.com/w3c/lws-protocol/refs/heads/main/lws10-vocab";
const SOURCES = ["vocabulary.yml", "template.html"];
const OUT = "lws-v1.context.json";

const work = join(tmpdir(), `lws-vocab-${Date.now()}`);
await mkdir(work, { recursive: true });

for (const file of SOURCES) {
  const res = await fetch(`${RAW_BASE}/${file}`);
  if (!res.ok) throw new Error(`cannot fetch ${RAW_BASE}/${file}: HTTP ${res.status}`);
  await writeFile(join(work, file), await res.text());
  console.log(`fetched ${file}`);
}

// canonical generator (see the vocab README: npx yml2vocab -v vocabulary -t template.html -c)
await $`bunx yml2vocab -v vocabulary -t template.html -c`.cwd(work).quiet();

const context = await readFile(join(work, "vocabulary.context.jsonld"), "utf8");
JSON.parse(context); // fail loudly on a malformed document
await writeFile(OUT, context);
console.log(`wrote ${OUT} (${context.length} bytes, from ${RAW_BASE}/vocabulary.yml)`);