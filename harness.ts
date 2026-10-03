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
import { DataFactory, Parser, Reasoner, Store } from "n3";
import { QueryEngine } from "@comunica/query-sparql-rdfjs";
import { parse as parseYaml } from "yaml";
import jsonld from "jsonld";

const { namedNode, blankNode, literal, defaultGraph } = DataFactory;

const RDF = {
  type: namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
};
const HTTP = "http://www.w3.org/2011/http#";
const METHODS = "http://www.w3.org/2011/http-methods#";
const STATUSES = "http://www.w3.org/2011/http-statusCodes#";
const LWST = "https://www.w3.org/ns/lws-tests/v1#";
const PARAM = "https://w3id.org/lws/test/param#";
const CNT = "http://www.w3.org/2011/content#";

const p = (ns: string, name: string) => namedNode(ns + name);
const pv = (ns: string, name: string) => namedNode(ns + name); // value node

const lwst = {
  value: p(LWST, "value"),
  operation: p(LWST, "operation"),
  target: p(LWST, "target"),
  inputs: p(LWST, "inputs"),
  constants: p(LWST, "constants"),
  bindings: p(LWST, "bindings"),
  assertions: p(LWST, "assertions"),
  steps: p(LWST, "steps"),
};

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

/** Expand the compact IRIs the manifest uses ("param:x", "http-status:OK"). */
const expand = (v: string): string => {
  if (v.startsWith("param:")) return PARAM + v.slice("param:".length);
  if (v.startsWith("http-status:")) return STATUSES + v.slice("http-status:".length);
  return v;
};

/**
 * The manifest's context: keep the author's terms, drop @list containers,
 * add the http-status prefix and force @id coercion on every property that
 * holds a parameter / status / shape reference (JSON-LD keeps uncoerced
 * compact IRIs in plain string values as literals, which would break the
 * rules' IRI matching).
 */
function manifestContext(doc: any): any {
  const ctx = { ...(doc["@context"] ?? {}), "http-status": STATUSES };
  for (const key of ["tests", "steps", "extractors", "bindings", "assertions"]) {
    const term = ctx[key];
    if (term && typeof term === "object") {
      ctx[key] = { ...term };
      delete ctx[key]["@container"];
    }
  }
  const asIri = (pred: string) => ({ "@id": pred, "@type": "@id" });
  const ctx2: Record<string, any> = {
    ...ctx,
    inputs: asIri(LWST + "inputs"),
    constants: asIri(LWST + "constants"),
    target: asIri(LWST + "target"),
    received: asIri(LWST + "received"),
    expected: asIri(LWST + "expected"),
    validate: asIri(LWST + "validate"),
    id: asIri(LWST + "id"),
    return: asIri(LWST + "return"),
    bindings: { "@id": LWST + "bindings", "@type": "@id" },
  };
  return ctx2;
}

/** Reshape the manifest into JSON-LD with a named graph per step. */
function toJsonLd(doc: any): any {
  const context = manifestContext(doc);
  const tests = (doc.tests ?? []).map((t: any, ti: number) => {
    const steps = (t.steps ?? []).map((s: any, si: number) => {
      const { ["@graph"]: _marker, ...body } = s; // current manifests use "@graph": null as a marker
      const graphId = `https://w3id.org/lws/test/case/${encodeURIComponent(t.id ?? `test-${ti}`)}/step/${si}`;
      return { "@id": graphId, "@graph": [body] };
    });
    return { ...t, steps };
  });
  // NB: @context must come AFTER the ...doc spread, or the manifest's own
  // (uncoerced) context would override the coercion terms above.
  return { ...doc, "@context": context, tests };
}

// documentLoader: cache remote contexts; stub the unpublished lws/v1 context
const remoteLoader = jsonld.documentLoaders.node();
const contextCache = new Map<string, any>();
const LWS_V1_STUB = {
  "@context": {
    Storage: "https://www.w3.org/ns/lws#Storage",
    StorageRoot: "https://www.w3.org/ns/lws#StorageRoot",
    Container: "https://www.w3.org/ns/lws#Container",
    DataResource: "https://www.w3.org/ns/lws#DataResource",
  },
};
const documentLoader = async (url: string, options: any) => {
  if (url === "https://www.w3.org/ns/lws/v1") {
    return { contextUrl: null, document: LWS_V1_STUB, documentUrl: url };
  }
  if (contextCache.has(url)) {
    return { contextUrl: null, document: contextCache.get(url), documentUrl: url };
  }
  const res = await remoteLoader(url, options);
  contextCache.set(url, res.document);
  return res;
};

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
const nquads = (await jsonld.toRDF(jsonLd, { format: "application/n-quads" })) as string;
const store = new Store();
for (const quad of new Parser({ format: "N-Quads" }).parse(nquads)) store.addQuad(quad);

