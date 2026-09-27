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
  OPENROUTER_API_KEY: OR_KEY,
  INSTAGRAM_ACCESS_TOKEN: IG_TOKEN,
  INSTAGRAM_VERIFY_TOKEN: IG_VERIFY,
})) {
  val ? ok(`${name} set`) : bad(`${name} is MISSING`);
}
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

// --- 3. OpenRouter: real completion through the live prompt ----------------
console.log("\n── OpenRouter ──");
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
for (const model of [...new Set(CASCADE)]) {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
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
      const reply = j.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      ok(`${model} → "${reply.slice(0, 80)}"`);
      working ??= model;
    } else {
      warn(`${model} unavailable (HTTP ${r.status}${j.error?.message ? `: ${j.error.message.slice(0, 80)}` : ""})`);
    }
  } catch (e) {
    warn(`${model} request failed: ${e.message}`);
  }
}
if (working) {
  ok(`AI is working — first healthy model: ${working}`);
  if (AI_MODEL && working !== AI_MODEL) {
    warn(`AI_MODEL="${AI_MODEL}" is not usable; the cascade fell back to ${working}.`);
    warn(`Consider setting AI_MODEL=${working} in .env.local.`);
  }
} else {
  bad("No model responded.");
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
