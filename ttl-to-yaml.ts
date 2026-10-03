/**
 * Convert a Turtle (.ttl) suite definition to YAML via JSON-LD,
 * compacted with the LWS test-suite context:
 *   @vocab  https://www.w3.org/ns/lws-tests/v1#  (suite + operation terms)
 *   http    http://www.w3.org/2011/http#         (HTTP-in-RDF)
 *
 * Usage: bun ttl-to-yaml.ts <input.ttl> <output.yaml>
 */
import { readFile, writeFile } from "node:fs/promises";
import { Parser, Writer } from "n3";
import jsonld from "jsonld";
import { stringify } from "yaml";

const [, , ttlPath, yamlPath] = process.argv;

if (!ttlPath || !yamlPath) {
  console.error("Usage: bun ttl-to-yaml.ts <input.ttl> <output.yaml>");
  process.exit(1);
}

// Key order for the serialized YAML; keys not listed keep their original
// relative order after the listed ones (sortMapEntries sorts every map
// with this rank).
const KEY_ORDER = [
  "@context",
  "@vocab",
  "http",
  "mf",
  "rdfs",
  "xsd",
  "type",
  "name",
  "comment",
  "rules",
  "tests",
  "steps",
  "target",
  "base",
  "relative",
  "param",
  "expects",
  "statusCodeValue",
  "extractors",
  "path",
  "header",
];

function keyRank(key: unknown): number {
  const index = typeof key === "string" ? KEY_ORDER.indexOf(key) : -1;
  return index === -1 ? KEY_ORDER.length : index;
}

// 1. Parse Turtle into RDF quads
const ttl = await readFile(ttlPath, "utf8");
const quads = new Parser().parse(ttl);

// 2. Serialize quads as N-Quads (input required by jsonld.fromRDF)
const writer = new Writer({ format: "N-Quads" });
for (const quad of quads) writer.addQuad(quad);
const nquads = await new Promise<string>((resolve, reject) =>
  writer.end((error, result) => (error ? reject(error) : resolve(result))),
);

// 3. Convert RDF to JSON-LD (expanded form; one entry per node).
// useNativeTypes gives native numbers/booleans for typed literals, so
// e.g. statusCodeValue serializes as 404 rather than "404".
const nodes = await jsonld.fromRDF(nquads, {
  format: "application/n-quads",
  useNativeTypes: true,
});

// 3b. Frame with an exact nested frame so only the expected keys survive
// (per-level @explicit). jsonld.js always emits @id for framed nodes, so
// blank-node @ids are stripped after compaction.
const context = {
  "@vocab": "https://www.w3.org/ns/lws-tests/v1#",
  http: "http://www.w3.org/2011/http#",
  mf: "https://www.w3.org/ns/test-manifest#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  // Keyword alias for @type as `type`; @type: "@id" marks the values as
  // IRIs so they compact via @vocab or a prefix (types are always IRIs).
  type: { "@id": "@type", "@type": "@id" },
  name: { "@id": "mf:name" },
  comment: { "@id": "rdfs:comment" },
  // RDF collections in the Turtle become plain arrays in the output
  tests: { "@container": "@list" },
  steps: { "@container": "@list" },
  extractors: { "@container": "@list" },
  statusCodeValue: { "@id": "http:statusCodeValue", "@type": "xsd:integer" },
};

// A "@type": {} entry keeps rdf:type in the framed output, but it also
// acts as a filter matching only *typed* nodes -- so it appears only at
// levels where every node is typed (steps are LWS operations, expects is
// an http:Response). Frame-listed properties a node lacks come out as
// null placeholders; cleanNode drops them below.
const frame = {
  "@context": context,
  "@explicit": true, // top-level node: only name + comment + rules + tests
  name: {},
  comment: {},
  rules: {},
  tests: {
    "@explicit": true, // test: only name + comment + steps
    name: {},
    comment: {},
    steps: {
      "@explicit": true, // step: operation type + target + extractors + expects
      "@type": {},
      target: {
        "@explicit": true, // target: URI template (param, or base + relative)
        base: {
          "@explicit": true,
          param: {},
        },
        relative: {},
        param: {},
      },
      extractors: {}, // extractors: keep param/path/header
      expects: {
        "@explicit": true, // expects: http:Response pattern
        "@type": {},
        statusCodeValue: {},
      },
    },
  },
};

const framed = await jsonld.frame(nodes, frame, {
  expandContext: context,
  embed: "@always",
});
// The top frame also matches test nodes (they share `name`); the root is
// the only entry carrying a `tests` property.
const root = (framed["@graph"] ?? [framed]).find((node) => "tests" in node);
if (!root) {
  console.error("No top-level node with `tests` found in the frame output");
  process.exit(1);
}

// Drop blank-node @id values (their content is already embedded by
// framing) and null placeholders that framing emits for frame-listed
// properties a node lacks.
function cleanNode(value: any): any {
  if (Array.isArray(value)) return value.map(cleanNode);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      if (val === null) continue;
      if (key === "@id" && typeof val === "string" && val.startsWith("_:")) continue;
      out[key] = cleanNode(val);
    }
    return out;
  }
  return value;
}

// 4. Compact, drop blank-node @ids and null placeholders, and serialize
// as YAML (key ordering is applied only here). expandContext is needed:
// the frame output already uses short (compacted) keys, and compact
// expands its input first.
const jsonLd = await jsonld.compact(cleanNode(root), context, {
  expandContext: context,
});
await writeFile(
  yamlPath,
  stringify(jsonLd, {
    sortMapEntries: (a, b) => keyRank(a.key.value) - keyRank(b.key.value),
  }),
);
console.log(`Wrote ${yamlPath}`);