// rules
const rules = new Store(new Parser({ format: "text/n3" }).parse(await readFile(rulesPath, "utf8")));
const reason = () => new Reasoner(store).reason(rules);

// SPARQL engine over the same store (default graph = test-case context)
const engine = new QueryEngine();

// 2. seed inputs into the default graph (test-case context)
const inputIris = new Set<string>();
for (const q of store.getQuads(null, lwst.inputs, null, defaultGraph())) {
  if (q.object.termType === "NamedNode") inputIris.add(q.object.value);
}
if (inputIris.size === 0) {
  console.error("no inputs found in manifest (expected lwst:inputs with param terms)");
}
for (const iri of inputIris) {
  store.addQuad(namedNode(iri), lwst.value, namedNode(storageUri), defaultGraph());
  console.log(`input  ${iri} = ${storageUri}`);
}

// helpers
const one = (s: any, pred: any, graph?: any) =>
  store.getQuads(s, pred, null, graph ?? null)[0]?.object;
const paramValue = (iri: string, graph?: any) =>
  one(namedNode(iri), lwst.value, graph);

/** Materialize the constants referenced inside a step graph, from the context. */
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
      store.addQuad(namedNode(iri), lwst.value, v, stepGraph);
      copied++;
    }
  }
  if (copied) {
    console.log(`  materialized ${copied} constant(s) into ${stepGraph.value}`);
  }
}

