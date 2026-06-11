// Minimal UI-label i18n (en/bn). Keys are the English strings themselves and
// lookups fall back to the key, so a missing translation can never blank the UI.
// Display-only: never use for API routes, Supabase columns, object keys, or
// product/team data coming from the database.
import { useSyncExternalStore } from "react";

export type Lang = "en" | "bn";

const STORAGE_KEY = "jerseybecho_lang";

const bn: Record<string, string> = {
  // Sidebar / navigation
  Dashboard: "ড্যাশবোর্ড",
  Inventory: "ইনভেন্টরি",
  "Add Product": "পণ্য যোগ করুন",
  "AI Stock Advisor": "এআই স্টক পরামর্শক",
  "Forecast Preview": "চাহিদার পূর্বাভাস",
  "Query Simulation": "কোয়েরি সিমুলেশন",

  // Header / common
  "Switch theme": "থিম পরিবর্তন করুন",
  "Switch language": "ভাষা পরিবর্তন করুন",

  // Forecast Preview page
  "Demand Forecast": "চাহিদার পূর্বাভাস",
  "Real-time demand signals to decide what to restock, promote, or hold this week.":
    "কোন পণ্য রিস্টক, প্রমোট বা ধরে রাখবেন তা ঠিক করতে রিয়েল-টাইম চাহিদার সিগন্যাল।",
  "Critical restocks": "জরুরি রিস্টক",
  "Top demand score": "সর্বোচ্চ চাহিদা স্কোর",
  "Live market signals": "লাইভ মার্কেট সিগন্যাল",
  "Sports events": "খেলার ইভেন্ট",
  "Top 10 Product Recommendations": "সেরা ১০টি পণ্যের সুপারিশ",
  "AI-ranked actions from inventory, market demand, sports news, customer queries, stock movement, and margin.":
    "ইনভেন্টরি, বাজার চাহিদা, খেলার খবর, ক্রেতার প্রশ্ন, স্টক মুভমেন্ট ও মার্জিন থেকে এআই-র‍্যাঙ্ক করা পদক্ষেপ।",
  "How is the score calculated?": "স্কোর কীভাবে হিসাব করা হয়?",
  "Live Market Signals": "লাইভ মার্কেট সিগন্যাল",
  "Refresh trends": "ট্রেন্ড রিফ্রেশ করুন",
  "Refresh news": "নিউজ রিফ্রেশ করুন",
  "Refreshing…": "রিফ্রেশ হচ্ছে…",
  "Top searches": "শীর্ষ অনুসন্ধান",
  Rising: "ঊর্ধ্বমুখী",
  "Sports News Signals": "স্পোর্টস নিউজ সিগন্যাল",
  "Football events feeding the Sports News score (13% of demand score)":
    "স্পোর্টস নিউজ স্কোরে যুক্ত ফুটবল ইভেন্ট (চাহিদা স্কোরের ১৩%)",
  "Recent Football Events": "সাম্প্রতিক ফুটবল ইভেন্ট",
  'No sports events yet — click "Refresh trends" to pull live data.':
    'এখনও কোনো খেলার ইভেন্ট নেই — লাইভ ডেটা আনতে "ট্রেন্ড রিফ্রেশ করুন" ক্লিক করুন।',
  "Demand Spike Score Table": "চাহিদা বৃদ্ধির সূচক টেবিল",
  "Per-product DSS from demand signals, stock movement, margin, and customer interest.":
    "চাহিদার সিগন্যাল, স্টক মুভমেন্ট, মার্জিন ও ক্রেতার আগ্রহ থেকে প্রতিটি পণ্যের DSS।",

  // Inventory page (low-risk labels only)
  "+ Add product": "+ পণ্য যোগ করুন",
  "Search product / team / font / print": "পণ্য / দল / ফন্ট / প্রিন্ট খুঁজুন",
};

let currentLang: Lang = "en";
if (typeof window !== "undefined") {
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === "bn") currentLang = "bn";
  } catch {
    // storage unavailable — stay on the English default
  }
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLang(): Lang {
  return currentLang;
}

export function setLang(lang: Lang): void {
  currentLang = lang;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // storage unavailable — selection still applies for this session
  }
  listeners.forEach((listener) => listener());
}

export function useLang(): Lang {
  return useSyncExternalStore(
    subscribe,
    () => currentLang,
    () => "en" as Lang,
  );
}

export function translate(text: string, lang: Lang): string {
  return lang === "bn" ? (bn[text] ?? text) : text;
}

/** Hook returning a translator bound to the current language. */
export function useT(): (text: string) => string {
  const lang = useLang();
  return (text: string) => translate(text, lang);
}
