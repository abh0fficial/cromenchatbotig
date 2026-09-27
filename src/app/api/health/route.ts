/**
 * Deployment fingerprint. Open /api/health in a browser to see which commit is
 * actually serving traffic and which providers it has configured — the quickest
 * way to catch a webhook still pointing at a stale preview deployment.
 *
 * Reports only whether a credential is present, never its value.
 */
import { supabase } from "@/lib/supabase";

// Reads and writes the real tables, because a bot that cannot write has no
// memory: every message then looks like the first and it greets again.
async function checkSupabase() {
  const out: Record<string, unknown> = {
    configured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
  };
  try {
    for (const table of ["instagram_conversations", "instagram_messages"]) {
      const { error } = await supabase.from(table).select("id").limit(1);
      out[table] = error ? `ERROR ${error.code ?? ""}: ${error.message}` : "readable";
    }

    // A read can succeed while an insert fails (missing column, RLS, grants),
    // and it is the insert that memory depends on.
    const probe = `__healthcheck_${Date.now()}`;
    const { data, error: wErr } = await supabase
      .from("instagram_conversations")
      .insert({ igsid: probe })
      .select()
      .single();
    if (wErr) {
      out.writable = `NO — ${wErr.code ?? ""}: ${wErr.message}`;
      out.memory = "BROKEN: the bot cannot store messages, so it will greet on every message";
    } else {
      out.writable = "yes";
      out.memory = "ok";
      await supabase.from("instagram_conversations").delete().eq("id", data.id);
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    out.memory = "BROKEN: Supabase unreachable";
  }
  return out;
}

export async function GET() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const supabaseStatus = await checkSupabase();

  return Response.json({
    ok: true,
    commit: sha ? sha.slice(0, 7) : "unknown (not a Vercel build)",
    commitFull: sha,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    // Bump when the reply behaviour changes, so a stale deploy is obvious even
    // without a git SHA.
    agentVersion: "2026-09-27.gemini-primary",
    providers: {
      gemini: {
        configured: Boolean(process.env.GEMINI_API_KEY),
        model: process.env.GEMINI_MODEL ?? "(cascade default)",
      },
      openrouter: {
        configured: Boolean(process.env.OPENROUTER_API_KEY),
        model: process.env.AI_MODEL ?? "(cascade default)",
      },
    },
    supabase: supabaseStatus,
    instagram: {
      tokenConfigured: Boolean(process.env.INSTAGRAM_ACCESS_TOKEN),
      verifyTokenConfigured: Boolean(process.env.INSTAGRAM_VERIFY_TOKEN),
    },
  });
}
