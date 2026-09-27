#!/usr/bin/env node
/**
 * Connection doctor — checks that every external service this project needs
 * is reachable and correctly configured.
 *
 *   npm run doctor
 *
 * Reads .env.local. Exits non-zero if any required check fails.
 */

import { readFileSync } from "node:fs";

// --- load .env.local -------------------------------------------------------
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  console.error("✖ Could not read .env.local — create it first (see README).");
  process.exit(1);
}

const {
  NEXT_PUBLIC_SUPABASE_URL: SB_URL,
  SUPABASE_SERVICE_ROLE_KEY: SB_KEY,
  OPENROUTER_API_KEY: OR_KEY,
  AI_MODEL,
  GEMINI_API_KEY: GM_KEY,
  GEMINI_MODEL,
  INSTAGRAM_ACCESS_TOKEN: IG_TOKEN,
  INSTAGRAM_VERIFY_TOKEN: IG_VERIFY,
} = process.env;

let failed = 0;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => { console.log(`✖ ${m}`); failed++; };
const warn = (m) => console.log(`! ${m}`);

// --- 1. env vars present ---------------------------------------------------
console.log("\n── Environment variables ──");
for (const [name, val] of Object.entries({
  NEXT_PUBLIC_SUPABASE_URL: SB_URL,
  SUPABASE_SERVICE_ROLE_KEY: SB_KEY,
  INSTAGRAM_ACCESS_TOKEN: IG_TOKEN,
  INSTAGRAM_VERIFY_TOKEN: IG_VERIFY,
})) {
  val ? ok(`${name} set`) : bad(`${name} is MISSING`);
}
if (GM_KEY) ok("GEMINI_API_KEY set (primary provider)");
if (OR_KEY) ok("OPENROUTER_API_KEY set (fallback provider)");
if (!GM_KEY && !OR_KEY) bad("Set GEMINI_API_KEY and/or OPENROUTER_API_KEY");
if (failed) { console.log("\nFix the missing variables, then re-run.\n"); process.exit(1); }

// --- 2. Supabase tables ----------------------------------------------------
console.log("\n── Supabase ──");
for (const table of ["instagram_conversations", "instagram_messages"]) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${table}?select=id&limit=1`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (r.ok) ok(`table "${table}" reachable`);
    else if (r.status === 404) bad(`table "${table}" NOT FOUND — apply supabase/schema.sql`);
    else bad(`table "${table}" returned HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
  } catch (e) {
    bad(`Supabase unreachable: ${e.message}`);
  }
}

// --- 3. AI providers: real completions -------------------------------------
async function probe(baseURL, key, model) {
  try {
    const r = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 100,
        messages: [
          { role: "system", content: "Reply in one short line." },
          { role: "user", content: "Hi, kya aap wall hung closet banate ho?" },
        ],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.choices?.[0]?.message?.content) {
      return { ok: true, reply: j.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() };
    }
    return { ok: false, why: `HTTP ${r.status}${j.error?.message ? `: ${j.error.message.slice(0, 90)}` : ""}` };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

let anyModelWorks = false;

console.log("\n── Google Gemini (primary) ──");
if (!GM_KEY) {
  warn("GEMINI_API_KEY not set, skipping");
} else {
  const base = "https://generativelanguage.googleapis.com/v1beta/openai";
  for (const model of [...new Set([GEMINI_MODEL, "gemini-2.5-flash", "gemini-2.5-flash-lite"].filter(Boolean))]) {
    const r = await probe(base, GM_KEY, model);
    if (r.ok) { ok(`${model} → "${r.reply.slice(0, 80)}"`); anyModelWorks = true; }
    else warn(`${model} unavailable (${r.why})`);
  }
  if (!anyModelWorks) bad("Gemini answered nothing — check GEMINI_API_KEY at https://aistudio.google.com/apikey");
}

console.log("\n── OpenRouter (fallback) ──");
const CASCADE = [
  AI_MODEL,
  "google/gemma-4-26b-a4b-it:free",
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "qwen/qwen3-8b:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
].filter(Boolean);

let working = null;
if (!OR_KEY) {
  warn("OPENROUTER_API_KEY not set, skipping");
} else {
  for (const model of [...new Set(CASCADE)]) {
    const r = await probe("https://openrouter.ai/api/v1", OR_KEY, model);
    if (r.ok) { ok(`${model} → "${r.reply.slice(0, 80)}"`); working ??= model; anyModelWorks = true; }
    else warn(`${model} unavailable (${r.why})`);
  }
}
if (working) {
  ok(`OpenRouter fallback healthy: ${working}`);
  if (AI_MODEL && working !== AI_MODEL) {
    warn(`AI_MODEL="${AI_MODEL}" is not usable; the cascade fell back to ${working}.`);
    warn(`Consider setting AI_MODEL=${working} in .env.local.`);
  }
} else if (OR_KEY && !anyModelWorks) {
  bad("No model responded on any provider.");
  // Every model failed — find out what this key can actually use.
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${OR_KEY}` },
    });
    if (r.status === 401) {
      bad("OPENROUTER_API_KEY is invalid or revoked (HTTP 401). Create a new key.");
    } else if (r.ok) {
      const models = (await r.json()).data ?? [];
      const free = models
        .filter((m) => m.id.endsWith(":free") && (m.architecture?.output_modalities ?? ["text"]).includes("text"))
        .map((m) => m.id)
        .sort();
      console.log(`\n  Your key is valid. ${models.length} models available, ${free.length} free.`);
      if (free.length) {
        console.log("  Free text models you can set as AI_MODEL:");
        for (const id of free.slice(0, 20)) console.log(`    ${id}`);
        if (free.length > 20) console.log(`    ...and ${free.length - 20} more`);
        console.log("\n  If the models above work but the cascade failed, you are rate-limited.");
        console.log("  Add credit at https://openrouter.ai/credits and use a paid model.");
      }
    } else {
      warn(`Could not list models (HTTP ${r.status}).`);
    }
  } catch (e) {
    warn(`Could not reach the model catalog: ${e.message}`);
  }
}

if (anyModelWorks) ok("AI is working — the bot can reply.");

// --- 4. Instagram token ----------------------------------------------------
console.log("\n── Instagram ──");
try {
  const r = await fetch(
    `https://graph.instagram.com/v24.0/me?fields=id,username&access_token=${IG_TOKEN}`
  );
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.id) ok(`token valid — @${j.username ?? j.id}`);
  else bad(`token rejected (HTTP ${r.status}): ${j.error?.message ?? "unknown error"}`);
} catch (e) {
  bad(`graph.instagram.com unreachable: ${e.message}`);
}

// --- summary ---------------------------------------------------------------
console.log(
  failed
    ? `\n${failed} check(s) failed.\n`
    : "\nAll checks passed — everything is connected. 🚀\n"
);
process.exit(failed ? 1 : 0);
