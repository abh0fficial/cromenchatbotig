import { supabase } from "@/lib/supabase";

export async function GET() {
  const { data: conversations, error } = await supabase
    .from("instagram_conversations")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Fetch last message for each conversation
  const withLastMessage = await Promise.all(
    (conversations || []).map(async (convo) => {
      const { data: messages } = await supabase
        .from("instagram_messages")
        .select("content, role, created_at")
        .eq("conversation_id", convo.id)
        .order("created_at", { ascending: false })
        .limit(1);

      return {
        ...convo,
        last_message: messages?.[0]?.content || null,
      };
    })
  );

  return Response.json(withLastMessage);
}
