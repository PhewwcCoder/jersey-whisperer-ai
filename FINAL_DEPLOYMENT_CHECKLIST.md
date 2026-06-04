# Final Deployment Checklist

## Vercel Deployment Only

1. Run the production build.

```powershell
npm run build
```

2. Confirm the static client entry exists.

```powershell
Test-Path dist/client/index.html
```

3. Check git status.

```powershell
git status
```

4. Stage changes.

```powershell
git add .
```

5. Commit the deployment fix.

```powershell
git commit -m "Final Vercel deployment fix"
```

6. Push to GitHub.

```powershell
git push origin main
```

7. In Vercel project settings, use:

```text
Framework Preset: Vite
Build Command: npm run build
Output Directory: dist/client
Install Command: npm install
```

8. Add Vercel environment variables.

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
GEMINI_API_KEY
GROQ_API_KEY
SERPAPI_KEY
```

> `SERPAPI_KEY` is **server-side only** — do NOT prefix it with `VITE_` and never
> expose it to the client bundle. It powers `api/trends-refresh.ts` (Google Trends
> TIMESERIES + GEO_MAP + RELATED_QUERIES). If unset, the app stays on cached
> snapshots and never crashes. Free tier = 100 calls/month, so refresh sparingly.

9. Deploy to production.

```powershell
npx vercel --prod
```

10. Test production routes.

```text
/
/inventory
/ai-advisor
/forecast
/query-sim
```

## Netlify Deployment

Build command: `npm run build`

Publish directory: `dist/client`

Environment variables:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
GEMINI_API_KEY
GROQ_API_KEY
SERPAPI_KEY
```

`GROQ_API_KEY` is required only if used. `SERPAPI_KEY` is server-side only
(never prefix with `VITE_`); leave it unset to stay on cached trend snapshots.

Test after deploy:

```text
/
/inventory
/ai-advisor
/forecast
/query-sim
```
