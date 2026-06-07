import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

const KEY = "jerseybecho_theme";

export function applyStoredTheme() {
  if (typeof document === "undefined") return;
  try {
    const t = localStorage.getItem(KEY);
    // Dark is the default; only an explicit "light" preference opts out.
    if (t === "light") document.documentElement.classList.remove("dark");
    else document.documentElement.classList.add("dark");
  } catch {}
}

export function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    try {
      const t = localStorage.getItem(KEY);
      // Dark is the default; only an explicit "light" preference opts out.
      const isDark = t !== "light";
      setDark(isDark);
      document.documentElement.classList.toggle("dark", isDark);
    } catch {}
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {}
  };

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={toggle}
      aria-label="Toggle theme"
      className="h-9 w-9 transition-transform hover:scale-105"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
