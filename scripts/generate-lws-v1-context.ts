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
 * Usage: bun scripts/generate-lws-v1-context.ts [--local <vocab-dir>]
 *   --local <vocab-dir>  use vocabulary.yml + template.html from a local
 *                        checkout instead of the raw GitHub sources.
 */
import { $ } from "bun";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RAW_BASE = "https://raw.githubusercontent.com/w3c/lws-protocol/refs/heads/main/lws10-vocab";
const SOURCES = ["vocabulary.yml", "template.html"];
const OUT = "lws-v1.context.json";

const localIdx = process.argv.indexOf("--local");
const LOCAL = localIdx >= 0 ? process.argv[localIdx + 1] : undefined;

const work = join(tmpdir(), `lws-vocab-${Date.now()}`);
await mkdir(work, { recursive: true });

for (const file of SOURCES) {
  if (LOCAL) {
    await cp(join(LOCAL, file), join(work, file));
    console.log(`copied ${file} from ${LOCAL}`);
  } else {
    const res = await fetch(`${RAW_BASE}/${file}`);
    if (!res.ok) throw new Error(`cannot fetch ${RAW_BASE}/${file}: HTTP ${res.status}`);
    await writeFile(join(work, file), await res.text());
    console.log(`fetched ${file}`);
  }
}

// canonical generator (see the vocab README: npx yml2vocab -v vocabulary -t template.html -c)
await $`bunx yml2vocab -v vocabulary -t template.html -c`.cwd(work).quiet();

const context = JSON.parse(await readFile(join(work, "vocabulary.context.jsonld"), "utf8"));

// local fix (track upstream w3c/lws-protocol): the `expires` term collides
// with the CID v1 embedded key context's protected `expires`
// (https://w3id.org/security#expiration) when a storage description carries
// both LWS webhook-subscription and key material, breaking strict JSON-LD
// expansion. Drop the term from the local generated copy until the upstream
// vocab renames it.
if (context["@context"] && "expires" in context["@context"]) {
  delete context["@context"].expires;
  console.log("removed the `expires` term (CID key-context collision)");
}

// Terms the upstream vocab (lws10-vocab/vocabulary.yml) does not declare
// yet, but which servers emit in storage descriptions; the ShEx shape
// (shape/storage-description.shex) requires each service to carry a type,
// and a JSON type that is not a context term is dropped by JSON-LD
// expansion. Post-patch them into the local copy until upstream adds them:
// if a term is now present in the generated context, the warning below says
// to remove it from this list.
const MISSING_TERMS: Record<string, string> = {
  TypeIndexService: "https://www.w3.org/ns/lws#TypeIndexService",
  TypeSearchService: "https://www.w3.org/ns/lws#TypeSearchService",
};

if (context["@context"]) {
  for (const [term, iri] of Object.entries(MISSING_TERMS)) {
    if (term in context["@context"]) {
      console.warn(
        `term \`${term}\` is now declared by the upstream vocabulary; remove it from MISSING_TERMS in scripts/generate-lws-v1-context.ts`,
      );
    } else {
      context["@context"][term] = iri;
      console.log(`patched missing term \`${term}\` -> ${iri} into the generated context`);
    }
  }
}

const out = JSON.stringify(context, null, 4) + "\n";
await writeFile(OUT, out);
console.log(`wrote ${OUT} (${out.length} bytes, from ${RAW_BASE}/vocabulary.yml)`);