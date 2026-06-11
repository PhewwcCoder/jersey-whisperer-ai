import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Boxes,
  PlusCircle,
  Brain,
  TrendingUp,
  MessageSquare,
  Shirt,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const items = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { to: "/inventory", label: "Inventory", icon: Boxes },
  { to: "/add-product", label: "Add Product", icon: PlusCircle },
  { to: "/ai-advisor", label: "AI Stock Advisor", icon: Brain },
  { to: "/forecast", label: "Forecast Preview", icon: TrendingUp },
  { to: "/query-sim", label: "Query Simulation", icon: MessageSquare },
];

export function AppSidebar() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const t = useT();
  return (
    <aside className="hidden md:flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border md:sticky md:top-0 md:self-start md:h-screen md:overflow-y-auto">
      <div className="px-5 py-5 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-sidebar-primary text-sidebar-primary-foreground flex items-center justify-center">
            <Shirt className="h-5 w-5" />
          </div>
          <div>
            <div className="font-bold text-base leading-tight">JerseyBecho AI</div>
            <div className="text-[10px] text-sidebar-foreground/60 leading-tight">
              24/7 inventory intelligence
            </div>
          </div>
        </div>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {items.map((it) => {
          const active = it.exact ? path === it.to : path.startsWith(it.to);
          return (
            <Link
              key={it.to}
              to={it.to}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                active
                  ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                  : "hover:bg-sidebar-accent text-sidebar-foreground/85",
              )}
            >
              <it.icon className="h-4 w-4" />
              {t(it.label)}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

export function MobileNav() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const t = useT();
  return (
    <nav className="md:hidden flex overflow-x-auto gap-1 bg-sidebar text-sidebar-foreground px-2 py-2 border-b border-sidebar-border">
      {items.map((it) => {
        const active = it.exact ? path === it.to : path.startsWith(it.to);
        return (
          <Link
            key={it.to}
            to={it.to}
            className={cn(
              "flex items-center gap-1 px-3 py-1.5 rounded-md text-xs whitespace-nowrap",
              active
                ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                : "text-sidebar-foreground/85",
            )}
          >
            <it.icon className="h-3.5 w-3.5" />
            {t(it.label)}
          </Link>
        );
      })}
    </nav>
  );
}