/** Scoreboard. */
const report = { passed: 0, failed: 0, skipped: 0 };
function check(label: string, ok: boolean, detail: string) {
  if (ok) report.passed++; else report.failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Evaluate one assertion; expects {type, received, expected?, validate?, ...}. */
async function assertStep(a: any, stepGraph: any, context: "step" | "test") {
  const type = a.type ?? "(unknown)";
  const received = a.received;
  if (!received) {
    report.skipped++;
    console.log(`  SKIP ${type} — no received param`);
    return;
  }
  const receivedIri = expand(String(received));
  const value = context === "step"
    ? (paramValue(receivedIri, stepGraph) ?? paramValue(receivedIri, defaultGraph()))
    : paramValue(receivedIri, defaultGraph());
  const got = value
    ? value.termType === "NamedNode" ? value.value
      : value.termType === "Literal" ? value.value : value.id
    : undefined;

  if (type === "ExistanceAssertion") {
    check(`ExistanceAssertion ${received}`, got !== undefined, got ?? "not bound");
    return;
  }
  if (type !== "IdentityAssertion") {
    report.skipped++;
    console.log(`  SKIP ${type} (unsupported)`);
    return;
  }
  const expected = expand(String(a.expected ?? ""));
  check(`IdentityAssertion ${received} == ${a.expected}`, got === expected, `received=${got ?? "∅"}`);
}

/** Lift the test's declared constants from a step graph into the context. */
async function liftConstants(constants: string[], stepGraph: any) {
  const iris = constants.map((c) => namedNode(expand(String(c))));
  if (iris.length === 0) return;
  const values = `VALUES ?p { ${iris.map((i) => `<${i.value}>`).join(" ")} }`;
  const quads = await engine.queryQuads(
    `CONSTRUCT { ?p <${LWST}value> ?v } ` +
    `WHERE { GRAPH <${stepGraph.value}> { ${values} ?p <${LWST}value> ?v } }`,
    { sources: [store] },
  );
  let lifted = 0;
  for await (const q of quads) {
    store.addQuad(q.subject, q.predicate, q.object, defaultGraph());
    lifted++;
  }
  if (lifted) console.log(`  lifted ${lifted} constant(s) to context`);
}

// 3. run the tests
let failedSteps = 0;
for (let ti = 0; ti < jsonLd.tests.length; ti++) {
  const test = jsonLd.tests[ti];
  console.log(`\n# ${test.name ?? test.id ?? `test-${ti}`} (${test.id ?? ""})`);
  const constants: string[] = (test.constants ?? []).map(String);

  for (let si = 0; si < (test.steps ?? []).length; si++) {
    const step = test.steps[si];
    const stepGraph = namedNode(step["@id"]);
    const ops = Array.isArray(step["@graph"][0]?.operation)
      ? step["@graph"][0].operation
      : [step["@graph"][0]?.operation].filter(Boolean);
    if (ops.length === 0) { console.error(`  NO OPERATION in step ${si}`); failedSteps++; continue; }

    console.log(`\nstep ${si + 1} <${stepGraph.value}>`);
    materializeConstants(stepGraph);
    reason();

    // execute: one request per operation in the step
    let stepOk = true;
    for (const op of ops) {
      console.log(`  execute ${op.type} ${String(op.target ?? "")}`);
      // find the operation node's derived request: any op typed by the rules
      let found = false;
      for (const q of store.getQuads(null, RDF.type, pv(HTTP, "Request"), stepGraph)) {
        const method = one(q.subject, pv(HTTP, "mthd"), null);
        const uri = one(q.subject, pv(HTTP, "absoluteURI"), null);
        if (!method || !uri) continue;
        found = true;
        // headers derived by the rules (Accept, Link, ...)
        const headers: Record<string, string> = {};
        for (const hq of store.getQuads(q.subject, pv(HTTP, "headers"), null, stepGraph)) {
          const h = hq.object;
          const name = one(h, pv(HTTP, "fieldName"), stepGraph);
          const value = one(h, pv(HTTP, "fieldValue"), stepGraph);
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
        const resp = namedNode(`${stepGraph.value}/response`);
        store.addQuad(resp, RDF.type, pv(HTTP, "Response"), stepGraph);
        const scIri = await lookupStatusIri(res.status);
        if (scIri) {
          store.addQuad(resp, pv(HTTP, "sc"), namedNode(scIri), stepGraph);
        } else {
          console.log(`  (no http:sc for status ${res.status}; vocabulary lookup failed)`);
        }
        const location = res.headers.get("location");
        if (location) {
          const h = blankNode();
          store.addQuad(resp, pv(HTTP, "headers"), h, stepGraph);
          store.addQuad(h, RDF.type, pv(HTTP, "ResponseHeader"), stepGraph);
          store.addQuad(h, pv(HTTP, "fieldName"), literal("Location"), stepGraph);
          store.addQuad(h, pv(HTTP, "fieldValue"), literal(new URL(location, storageUri).href), stepGraph);
        }
        if (isRdfContentType(contentType)) {
          try {
            const bodyQuads = await parseRdfBody(bodyText, contentType);
            let b: any = null;
            for (const q of bodyQuads) store.addQuad(q.subject, q.predicate, q.object, stepGraph);
            b = blankNode();
            store.addQuad(resp, pv(HTTP, "body"), b, stepGraph);
            store.addQuad(b, RDF.type, pv(CNT, "ContentAsRDF"), stepGraph);
            console.log(`  response ${res.status} (${contentType}) — ${bodyQuads.length} body triple(s) into step graph`);
          } catch (e: any) {
            console.log(`  response ${res.status} — could not parse RDF body: ${e.message}`);
          }
        } else {
          const b = blankNode();
          store.addQuad(resp, pv(HTTP, "body"), b, stepGraph);
          store.addQuad(b, RDF.type, pv(CNT, "ContentAsText"), stepGraph);
          store.addQuad(b, pv(CNT, "chars"), literal(bodyText), stepGraph);
          console.log(`  response ${res.status} (${contentType || "no type"})`);
        }

        reason(); // derive param:status-code, param:location, storage-root, bindings...

        // bindings: id -> return were derived by the rules (lwst:value on return param)
        for (const binding of step["@graph"][0]?.bindings ?? []) {
          if (typeof binding === "string") continue;
          const id = expand(String(binding.id ?? ""));
          const ret = String(binding.return ?? "");
          const v = paramValue(id, stepGraph);
          if (v) console.log(`  bound ${ret} <- ${id} = ${v.value}`);
        }
      }
      if (!found) {
        console.error(`  NO REQUEST DERIVED for ${op.type}`);
        stepOk = false;
      }
    }

    // assertions on this step
    for (const a of step["@graph"][0]?.assertions ?? []) {
      await assertStep(a, stepGraph, "step");
    }
    if (!stepOk) failedSteps++;

    // lift this test's declared constants into the context (default graph)
    await liftConstants(constants, stepGraph);
  }

  // test-level assertions, resolved against the context
  console.log(`\n[test-level assertions]`);
  for (const a of test.assertions ?? []) {
    await assertStep(a, null, "test");
  }
}

// 4. summary
console.log(`\n=== ${jsonLd.tests.length} test case(s): ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped${failedSteps ? `, ${failedSteps} step error(s)` : ""}`);
process.exit(report.failed > 0 || failedSteps > 0 ? 1 : 0);