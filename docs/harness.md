# LWS rules-based test harness

Design and behavior of the N3-rules + SPARQL conformance harness (`harness.ts`)
and the suite format it runs (`lws10/tests.yaml` + `lws10/rules.n3`).

## Model: one RDF dataset

The manifest is a document (YAML/JSON-LD). The harness converts it to RDF
abstract syntax as a single RDF dataset (terminology per
[RDF Graph Terminology](https://www.w3.org/2011/rdf-wg/wiki/Graph_Terminology)):

- the default graph is the test-case context: suite/test metadata, the
  `TestCase` node, `inputs`, `constants`, test-level assertions, and the
  accumulated parameter bindings;
- named graphs hold one step each.

Each step graph has a graph name: the IRI the manifest authored, or the
internal `urn:uuid:<randomUUID()>` the harness mints for the blank identifier
jsonld assigned. Every graph is therefore addressable from SPARQL
(`GRAPH <...>`) and from rule conclusions.

### Parameters are IRIs

A parameter is a constant IRI (`param:status-code`, `param:new-resource`,
...), bound to its value with a triple:

```
param:new-resource lwst:value <https://storage.example/root/r1>
```

The same representation serves inputs (seeded by the harness from the storage
URI, e.g. `param:storage`), response-derived values (`param:status-code`,
`param:location`, `param:content`, `param:storage-root`, `param:content-type`,
`param:up`, `param:linkset`), bindings (`id`/`return` copy the value named by
`lwst:id` to the param named by `lwst:return`), and cached/test-level
assertions (`received` vs `expected`).

### Operation classes, not step procedures

Tests are written as higher-level operations (`lwst:ReadResource`,
`lwst:CreateDataResource`, `lwst:CreateContainer`, `lwst:ReadContainer`,
`lwst:ReadStorageDescription`, `lwst:ReadLinkset`, `lwst:UpdateResource`,
`lwst:DeleteResource`, generic `lwst:CreateResource`). Reuse lives at the
type level: each class has
one N3 rule carrying the full protocol binding (method, and headers such as
`Accept` and `Link` where they are constant per operation).

```n3
{ ?op a lwst:ReadContainer ;
    lwst:target ?target .
  ?target lwst:value ?uri }
=> { ?op a http:Request ; http:absoluteURI ?uri ; http:mthd methods:GET ;
     http:headers [ a http:RequestHeader ; http:fieldName "Accept" ;
                    http:fieldValue "application/lws+json" ] } .
```

The manifest instance is thin: type + target + bindings + assertions. Per test
case there is one instance per step, and each instance sits in its own graph
for run isolation. This differs from LWS.net, which reuses concrete step
definitions (request templates) from a shared pool. Here the protocol details
(`method: POST`, headers, ...) live once per class in `rules.n3`.

Rules use only Basic Graph Patterns (n3.js reasoner), with two consequences:

- Targets resolve via `lwst:value`. The operation's `lwst:target` is a
  parameter IRI; its bound value becomes `http:absoluteURI`. Relative-URI
  construction (`base` + `relative`) needs string operations the reasoner
  cannot express (see Open decisions).
- Conclusion blank nodes are created once per rule, not per firing. Per-step
  data attaches to the operation node itself (the operation doubles as the
  `http:Request`), and constant header content on shared nodes is safe only
  because it never varies per firing.

## Execution

For each test case, for each step, in order:

1. Materialize. Copy the constants the step references (any `param:*` term in
   the step graph) from the default graph into the step's named graph. Rule
   premises cannot join across graphs, so target params must sit in the same
   graph as the operation.
2. Reason. Run `rules.n3` once. Premises are matched within a step graph;
   conclusions land in the same graph. This derives the request.
3. Execute. Read `http:mthd`, `http:absoluteURI`, `http:headers` from the
   step graph and `fetch` the SUT (the server under test; the cell passes its
   base URL as `LWS_STORAGE`, seeded as the `param:storage` input).
4. Inject. Add the response as basic HTTP-in-RDF triples into the step graph:
   `http:sc` (the status-code IRI, looked up from the cached vocabulary via
   SPARQL), every response header as an `http:ResponseHeader` (field names
   lowercased as fetch yields them; `Set-Cookie` one node per cookie), and
   the body. `Location`/`Content-Location` are resolved to absolute against
   the effective request URI (`res.url`); `Content-Type` and `Link` are
   deconstructed into `http:HeaderElement`/`http:Parameter` triples (via the
   `content-type` and `http-link-header` packages), and each Link element also
   gets `lwst:linkTarget` (an IRI) and `lwst:linkRelation` so rules can join
   on them. RDF bodies -- the `application/lws+cid` storage description,
   `application/lws+json` container listings, and RFC 9264
   `application/linkset+json` linksets (expanded with the linkset JSON-LD
   context) -- are parsed and flattened into the same graph as
   `cnt:ContentAsRDF`; other bodies are added as `cnt:ContentAsText`.
5. Reason again. Response-driven derivations land in the step graph:
   `param:status-code` (from `http:sc`), `param:location` (Location header
   value), `param:content` (body node), `param:storage-root` (the
   `lws:StorageRoot` service endpoint in a parsed description),
   `param:content-type` (the media type of a `content-type` header element),
   `param:up`/`param:linkset` (Link-header relations, or the `up` relation
   read from a parsed RFC 9264 linkset), and binding copies from `lwst:id` to
   `lwst:return`.
6. Assert. Evaluate each assertion node on the step graph (or the default
   graph for test-level assertions). See [Assertions](#assertions).
7. Lift. A SPARQL CONSTRUCT picks the test's declared `constants` values from
   the step graph and merges them into the default graph. The next step's
   materialize pulls from the growing context; test-level assertions resolve
   against it.

Each request/response exchange is isolated in its own named graph (inference
closure, params, response), while the default graph accumulates the shared run
state across steps.

## Assertions

An assertion node is any `*Assertion`-typed resource in a step graph, or in
the default graph for test-level assertions. The reference-bearing keys
(`received`, `expected`, `jsonString`, `jsonSchema`, `with`) are params or
IRIs; `expectedLiteral` is a literal; `jsonPath` is a plain string.

- IdentityAssertion. Compares `received` with `expected`, both params. Fails
  when the received value differs from the expected value or is unbound.
  `expectedLiteral` is the same comparison against a literal (an `@id`-
  coerced `expected` cannot hold one), e.g.
  `expectedLiteral: application/lws+json`. Receipt/value resolution and the
  comparison itself run in SPARQL.
- ExistanceAssertion. Checks that `received` is bound to a value; the
  lookup runs in SPARQL.
- MatchJsonPathAssertion. Runs `jsonPath`, a JSONPath expression, against the
  raw response body `jsonString` and compares the result with `expected`.
- ValidateJsonSchemaAssertion. Validates the raw response body `jsonString`
  against the JSON Schema at the `jsonSchema` IRI. The schema resolves through
  `documentLoader()`, which serves the local copy under its published IRI; an
  unresolvable or invalid schema fails the assertion.
- ValidateShapeAssertion. Validates the parsed RDF body `received` (a param
  bound to the `cnt:ContentAsRDF` content node) with the ShEx shape at the
  `with` IRI. The harness checks every subject of the body graph and passes
  when at least one conforms. The shape resolves through `documentLoader()`,
  which serves the local copy under its published IRI.

Values that are neither IRIs nor literals are skipped, as are unsupported
types.

## Rules vs. SPARQL vs. TypeScript

- Rules (n3.js Reasoner) do in-graph inference. An operation becomes an
  `http:Request`; a response derives the well-known params, the storage-root
  value, the header-derived params (`param:content-type`, `param:up`,
  `param:linkset`) and binding copies. Pure BGP, no string operations, no
  cross-graph joins; conclusions land in the graph their premises matched.
- SPARQL (`@comunica/query-sparql-rdfjs`) moves facts and compares values:
  it materializes step constants (a `CONSTRUCT` mirroring the lift), lifts
  declared constants into the default graph (`CONSTRUCT`, idempotent),
  reports bindings and discovers operations (graph-scoped `SELECT`s), and
  evaluates `IdentityAssertion`/`ExistanceAssertion` (per-type `SELECT`s
  whose `?ok` binding does the value comparison). The `http:sc` status-code
  lookup runs over a second store holding the cached vocabulary. Comunica
  skolemizes blank nodes in query results (`bc_<source>_...`), so
  query-discovered blank nodes cannot be fed back into the store; the harness
  keys on stable IRIs instead.
- TypeScript owns the HTTP/parse boundary: `fetch`, the header/body parsers
  (`content-type`, `http-link-header`, jsonld, Turtle), the RFC 9264 linkset
  context injection, URI resolution (`new URL` against `res.url`), and the
  external validators (JSONPath, JSON Schema/Ajv, ShEx).

## Contexts & documents

| local file | IRI it serves | origin |
|---|---|---|
| `context.json` | `https://w3id.org/lws/test/context` | authored by hand; the suite's canonical context |
| `lws-v1.context.json` | `https://www.w3.org/ns/lws/v1` | generated (`bun run context:lws-v1`) from `w3c/lws-protocol` `lws10-vocab` via `yml2vocab`, with a post-patched missing-terms list (`TypeIndexService`, `TypeSearchService`; see `scripts/generate-lws-v1-context.ts`) |
| `linkset.context.json` | `https://w3id.org/lws/test/context/linkset` | RFC 9264 linkset JSON-LD context (local copy; maps `anchor`/`href` to `@id`, `linkset` to `@graph`, registered relation names to IANA relation IRIs) |
| `schema/json/storage-description.json` | `https://w3id.org/lws/test/schema/json/storage-description` | minimal JSON Schema derived from `lws10-core/Discovery.html` § storage description data model |
| `shape/storage-description.shex` | `https://w3id.org/lws/test/shape/storage-description` | minimal ShExC shape, the RDF counterpart of the storage-description schema |
| `lws10/http-statusCodes.ttl` | (lookup store, not served) | cached conversion of the W3C RDF/XML status-codes vocabulary |

`documentLoader()` (`context.ts`) serves the contexts, JSON schemas and ShEx
shapes from the repo under their published IRIs, and fetches and caches any
other remote document. Conversion therefore never depends on the unpublished
`lws/v1`, repeated network calls, or the schema and shape publications landing
before the tests run. The context `@id`-coerces every reference-bearing term
(`inputs`, `constants`, `target`, `received`, `expected`, `validate`, `with`,
`id`, `return`, `bindings`, `jsonSchema`) and carries type-scoped contexts for
the assertion types, so `expected: http-status:OK` becomes a real status-code
IRI in RDF and `jsonSchema: schema:storage-description` stays an IRI in the
`https://w3id.org/lws/test/schema/json/` namespace. (`expectedLiteral` is
deliberately not coerced, so literal comparisons stay literals.) `jsonSchema`
is the manifest property; `schema` the prefix.

## Report

Each assertion logs PASS/FAIL/SKIP with the received value. The summary prints
totals, and the harness exits non-zero on any failure, so a dagger cell fails
for the suite.

Dagger: the `rules` harness cell in `dagger-workspace` runs
`bun harness.ts lws10/tests.yaml lws10/rules.n3` in an `oven/bun` container
with the SUT bound as a service and `LWS_STORAGE` set to its base URL. The
suite source defaults to the `n3` branch of `elf-pavlik/lws-test-suite`;
`--tests` overrides with a local checkout.

## Open decisions / gaps

- Base + relative target templates. No rule can construct URIs; targets are
  prebound absolute values (`lwst:value`). Support for dynamic
  `{base}/{relative}` needs harness-side resolution before reasoning.
- Numeric status parameter. Assertions compare status-code IRIs; a literal
  form (`param:status-code-value` from `http:statusCodeValue`) is available if
  numeric `EqualityAssertion`-style tests are wanted.
- Shared step library (`@included`). LWS.net-style reuse of step definitions
  requires dereferencing `@id` refs and mounting per-(test, step) run graphs;
  the class/rule layer is untouched.
- Generic JSONPath extractors. JSONPath/JSON Schema run against the raw body
  text; a general `path:` extractor that binds a param from a JSONPath result
  in a non-RDF body has no counterpart yet.

## References

- [Web Linking (RFC 8288)](https://www.rfc-editor.org/rfc/rfc8288). The Link
  header syntax (parsed with `http-link-header`) and the IANA link-relation
  IRIs (`http://www.iana.org/assignments/relation/...`) used for
  `param:up`/`param:linkset`.
- [Linkset: Media Types and Link Relations (RFC 9264)](https://www.rfc-editor.org/rfc/rfc9264).
  The `application/linkset+json` media type and its JSON-LD context
  (`linkset.context.json`), used by `lwst:ReadLinkset`.
- [HTTP Vocabulary in RDF](https://www.w3.org/TR/HTTP-in-RDF10/). The
  HTTP-in-RDF vocabulary used for request/response descriptions
  (`http:Request`, `http:mthd`, `http:absoluteURI`, `http:headers`,
  `http:Response`, `http:sc`, `http:statusCodeValue`, `http:HeaderElement`,
  `http:Parameter`, ...)
- [Representing Content in RDF 1.0](https://www.w3.org/TR/Content-in-RDF10/).
  Content modeling for response bodies (`cnt:ContentAsRDF` / `cnt:graph` for
  RDF content, `cnt:ContentAsText` for other bodies)
- [HTTP Status Codes vocabulary](https://www.w3.org/2011/http-statusCodes).
  The source of the cached `lws10/http-statusCodes.ttl` used to resolve
  response status codes to their IRI form
