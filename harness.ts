/**
 * Minimal LWS conformance harness: N3 rules + SPARQL.
 *
 * Pipeline (per run):
 *   1. convert the manifest (tests.yaml) to RDF with the n3.js reasoner
 *      target: one named graph per step; the suite/test-case data stays in
 *      the default graph, which is the test-case context.
 *   2. seed the inputs (`param:storage`) with the storage URI from
 *      LWS_STORAGE (env) or the 3rd CLI arg, into the default graph.
 *   3. for each test, for each step, in order:
 *        a. materialize the constants the step references (param IRIs found
 *           in its graph) from the default-graph context into the step's
 *           named graph -- the n3.js reasoner cannot join premises across
 *           graphs, so target values must live in the step graph itself.
 *        b. reason() -> the operation's http:Request (mthd, absoluteURI,
 *           headers) is derived.
 *        c. execute the request against the SUT.
 *        d. inject the response as basic HTTP-in-RDF triples (http:Response,
 *           http:sc, Location header, body) into the step graph.
 *        e. reason() again -> param:status-code / param:location /
 *           param:content, the storage-root extraction (from RDF bodies) and
 *           the id->return binding copies are derived in the step graph.
 *        f. evaluate the step assertions; log PASS/FAIL; skip unsupported
 *           assertion types (e.g. ShapeAssertion).
 *        g. lift the test's declared constants from the step graph into the
 *           default graph (test-case context) via a SPARQL CONSTRUCT.
 *   4. evaluate test-level assertions against the context; print a summary;
 *      exit non-zero on any failure (so a dagger cell fails).
 *
 * Usage:
 *   LWS_STORAGE=<storage-uri> bun harness.ts <tests.yaml> <rules.n3>
 */
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DataFactory, Parser, Reasoner, Store } from "n3";
import { QueryEngine } from "@comunica/query-sparql-rdfjs";
import { createVocabulary } from "rdf-vocabulary";
import { parse as parseYaml } from "yaml";
import jsonld from "jsonld";
import { LWS_TEST_CONTEXT, documentLoader } from "./context";

const { namedNode, blankNode, literal, defaultGraph } = DataFactory;

// ---------------------------------------------------------------------------
// Typed vocabularies (rdf-vocabulary): `vocab.Name` is the IRI string,
// `vocab.terms.Name` is an RDF/JS NamedNode. Namespaces without a fixed
// local-name set (param:, statusCodes:) stay plain namespace strings.
// ---------------------------------------------------------------------------

const rdf = createVocabulary(
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  "type", "first", "rest", "nil",
);
const http = createVocabulary(
  "http://www.w3.org/2011/http#",
  "Request", "Response", "RequestHeader", "ResponseHeader",
  "mthd", "absoluteURI", "headers", "sc", "fieldName", "fieldValue", "body",
);
const methods = createVocabulary(
  "http://www.w3.org/2011/http-methods#",
  "GET", "POST", "PUT", "DELETE", "PATCH",
);
const cnt = createVocabulary(
  "http://www.w3.org/2011/content#",
  "ContentAsRDF", "ContentAsText", "chars",
);
const lwst = createVocabulary(
  "https://www.w3.org/ns/lws-tests/v1#",
  "value", "operation", "target", "inputs", "constants", "bindings",
  "assertions", "steps", "received", "expected", "id", "return",
);

// namespaces with dynamic local names (status names come from the cached
// vocabulary; params are arbitrary manifest-defined names) plus the base
// namespaces of the vocabularies above, for string templating
const LWST = lwst.namespace;
const HTTP = http.namespace;
const CNT = cnt.namespace;
const PARAM = "https://w3id.org/lws/test/param#";


// ---------------------------------------------------------------------------
// HTTP status codes vocabulary: cached as Turtle next to the manifest
// (lws10/http-statusCodes.ttl, converted from the W3C RDF/XML document) and
// queried with SPARQL so no numeric->name table is kept in the harness and
// no XML is parsed at run time.
// ---------------------------------------------------------------------------

const statusStore = new Store();
const statusEngine = new QueryEngine();

/** Load <manifest-dir>/http-statusCodes.ttl into statusStore. */
async function loadStatusCodes(dir: string) {
  try {
    const ttl = await readFile(`${dir}/http-statusCodes.ttl`, "utf8");
    for (const quad of new Parser().parse(ttl)) statusStore.addQuad(quad);
    console.log(`status-codes vocabulary: ${statusStore.size} triples (${dir}/http-statusCodes.ttl)`);
  } catch (e: any) {
    console.error(`could not load status-codes vocabulary (${dir}/http-statusCodes.ttl): ${e.message}`);
  }
}

