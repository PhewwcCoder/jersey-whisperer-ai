import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { SHOP_POLICY, matchQuery } from "@/lib/ai-matcher";
import {
  buildSafeInventoryContext,
  type EnhancedReplySource,
  type GeminiChatRequest,
  type GeminiChatSuccessResponse,
  type RecentTurnSummary,
} from "@/lib/query-sim";
import { saveChatLogToSupabase } from "@/lib/supabase-service";
import { useStore } from "@/lib/store";
import type { ConversationContext, MissingField, QueryReasoning } from "@/lib/types";
import { Bot, MessageSquare, Send, Sparkles, Trash2 } from "lucide-react";

export const Route = createFileRoute("/query-sim")({
  head: () => ({ meta: [{ title: "Query Simulation - JerseyBecho AI" }] }),
  component: QueryPage,
});

const TESTS = [
  "vai Brazil jersey ase?",
  "player edition XL",
  "Brazil away player edition ache?",
  "Brazil away player edition XL ache?",
  "Neymar font ache?",
  "Argentina jersey te Messi10 print hobe?",
  "Spain away player edition XL ache?",
  "miau",
];

interface Turn {
  id: string;
  customerMessage: string;
  botReply: string;
  source?: EnhancedReplySource;
  fallbackUsed: boolean;
  errorMessage?: string;
  reasoning?: QueryReasoning;
  createdAt: string;
  isLoading: boolean;
}

const MISSING_FIELD_LABELS: Record<MissingField, string> = {
  team_country_club: "Team/club/country",
  kit_type: "Kit type",
  edition_type: "Edition",
  size: "Size",
  font_print: "Font / Print",
  source_country: "Source country",
  manufacturing_type: "Manufacturing type",
  season_year: "Season year",
};

const CONTINUATION_HINTS = [
  "player edition",
  "fan edition",
  "xl",
  "xxl",
  "l",
  "m",
  "s",
  "size",
  "home",
  "away",
  "retro",
  "print",
  "font",
  "eta",
  "oita",
  "same",
  "then",
  "price",
  "dam",
  "delivery",
  "order",
  "preorder",
];

const RESET_MESSAGES = new Set([
  "what",
  "oi",
  "hello",
  "hi",
  "hmm",
  "ok",
  "accha",
  "miau",
  "meow",
  "?",
  "??",
]);

