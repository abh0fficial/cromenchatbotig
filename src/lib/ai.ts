import OpenAI from "openai";
import { INSTAGRAM_SYSTEM_PROMPT } from "@/lib/system-prompt";

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
    });
  }
  return _openai;
}

// Tried in order. AI_MODEL (if set) goes first, then this cascade — so a
// rate-limited or retired model never takes the bot offline.
const DEFAULT_MODELS = [
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "qwen/qwen3-8b:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
];

function getFallbackModels(): string[] {
  const models = [process.env.AI_MODEL, ...DEFAULT_MODELS].filter(
    Boolean
  ) as string[];
  // De-dupe in case AI_MODEL is already in the cascade
  return [...new Set(models)];
}

// Retry on transient/availability errors; anything else (bad key, malformed
// request) is a real bug and should surface.
const RETRYABLE_STATUSES = new Set([402, 404, 408, 429, 500, 502, 503, 504]);

// Some models (Qwen3, DeepSeek R1) emit visible reasoning. Never DM that.
function cleanReply(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

export async function getAIResponse(
  messages: { role: "user" | "assistant"; content: string }[]
) {
  const payload = [
    { role: "system" as const, content: INSTAGRAM_SYSTEM_PROMPT },
    ...messages,
  ];

  const failures: string[] = [];

  for (const model of getFallbackModels()) {
    try {
      const completion = await getOpenAI().chat.completions.create({
        model,
        messages: payload,
        // Instagram DMs should stay short; also caps free-tier token burn.
        max_tokens: 400,
        temperature: 0.7,
      });

      const reply = cleanReply(completion.choices[0]?.message?.content || "");
      if (reply) return reply;

      failures.push(`${model}: empty reply`);
      console.warn(`Model ${model} returned an empty reply, trying next...`);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status !== undefined && !RETRYABLE_STATUSES.has(status)) throw err;
      failures.push(`${model}: HTTP ${status ?? "network error"}`);
      console.warn(`Model ${model} failed with ${status ?? "network error"}, trying next...`);
    }
  }

  // Every model failed. Log loudly — this is the one path that sends a
  // non-answer to a customer, so it must be obvious in the server logs.
  console.error(
    `All ${failures.length} model(s) failed, sending fallback message. ` +
      `Attempts: ${failures.join(" | ")}. ` +
      `404 = model ID retired or wrong; 429 = rate-limited (add OpenRouter credit); ` +
      `401 = bad OPENROUTER_API_KEY. Run "npm run doctor" to diagnose.`
  );

  // Keep the lead warm instead of going silent.
  return "Sorry, thoda technical issue aa gaya 🙏 Aap humein +91 91267 55555 par WhatsApp kar dijiye, ya apna number share kijiye — hamari team turant call karegi!";
}
