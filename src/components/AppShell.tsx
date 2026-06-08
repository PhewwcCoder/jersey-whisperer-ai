import type { ReactNode } from "react";
import { Shirt } from "lucide-react";
import { AppSidebar, MobileNav } from "./AppSidebar";
import { ThemeToggle } from "./ThemeToggle";

function BrandMark({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <div
        className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-sm ring-1 ring-primary/30"
        aria-hidden
      >
        <Shirt className="h-[18px] w-[18px]" strokeWidth={2.25} />
      </div>
      <div className="leading-none">
        <div className="text-sm font-semibold tracking-tight text-foreground">JerseyBecho AI</div>
        <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Demand Intelligence
        </div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex bg-background">
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="hidden md:flex items-center justify-between border-b border-border bg-background/70 backdrop-blur-xl px-6 py-2.5 sticky top-0 z-30">
          <BrandMark />
          <div className="flex items-center gap-3">
            <ThemeToggle />
          </div>
        </header>
        <div className="md:hidden flex items-center justify-between px-3 py-2 border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-30">
          <BrandMark />
          <ThemeToggle />
        </div>
        <MobileNav />
        <main className="flex-1 p-4 md:p-8 max-w-[1400px] w-full mx-auto animate-in fade-in duration-300">
          {children}
        </main>
        <footer className="border-t border-border px-4 md:px-8 py-4 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">JerseyBecho AI</span> · Built for Infinity
          AI BuildFest 2026 · Online Commerce track
        </footer>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}
