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
    // Counts: if conversations grow in step with messages, each message is
    // creating its own conversation and the bot has no history to work from.
    const { count: convos } = await supabase
      .from("instagram_conversations")
      .select("*", { count: "exact", head: true });
    const { count: msgs } = await supabase
      .from("instagram_messages")
      .select("*", { count: "exact", head: true });
    out.conversationCount = convos ?? null;
    out.messageCount = msgs ?? null;
    if (convos && msgs && msgs / convos < 1.5) {
      out.warning =
        "Few messages per conversation — history may not be accumulating (check the igsid UNIQUE constraint).";
    }

    const probe = `__healthcheck_${Date.now()}`;
    // Insert the SAME shape the webhook uses, not just igsid. A table missing
    // any profile column accepts the minimal row and fails the real one, which
    // would report healthy while the bot silently lost its memory.
    const fullRow = {
      igsid: probe,
      name: "healthcheck",
      username: "healthcheck",
      profile_pic: null,
      follower_count: 0,
      is_user_follow_business: null,
      is_business_follow_user: null,
    };
    const { data, error: wErr } = await supabase
      .from("instagram_conversations")
      .insert(fullRow)
      .select()
      .single();
    if (wErr) {
      out.writable = `NO — ${wErr.code ?? ""}: ${wErr.message}`;
      out.memory = "BROKEN: the bot cannot store messages, so it will greet on every message";
      // Narrow it down: does a bare row work where the full one does not?
      const { data: bare, error: bareErr } = await supabase
        .from("instagram_conversations")
        .insert({ igsid: probe })
        .select()
        .single();
      if (!bareErr) {
        out.diagnosis =
          "A minimal row inserts but the full profile row does not — your instagram_conversations table is missing columns. Apply supabase/schema.sql.";
        await supabase.from("instagram_conversations").delete().eq("id", bare.id);
      }
    } else {
      out.writable = "yes";
      out.memory = "ok";

      // A second insert of the same igsid must be rejected with 23505. Without
      // that constraint duplicate conversations pile up and history is lost.
      const { error: dupErr } = await supabase
        .from("instagram_conversations")
        .insert({ igsid: probe });
      out.igsidUnique =
        dupErr?.code === "23505"
          ? "yes"
          : "NO — igsid is not UNIQUE, so duplicate conversations can hide history. Fix: alter table instagram_conversations add constraint instagram_conversations_igsid_key unique (igsid);";

      await supabase.from("instagram_conversations").delete().eq("igsid", probe);
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    out.memory = "BROKEN: Supabase unreachable";
  }
  return out;
}

// Verifies the token actually works and names the connected account — the
// quickest way to confirm a handle switch took effect.
async function checkInstagram() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const out: Record<string, unknown> = {
    tokenConfigured: Boolean(token),
    verifyTokenConfigured: Boolean(process.env.INSTAGRAM_VERIFY_TOKEN),
  };
  if (!token) return out;

  const base =
    process.env.INSTAGRAM_GRAPH_BASE_URL ?? "https://graph.instagram.com/v24.0";

  // Instagram Business Login exposes user_id on /me, not id, and rejects an
  // unknown field with "Unsupported request - method type: get". Try the
  // documented shapes and report the first that answers.
  // field list per attempt; null means request no fields at all
  const variants: (string | null)[] = [
    "user_id,username",
    "id,username",
    "username",
    null,
  ];

  const errors: string[] = [];
  for (const fields of variants) {
    const path = fields ? `me?fields=${fields}` : "me";
    try {
      const url = new URL(`${base}/me`);
      if (fields) url.searchParams.set("fields", fields);
      url.searchParams.set("access_token", token);
      const r = await fetch(url.toString());
      const d = await r.json().catch(() => ({}));
      if (r.ok && (d.user_id || d.id || d.username)) {
        out.tokenValid = true;
        out.connectedAccount = d.username ? `@${d.username}` : String(d.user_id ?? d.id);
        out.accountId = String(d.user_id ?? d.id ?? "");
        out.probeUsed = path;
        return out;
      }
      errors.push(`${path} → HTTP ${r.status}: ${d?.error?.message ?? "no data"}`);
      if (d?.error?.code === 190) {
        out.tokenValid = false;
        out.errors = errors;
        out.diagnosis =
          "Token expired or revoked (code 190) — generate a new one in the Meta App Dashboard.";
        return out;
      }
    } catch (e) {
      errors.push(`${path} → ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  out.tokenValid = false;
  out.errors = errors;
  out.note =
    "Could not read the profile, which does NOT by itself mean the token cannot send messages — sending uses POST /me/messages. Check the Vercel logs for a reply attempt.";
  return out;
}

export async function GET() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const [supabaseStatus, instagramStatus] = await Promise.all([
    checkSupabase(),
    checkInstagram(),
  ]);

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
    instagram: instagramStatus,
  });
}
