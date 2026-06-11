import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { PageHeader } from "@/components/AppShell";
import { useT } from "@/lib/i18n";
import { StatusBadge, TrendBadge } from "@/components/Badges";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { bdt, computeProfitMargin, computeStatus } from "@/lib/inventory-utils";
import { useStore } from "@/lib/store";
import type { Product, TrendSignal, Variant } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ChevronDown, Minus, Pencil, Plus, Search, Shirt, Trash2 } from "lucide-react";
import { toast } from "sonner";

const ProductForm = lazy(() =>
  import("@/components/ProductForm").then((module) => ({ default: module.ProductForm })),
);

export const Route = createFileRoute("/inventory")({
  head: () => ({ meta: [{ title: "Inventory - JerseyBecho AI" }] }),
  component: InventoryPage,
});

function InventoryPage() {
  const t = useT();
  const { products, deleteProduct, updateProduct } = useStore();
  const [q, setQ] = useState("");
  const [edition, setEdition] = useState("all");
  const [mfg, setMfg] = useState("all");
  const [source, setSource] = useState("all");
  const [size, setSize] = useState("all");
  const [status, setStatus] = useState("all");
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  const rows = useMemo(() => {
    const out: Array<{ p: Product; v: Product["variants"][number] }> = [];
    for (const product of products) {
      for (const variant of product.variants) {
        out.push({ p: product, v: variant });
      }
    }

    return out.filter(({ p, v }) => {
      if (q) {
        const term = q.toLowerCase();
        if (
          !p.product_name.toLowerCase().includes(term) &&
          !p.team_country_club.toLowerCase().includes(term) &&
          !(p.player_name || "").toLowerCase().includes(term) &&
          !(p.font_name || "").toLowerCase().includes(term)
        ) {
          return false;
        }
      }
      if (edition !== "all" && p.edition_type !== edition) return false;
      if (mfg !== "all" && p.manufacturing_type !== mfg) return false;
      if (source !== "all" && p.source_country !== source) return false;
      if (size !== "all" && v.size !== size) return false;
      if (status !== "all" && v.status !== status) return false;
      return true;
    });
  }, [edition, mfg, products, q, size, source, status]);

  // Group the filtered variant rows by team / country / club for the sectioned list.
  // Preserves first-seen order; the same filtered `rows` feed it, so search/filters
  // keep working exactly as before — only the presentation below changes.
  const groups = useMemo(() => {
    const map = new Map<string, Array<{ p: Product; v: Variant }>>();
    for (const row of rows) {
      const key = row.p.team_country_club || "Other";
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return [...map.entries()];
  }, [rows]);

  // Inline +/- on a single variant. Optimistic via updateProduct (the same pattern the
  // rest of this file uses) which also upserts to Supabase. Never drops below 0 and
  // recomputes the variant status so its badge stays accurate. Returns true when the
  // quantity actually changed (so the caller can fire the pop animation).
  const adjustQty = (productId: string, variantId: string, delta: number): boolean => {
    const product = products.find((entry) => entry.id === productId);
    if (!product) return false;
    let changed = false;
    const variants = product.variants.map((variant) => {
      if (variant.id !== variantId) return variant;
      const nextQty = Math.max(0, variant.stock_quantity + delta);
      if (nextQty === variant.stock_quantity) return variant;
      changed = true;
      return {
        ...variant,
        stock_quantity: nextQty,
        status: computeStatus(nextQty, variant.low_stock_threshold, variant.status === "Preorder"),
      };
    });
    if (!changed) return false;
    updateProduct({ ...product, variants });
    return true;
  };

  return (
    <>
      <PageHeader
        title={t("Inventory")}
        subtitle={`${rows.length} variants across ${products.length} products`}
        actions={
          <Button asChild size="sm">
            <Link to="/add-product">{t("+ Add product")}</Link>
          </Button>
        }
      />

      <Card className="mb-4">
        <CardContent className="grid gap-2 p-4 md:grid-cols-6">
          <div className="relative md:col-span-2">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder={t("Search product / team / font / print")}
              value={q}
              onChange={(event) => setQ(event.target.value)}
            />
          </div>
          <Select value={edition} onValueChange={setEdition}>
            <SelectTrigger><SelectValue placeholder="Edition" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All editions</SelectItem>
              <SelectItem value="Player Edition">Player Edition</SelectItem>
              <SelectItem value="Fan Edition">Fan Edition</SelectItem>
              <SelectItem value="Retro Kit">Retro Kit</SelectItem>
            </SelectContent>
          </Select>
          <Select value={mfg} onValueChange={setMfg}>
            <SelectTrigger><SelectValue placeholder="Manufacturing" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All manufacturing</SelectItem>
              <SelectItem value="Imported">Imported</SelectItem>
              <SelectItem value="BD-made">BD-made</SelectItem>
            </SelectContent>
          </Select>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger><SelectValue placeholder="Source" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="China">China</SelectItem>
              <SelectItem value="Thailand">Thailand</SelectItem>
              <SelectItem value="Bangladesh">Bangladesh</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="Available">Available</SelectItem>
              <SelectItem value="Low Stock">Low Stock</SelectItem>
              <SelectItem value="Out of Stock">Out of Stock</SelectItem>
              <SelectItem value="Preorder">Preorder</SelectItem>
            </SelectContent>
          </Select>
          <Select value={size} onValueChange={setSize}>
            <SelectTrigger><SelectValue placeholder="Size" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sizes</SelectItem>
              {["S", "M", "L", "XL", "XXL"].map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {groups.map(([team, items]) => {
          const totalUnits = items.reduce((sum, { v }) => sum + v.stock_quantity, 0);
          return (
            <Card key={team}>
              <CardContent className="p-0">
                {/* Team / country / club heading — initials avatar + roll-up counts. */}
                <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-[11px] font-bold tracking-wide text-primary ring-1 ring-primary/20">
                    {teamInitials(team)}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-foreground">{team}</div>
                    <div className="text-xs text-muted-foreground">
                      {items.length} {items.length === 1 ? "variant" : "variants"} · {totalUnits} in
                      stock
                    </div>
                  </div>
                </div>

                {/* This team's jersey variants. */}
                <div className="divide-y divide-border/60">
                  {items.map(({ p, v }) => (
                    <VariantRow
                      key={`${p.id}-${v.id}`}
                      p={p}
                      v={v}
                      onAdjust={(delta) => adjustQty(p.id, v.id, delta)}
                      onEdit={() => setEditingProduct(p)}
                      onDelete={() => {
                        if (confirm(`Delete ${p.product_name}?`)) {
                          deleteProduct(p.id);
                          toast.success("Product deleted");
                        }
                      }}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}

        {rows.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              No items match these filters.
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={Boolean(editingProduct)} onOpenChange={(open) => !open && setEditingProduct(null)}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Product</DialogTitle>
            <DialogDescription>
              Update pricing, stock, sizing, trend signal, and supplier details for this product.
            </DialogDescription>
          </DialogHeader>
          {editingProduct && (
            <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading editor...</div>}>
              <ProductForm
                key={editingProduct.id}
                initial={editingProduct}
                submitLabel="Save Changes"
                onSubmit={(product) => {
                  updateProduct(product);
                  setEditingProduct(null);
                  toast.success("Product updated");
                }}
              />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// Initials avatar for a team/country/club heading when no logo field exists. Multi-word
// names use first letters ("Real Madrid" → "RM"); single words use the first 3 chars
// ("Argentina" → "ARG", "Barcelona" → "BAR").
function teamInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words
      .slice(0, 3)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  }
  const clean = name.replace(/[^a-zA-Z0-9]/g, "");
  return (clean.slice(0, 3) || "?").toUpperCase();
}

// Seller-facing explanation of the demand (trend) signal, shown in the hover tooltip.
const DEMAND_HELP: Record<TrendSignal, string> = {
  High: "Strong buyer interest. Prioritize stock and fast replies.",
  Medium: "Some buyer interest. Monitor stock.",
  Low: "Lower buyer interest. Restock carefully.",
  None: "No notable buyer interest yet.",
};

function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

function PriceCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-foreground">{value}</div>
    </div>
  );
}

function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-foreground/90">{value}</div>
    </div>
  );
}

// A single jersey variant row: seller-facing essentials always visible, inline +/- stock
// stepper with a red/green pop on change, and a local "Show more" for supplier/source
// details. All quantity writes go through the parent's optimistic adjustQty → Supabase.
function VariantRow({
  p,
  v,
  onAdjust,
  onEdit,
  onDelete,
}: {
  p: Product;
  v: Variant;
  onAdjust: (delta: number) => boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pop, setPop] = useState<"up" | "down" | null>(null);

  const adjust = (delta: number) => {
    const changed = onAdjust(delta);
    if (!changed) return;
    setPop(delta > 0 ? "up" : "down");
    window.setTimeout(() => setPop(null), 450);
  };

  const fontPrint = p.font_name || p.player_name;

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {/* Identity: product photo (or jersey placeholder) + key attributes. */}
        <div className="flex min-w-[200px] flex-1 items-center gap-3">
          <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
            <Shirt className="h-4 w-4 text-muted-foreground" aria-hidden />
            {p.product_image_url && (
              <img
                src={p.product_image_url}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                onError={(event) => {
                  (event.target as HTMLImageElement).style.display = "none";
                }}
              />
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{p.product_name}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <MetaChip>{p.season_year}</MetaChip>
              <MetaChip>{p.kit_type}</MetaChip>
              <MetaChip>{p.edition_type}</MetaChip>
              <MetaChip>Size {v.size}</MetaChip>
              {fontPrint && <MetaChip>{fontPrint}</MetaChip>}
            </div>
          </div>
        </div>

        {/* Pricing. */}
        <div className="flex items-center gap-3 font-mono text-xs">
          <PriceCell label="Buy" value={bdt(v.buy_price)} />
          <PriceCell label="Sell" value={bdt(v.selling_price)} />
          <PriceCell label="Margin" value={`${computeProfitMargin(v.buy_price, v.selling_price)}%`} />
        </div>

        {/* Status + demand (trend) signal, labelled and explained for sellers. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <StatusBadge status={v.status} />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Demand
            </span>
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help">
                    <TrendBadge trend={p.trend_signal} />
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[220px]">
                  {DEMAND_HELP[p.trend_signal]}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>

        {/* Inline stock stepper. */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={() => adjust(-1)}
            disabled={v.stock_quantity <= 0}
            aria-label={`Decrease ${p.product_name} size ${v.size} quantity`}
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <span
            aria-live="polite"
            className={cn(
              "inline-flex h-7 min-w-[2.75rem] items-center justify-center rounded-md border px-2 font-mono text-sm tabular-nums transition-all duration-300",
              pop === "up" && "scale-110 border-success/50 bg-success/20 text-success",
              pop === "down" && "scale-110 border-destructive/50 bg-destructive/20 text-destructive",
              !pop && "border-border bg-muted text-foreground",
            )}
          >
            {v.stock_quantity}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={() => adjust(1)}
            aria-label={`Increase ${p.product_name} size ${v.size} quantity`}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Actions + show-more toggle. */}
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            aria-label={`Delete ${p.product_name}`}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded ? "true" : "false"}
          >
            {expanded ? "Show less" : "Show more"}
            <ChevronDown
              className={cn("ml-1 h-3.5 w-3.5 transition-transform", expanded && "rotate-180")}
            />
          </Button>
        </div>
      </div>

      {/* Secondary details — local UI state only, never touches Supabase. */}
      {expanded && (
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border/60 bg-muted/20 p-3 sm:grid-cols-4">
          <DetailCell label="Mfg" value={p.manufacturing_type} />
          <DetailCell label="Source" value={p.source_country} />
          <DetailCell label="Supplier" value={p.supplier_name || "-"} />
          <DetailCell label="Restock" value={v.possible_restock_date || "-"} />
        </div>
      )}
    </div>
  );
}