/** Look up the http-status-codes IRU for a numeric status, or null. */
async function lookupStatusIri(status: number): Promise<string | null> {
  if (statusStore.size === 0) return null;
  const bindings = await statusEngine.queryBindings(
    `PREFIX http: <${HTTP}> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
     SELECT ?sc WHERE { ?sc a http:StatusCode ; http:statusCodeNumber ?n .
                        FILTER(xsd:integer(?n) = ${status}) }`,
    { sources: [statusStore] },
  );
  for await (const row of bindings) return row.get("sc").value;
  return null;
}

// ---------------------------------------------------------------------------
// Manifest -> JSON-LD -> RDF (one named graph per step)
// ---------------------------------------------------------------------------

/** Short label of an IRI (last # or / segment) for logs. */
const short = (v: string): string => v.slice(Math.max(v.lastIndexOf("#"), v.lastIndexOf("/")) + 1);

/**
 * Reshape the manifest into JSON-LD with a named graph per step. A step that
 * already carries a real "@graph" (with an authored graph name) is passed
 * through untouched; a flat step (whose "@graph": null is only a marker) is
 * wrapped so jsonld gives it a (blank-node) graph name -- the harness
 * remaps those to internal urn:uuid IRIs after conversion.
 *
 * The @context comes from the shared context module: either the manifest
 * references the context IRI (https://w3id.org/lws/test/context), which
 * documentLoader() serves, or we use the canonical context object directly.
 */
function toJsonLd(doc: any): any {
  const context =
    typeof doc["@context"] === "string" ? doc["@context"] : LWS_TEST_CONTEXT;
  const tests = (doc.tests ?? []).map((t: any) => {
    const steps = (t.steps ?? []).map((s: any) => {
      if (Array.isArray(s["@graph"])) return s; // authored by the manifest
      const { ["@graph"]: _marker, ...body } = s;
      return { "@graph": [body] };
    });
    return { ...t, steps };
  });
  // NB: @context must come AFTER the ...doc spread, or an inline manifest
  // context would override the canonical one above.
  return { ...doc, "@context": context, tests };
}

/** Parse an RDF response body and return its quads (default graph only). */
async function parseRdfBody(text: string, contentType: string): Promise<any[]> {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (["application/ld+json", "application/lws+cid", "application/json"].includes(ct)) {
    const nquads = (await jsonld.toRDF(JSON.parse(text), {
      format: "application/n-quads",
      documentLoader,
    })) as string;
    return new Parser({ format: "N-Quads" }).parse(nquads);
  }
  const format =
    ct === "application/n-triples" ? "N-Triples"
    : ct === "application/n-quads" ? "N-Quads"
    : "Turtle";
  return new Parser({ format }).parse(text);
}

const isRdfContentType = (ct: string) =>
  /turtle|n-triples|n-quads|ld\+json|lws\+cid|\+json$/.test(ct.split(";")[0].toLowerCase());

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [, , manifestPath, rulesPath] = process.argv;
const storageUri = process.env.LWS_STORAGE ?? process.argv[4];

if (!manifestPath || !rulesPath || !storageUri) {
  console.error("Usage: LWS_STORAGE=<storage-uri> bun harness.ts <tests.yaml> <rules.n3>");
  process.exit(2);
}

// 0. status-codes vocabulary (cached Turtle next to the manifest)
await loadStatusCodes(dirname(manifestPath));

// 1. manifest -> RDF
const doc = parseYaml(await readFile(manifestPath, "utf8"));
const jsonLd = toJsonLd(doc);
const nquads = (await jsonld.toRDF(jsonLd, { format: "application/n-quads", documentLoader })) as string;
const store = new Store();
// Remap blank-node graph names (jsonld turns @graph-without-@id steps into
// blank-named graphs) to internal urn:uuid IRIs so the harness can address
// every step graph from SPARQL/GRAPH and rule conclusions alike. Authored
// graph names are kept as-is. A blank graph name is the same RDF resource
// in graph position and as the rdf:first/rest list item, so every
// occurrence of the label is replaced consistently.
const quads = new Parser({ format: "N-Quads" }).parse(nquads);
const blankGraphNames = new Map<string, string>();
for (const quad of quads) {
  if (quad.graph.termType === "BlankNode") blankGraphNames.set(quad.graph.value, `urn:uuid:${randomUUID()}`);
}
const remap = (term: any) =>
  term.termType === "BlankNode" && blankGraphNames.has(term.value)
    ? namedNode(blankGraphNames.get(term.value)!)
    : term;
