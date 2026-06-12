// esbuild entry for scripts/compute-dss.mjs — re-exports the REAL scoring
// pipeline so the verification script computes exactly what the browser shows.
export { forecastProduct } from "../src/lib/forecast";
export { applyJerseyInquiryCountsToProducts } from "../src/lib/supabase-service";
