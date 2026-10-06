/**
 * LWS test-suite JSON-LD context + document loader.
 *
 * The context itself lives in context.json (plain data, importable/readable
 * from any tool) and is published under
 * https://w3id.org/lws/test/context. Tools that convert manifests
 * (harness.ts, converters, ...) load it through documentLoader(), so the
 * context and the auxiliary context documents (e.g. the unpublished
 * https://www.w3.org/ns/lws/v1) resolve locally instead of failing over the
 * network.
 */
import { readFileSync } from "node:fs";
import jsonld from "jsonld";
import LWS_TEST_CONTEXT from "./context.json" with { type: "json" };
import LWS_V1_CONTEXT from "./lws-v1.context.json" with { type: "json" };
import LINKSET_CONTEXT from "./linkset.context.json" with { type: "json" };
import STORAGE_DESCRIPTION_SCHEMA from "./schema/json/storage-description.json" with { type: "json" };

export { LWS_TEST_CONTEXT };

/** IRI under which the context is published / served locally. */
export const LWS_TEST_CONTEXT_IRI = "https://w3id.org/lws/test/context";

/** IRI of the LWS vocabulary context document. */
export const LWS_V1_CONTEXT_IRI = "https://www.w3.org/ns/lws/v1";

/**
 * JSON-LD context for RFC 9264 linksets (served locally, same strategy as
 * the other contexts). It maps the linkset JSON keys (anchor/href/linkset)
 * to @id/@graph and expands registered relation names such as "up" to
 * IANA relation type IRIs (http://www.iana.org/assignments/relation/...).
 */
export const LINKSET_CONTEXT_IRI = "https://w3id.org/lws/test/context/linkset";

/**
 * JSON Schemas published under https://w3id.org/lws/test/schema/json/ and
 * ShEx shapes published under https://w3id.org/lws/test/shape/, served
 * locally from the repo under their published IRIs (same strategy as the
 * context documents: manifests reference the IRI, the harness resolves the
 * local copy; once published and updated upstream they would be fetched
 * remotely instead).
 */
export const LWS_STORAGE_DESCRIPTION_SCHEMA_IRI =
  "https://w3id.org/lws/test/schema/json/storage-description";

export const LWS_STORAGE_DESCRIPTION_SHAPE_IRI =
  "https://w3id.org/lws/test/shape/storage-description";

/** ShExC text (not JSON), read at module load like the JSON imports above. */
const STORAGE_DESCRIPTION_SHAPE = readFileSync(
  new URL("./shape/storage-description.shex", import.meta.url),
  "utf8",
);

const localDocuments = new Map<string, any>([
  [LWS_STORAGE_DESCRIPTION_SCHEMA_IRI, STORAGE_DESCRIPTION_SCHEMA],
  [LWS_STORAGE_DESCRIPTION_SHAPE_IRI, STORAGE_DESCRIPTION_SHAPE],
]);

const remoteLoader = jsonld.documentLoaders.node();
const contextCache = new Map<string, any>();

/**
 * Document loader:
 * - serves the suite context (context.json) under its IRI
 * - serves the LWS v1 context (lws-v1.context.json) under its IRI, so
 *   response bodies can be expanded without the unpublished document
 * - serves the local JSON schemas (schema/json/*.json) and ShEx shapes
 *   (shape/*.shex) under their published IRIs, so tests can validate
 *   bodies against the local copy while referencing the IRI
 * - fetches and caches any other remote document
 */
export async function documentLoader(url: string, options: any): Promise<any> {
  if (url === LWS_TEST_CONTEXT_IRI) {
    return { contextUrl: null, document: { "@context": LWS_TEST_CONTEXT }, documentUrl: url };
  }
  if (url === LWS_V1_CONTEXT_IRI) {
    return { contextUrl: null, document: LWS_V1_CONTEXT, documentUrl: url };
  }
  if (url === LINKSET_CONTEXT_IRI) {
    return { contextUrl: null, document: LINKSET_CONTEXT, documentUrl: url };
  }
  const localDocument = localDocuments.get(url);
  if (localDocument) {
    return { contextUrl: null, document: localDocument, documentUrl: url };
  }
  if (contextCache.has(url)) {
    return { contextUrl: null, document: contextCache.get(url), documentUrl: url };
  }
  const res = await remoteLoader(url, options);
  contextCache.set(url, res.document);
  return res;
}