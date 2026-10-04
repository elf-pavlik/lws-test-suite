# LWS Rules-Based Test Harness

Design and behavior of the N3-rules + SPARQL conformance harness (`harness.ts`)
and the suite format it runs (`lws10/tests.yaml` + `lws10/rules.n3`).

## Model: one RDF dataset

The manifest is a **document** (YAML/JSON-LD). The harness converts it to RDF
**abstract syntax** as a single **RDF dataset** (terminology per
[RDF Graph Terminology](https://www.w3.org/2011/rdf-wg/wiki/Graph_Terminology)):

- **default graph** — the *test-case context*: suite/test metadata, the
  `TestCase` node, `inputs`, `constants`, test-level assertions, and the
  accumulated parameter bindings;
- **named graphs** — one per step.

Each step graph has a proper **graph name**: the authored IRI when the manifest
provides one, otherwise the internal `urn:uuid:<randomUUID()>` the harness mints
for the blank identifier jsonld assigned. This makes the dataset **ground** with
respect to graph names — every graph is addressable from SPARQL
(`GRAPH <…>`) and rule conclusions alike.

### Parameters are IRIs

A parameter is a constant IRI (`param:status-code`,
`param:new-resource`, …), *bound* to its value with a triple:

```
param:new-resource lwst:value <https://storage.example/root/r1>
```

The same representation serves:
- **inputs** (seeded by the harness from the storage URI, e.g. `param:storage`),
- **response-derived values** (`param:status-code`, `param:location`,
  `param:content`, `param:storage-root`),
- **bindings** (`id`/`return`: copy the value named by `lwst:id` to the param
  named by `lwst:return`),
- **cached/test-level assertions** (`received` vs `expected`).

### Operation classes, not step procedures

Tests are written as higher-level **operations** (`lwst:ReadResource`,
`lwst:CreateDataResource`, `lwst:CreateContainer`, `lwst:ReadContainer`,
`lwst:ReadStorageDescription`, `lwst:UpdateResource`, `lwst:DeleteResource`,
generic `lwst:CreateResource`). Reuse lives at the **type level**: each class
has one N3 rule carrying the full protocol binding (method, and where constant
per operation — `Accept`, `Link` — the headers).

```n3
{ ?op a lwst:ReadContainer ;
    lwst:target ?target .
  ?target lwst:value ?uri }
=> { ?op a http:Request ; http:absoluteURI ?uri ; http:mthd methods:GET ;
     http:headers [ a http:RequestHeader ; http:fieldName "Accept" ;
                    http:fieldValue "application/lws+json" ] } .
```

The manifest instance is thin — type + target + bindings + assertions — and per
test case there is one instance per step (forward-chaining rules fire over
individuals, and each instance sits in its own graph for run isolation). This
differs from LWS.net, which reuses concrete *step definitions* (request
templates) from a shared pool; here the step definition's protocol details
(`method: POST`, headers, …) live once per class in `rules.n3`.

Rules deliberately use only Basic Graph Patterns (n3.js reasoner), with two
consequences:

- **targets resolve via `lwst:value`** — the operation's `lwst:target` is a
  parameter IRI; its bound value becomes `http:absoluteURI`. Relative-URI
  construction (`base` + `relative`) needs string operations the reasoner
  cannot express (see Open decisions).
- **conclusion blank nodes are created once per rule, not per firing** — so
  per-step data attaches to the operation node itself (the operation doubles
  as the `http:Request`), and constant header content on our shared nodes is
  safe only because it never varies per firing.

## Execution

For each test case, for each step, in order:

1. **Materialize** — copy the constants the step references (any `param:*`
   term in the step graph) from the default graph into the step's named graph.
   Rule premises cannot join across graphs, so target params must sit in the
   same graph as the operation.
2. **Reason** — run `rules.n3` once; premises are matched within a step graph,
   conclusions are added to the same graph (per-graph inferences, one run per
   dataset). This derives the request.
3. **Execute** — read `http:mthd`, `http:absoluteURI`, `http:headers` from the
   step graph and `fetch` the SUT (the server under test; the cell passes its
   base URL as `LWS_STORAGE`, seeded as the `param:storage` input).
4. **Inject** — add the response as basic HTTP-in-RDF triples **into the step
   graph**: `http:sc` (the status-code IRI, looked up from the cached
   vocabulary via SPARQL), the `Location` header (resolved to absolute), and
   the body (RDF bodies — the `application/lws+cid` storage description —
   parsed and flattened into the same graph as `cnt:ContentAsRDF`; other bodies
   as `cnt:ContentAsText`).
5. **Reason again** — response-driven derivations land in the step graph:
   `param:status-code` (from `http:sc`), `param:location` (Location header
   value), `param:content` (body node), `param:storage-root` (the
   `lws:StorageRoot` service endpoint in a parsed description), and `id → return`
   binding copies.
6. **Assert** — evaluation happens on RDF assertion nodes (any `*Assertion`
   typed node in the step graph, or the default graph for test-level
   assertions): `IdentityAssertion` compares the `received` param's bound value
   against `expected`; `ExistanceAssertion` checks the param is bound; unknown
   types (`ShapeAssertion`, …) are skipped. Values that are not NamedNode /
   Literal are skipped.
7. **Lift** — a SPARQL CONSTRUCT picks the test's declared `constants` values
   from the step graph and **merges** them into the default graph. This is the
   propagation mechanism: the next step's *materialize* pulls from the growing
   context, and test-level assertions resolve against it.

Each request/response exchange is thus isolated in its own named graph
(inference closure, params, response), while the default graph accumulates the
shared run state across steps.

## Rules vs. SPARQL

- **rules (n3.js Reasoner)** — inference: operation → `http:Request`,
  response → well-known params, storage-root, binding copies. Pure BGP, no
  string operations, no cross-graph joins.
- **SPARQL (`@comunica/query-sparql-rdfjs`)** — *moving facts*: graph-scoped
  `SELECT`/looking up and the `CONSTRUCT` that lifts constants into the
  default graph (re-insertion is idempotent). Status-code `http:sc` lookup also
  runs over a second store holding the cached vocabulary.

## Contexts & documents

| local file | IRI it serves | origin |
|---|---|---|
| `context.json` | `https://w3id.org/lws/test/context` | authored by hand; the suite's canonical context |
| `lws-v1.context.json` | `https://www.w3.org/ns/lws/v1` | generated (`bun run context:lws-v1`) from `w3c/lws-protocol` `lws10-vocab` via `yml2vocab` |
| `lws10/http-statusCodes.ttl` | (lookup store, not served) | cached conversion of the W3C RDF/XML status-codes vocabulary |

`documentLoader()` (`context.ts`) serves the two contexts locally and
fetches/caches any remote context document, so conversion never depends on
the unpublished `lws/v1` or on repeated network calls. The context includes
`@id` coercions for every reference-bearing term (`inputs`, `constants`,
`target`, `received`, `expected`, `validate`, `id`, `return`, `bindings`) and
type-scoped contexts for the assertion types so `expected: http-status:OK`
becomes a real status-code IRI in RDF.

## Report

Each assertion logs `PASS`/`FAIL`/`SKIP` with the received value; the summary
prints totals and the harness exits non-zero on any failure, so a dagger cell
fails for the suite.

Dagger: the `rules` harness cell in `dagger-workspace` runs
`bun harness.ts lws10/tests.yaml lws10/rules.n3` in an `oven/bun` container
with the SUT bound as a service, `LWS_STORAGE` set to its base URL; the suite
source defaults to the `n3` branch of `elf-pavlik/lws-test-suite`
(`--tests` overrides with a local checkout).

## Open decisions / gaps

- **base + relative target templates** — no rule can construct URIs; targets
  are prebound absolute values (`lwst:value`). Support for dynamic
  `{base}/{relative}` needs harness-side resolution before reasoning.
- **Numeric status parameter** — assertions compare status-code IRIs; a literal
  form (`param:status-code-value` from `http:statusCodeValue`) is available if
  numeric `EqualityAssertion`-style tests are wanted.
- **Shared step library (`@included`)** — LWS.net-style reuse of step
  definitions requires dereferencing `@id` refs and mounting per-(test, step)
  run graphs; the class/rule layer is untouched.
- **Generic JSONPath extractors** — only RDF-parseable bodies are currently
  inspected (storage description); a general `path:` extractor for non-RDF
  bodies has no counterpart yet.

## References

- [HTTP Vocabulary in RDF](https://www.w3.org/TR/HTTP-in-RDF10/) — the
  HTTP-in-RDF vocabulary used for request/response descriptions
  (`http:Request`, `http:mthd`, `http:absoluteURI`, `http:headers`,
  `http:Response`, `http:sc`, `http:statusCodeValue`, …)
- [Representing Content in RDF 1.0](https://www.w3.org/TR/Content-in-RDF10/) —
  content modeling for response bodies (`cnt:ContentAsRDF` / `cnt:graph` for
  RDF content, `cnt:ContentAsText` for other bodies)
- [HTTP Status Codes vocabulary](https://www.w3.org/2011/http-statusCodes) —
  the source of the cached `lws10/http-statusCodes.ttl` used to resolve
  response status codes to their IRI form