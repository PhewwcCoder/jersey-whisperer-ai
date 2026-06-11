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

  // Dashboard page
  "24/7 AI inventory intelligence for jersey sellers":
    "জার্সি বিক্রেতাদের জন্য ২৪/৭ এআই ইনভেন্টরি ইন্টেলিজেন্স",
  "Revenue Impact Projection": "রাজস্ব প্রভাবের পূর্বাভাস",
  "Projected uplift from AI-assisted replies and better demand-aware replenishment.":
    "এআই-সহায়ক রিপ্লাই ও চাহিদা-সচেতন রিস্টক থেকে প্রত্যাশিত প্রবৃদ্ধি।",
  "Inventory Stockout Reduction Target": "স্টকআউট কমানোর লক্ষ্যমাত্রা",
  "Target reduction by using deterministic Demand Spike Score prioritization.":
    "ডিটারমিনিস্টিক ডিমান্ড স্পাইক স্কোর অগ্রাধিকার ব্যবহার করে কমানোর লক্ষ্য।",
  "Conversion Rate Improvement": "কনভার্সন রেট উন্নতি",
  "Always-on reply coverage helps convert off-hour Messenger and WhatsApp leads.":
    "সার্বক্ষণিক রিপ্লাই কাভারেজ অফ-আওয়ার মেসেঞ্জার ও হোয়াটসঅ্যাপ লিড কনভার্ট করতে সাহায্য করে।",
  "Total products": "মোট পণ্য",
  "Total stock units": "মোট স্টক ইউনিট",
  "Low stock": "কম স্টক",
  "Out of stock": "স্টক শেষ",
  Preorder: "প্রি-অর্ডার",
  "Expected restock": "প্রত্যাশিত রিস্টক",
  "Inventory value": "ইনভেন্টরির মূল্য",
  "Potential profit": "সম্ভাব্য লাভ",
  "High demand": "উচ্চ চাহিদা",
  "AI restock alerts": "এআই রিস্টক অ্যালার্ট",
  "Today's AI Business Alerts": "আজকের এআই বিজনেস অ্যালার্ট",
  "Demand score insights generated from trend signals, stock levels, and live selling pressure":
    "ট্রেন্ড সিগন্যাল, স্টক লেভেল ও লাইভ বিক্রির চাপ থেকে তৈরি চাহিদা স্কোরের ইনসাইট",
  "Today's Selling Signals": "আজকের বিক্রির সিগন্যাল",
  "Market Demand": "বাজার চাহিদা",
  "Stock Pressure": "স্টকের চাপ",
  "Restock Priority": "রিস্টক অগ্রাধিকার",
  "Conversion Opportunity": "কনভার্সনের সুযোগ",
  "24/7 chat can capture late-night football buyers when the seller is offline.":
    "বিক্রেতা অফলাইনে থাকলেও ২৪/৭ চ্যাট গভীর রাতের ফুটবল ক্রেতাদের ধরে রাখতে পারে।",
  "Football jersey demand is active in BD searches this week.":
    "এই সপ্তাহে বিডি সার্চে ফুটবল জার্সির চাহিদা সক্রিয় রয়েছে।",
  "Open Forecast": "পূর্বাভাস দেখুন",

  // Add Product page + ProductForm
  "New jersey listing for your AI-ready inventory":
    "আপনার এআই-রেডি ইনভেন্টরির জন্য নতুন জার্সি লিস্টিং",
  "Loading form...": "ফর্ম লোড হচ্ছে...",
  "Add to Inventory": "ইনভেন্টরিতে যোগ করুন",
  "Save Changes": "পরিবর্তন সংরক্ষণ করুন",
  "Save Product": "পণ্য সংরক্ষণ করুন",
  "Product name": "পণ্যের নাম",
  "Team / Country / Club": "দল / দেশ / ক্লাব",
  "Athlete reference (optional)": "খেলোয়াড়ের রেফারেন্স (ঐচ্ছিক)",
  "Font / Print": "ফন্ট / প্রিন্ট",
  "Has print?": "প্রিন্ট আছে?",
  "Patch available?": "প্যাচ আছে?",
  "Season / Year": "সিজন / বছর",
  "Kit type": "কিটের ধরন",
  "Edition type": "এডিশনের ধরন",
  "Manufacturing type": "উৎপাদনের ধরন",
  "Source country": "উৎস দেশ",
  "Supplier name": "সরবরাহকারীর নাম",
  "Trend signal": "ট্রেন্ড সিগন্যাল",
  "Trend reason": "ট্রেন্ডের কারণ",
  "Keep this as the base jersey name only. Put Messi10/Neymar10 in Font / Print.":
    "শুধু মূল জার্সির নাম লিখুন। Messi10/Neymar10 ফন্ট / প্রিন্টে দিন।",
  "Back print label, e.g. Messi10, Cristiano7, Lamine Yamal19, or Blank / No print.":
    "পেছনের প্রিন্ট লেবেল, যেমন Messi10, Cristiano7, Lamine Yamal19, অথবা Blank / No print।",
  "BD-made auto-locks to Bangladesh. Imported allows China or Thailand.":
    "BD-made হলে স্বয়ংক্রিয়ভাবে Bangladesh নির্বাচিত হয়। Imported হলে China বা Thailand বেছে নেওয়া যায়।",
  "Used by Demand Spike Score to forecast restock urgency.":
    "রিস্টকের জরুরিতা পূর্বাভাসে ডিমান্ড স্পাইক স্কোর এটি ব্যবহার করে।",
  "Max 2MB. Stored locally with the product (demo).":
    "সর্বোচ্চ ২ এমবি। পণ্যের সাথে লোকালি সংরক্ষিত (ডেমো)।",
  Yes: "হ্যাঁ",
  No: "না",
  "No / Blank": "না / ফাঁকা",
  Home: "হোম",
  Away: "অ্যাওয়ে",
  Third: "থার্ড",
  Retro: "রেট্রো",
  "Player Edition": "প্লেয়ার এডিশন",
  "Fan Edition": "ফ্যান এডিশন",
  "Retro Kit": "রেট্রো কিট",
  Imported: "আমদানি",
  "BD-made": "বিডি-মেড",
  Low: "নিম্ন",
  Medium: "মাঝারি",
  High: "উচ্চ",
  Available: "উপলব্ধ",
  "Low Stock": "কম স্টক",
  "Out of Stock": "স্টক শেষ",
  "Sizes & Stock": "সাইজ ও স্টক",
  "Add size": "সাইজ যোগ করুন",
  Size: "সাইজ",
  "Stock qty": "স্টক সংখ্যা",
  "Low threshold": "লো থ্রেশহোল্ড",
  "Buy ৳": "ক্রয় ৳",
  "Sell ৳": "বিক্রয় ৳",
  Margin: "মার্জিন",
  Status: "স্ট্যাটাস",
  "Restock date": "রিস্টকের তারিখ",
  "Optional Image": "ঐচ্ছিক ছবি",
  "Add a jersey photo via URL or upload. Leave blank to use a placeholder.":
    "URL বা আপলোডের মাধ্যমে জার্সির ছবি দিন। ফাঁকা রাখলে প্লেসহোল্ডার ব্যবহৃত হবে।",
  "No image": "ছবি নেই",
  "Image URL (optional)": "ছবির URL (ঐচ্ছিক)",
  "Or upload from device": "অথবা ডিভাইস থেকে আপলোড করুন",

  // AI Stock Advisor page
  "Actionable restock, promotion, and inventory alerts based on your products and demand signals.":
    "আপনার পণ্য ও চাহিদার সিগন্যালের ভিত্তিতে কার্যকর রিস্টক, প্রমোশন ও ইনভেন্টরি অ্যালার্ট।",
  "Seller-ready inventory guidance": "বিক্রেতার জন্য প্রস্তুত ইনভেন্টরি গাইডেন্স",
  "Your AI advisor reviews stock, margin, customer interest, and demand signals to suggest what to restock, promote, or hold — without guessing prices or inventing products.":
    "আপনার এআই পরামর্শক স্টক, মার্জিন, ক্রেতার আগ্রহ ও চাহিদার সিগন্যাল পর্যালোচনা করে কী রিস্টক, প্রমোট বা হোল্ড করবেন তা পরামর্শ দেয় — দাম অনুমান বা পণ্য বানিয়ে না নিয়ে।",
  "Urgent actions": "জরুরি পদক্ষেপ",
  "Restock soon": "শীঘ্রই রিস্টক করুন",
  "Promote this week": "এই সপ্তাহে প্রমোট করুন",
  "Safe to hold": "হোল্ড করা নিরাপদ",
  All: "সব",
  "High Priority": "উচ্চ অগ্রাধিকার",
  Restock: "রিস্টক",
  Promote: "প্রমোট",
  Hold: "হোল্ড",
  Reviewed: "রিভিউড",
  "High margin": "উচ্চ মার্জিন",
  Reason: "কারণ",
  "Suggested action": "প্রস্তাবিত পদক্ষেপ",
  "Business impact": "ব্যবসায়িক প্রভাব",
  "Why?": "কেন?",
  "Hide details": "বিস্তারিত লুকান",
  "Why this matters": "কেন এটি গুরুত্বপূর্ণ",
  "Current stock": "বর্তমান স্টক",
  "Customer interest": "ক্রেতার আগ্রহ",
  "Next step": "পরবর্তী ধাপ",
  "View Product": "পণ্য দেখুন",
  "Edit Stock": "স্টক এডিট করুন",
  "Mark Reviewed": "রিভিউড মার্ক করুন",
  "Copy Supplier Note": "সাপ্লায়ার নোট কপি",
  "No advisor cards match this filter right now.":
    "এই ফিল্টারে এখন কোনো পরামর্শ কার্ড নেই।",
  "Supplier note copied": "সাপ্লায়ার নোট কপি হয়েছে",
  "Could not copy supplier note": "সাপ্লায়ার নোট কপি করা যায়নি",
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
