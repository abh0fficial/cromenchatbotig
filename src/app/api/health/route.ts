/**
 * Deployment fingerprint. Open /api/health in a browser to see which commit is
 * actually serving traffic and which providers it has configured — the quickest
 * way to catch a webhook still pointing at a stale preview deployment.
 *
 * Reports only whether a credential is present, never its value.
 */
export async function GET() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;

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
    supabase: { configured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) },
    instagram: {
      tokenConfigured: Boolean(process.env.INSTAGRAM_ACCESS_TOKEN),
      verifyTokenConfigured: Boolean(process.env.INSTAGRAM_VERIFY_TOKEN),
    },
  });
}
