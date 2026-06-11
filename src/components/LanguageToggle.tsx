import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setLang, useLang, translate } from "@/lib/i18n";

export function LanguageToggle() {
  const lang = useLang();
  const label = translate("Switch language", lang);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setLang(lang === "en" ? "bn" : "en")}
      aria-label={label}
      title={label}
      className="h-9 transition-transform hover:scale-105"
    >
      <Languages className="h-4 w-4" />
      <span className="ml-1.5 text-xs font-semibold">{lang === "en" ? "বাংলা" : "EN"}</span>
    </Button>
  );
}
