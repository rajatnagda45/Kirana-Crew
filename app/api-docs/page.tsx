import { notFound } from "next/navigation";
import { NAMMAOPS_OPENAPI } from "@/lib/server/nammaops/openapi.mjs";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const metadata = { title: "KiranaCrew API reference" };

const METHOD_COLOURS: Record<string, string> = { get: "#2f855a", post: "#2b6cb0" };
const pre = (value: unknown) => JSON.stringify(value, null, 2);

/** Development reference for the KiranaCrew REST API, rendered from the served OpenAPI document. */
export default function ApiDocsPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const spec: Any = NAMMAOPS_OPENAPI;
  return (
    <main
      style={{
        maxWidth: 1000,
        margin: "0 auto",
        padding: "24px 16px 64px",
        fontFamily: "system-ui, sans-serif",
        lineHeight: 1.5,
        color: "#e2e8f0",
        background: "#0f141b",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 26 }}>{spec.info.title}</h1>
      <p>{spec.info.description}</p>
      <p>
        Machine-readable: <a href="/api/nammaops/openapi.json">/api/nammaops/openapi.json</a>{" "}
        (OpenAPI {spec.openapi}). Development only; this page is not served in production.
      </p>
      {Object.entries(spec.paths).map(([path, operations]: [string, Any]) =>
        Object.entries(operations).map(([method, op]: [string, Any]) => (
          <section
            key={`${method} ${path}`}
            id={`${method}-${path}`}
            style={{ border: "1px solid #2d3748", borderRadius: 10, padding: 16, margin: "16px 0" }}
          >
            <h2 style={{ fontSize: 17, margin: 0, wordBreak: "break-all" }}>
              <span
                style={{
                  background: METHOD_COLOURS[method] ?? "#4a5568",
                  color: "white",
                  borderRadius: 6,
                  padding: "2px 8px",
                  marginRight: 8,
                  textTransform: "uppercase",
                  fontSize: 13,
                }}
              >
                {method}
              </span>
              <code>{path}</code>
            </h2>
            <p style={{ margin: "8px 0 0" }}>
              <strong>{op.summary}</strong>
            </p>
            {op.description ? <p style={{ color: "#a0aec0" }}>{op.description}</p> : null}
            {op.requestBody ? (
              <details>
                <summary>Request body</summary>
                <pre style={{ overflowX: "auto", fontSize: 12 }}>
                  {pre(
                    op.requestBody.content["application/json"].example ??
                      op.requestBody.content["application/json"].schema,
                  )}
                </pre>
              </details>
            ) : null}
            {Object.entries(op.responses).map(([code, response]: [string, Any]) => (
              <details key={code}>
                <summary>
                  <code>{code}</code> {response.description}
                </summary>
                <pre style={{ overflowX: "auto", fontSize: 12, maxHeight: 360 }}>
                  {pre(
                    response.content?.["application/json"]?.example ??
                      response.content?.["application/json"]?.schema ??
                      {},
                  )}
                </pre>
              </details>
            ))}
          </section>
        )),
      )}
      <h2>Schemas</h2>
      {Object.entries(spec.components.schemas).map(([name, schema]) => (
        <details key={name} style={{ margin: "6px 0" }}>
          <summary>
            <code>{name}</code>
          </summary>
          <pre style={{ overflowX: "auto", fontSize: 12 }}>{pre(schema)}</pre>
        </details>
      ))}
    </main>
  );
}
