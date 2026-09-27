export interface InstagramProfile {
  name: string | null;
  username: string | null;
  profile_pic: string | null;
  follower_count: number | null;
  is_user_follow_business: boolean | null;
  is_business_follow_user: boolean | null;
}

// Overridable so tests can point at a local stub.
const GRAPH_BASE =
  process.env.INSTAGRAM_GRAPH_BASE_URL ?? "https://graph.instagram.com/v24.0";

export async function fetchInstagramProfile(igsid: string): Promise<InstagramProfile> {
  const url = new URL(`${GRAPH_BASE}/${igsid}`);
  url.searchParams.set("fields", "name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user");
  url.searchParams.set("access_token", process.env.INSTAGRAM_ACCESS_TOKEN!);

  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));

  // The profile is cosmetic, so a failure here must not abort the reply — but
  // it should be visible rather than silently becoming a row of nulls.
  if (!res.ok) {
    console.warn(
      `Instagram profile fetch failed (HTTP ${res.status}): ${data?.error?.message ?? "unknown"}`
    );
  }

  return {
    name: data.name ?? null,
    username: data.username ?? null,
    profile_pic: data.profile_pic ?? null,
    follower_count: data.follower_count ?? null,
    is_user_follow_business: data.is_user_follow_business ?? null,
    is_business_follow_user: data.is_business_follow_user ?? null,
  };
}

export async function sendInstagramMessage(recipientIgsid: string, text: string) {
  const url = new URL(`${GRAPH_BASE}/me/messages`);
  url.searchParams.set("access_token", process.env.INSTAGRAM_ACCESS_TOKEN!);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientIgsid },
      // Instagram rejects a message over 1000 characters outright, which would
      // silently lose the whole reply.
      message: { text: text.length > 1000 ? `${text.slice(0, 997)}...` : text },
    }),
  });

  const data = await res.json().catch(() => ({}));

  // This used to return the body regardless of status, so a rejected send —
  // an expired token, a closed messaging window, a rate limit — looked exactly
  // like a delivered message: no reply for the customer and nothing in the
  // logs. Surface it so the caller knows the reply never arrived.
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new Error(
      `Instagram send failed (HTTP ${res.status}) code=${e.code ?? "?"}/${e.error_subcode ?? "-"}: ${e.message ?? JSON.stringify(data).slice(0, 200)}`
    );
  }

  return data;
}
