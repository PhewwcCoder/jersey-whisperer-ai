// api/news-only-refresh.ts — refresh ONLY the news sources, not trends/SerpApi-trends.
// Runs API-Football transfers (refreshNewsEvents) + Google AI Mode news (refreshFootballNews),
// each in its own non-blocking try/catch so one failing never blocks the other. Backs the
// "Refresh news" button on the Sports News box. Server-side only.

export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

// Exported so it can be reused/tested. Never throws — both sources fail safe.
export async function refreshNewsOnly(): Promise<void> {
  // API-Football transfers/fixtures.
  try {
    const { refreshNewsEvents } = await import('./news-refresh.js')
    await refreshNewsEvents()
  } catch (e) {
    console.error('[news-only] news-refresh failed (non-blocking):', e)
  }

  // Google AI Mode football news → Gemini parse (own internal 20h cache guard).
  try {
    const { refreshFootballNews } = await import('./football-news-refresh.js')
    await refreshFootballNews()
  } catch (e) {
    console.error('[news-only] football-news-refresh failed (non-blocking):', e)
  }
}

export const handler = {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed. Use POST.' }, 405)
    }
    try {
      await refreshNewsOnly()
      return jsonResponse({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[news-only] handler error:', message)
      return jsonResponse({ ok: false, error: message }, 500)
    }
  },
}

export default handler
