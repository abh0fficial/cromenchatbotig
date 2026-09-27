import OpenAI from "openai";
import { INSTAGRAM_SYSTEM_PROMPT } from "@/lib/system-prompt";

/**
 * Two providers, tried in order:
 *   1. Google Gemini direct (GEMINI_API_KEY) — fewer hops, generous free tier
 *   2. OpenRouter (OPENROUTER_API_KEY) — fallback across several models
 *
 * Within each provider a model cascade runs, so one retired or rate-limited
 * model never takes the bot offline.
 */

const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

const OPENROUTER_MODELS = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "qwen/qwen3-8b:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
];

const clients = new Map<string, OpenAI>();

function getClient(baseURL: string, apiKey: string): OpenAI {
  const cached = clients.get(baseURL);
  if (cached) return cached;
  const client = new OpenAI({ baseURL, apiKey });
  clients.set(baseURL, client);
  return client;
}

type Attempt = { client: OpenAI; model: string; provider: string };

function getAttempts(): Attempt[] {
  const attempts: Attempt[] = [];
  const seen = new Set<string>();

  const add = (provider: string, baseURL: string, key: string, models: (string | undefined)[]) => {
    for (const model of models) {
      if (!model || seen.has(`${provider}:${model}`)) continue;
      seen.add(`${provider}:${model}`);
      attempts.push({ client: getClient(baseURL, key), model, provider });
    }
  };

  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    add("gemini", GEMINI_BASE_URL, geminiKey, [
      process.env.GEMINI_MODEL,
      ...GEMINI_MODELS,
    ]);
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    add("openrouter", OPENROUTER_BASE_URL, openrouterKey, [
      process.env.AI_MODEL,
      ...OPENROUTER_MODELS,
    ]);
  }

  return attempts;
}

// Retry on transient/availability errors; anything else (malformed request)
// is a real bug and should surface.
const RETRYABLE_STATUSES = new Set([402, 404, 408, 429, 500, 502, 503, 504]);

// Some models (Qwen3, DeepSeek R1) emit visible reasoning. Never DM that.
function cleanReply(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Gemma-family models have no system role. Most providers accept one and
// prepend it, but those that don't reject the request outright — so retry
// with the prompt folded into the first user turn.
function withSystemMerged(messages: ChatMessage[]): ChatMessage[] {
  const convo = messages.filter((m) => m.role !== "system");
  const firstUser = convo.findIndex((m) => m.role === "user");
  if (firstUser === -1) {
    return [{ role: "user", content: INSTAGRAM_SYSTEM_PROMPT }];
  }
  return convo.map((m, i) =>
    i === firstUser
      ? { ...m, content: `${INSTAGRAM_SYSTEM_PROMPT}\n\n---\n\nCustomer: ${m.content}` }
      : m
  );
}

function rejectsSystemRole(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  if (e.status !== 400) return false;
  return /system/i.test(e.message ?? "");
}

export async function getAIResponse(
  messages: { role: "user" | "assistant"; content: string }[]
) {
  const payload: ChatMessage[] = [
    { role: "system", content: INSTAGRAM_SYSTEM_PROMPT },
    ...messages,
  ];

  const attempts = getAttempts();
  if (attempts.length === 0) {
    console.error("No AI provider configured — set GEMINI_API_KEY or OPENROUTER_API_KEY.");
  }

  const failures: string[] = [];

  for (const { client, model, provider } of attempts) {
    const label = `${provider}/${model}`;
    try {
      const params = {
        model,
        // Instagram DMs should stay short; also caps free-tier token burn.
        max_tokens: 400,
        temperature: 0.7,
      };

      let completion;
      try {
        completion = await client.chat.completions.create({ ...params, messages: payload });
      } catch (err: unknown) {
        if (!rejectsSystemRole(err)) throw err;
        console.warn(`${label} rejected the system role, retrying merged...`);
        completion = await client.chat.completions.create({
          ...params,
          messages: withSystemMerged(payload),
        });
      }

      const reply = cleanReply(completion.choices[0]?.message?.content || "");
      if (reply) return reply;

      failures.push(`${label}: empty reply`);
      console.warn(`${label} returned an empty reply, trying next...`);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status !== undefined && !RETRYABLE_STATUSES.has(status)) throw err;
      failures.push(`${label}: HTTP ${status ?? "network error"}`);
      console.warn(`${label} failed with ${status ?? "network error"}, trying next...`);
    }
  }

  // Every model failed. Log loudly — this is the one path that sends a
  // non-answer to a customer, so it must be obvious in the server logs.
  console.error(
    `All ${failures.length} model(s) failed, sending fallback message. ` +
      `Attempts: ${failures.join(" | ")}. ` +
      `404 = model ID retired or wrong; 429 = rate-limited; ` +
      `401/403 = bad API key. Run "npm run doctor" to diagnose.`
  );

  // Keep the lead warm instead of going silent.
  return "Sorry, thoda technical issue aa gaya 🙏 Aap humein +91 91267 55555 par WhatsApp kar dijiye, ya apna number share kijiye — hamari team turant call karegi!";
}
