import { NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendInstagramMessage } from "@/lib/instagram";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { message } = body;

  if (!message?.trim()) {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }

  // Get conversation to find igsid
  const { data: conversation, error: convoError } = await supabase
    .from("instagram_conversations")
    .select("igsid")
    .eq("id", id)
    .single();

  if (convoError || !conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  // Send via Instagram
  await sendInstagramMessage(conversation.igsid, message);

  // Store in DB
  const { data: msg, error: msgError } = await supabase
    .from("instagram_messages")
    .insert({
      conversation_id: id,
      role: "assistant",
      content: message,
    })
    .select()
    .single();

  if (msgError) {
    return Response.json({ error: msgError.message }, { status: 500 });
  }

  // Update conversation timestamp
  await supabase
    .from("instagram_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  return Response.json(msg);
}
