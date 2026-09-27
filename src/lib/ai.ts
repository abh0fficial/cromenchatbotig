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

// Probed live against the API. The 2.5 line is refused for newer keys
// ("no longer available to new users"), so the cascade is 3.x, ordered by
// quality then latency, with fast lite models behind as cheap fallbacks.
const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
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

// reasoning_effort is provider-specific and not in every SDK version's type.
type CreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

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

// A rate limit is often just a burst. Retrying the same model briefly recovers
// far more conversations than moving straight on, but Meta re-delivers a
// webhook it considers slow, so the whole attempt chain stays inside a budget.
const OVERALL_DEADLINE_MS = 12_000;
const RATE_LIMIT_BACKOFF_MS = 2_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// Not every Gemini model accepts reasoning_effort — gemini-3.5-flash-lite
// returns 400 for it while answering fine without.
function rejectsReasoningEffort(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  if (e.status !== 400) return false;
  return /reasoning|thinking|thought/i.test(e.message ?? "");
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
  const startedAt = Date.now();
  const timeLeft = () => OVERALL_DEADLINE_MS - (Date.now() - startedAt);

  // Result of one model attempt: a reply to send, or nothing (reason recorded).
  async function tryAttempt({ client, model, provider }: Attempt): Promise<string | null> {
    const label = `${provider}/${model}`;
    const params = {
      model,
      // Headroom. Gemini 2.5 counts internal thinking against this budget, and
      // when it spikes the visible reply gets cut mid-sentence. Length is
      // controlled by the prompt, not by starving the token budget.
      max_tokens: 1000,
      temperature: 0.7,
      // Turn Gemini's thinking off outright: this is a short chat reply, and
      // thinking only adds latency and truncation risk. Gemini-only — other
      // providers may reject an unknown parameter.
      ...(provider === "gemini" ? { reasoning_effort: "none" } : {}),
    };

    // A 400 from one unsupported parameter should not lose the model, so drop
    // the offending part and try again rather than moving on.
    let completion;
    try {
      completion = await client.chat.completions.create({
        ...params,
        messages: payload,
      } as CreateParams);
    } catch (err: unknown) {
      if (rejectsReasoningEffort(err)) {
        console.warn(`${label} rejected reasoning_effort, retrying without it...`);
        const { reasoning_effort: _dropped, ...rest } = params as Record<string, unknown>;
        completion = await client.chat.completions.create({
          ...rest,
          messages: payload,
        } as CreateParams);
      } else if (rejectsSystemRole(err)) {
        console.warn(`${label} rejected the system role, retrying merged...`);
        completion = await client.chat.completions.create({
          ...params,
          messages: withSystemMerged(payload),
        } as CreateParams);
      } else {
        throw err;
      }
    }

    const choice = completion.choices[0];
    const reply = cleanReply(choice?.message?.content || "");

    // Hit the token ceiling: the text ends mid-sentence. Salvage the complete
    // sentences; if there are none, move on rather than DM a fragment.
    if (choice?.finish_reason === "length") {
      const whole = reply.match(/^[\s\S]*[.!?…]|^[\s\S]*[\u0900-\u097F]।/);
      const salvaged = whole?.[0]?.trim();
      if (salvaged && salvaged.length > 40) {
        console.warn(`${label} hit the token limit; trimmed to the last complete sentence.`);
        return salvaged;
      }
      failures.push(`${label}: truncated (finish_reason=length)`);
      console.warn(`${label} was truncated with nothing salvageable, trying next...`);
      return null;
    }

    if (reply) return reply;

    failures.push(`${label}: empty reply`);
    console.warn(`${label} returned an empty reply, trying next...`);
    return null;
  }

  // First pass over every model. A rate-limited one is set aside rather than
  // waited on, so the other models are tried first.
  const rateLimited: Attempt[] = [];

  for (const attempt of attempts) {
    const label = `${attempt.provider}/${attempt.model}`;
    if (timeLeft() <= 0) {
      failures.push("deadline reached");
      break;
    }
    try {
      const reply = await tryAttempt(attempt);
      if (reply) return reply;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status !== undefined && !RETRYABLE_STATUSES.has(status)) throw err;
      if (status === 429) rateLimited.push(attempt);
      failures.push(`${label}: HTTP ${status ?? "network error"}`);
      console.warn(`${label} failed with ${status ?? "network error"}, trying next...`);
    }
  }

  // A rate limit is often just a burst, so back off once and retry those.
  if (rateLimited.length > 0 && timeLeft() > RATE_LIMIT_BACKOFF_MS + 2_000) {
    console.warn(
      `${rateLimited.length} model(s) rate-limited; backing off ${RATE_LIMIT_BACKOFF_MS}ms and retrying once.`
    );
    await sleep(RATE_LIMIT_BACKOFF_MS);

    for (const attempt of rateLimited) {
      const label = `${attempt.provider}/${attempt.model}`;
      if (timeLeft() <= 0) break;
      try {
        const reply = await tryAttempt(attempt);
        if (reply) {
          console.warn(`${label} succeeded on the rate-limit retry.`);
          return reply;
        }
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        if (status !== undefined && !RETRYABLE_STATUSES.has(status)) throw err;
        failures.push(`${label}: HTTP ${status ?? "network error"} (retry)`);
      }
    }
  }

  // Everything failed. Log loudly — this is the one path that sends a
  // non-answer to a customer, so it must be obvious in the server logs.
  console.error(
    `All attempts failed, sending fallback message. ` +
      `Attempts: ${failures.join(" | ")}. ` +
      `404 = model ID retired or wrong; 429 = rate-limited (enable billing or ` +
      `add an OpenRouter key); 401/403 = bad API key. Run "npm run doctor".`
  );

  // Keep the lead warm instead of going silent.
  return "Sorry, thoda technical issue aa gaya 🙏 Aap humein +91 91267 55555 par WhatsApp kar dijiye, ya apna number share kijiye — hamari team turant call karegi!";
}
