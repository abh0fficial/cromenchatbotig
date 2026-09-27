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
  bad("No model responded — check OPENROUTER_API_KEY and your credit/rate limits.");
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