for (const quad of quads) {
  store.addQuad(remap(quad.subject), remap(quad.predicate), remap(quad.object), remap(quad.graph));
}
if (blankGraphNames.size > 0) {
  console.log(`graph names: ${blankGraphNames.size} blank step graph(s) remapped to urn:uuid`);
}

// rules
const rules = new Store(new Parser({ format: "text/n3" }).parse(await readFile(rulesPath, "utf8")));
const reason = () => new Reasoner(store).reason(rules);

// SPARQL engine over the same store (default graph = test-case context)
const engine = new QueryEngine();

// 2. seed inputs into the default graph (test-case context)
const inputIris = new Set<string>();
for (const q of store.getQuads(null, lwst.terms.inputs, null, defaultGraph())) {
  if (q.object.termType === "NamedNode") inputIris.add(q.object.value);
}
if (inputIris.size === 0) {
  console.error("no inputs found in manifest (expected lwst:inputs with param terms)");
}
for (const iri of inputIris) {
  store.addQuad(namedNode(iri), lwst.terms.value, namedNode(storageUri), defaultGraph());
  console.log(`input  ${iri} = ${storageUri}`);
}

// helpers
const one = (s: any, pred: any, graph?: any) =>
  pred ? store.getQuads(s, pred, null, graph ?? null)[0]?.object : undefined;
const paramValue = (iri: string, graph?: any) =>
  one(namedNode(iri), lwst.terms.value, graph);

/** Walk an RDF list (rdf:first/rest) and return the list items in order. */
function listItems(head: any): any[] {
  const items = [];
  while (head && !(head.termType === "NamedNode" && head.value === rdf.terms.nil.value)) {
    items.push(one(head, rdf.terms.first, defaultGraph()));
    head = one(head, rdf.terms.rest, defaultGraph());
  }
  return items;
}

/**
 * The graph name of each step in document/list order: an authored IRI when
 * the manifest named the step graph, otherwise the internal urn:uuid the
 * harness minted for the blank-node name jsonld assigned (see the remap
 * after the N-Quads parse).
 */
function stepGraphs(testNode: any): any[] {
  return listItems(one(testNode, lwst.terms.steps, defaultGraph()));
}

/**
 * Materialize the constants referenced inside a step graph, from the
 * context: a cheap local copy of the param -> value triples the step's own
 * rules need to join on (their premises cannot span graphs).
 */
function materializeConstants(stepGraph: any) {
  const needed = new Set<string>();
  for (const q of store.getQuads(null, null, null, stepGraph)) {
    for (const term of [q.subject, q.object]) {
      if (term.termType === "NamedNode" && term.value.startsWith(PARAM)) needed.add(term.value);
    }
  }
  let copied = 0;
  for (const iri of needed) {
    const v = paramValue(iri, defaultGraph());
    if (v) {
      store.addQuad(namedNode(iri), lwst.terms.value, v, stepGraph);
      copied++;
    }
  }
  if (copied) console.log(`  materialized ${copied} constant(s)`);
}

