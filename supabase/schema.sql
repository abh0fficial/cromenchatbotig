-- Cromen Instagram DM AI Agent — database schema
-- Apply in the Supabase SQL editor (Dashboard > SQL Editor > New query) or via the Supabase MCP server.

create table if not exists instagram_conversations (
  id uuid default gen_random_uuid() primary key,
  igsid text unique not null,
  name text,
  username text,
  profile_pic text,
  follower_count integer,
  is_user_follow_business boolean,
  is_business_follow_user boolean,
  mode text not null default 'agent' check (mode in ('agent', 'human')),
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);

create table if not exists instagram_messages (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references instagram_conversations(id) on delete cascade not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  instagram_msg_id text unique,
  created_at timestamp with time zone default now()
);

create index if not exists idx_instagram_messages_conversation
  on instagram_messages(conversation_id);
create index if not exists idx_instagram_conversations_updated
  on instagram_conversations(updated_at desc);

-- Realtime is NOT enabled by default. Without this the dashboard will not
-- live-update, even though the subscription code is correct.
alter publication supabase_realtime
  add table instagram_conversations, instagram_messages;
