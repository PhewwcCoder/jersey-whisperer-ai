import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PageHeader } from "@/components/AppShell";
import { Card, CardContent } from "@/components/ui/card";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/i18n";
import { toast } from "sonner";

const ProductForm = lazy(() =>
  import("@/components/ProductForm").then((module) => ({ default: module.ProductForm })),
);

export const Route = createFileRoute("/add-product")({
  head: () => ({ meta: [{ title: "Add Product - JerseyBecho AI" }] }),
  component: AddPage,
});

function AddPage() {
  const t = useT();
  const { addProduct } = useStore();
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        title={t("Add Product")}
        subtitle={t("New jersey listing for your AI-ready inventory")}
      />
      <Card>
        <CardContent className="p-6">
          <Suspense
            fallback={
              <div className="p-4 text-sm text-muted-foreground">{t("Loading form...")}</div>
            }
          >
            <ProductForm
              onSubmit={(p) => {
                addProduct(p);
                toast.success(`${p.product_name} added`);
                navigate({ to: "/inventory" });
              }}
              submitLabel="Add to Inventory"
            />
          </Suspense>
        </CardContent>
      </Card>
    </>
  );
}
