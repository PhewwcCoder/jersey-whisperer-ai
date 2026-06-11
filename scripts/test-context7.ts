// Smoke test for api/context7-docs.ts — run: npx tsx scripts/test-context7.ts
// Exercises the full MCP session against the hosted Context7 server.
import handler from "../api/context7-docs.ts";

async function main() {
  const res = await handler.fetch(
    new Request(
      "http://localhost/api/context7-docs?library=react&query=how%20to%20use%20useEffect%20cleanup",
    ),
  );
  const body = (await res.json()) as Record<string, unknown>;
  console.log("status:", res.status);
  console.log("ok:", body.ok, "| library:", body.library, "| query:", body.query);
  console.log("docs preview:", String(body.docs ?? body.error ?? "").slice(0, 400));
}

main().catch((err) => {
  console.error("test failed:", err);
  process.exit(1);
});
