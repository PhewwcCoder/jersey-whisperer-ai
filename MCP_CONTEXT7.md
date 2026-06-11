# Context7 MCP Integration

This project uses the [Context7 MCP server](https://context7.com) (hosted at
`https://mcp.context7.com/mcp`), which serves up-to-date, version-accurate library
documentation over the Model Context Protocol.

## How it's used

**1. Development workflow** — [.mcp.json](.mcp.json) registers the Context7 MCP server
for the project, so the AI coding assistant resolves current library docs through MCP
tool calls (`resolve-library-id`, `query-docs`) while building features instead of
relying on stale training data.

**2. Live in the product** — [api/context7-docs.ts](api/context7-docs.ts) is a
serverless endpoint that opens a real MCP session (JSON-RPC over Streamable HTTP)
against the Context7 server and exposes its tools:

```
GET /api/context7-docs?library=react&query=how to use useEffect cleanup
```

Response:

```json
{
  "ok": true,
  "source": "context7-mcp",
  "server": "https://mcp.context7.com/mcp",
  "library": "/reactjs/react.dev",
  "query": "how to use useEffect cleanup",
  "docs": "### Fetching data with useEffect and cleanup ..."
}
```

## Smoke test

```
npx tsx scripts/test-context7.ts
```

Runs the full MCP session locally (initialize → resolve-library-id → query-docs).

## Optional

Set `CONTEXT7_API_KEY` in the environment for higher rate limits; anonymous access
works for demos.