function QueryPage() {
  const { products, incrementQueryCount } = useStore();
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [geminiEnhanced, setGeminiEnhanced] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [conversationContext, setConversationContext] = useState<ConversationContext>({});
  const [selectedTurnId, setSelectedTurnId] = useState<string>();
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const selectedTurn =
    turns.find((turn) => turn.id === selectedTurnId) || turns[turns.length - 1];

  const persistChatLog = (customerMessage: string, aiReply: string, matchedProductId?: string) => {
    void saveChatLogToSupabase(customerMessage, aiReply, matchedProductId);
  };

  const submitMessage = async (rawQuery: string) => {
    const query = rawQuery.trim();
    if (!query || isSending) return;

    const previousReasoning = [...turns]
      .reverse()
      .find((turn) => turn.reasoning)?.reasoning;
    const contextForMessage = shouldReuseConversation(query, previousReasoning)
      ? conversationContext
      : {};
    const recentTurns = toRecentTurns(turns);

    const turnId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const initialTurn: Turn = {
      id: turnId,
      customerMessage: query,
      botReply: "",
      source: undefined,
      fallbackUsed: false,
      errorMessage: undefined,
      reasoning: undefined,
      createdAt: new Date().toISOString(),
      isLoading: true,
    };

    setTurns((current) => [...current, initialTurn]);
    setSelectedTurnId(turnId);
    setInput("");
    setIsSending(true);

    try {
      const result = matchQuery(query, products, contextForMessage);
      const nextConversationContext: ConversationContext = {
        ...result.updated_context,
        lastIntent: result.intent,
        lastMatchedProductId: result.matched_product_id,
      };
      setConversationContext(nextConversationContext);

      const targetId = result.matched_product_id || result.closest_fallback?.product_id;
      if (targetId) {
        incrementQueryCount(targetId);
      }

      if (!geminiEnhanced) {
        setTurns((current) =>
          updateTurn(current, turnId, {
            botReply: result.reply,
            source: "Rule-based fallback",
            fallbackUsed: false,
            errorMessage: undefined,
            reasoning: result,
            isLoading: false,
          }),
        );
        persistChatLog(query, result.reply, result.matched_product_id);
        return;
      }

      const payload: GeminiChatRequest = {
        message: query,
        inventoryContext: buildSafeInventoryContext(products, result),
        shopPolicy: SHOP_POLICY,
        matchResult: result,
        conversationContext: nextConversationContext,
        recentTurns,
      };

      try {
        if (import.meta.env.DEV) {
          console.log("[Gemini] calling /api/gemini-chat", payload);
        }

        const response = await fetch("/api/gemini-chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorPayload = (await response.json().catch(() => null)) as
            | { error?: string; details?: string }
            | null;
          const errorMessage =
            errorPayload?.details ||
            errorPayload?.error ||
            `Gemini route returned ${response.status}`;
          throw new Error(errorMessage);
        }

        const data = (await response.json()) as Partial<GeminiChatSuccessResponse>;
        if (typeof data.reply !== "string" || !data.reply.trim()) {
          throw new Error("Gemini route returned no reply text");
        }
        const aiReply = data.reply.trim();

        setTurns((current) =>
          updateTurn(current, turnId, {
            botReply: aiReply,
            source: "Gemini AI",
            fallbackUsed: false,
            errorMessage: undefined,
            reasoning: result,
            isLoading: false,
          }),
        );
        persistChatLog(query, aiReply, result.matched_product_id);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown Gemini request failure.";
        if (import.meta.env.DEV) {
          console.error("[Gemini] /api/gemini-chat failed", error);
        }

        setTurns((current) =>
          updateTurn(current, turnId, {
            botReply: result.reply,
            source: "Rule-based fallback",
            fallbackUsed: true,
            errorMessage: errorMessage,
            reasoning: result,
            isLoading: false,
          }),
        );
        persistChatLog(query, result.reply, result.matched_product_id);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unexpected Query Simulation error.";
      setTurns((current) =>
        updateTurn(current, turnId, {
          botReply:
            "Sir, kon jersey ta dekhte chacchen? Team/club, edition, size bolle ami check korte parbo.",
          source: "Rule-based fallback",
          fallbackUsed: true,
          errorMessage,
          isLoading: false,
        }),
      );
      persistChatLog(
        query,
        "Sir, kon jersey ta dekhte chacchen? Team/club, edition, size bolle ami check korte parbo.",
      );
    } finally {
      setIsSending(false);
    }
  };

  const clearChat = () => {
    setTurns([]);
    setConversationContext({});
    setSelectedTurnId(undefined);
    setInput("");
    setIsSending(false);
  };

  return (
    <>
      <PageHeader
        title="Customer Query Simulation"
        subtitle="Test how the AI handles a real multi-turn jersey sales chat with inventory-first matching and optional Gemini-enhanced replies."
      />

      <Card className="mb-4">
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <div>
              <div className="text-sm font-medium">Gemini enhanced reply</div>
              <div className="text-xs text-muted-foreground">
                Gemini writes the final reply when enabled. Rule-based slot filling always runs first.
              </div>
            </div>
            <Switch
              checked={geminiEnhanced}
              onCheckedChange={setGeminiEnhanced}
              aria-label="Toggle Gemini enhanced reply"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Type a customer message (Bangla / Banglish / English)..."
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void submitMessage(input);
              }}
            />
            <Button type="button" onClick={() => void submitMessage(input)} disabled={isSending}>
              <Send className="mr-1 h-4 w-4" /> Send
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={clearChat}
              disabled={isSending}
            >
              <Trash2 className="mr-1 h-4 w-4" /> Clear chat
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {TESTS.map((test) => (
              <button
                key={test}
                type="button"
                onClick={() => void submitMessage(test)}
                disabled={isSending}
                className="rounded-full border border-border bg-muted px-3 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {test}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <div className="text-sm font-semibold">Conversation</div>
                <div className="text-xs text-muted-foreground">
                  Send unlimited messages. Previous turns stay visible.
                </div>
              </div>
              <Badge variant="outline">{turns.length} turns</Badge>
            </div>

            <div className="max-h-[70vh] overflow-y-auto p-4">
              {turns.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                  Click a test button or type a message to start a multi-turn sales chat.
                </div>
              ) : (
                <div className="space-y-4">
                  {turns.map((turn) => {
                    const isSelected = turn.id === selectedTurn?.id;

                    return (
                      <button
                        key={turn.id}
                        type="button"
                        onClick={() => setSelectedTurnId(turn.id)}
                        className={`block w-full rounded-xl border p-3 text-left transition-colors ${
                          isSelected
                            ? "border-primary/40 bg-primary/5"
                            : "border-border bg-background hover:bg-muted/40"
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                            <MessageSquare className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-[10px] font-medium uppercase text-muted-foreground">
                              Customer
                            </div>
                            <div className="mt-1 rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm">
                              {turn.customerMessage}
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 flex items-start gap-2">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Bot className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2 text-[10px] font-medium uppercase text-muted-foreground">
                              <span>JerseyBecho AI</span>
                              {turn.source && (
                                <Badge variant="outline" className="text-[10px] normal-case">
                                  {turn.source}
                                </Badge>
                              )}
                            </div>
                            <div className="mt-1 whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-primary/20 bg-primary/10 px-3 py-2 text-sm">
                              {turn.isLoading ? "Thinking..." : turn.botReply}
                            </div>
                            {turn.isLoading && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                Writing reply...
                              </div>
                            )}
                            {turn.fallbackUsed && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                Fallback response used.
                              </div>
                            )}
                            {turn.errorMessage && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                {turn.errorMessage}
                              </div>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  <div ref={chatEndRef} />
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border-accent/40 bg-accent/5">
          <CardContent className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <div className="text-sm font-semibold">AI Reasoning Preview</div>
              {selectedTurn?.reasoning && (
                <Badge
                  variant="outline"
                  className={
                    selectedTurn.reasoning.confidence >= 70
                      ? "ml-auto border-success/30 bg-success/15 text-success"
                      : selectedTurn.reasoning.confidence >= 45
                        ? "ml-auto border-warning/40 bg-warning/15 text-warning-foreground"
                        : "ml-auto border-destructive/30 bg-destructive/10 text-destructive"
                  }
                >
                  Confidence {selectedTurn.reasoning.confidence}
                </Badge>
              )}
            </div>

            {!selectedTurn ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                Send a message to inspect the latest rule-based reasoning.
              </div>
            ) : selectedTurn.reasoning ? (
              <>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <Row k="Detected intent" v={selectedTurn.reasoning.intent} />
                  <Row k="Detected team/club/country" v={selectedTurn.reasoning.detected_team} />
                  <Row k="Detected kit type" v={selectedTurn.reasoning.detected_kit} />
                  <Row k="Detected edition" v={selectedTurn.reasoning.detected_edition} />
                  <Row k="Detected size" v={selectedTurn.reasoning.detected_size} />
                  <Row
                    k="Detected font/print"
                    v={selectedTurn.reasoning.detected_font_print}
                  />
                  <Row
                    k="Missing fields"
                    v={formatMissingFields(selectedTurn.reasoning.missing_fields)}
                  />
                  <Row
                    k="Reused context from previous message"
                    v={formatReusedContext(selectedTurn.reasoning.reused_context)}
                  />
                  <Row k="Displayed reply source" v={selectedTurn.source || "-"} />
                  <Row k="Rule engine source" v={selectedTurn.reasoning.response_source} />
                  <Row k="Best inventory match" v={selectedTurn.reasoning.matched_product_name} />
                  <Row
                    k="Closest fallback"
                    v={selectedTurn.reasoning.closest_fallback?.product_name}
                  />
                </div>

                <div className="mt-3 rounded-md border border-border bg-background p-2 text-xs">
                  <div className="mb-1 font-semibold">Reason</div>
                  <div className="text-muted-foreground">{selectedTurn.reasoning.reason}</div>
                </div>

                {selectedTurn.reasoning.candidates &&
                  selectedTurn.reasoning.candidates.length > 0 && (
                    <div className="mt-3">
                      <div className="mb-1 text-xs font-semibold">Top candidates</div>
                      <div className="space-y-1">
                        {selectedTurn.reasoning.candidates.map((candidate) => (
                          <div
                            key={candidate.product_id}
                            className="flex justify-between rounded border border-border bg-background px-2 py-1 text-xs"
                          >
                            <span>{candidate.name}</span>
                            <span className="font-mono text-muted-foreground">
                              {candidate.score}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                The latest turn is still processing.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function updateTurn(turns: Turn[], turnId: string, patch: Partial<Turn>) {
  return turns.map((turn) => (turn.id === turnId ? { ...turn, ...patch } : turn));
}

function toRecentTurns(turns: Turn[]): RecentTurnSummary[] {
  return turns
    .filter((turn) => turn.customerMessage.trim() && turn.botReply.trim())
    .slice(-6)
    .map((turn) => ({
      customerMessage: turn.customerMessage,
      botReply: turn.botReply,
    }));
}

function shouldReuseConversation(query: string, previousResult?: QueryReasoning) {
  if (!previousResult || previousResult.missing_fields.length === 0) return false;

  const normalized = query
    .toLowerCase()
    .replace(/[?,.!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || RESET_MESSAGES.has(normalized)) return false;
  if (
    (normalized.includes("font") || normalized.includes("print")) &&
    ![
      "size",
      "xl",
      "xxl",
      "l",
      "m",
      "player edition",
      "fan edition",
      "home",
      "away",
      "retro",
    ].some((hint) => normalized.includes(hint))
  ) {
    return false;
  }
  return CONTINUATION_HINTS.some((hint) => normalized.includes(hint));
}

function formatMissingFields(fields: MissingField[]) {
  if (!fields.length) return "-";
  return fields.map((field) => MISSING_FIELD_LABELS[field]).join(", ");
}

function formatReusedContext(context?: Partial<ConversationContext>) {
  if (!context) return "-";

  const parts: string[] = [];
  if (context.lastDetectedTeam) parts.push(`Team: ${context.lastDetectedTeam}`);
  if (context.lastDetectedKitType) parts.push(`Kit: ${context.lastDetectedKitType}`);
  if (context.lastDetectedEdition) parts.push(`Edition: ${context.lastDetectedEdition}`);
  if (context.lastDetectedSize) parts.push(`Size: ${context.lastDetectedSize}`);
  if (context.lastDetectedFontPrint) parts.push(`Font/Print: ${context.lastDetectedFontPrint}`);
  if (context.lastIntent) parts.push(`Intent: ${context.lastIntent}`);
  if (context.lastMatchedProductId) parts.push(`Product ID: ${context.lastMatchedProductId}`);

  return parts.length ? parts.join(", ") : "-";
}

function Row({ k, v }: { k: string; v?: unknown }) {
  return (
    <>
      <div className="text-muted-foreground">{k}</div>
      <div className="truncate font-medium text-foreground">{String(v ?? "-")}</div>
    </>
  );
}