/** Scoreboard. */
const report = { passed: 0, failed: 0, skipped: 0 };
function check(label: string, ok: boolean, detail: string) {
  if (ok) report.passed++; else report.failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Evaluate one assertion node read from the RDF dataset. All the terms are
 * already IRIs (the manifest's scoped contexts / @id coercions), so no
 * compact-IRI expansion happens here.
 */
async function assertStep(a: any, scopeGraph: any) {
  const typeTerm = one(a, rdf.terms.type, scopeGraph);
  const type = typeTerm ? short(typeTerm.value) : "(unknown)";
  const received = one(a, lwst.terms.received, scopeGraph);
  if (!received) {
    report.skipped++;
    console.log(`  SKIP ${type} — no received param`);
    return;
  }
  if (received.termType !== "NamedNode") {
    report.skipped++;
    console.log(`  SKIP ${type} — received is not an IRI: ${received.value}`);
    return;
  }
  const value = paramValue(received.value, scopeGraph) ?? paramValue(received.value, defaultGraph());
  let got: string | undefined;
  switch (value?.termType) {
    case "NamedNode":
    case "Literal":
      got = value.value;
      break;
    case undefined:
      break; // unbound: leave got undefined, assertions fail below
    default:
      report.skipped++;
      console.log(`  SKIP ${type} — unsupported received term type ${value.termType}`);
      return;
  }

  const rLabel = short(received.value);
  switch (type) {
    case "ExistanceAssertion":
      check(`ExistanceAssertion ${rLabel}`, got !== undefined, got ?? "not bound");
      return;
    case "IdentityAssertion": {
      const expected = one(a, lwst.terms.expected, scopeGraph);
      const expectedValue = expected && (expected.termType === "NamedNode" || expected.termType === "Literal")
        ? expected.value
        : undefined;
      check(
        `IdentityAssertion ${rLabel} == ${expected ? short(expected.value) : "∅"}`,
        got === expectedValue,
        `received=${got ?? "∅"}`,
      );
      return;
    }
    default:
      report.skipped++;
      console.log(`  SKIP ${type} (unsupported)`);
      return;
  }
}

/**
 * Lift the test's declared constants into the context (default graph): a
 * SPARQL CONSTRUCT that picks ?p lwst:value ?v from the step's graph (its
 * name is an IRI -- authored or the internal urn:uuid -- so it can be
 * named in the GRAPH clause) and emits the triple into the default graph.
 */
async function liftConstants(constants: any[], stepGraph: any) {
  const iris = constants.filter((t) => t.termType === "NamedNode");
  if (iris.length === 0) return;
  const values = `VALUES ?p { ${iris.map((i) => `<${i.value}>`).join(" ")} }`;
  const quads = await engine.queryQuads(
    `CONSTRUCT { ?p <${LWST}value> ?v } ` +
    `WHERE { GRAPH <${stepGraph.value}> { ${values} ?p <${LWST}value> ?v } }`,
    { sources: [store] },
  );
  let lifted = 0;
  for await (const q of quads) {
    if (store.getQuads(q.subject, q.predicate, q.object, defaultGraph()).length === 0) {
      store.addQuad(q.subject, q.predicate, q.object, defaultGraph());
      lifted++;
    }
  }
  if (lifted) console.log(`  lifted ${lifted} constant(s) to context`);
}

// 3. run the tests
// Test nodes in the default graph, paired with the JSON-LD tests (same
// document order); each test's step graphs come from its rdf:first/rest
// list, in order, with the blank-node names jsonld assigned.
const testNodes = store.getQuads(null, rdf.terms.type, namedNode(LWST + "TestCase"), defaultGraph())
  .map((q) => q.subject);
let failedSteps = 0;
for (let ti = 0; ti < jsonLd.tests.length; ti++) {
  const test = jsonLd.tests[ti];
  const testNode = testNodes[ti];
  console.log(`\n# ${test.name ?? test.id ?? `test-${ti}`} (${test.id ?? ""})`);
  // declared constants, straight from the RDF (already IRIs)
  const constants = testNode
    ? store.getQuads(testNode, lwst.terms.constants, null, defaultGraph()).map((q) => q.object)
    : [];
  const graphs = testNodes[ti] ? stepGraphs(testNodes[ti]) : [];

  for (let si = 0; si < (test.steps ?? []).length; si++) {
    const step = test.steps[si];
    const stepGraph = graphs[si];
    const ops = Array.isArray(step["@graph"][0]?.operation)
      ? step["@graph"][0].operation
      : [step["@graph"][0]?.operation].filter(Boolean);
    if (ops.length === 0) { console.error(`  NO OPERATION in step ${si}`); failedSteps++; continue; }

    if (!stepGraph) {
      console.error(`  NO GRAPH for step ${si + 1}`);
      failedSteps++;
      continue;
    }
    console.log(`\nstep ${si + 1}`);
    materializeConstants(stepGraph);
    reason();

    // execute: one request per operation in the step
    let stepOk = true;
    for (const op of ops) {
      console.log(`  execute ${op.type} ${String(op.target ?? "")}`);
      // find the operation node's derived request: any op typed by the rules
      let found = false;
      for (const q of store.getQuads(null, rdf.terms.type, http.terms.Request, stepGraph)) {
        const method = one(q.subject, http.terms.mthd, null);
        const uri = one(q.subject, http.terms.absoluteURI, null);
        if (!method || !uri) continue;
        found = true;
        // headers derived by the rules (Accept, Link, ...)
        const headers: Record<string, string> = {};
        for (const hq of store.getQuads(q.subject, http.terms.headers, null, stepGraph)) {
          const h = hq.object;
          const name = one(h, http.terms.fieldName, stepGraph);
          const value = one(h, http.terms.fieldValue, stepGraph);
          if (name && value) headers[name.value] = value.value;
        }
        const methodName = method.value.slice(Math.max(method.value.lastIndexOf("#"), method.value.lastIndexOf("/")) + 1);
        console.log(`  ${methodName} ${uri.value}${Object.keys(headers).length ? ` ${JSON.stringify(headers)}` : ""}`);

        // --- execute ---
        let res: Response;
        try {
          res = await fetch(uri.value, { method: methodName, headers });
        } catch (e: any) {
          console.error(`  request failed: ${e.message}`);
          stepOk = false;
          continue;
        }
        const bodyText = await res.text();
        const contentType = res.headers.get("content-type") ?? "";

        // --- inject the response as HTTP-in-RDF into the step graph ---
        const resp = blankNode();
        store.addQuad(resp, rdf.terms.type, http.terms.Response, stepGraph);
        const scIri = await lookupStatusIri(res.status);
        if (scIri) {
          store.addQuad(resp, http.terms.sc, namedNode(scIri), stepGraph);
        } else {
          console.log(`  (no http:sc for status ${res.status}; vocabulary lookup failed)`);
        }
        const location = res.headers.get("location");
        if (location) {
          const h = blankNode();
          store.addQuad(resp, http.terms.headers, h, stepGraph);
          store.addQuad(h, rdf.terms.type, http.terms.ResponseHeader, stepGraph);
          store.addQuad(h, http.terms.fieldName, literal("Location"), stepGraph);
          store.addQuad(h, http.terms.fieldValue, literal(new URL(location, storageUri).href), stepGraph);
        }
        if (isRdfContentType(contentType)) {
          try {
            const bodyQuads = await parseRdfBody(bodyText, contentType);
            let b: any = null;
            for (const q of bodyQuads) store.addQuad(q.subject, q.predicate, q.object, stepGraph);
            b = blankNode();
            store.addQuad(resp, http.terms.body, b, stepGraph);
            store.addQuad(b, rdf.terms.type, cnt.terms.ContentAsRDF, stepGraph);
            console.log(`  response ${res.status} (${contentType}) — ${bodyQuads.length} body triple(s) into step graph`);
          } catch (e: any) {
            console.log(`  response ${res.status} — could not parse RDF body: ${e.message}`);
          }
        } else {
          const b = blankNode();
          store.addQuad(resp, http.terms.body, b, stepGraph);
          store.addQuad(b, rdf.terms.type, cnt.terms.ContentAsText, stepGraph);
          store.addQuad(b, cnt.terms.chars, literal(bodyText), stepGraph);
          console.log(`  response ${res.status} (${contentType || "no type"})`);
        }

        reason(); // derive param:status-code, param:location, storage-root, bindings...

        // bindings: id -> return were derived by the rules (lwst:value on
        // the return param); report the ones that got a value
        for (const bq of store.getQuads(null, lwst.terms.bindings, null, stepGraph)) {
          const b = bq.object;
          const id = one(b, lwst.terms.id, stepGraph);
          const ret = one(b, lwst.terms.return, stepGraph);
          if (!id || !ret) continue; // shorthand bindings have no id/return
          const v = paramValue(id.value, stepGraph);
          if (v) console.log(`  bound ${short(ret.value)} <- ${short(id.value)} = ${v.value}`);
        }
      }
      if (!found) {
        console.error(`  NO REQUEST DERIVED for ${op.type}`);
        stepOk = false;
      }
    }

    // assertions on this step (any node typed *Assertion in the step graph)
    const assertionNodes = [...new Set(
      [...store.getQuads(null, rdf.terms.type, null, stepGraph)]
        .filter((q) => q.object.termType === "NamedNode" && /Assertion$/.test(q.object.value))
        .map((q) => q.subject),
    )];
    for (const a of assertionNodes) await assertStep(a, stepGraph);
    if (!stepOk) failedSteps++;

    // lift this test's declared constants into the context (default graph)
    await liftConstants(constants, stepGraph);
  }

  // test-level assertions, resolved against the context (default graph)
  console.log(`\n[test-level assertions]`);
  if (testNode) {
    for (const a of store.getQuads(testNode, lwst.terms.assertions, null, defaultGraph()).map((q) => q.object)) {
      await assertStep(a, defaultGraph());
    }
  }
}

// 4. summary
console.log(`\n=== ${jsonLd.tests.length} test case(s): ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped${failedSteps ? `, ${failedSteps} step error(s)` : ""}`);
process.exit(report.failed > 0 || failedSteps > 0 ? 1 : 0);