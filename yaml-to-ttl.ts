/**
 * Convert a YAML JSON-LD file to Turtle (N-Triples, no prefixes).
 *
 * Converts yaml -> json (JSON-LD) -> RDF (N-Triples), suitable as the
 * suite definition file passed to the harness (.ttl extension).
 *
 * Usage: bun yaml-to-ttl.ts <input.yaml> <output.ttl>
 */
import { readFile, writeFile } from "node:fs/promises";
import jsonld from "jsonld";
import { parse } from "yaml";

const [, , yamlPath, ttlPath] = process.argv;

if (!yamlPath || !ttlPath) {
  console.error("Usage: bun yaml-to-ttl.ts <input.yaml> <output.ttl>");
  process.exit(1);
}

// 1. YAML -> JSON (the YAML document is JSON-LD: it carries an inline
//    @context with @vocab, @container: @list terms and the type alias)
const jsonLd = parse(await readFile(yamlPath, "utf8"));

// 2. JSON-LD -> RDF as N-Triples (single default graph => plain triples,
//    no prefixes; quoted as N-Quads format, which is identical here)
const nTriples = await jsonld.toRDF(jsonLd, { format: "application/n-quads" });

await writeFile(ttlPath, nTriples);
console.log(`Wrote ${ttlPath}`);