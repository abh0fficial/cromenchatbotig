import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendInstagramMessage, fetchInstagramProfile } from "@/lib/instagram";
import { getAIResponse } from "@/lib/ai";

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

  // Only process instagram events
  if (body.object !== "instagram") {
    return Response.json({ status: "ignored" });
  }

  const entry = body.entry?.[0];
  const messaging = entry?.messaging?.[0];

  if (!messaging) {
    return Response.json({ status: "no_messaging" });
  }

  // Skip echo messages (sent by our own page)
  if (messaging.message?.is_echo) {
    return Response.json({ status: "echo_ignored" });
  }

  // Only handle text messages
  if (!messaging.message?.text) {
    return Response.json({ status: "non_text" });
  }

  const igsid = messaging.sender.id;
  const text = messaging.message.text;
  const instagramMsgId = messaging.message.mid;

  try {
    // Find or create conversation
    let { data: conversation } = await supabase
      .from("instagram_conversations")
      .select("*")
      .eq("igsid", igsid)
      .single();

    if (!conversation) {
      // Fetch profile info on first message
      const profile = await fetchInstagramProfile(igsid);
      const { data: newConvo } = await supabase
        .from("instagram_conversations")
        .insert({ igsid, ...profile })
        .select()
        .single();
      conversation = newConvo;
    } else {
      // Refresh profile on every message to keep data up to date
      const profile = await fetchInstagramProfile(igsid);
      await supabase
        .from("instagram_conversations")
        .update(profile)
        .eq("id", conversation.id);
      conversation = { ...conversation, ...profile };
    }

    if (!conversation) {
      return Response.json({ error: "Failed to create conversation" }, { status: 500 });
    }

    // Store user message (ignore duplicates)
    const { error: insertError } = await supabase.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "user",
      content: text,
      instagram_msg_id: instagramMsgId,
    });

    if (insertError?.code === "23505") {
      // Duplicate message, ignore
      return Response.json({ status: "duplicate" });
    }

    // Update conversation timestamp
    await supabase
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id);

    // If mode is 'human', don't auto-reply
    if (conversation.mode === "human") {
      return Response.json({ status: "stored_for_human" });
    }

    // Fetch conversation history (last 20 messages for context)
    const { data: history } = await supabase
      .from("instagram_messages")
      .select("role, content")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true })
      .limit(20);

    // Get AI response
    const aiResponse = await getAIResponse(
      (history || []).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }))
    );

    // Send response via Instagram
    await sendInstagramMessage(igsid, aiResponse);

    // Store AI response
    await supabase.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: aiResponse,
    });

    // Update conversation timestamp again
    await supabase
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id);

    return Response.json({ status: "replied" });
  } catch (error) {
    console.error("Webhook error:", error);
    return Response.json({ status: "error" }, { status: 500 });
  }
}
