// api/context7-docs.ts - live demo of our Context7 MCP integration.
//
// Speaks the Model Context Protocol (JSON-RPC over Streamable HTTP) to the hosted
// Context7 MCP server — the same server registered for the dev workflow in .mcp.json.
// GET /api/context7-docs?library=react&query=how+to+use+hooks resolves the library
// through the resolve-library-id tool, then fetches up-to-date docs via query-docs.
//
// Optional: set CONTEXT7_API_KEY for higher rate limits (anonymous access works).

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

const MCP_URL = "https://mcp.context7.com/mcp";
const MCP_PROTOCOL_VERSION = "2025-03-26";

interface McpSession {
  id: string | null;
  nextId: number;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// Streamable HTTP servers may answer with plain JSON or an SSE stream of
// `data:` lines; either way we want the JSON-RPC message matching our id.
function parseJsonRpc(raw: string, id: number | undefined): JsonRpcMessage | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates =
    trimmed.startsWith("{") || trimmed.startsWith("[")
      ? [trimmed]
      : trimmed
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as JsonRpcMessage | JsonRpcMessage[];
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        if (id === undefined || message.id === id) return message;
      }
    } catch {
      // Non-JSON SSE line (comments, keep-alives) — skip.
    }
  }
  return null;
}

async function mcpRequest(
  session: McpSession,
  payload: Record<string, unknown>,
): Promise<JsonRpcMessage | null> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  const apiKey = process.env.CONTEXT7_API_KEY?.trim();
  if (apiKey) {
    headers.CONTEXT7_API_KEY = apiKey;
    headers.authorization = `Bearer ${apiKey}`;
  }
  if (session.id) headers["mcp-session-id"] = session.id;

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const sessionId = res.headers.get("mcp-session-id");
  if (sessionId) session.id = sessionId;
  if (res.status === 202) return null; // notification accepted, no body expected
  if (!res.ok) {
    throw new Error(`Context7 MCP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return parseJsonRpc(await res.text(), payload.id as number | undefined);
}

async function initialize(session: McpSession): Promise<void> {
  const message = await mcpRequest(session, {
    jsonrpc: "2.0",
    id: session.nextId++,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "jersey-whisper", version: "1.0.0" },
    },
  });
  if (!message || message.error) {
    throw new Error(`MCP initialize failed: ${message?.error?.message ?? "no response"}`);
  }
  await mcpRequest(session, { jsonrpc: "2.0", method: "notifications/initialized" });
}

async function callTool(
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const message = await mcpRequest(session, {
    jsonrpc: "2.0",
    id: session.nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (!message) throw new Error(`MCP tool ${name}: empty response`);
  if (message.error) throw new Error(`MCP tool ${name}: ${message.error.message}`);
  const content = message.result?.content;
  const text = Array.isArray(content)
    ? content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
    : "";
  if (message.result?.isError) {
    throw new Error(`MCP tool ${name} errored: ${text.slice(0, 200)}`);
  }
  return text;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return jsonResponse({ ok: true });
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const url = new URL(request.url);
    const library = url.searchParams.get("library")?.trim() || "react";
    const query = url.searchParams.get("query")?.trim() || `How do I get started with ${library}?`;

    const session: McpSession = { id: null, nextId: 1 };
    try {
      await initialize(session);

      let libraryId = library;
      if (!libraryId.startsWith("/")) {
        const resolved = await callTool(session, "resolve-library-id", {
          libraryName: library,
          query,
        });
        const match = resolved.match(/\/[\w.-]+\/[\w.-]+(?:\/[\w.-]+)?/);
        if (!match) {
          return jsonResponse({ error: `No Context7 library found for "${library}"` }, 404);
        }
        libraryId = match[0];
      }

      const docs = await callTool(session, "query-docs", { libraryId, query });

      return jsonResponse({
        ok: true,
        source: "context7-mcp",
        server: MCP_URL,
        library: libraryId,
        query,
        docs,
      });
    } catch (error) {
      return jsonResponse(
        { ok: false, error: error instanceof Error ? error.message : "Context7 MCP call failed" },
        502,
      );
    }
  },
};
