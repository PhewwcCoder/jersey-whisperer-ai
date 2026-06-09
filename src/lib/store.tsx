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
