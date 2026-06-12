import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { seedProducts } from "./seed-data";
import {
  applyJerseyInquiryCountsToProducts,
  deleteProductFromSupabase,
  fetchJerseyInquiryCounts,
  fetchProductsFromSupabase,
  upsertProductToSupabase,
} from "./supabase-service";
import { isSupabaseConfigured } from "./supabase";
import { subscribeToTableChanges } from "./realtime";
import type { Product } from "./types";

export const STORAGE_KEY = "jerseybecho_products_v4";

interface Ctx {
  products: Product[];
  setProducts: (products: Product[]) => void;
  addProduct: (product: Product) => void;
  updateProduct: (product: Product) => void;
  deleteProduct: (id: string) => void;
  incrementQueryCount: (id: string) => void;
  resetDemo: () => void;
}

const StoreContext = createContext<Ctx | null>(null);

function sanitize(list: unknown): Product[] {
  if (!Array.isArray(list)) return seedProducts;
  return list.map((product) => ({
    ...product,
    trend_signal: product?.trend_signal ?? "None",
    trend_reason: product?.trend_reason ?? "",
    query_count: Number.isFinite(product?.query_count) ? product.query_count : 0,
    variants: Array.isArray(product?.variants) ? product.variants : [],
  })) as Product[];
}

function persistLocalProducts(products: Product[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(products));
  } catch {
    // Local demo storage should never break the UI.
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [products, setProductsState] = useState<Product[]>(seedProducts);

  useEffect(() => {
    let cancelled = false;
    let localProducts = seedProducts;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        localProducts = sanitize(JSON.parse(raw));
        setProductsState(localProducts);
      }
    } catch {
      localProducts = seedProducts;
    }

    const load = async () => {
      let baseProducts = localProducts;

      if (isSupabaseConfigured) {
        const remoteProducts = await fetchProductsFromSupabase();
        if (cancelled) return;

        if (remoteProducts.length > 0) {
          baseProducts = sanitize(remoteProducts);
          setProductsState(baseProducts);
          persistLocalProducts(baseProducts);
        }
      }

      const inquiryCounts = await fetchJerseyInquiryCounts();
      if (cancelled || !inquiryCounts.length) return;

      const withInquiries = applyJerseyInquiryCountsToProducts(baseProducts, inquiryCounts);
      if (withInquiries !== baseProducts) {
        setProductsState(withInquiries);
        persistLocalProducts(withInquiries);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  // Realtime: live inventory updates (requires Realtime enabled on public.products —
  // see src/lib/realtime.ts). When any client changes stock, re-pull products so
  // stock numbers and status badges (Available/Low Stock/Out of Stock colors)
  // update everywhere without a refresh. Bursts (rapid +/- clicks, bulk seeds —
  // including the echo of this client's own upserts) are debounced into one
  // refetch of the final server state.
  useEffect(() => {
    if (!isSupabaseConfigured) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const unsubscribe = subscribeToTableChanges("products-changes", "products", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const remoteProducts = await fetchProductsFromSupabase();
        if (cancelled || remoteProducts.length === 0) return;
        // Re-apply Botpress inquiry counts so the refetch never drops them.
        const inquiryCounts = await fetchJerseyInquiryCounts();
        if (cancelled) return;
        const next = applyJerseyInquiryCountsToProducts(sanitize(remoteProducts), inquiryCounts);
        setProductsState(next);
        persistLocalProducts(next);
      }, 600);
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  // Realtime: live customer inquiries (requires Realtime enabled on
  // public.jersey_inquiry_events). Lives in the store — NOT a single page — so
  // a Botpress/Messenger inquiry moves query_count (and therefore the DSS
  // customer signal) on every screen that is open: Dashboard KPIs, Forecast
  // Preview score table, AI Advisor. The dashboard adds its own toast/flash cue
  // on top of this data update.
  useEffect(() => {
    if (!isSupabaseConfigured) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const unsubscribe = subscribeToTableChanges(
      "inquiry-counts-changes",
      "jersey_inquiry_events",
      (payload) => {
        if (payload.eventType !== "INSERT") return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const inquiryCounts = await fetchJerseyInquiryCounts();
          if (cancelled || !inquiryCounts.length) return;
          setProductsState((current) => {
            const next = applyJerseyInquiryCountsToProducts(current, inquiryCounts);
            if (next !== current) persistLocalProducts(next);
            return next;
          });
        }, 300);
      },
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const setProducts = (nextProducts: Product[]) => {
    const clean = sanitize(nextProducts);
    setProductsState(clean);
    persistLocalProducts(clean);
  };

  const addProduct = (product: Product) => {
    const nextProducts = [product, ...products];
    setProducts(nextProducts);
    void upsertProductToSupabase(product);
  };

  const updateProduct = (product: Product) => {
    const nextProducts = products.map((entry) => (entry.id === product.id ? product : entry));
    setProducts(nextProducts);
    void upsertProductToSupabase(product);
  };

  const deleteProduct = (id: string) => {
    const nextProducts = products.filter((entry) => entry.id !== id);
    setProducts(nextProducts);
    void deleteProductFromSupabase(id);
  };

  const incrementQueryCount = (id: string) => {
    const nextProducts = products.map((entry) =>
      entry.id === id ? { ...entry, query_count: (entry.query_count || 0) + 1 } : entry,
    );
    setProducts(nextProducts);
    const updatedProduct = nextProducts.find((entry) => entry.id === id);
    if (updatedProduct) {
      void upsertProductToSupabase(updatedProduct);
    }
  };

  const resetDemo = () => {
    setProducts(seedProducts);
    void Promise.allSettled(seedProducts.map((product) => upsertProductToSupabase(product)));
  };

  return (
    <StoreContext.Provider
      value={{
        products,
        setProducts,
        addProduct,
        updateProduct,
        deleteProduct,
        incrementQueryCount,
        resetDemo,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be inside StoreProvider");
  return ctx;
}
