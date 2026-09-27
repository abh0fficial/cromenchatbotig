import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendInstagramMessage, fetchInstagramProfile } from "@/lib/instagram";
import { getAIResponse } from "@/lib/ai";

// The AI chain alone may take ~12s. Vercel's default is 10s, which killed the
// function mid-reply, so declare a ceiling that leaves room for the DB and the
// Instagram send.
export const maxDuration = 30;

type Msg = { role: "user" | "assistant"; content: string };

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (body.object !== "instagram") {
    return Response.json({ status: "ignored" });
  }

  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];

  if (!messaging) {
    return Response.json({ status: "no_messaging" });
  }

  // Skip echoes of our own outgoing messages. is_echo is the documented flag;
  // the sender check is a second line of defence, because processing our own
  // message would have the bot reply to itself in a loop and burn the AI quota.
  if (messaging.message?.is_echo) {
    return Response.json({ status: "echo_ignored" });
  }
  if (messaging.sender?.id && messaging.sender.id === entry?.id) {
    return Response.json({ status: "self_ignored" });
  }

  if (!messaging.message?.text) {
    return Response.json({ status: "non_text" });
  }

  const igsid = messaging.sender.id;
  const text = messaging.message.text;
  const instagramMsgId = messaging.message.mid;
  // Correlates every log line of one delivery, so a failing step is findable.
  const tag = `[dm ${igsid}/${(instagramMsgId ?? "no-mid").slice(-8)}]`;

  // Everything except the AI call and the send is best-effort. A customer
  // waiting on a reply must not be dropped because a profile lookup or an
  // analytics write failed, so each step logs and degrades instead of throwing.
  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      console.error(`${tag} ${name} failed:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  try {
    console.log(`${tag} received: ${JSON.stringify(text.slice(0, 80))}`);

    // --- conversation ------------------------------------------------------
    // Deliberately not maybeSingle: if the igsid unique constraint is missing
    // the table can hold duplicates, and maybeSingle errors on more than one
    // row. That would look like "no conversation", so a new one would be
    // created per message and the bot would greet every time. Take the oldest.
    let conversation = await step("conversation lookup", async () => {
      const { data, error } = await supabase
        .from("instagram_conversations")
        .select("*")
        .eq("igsid", igsid)
        .order("created_at", { ascending: true })
        .limit(1);
      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    });

    const profile = await step("profile fetch", () => fetchInstagramProfile(igsid));

    if (!conversation) {
      conversation = await step("conversation insert", async () => {
        const { data, error } = await supabase
          .from("instagram_conversations")
          .insert({ igsid, ...(profile ?? {}) })
          .select()
          .single();
        if (!error) return data;

        // The profile columns are optional extras; igsid is the only one the
        // conversation needs. If the table is missing any of them the insert
        // fails, and without a conversation row there is no history — so the
        // bot would greet on every message. Retry with igsid alone.
        console.error(
          `${tag} conversation insert with profile failed (${error.code ?? "?"}: ${error.message}); retrying with igsid only`
        );
        const { data: bare, error: bareErr } = await supabase
          .from("instagram_conversations")
          .insert({ igsid })
          .select()
          .single();
        if (bareErr) throw new Error(bareErr.message);
        return bare;
      });
      // Lost a race with a concurrent delivery — read the row it created.
      if (!conversation) {
        conversation = await step("conversation re-read", async () => {
          const { data } = await supabase
            .from("instagram_conversations")
            .select("*")
            .eq("igsid", igsid)
            .order("created_at", { ascending: true })
            .limit(1);
          return data?.[0] ?? null;
        });
      }
    } else if (profile) {
      await step("profile refresh", async () => {
        await supabase
          .from("instagram_conversations")
          .update(profile)
          .eq("id", conversation!.id);
      });
    }

    // Human has taken over — store only, never auto-reply.
    if (conversation?.mode === "human") {
      await step("store user message (human mode)", async () => {
        await supabase.from("instagram_messages").insert({
          conversation_id: conversation!.id,
          role: "user",
          content: text,
          instagram_msg_id: instagramMsgId,
        });
      });
      console.log(`${tag} human mode, stored without replying`);
      return Response.json({ status: "stored_for_human" });
    }

    // --- store the incoming message, and drop Meta's re-deliveries ---------
    if (conversation) {
      const duplicate = await step("store user message", async () => {
        const { error } = await supabase.from("instagram_messages").insert({
          conversation_id: conversation!.id,
          role: "user",
          content: text,
          instagram_msg_id: instagramMsgId,
        });
        // 23505 = unique violation on instagram_msg_id: Meta re-delivered a
        // message we already answered. Replying again would double-send.
        if (error?.code === "23505") return true;
        if (error) throw new Error(error.message);
        return false;
      });

      if (duplicate) {
        console.log(`${tag} duplicate delivery, skipping`);
        return Response.json({ status: "duplicate" });
      }
    }

    // --- history ------------------------------------------------------------
    // Without it the bot still answers, just without memory of earlier turns.
    let history: Msg[] = [{ role: "user", content: text }];
    if (conversation) {
      const rows = await step("history fetch", async () => {
        // Newest 20, then flipped back into chronological order. Ordering
        // ascending with a limit returns the OLDEST 20 instead, so past 20
        // messages the model would only ever see the start of the
        // conversation and would keep replying as if it had just begun.
        const { data, error } = await supabase
          .from("instagram_messages")
          .select("role, content, created_at")
          .eq("conversation_id", conversation!.id)
          .order("created_at", { ascending: false })
          .limit(20);
        if (error) throw new Error(error.message);
        return (data ?? []).reverse();
      });

      const cleaned: Msg[] = (rows ?? [])
        .filter((m) => !!m.content?.trim() && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      // The provider needs the exchange to end on the customer's turn.
      if (cleaned.length && cleaned[cleaned.length - 1].role === "user") {
        history = cleaned;
      } else if (cleaned.length) {
        history = [...cleaned, { role: "user", content: text }];
      }
    }

    console.log(`${tag} asking the model with ${history.length} message(s)`);

    // --- the two steps that actually matter --------------------------------
    const aiResponse = await getAIResponse(history);
    await sendInstagramMessage(igsid, aiResponse);
    console.log(`${tag} replied: ${JSON.stringify(aiResponse.slice(0, 80))}`);

    if (conversation) {
      await step("store assistant message", async () => {
        await supabase.from("instagram_messages").insert({
          conversation_id: conversation!.id,
          role: "assistant",
          content: aiResponse,
        });
        await supabase
          .from("instagram_conversations")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", conversation!.id);
      });
    }

    return Response.json({ status: "replied" });
  } catch (error) {
    // Only a failed AI call or a failed send reaches here. Return 200 so Meta
    // does not re-deliver and burn the quota again on a message that will fail
    // the same way; the log line above names the step.
    console.error(`${tag} FAILED:`, error instanceof Error ? error.stack ?? error.message : error);
    return Response.json({ status: "error" });
  }
}
