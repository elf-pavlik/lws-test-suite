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
import jsonld from "jsonld";
import LWS_TEST_CONTEXT from "./context.json" with { type: "json" };
import LWS_V1_CONTEXT from "./lws-v1.context.json" with { type: "json" };

export { LWS_TEST_CONTEXT };

/** IRI under which the context is published / served locally. */
export const LWS_TEST_CONTEXT_IRI = "https://w3id.org/lws/test/context";

/** IRI of the LWS vocabulary context document. */
export const LWS_V1_CONTEXT_IRI = "https://www.w3.org/ns/lws/v1";

const remoteLoader = jsonld.documentLoaders.node();
const contextCache = new Map<string, any>();

/**
 * JSON-LD document loader:
 * - serves the suite context (context.json) under its IRI
 * - serves the LWS v1 context (lws-v1.context.json) under its IRI, so
 *   response bodies can be expanded without the unpublished document
 * - fetches and caches any other remote context document
 */
export async function documentLoader(url: string, options: any): Promise<any> {
  if (url === LWS_TEST_CONTEXT_IRI) {
    return { contextUrl: null, document: { "@context": LWS_TEST_CONTEXT }, documentUrl: url };
  }
  if (url === LWS_V1_CONTEXT_IRI) {
    return { contextUrl: null, document: LWS_V1_CONTEXT, documentUrl: url };
  }
  if (contextCache.has(url)) {
    return { contextUrl: null, document: contextCache.get(url), documentUrl: url };
  }
  const res = await remoteLoader(url, options);
  contextCache.set(url, res.document);
  return res;
}