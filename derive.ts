/**
 * Derive HTTP-in-RDF exchanges from a suite definition whose steps are
 * high-level LWS operations (lwst:CreateResource, lwst:ReadResource,
 * lwst:UpdateResource, lwst:DeleteResource):
 *
 *   1. resolve every lwst:target template to a concrete
 *      http:absoluteURI (execution parameters come from --env, or the
 *      built-in example values below)
 *   2. run the N3 rules with the n3.js reasoner -- every operation
 *      becomes an http:Request with method details and (where the rules
 *      define one) an lwst:expectedResponse, all in HTTP-in-RDF terms
 *   3. write the enriched graph and print a per-step summary
 *
 * In a real harness the extracted parameters (storageRoot, newResource,
 * ...) become known step by step as responses arrive; the static
 * environment stands in for them so the whole suite can be derived.
 *
 * Usage: bun derive.ts <suite.ttl> <rules.n3> <output.ttl> [env.json]
 */
import { readFile, writeFile } from "node:fs/promises";
import { DataFactory, Parser, Reasoner, Store, Writer } from "n3";

const { namedNode } = DataFactory;

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const HTTP = "http://www.w3.org/2011/http#";
const LWST = "https://www.w3.org/ns/lws-tests/v1#";

const [, , suitePath, rulesPath, outPath, envPath] = process.argv;

if (!suitePath || !rulesPath || !outPath) {
  console.error("Usage: bun derive.ts <suite.ttl> <rules.n3> <output.ttl> [env.json]");
  process.exit(1);
}

// Example environment standing in for execution-time extractor bindings.
const env: Record<string, string> = {
  baseUri: "https://storage.example",
  storageRoot: "https://storage.example/alice/",
  newResource: "https://storage.example/alice/cc55f71c-0bb7-4d5e-9f21-2a1b3c4d5e6f",
  ...(envPath ? JSON.parse(await readFile(envPath, "utf8")) : {}),
};

const data = new Store(new Parser().parse(await readFile(suitePath, "utf8")));

const objectOf = (s: any, p: string) =>
  data.getQuads(s, namedNode(p), null, null)[0]?.object;

// 1. Resolve lwst:target templates to http:absoluteURI IRIs
for (const q of data.getQuads(null, namedNode(LWST + "target"), null, null)) {
  const template = q.object;
  let iri: string | undefined;
  const param = objectOf(template, LWST + "param");
  if (param) {
    iri = env[param.value];
  } else {
    const base = objectOf(objectOf(template, LWST + "base"), LWST + "param");
    const relative = objectOf(template, LWST + "relative");
    if (base && relative) iri = new URL(relative.value, env[base.value]).href;
  }
  if (!iri) {
    console.error(`Cannot resolve target of ${q.subject.value}: unbound parameter`);
    process.exit(1);
  }
  data.addQuad(q.subject, namedNode(HTTP + "absoluteURI"), namedNode(iri));
}

// 2. Run the N3 rules (Basic Graph Patterns only; rules are a separate
//    dataset, reason() mutates the data store with derived quads)
const rules = new Store(
  new Parser({ format: "text/n3" }).parse(await readFile(rulesPath, "utf8")),
);
new Reasoner(data).reason(rules);

// 3. Summarize, walking the RDF lists in document order
const listItems = (head: any): any[] => {
  const items = [];
  while (head && head.value !== RDF + "nil") {
    items.push(objectOf(head, RDF + "first"));
    head = objectOf(head, RDF + "rest");
  }
  return items;
};

const localName = (iri: string) => iri.slice(Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/")) + 1);

let failures = 0;
const suite = data.getQuads(null, namedNode(LWST + "tests"), null, null)[0]?.subject;
for (const test of listItems(objectOf(suite, LWST + "tests"))) {
  console.log(`\n${objectOf(test, "https://www.w3.org/ns/test-manifest#name")?.value}`);
  for (const step of listItems(objectOf(test, LWST + "steps"))) {
    const op = objectOf(step, RDF + "type")?.value;
    const method = objectOf(step, HTTP + "methodName")?.value;
    const uri = objectOf(step, HTTP + "absoluteURI")?.value;
    const expects = objectOf(step, LWST + "expects");
    const status = expects && objectOf(expects, HTTP + "statusCodeValue")?.value;
    if (!method || !uri) {
      console.error(`  ${localName(op)}: NO REQUEST DERIVED`);
      failures++;
      continue;
    }
    console.log(
      `  ${localName(op)} -> ${method} ${uri}` + (status ? `  (expects ${status})` : ""),
    );
  }
}

if (failures) process.exit(1);

const writer = new Writer({
  prefixes: {
    rdf: RDF,
    http: HTTP,
    methods: "http://www.w3.org/2011/http-methods#",
    headers: "http://www.w3.org/2011/http-headers#",
    statuses: "http://www.w3.org/2011/http-statusCodes#",
    lwst: LWST,
    mf: "https://www.w3.org/ns/test-manifest#",
    rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  },
});
for (const quad of data) writer.addQuad(quad);
const ttl = await new Promise<string>((resolve, reject) =>
  writer.end((error, result) => (error ? reject(error) : resolve(result))),
);
await writeFile(outPath, ttl);
console.log(`\nWrote ${outPath}`);
