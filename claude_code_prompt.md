# Instagram DM AI Agent - Next.js Application

## Overview
Build a production-ready Instagram DM AI agent using the official Meta Instagram Messaging API with a Next.js app. This replaces n8n — our app handles the webhook, AI responses, and provides a frontend dashboard to view all conversations.

## Architecture

```
User sends Instagram DM
  → Meta forwards to our webhook (POST /api/webhook)
  → App extracts message, fetches user profile from Instagram API
  → App stores profile + message in DB
  → App sends message to AI model (OpenRouter with fallback chain)
  → App sends AI response back via Instagram Graph API
  → App stores AI response in DB
  → Frontend dashboard shows all conversations in real-time
```

## Tech Stack
- **Framework**: Next.js 16+ (App Router, src/ directory)
- **Database**: Supabase (PostgreSQL) with Supabase JS client
- **AI**: OpenRouter API (OpenAI-compatible SDK) with model fallback chain
- **Styling**: Tailwind CSS
- **Deployment**: Vercel or any Node.js host

## Meta Instagram Messaging API Reference

### Webhook Verification (GET /api/webhook)
Meta sends a GET request to verify the webhook. Must return the `hub.challenge` value if `hub.verify_token` matches.

```
Query params: hub.mode, hub.verify_token, hub.challenge
Response: hub.challenge (plain text) if token matches, else 403
```

### Receiving Messages (POST /api/webhook)
Meta sends incoming Instagram DMs as POST to the webhook.

```json
{
  "object": "instagram",
  "entry": [{
    "id": "INSTAGRAM_BUSINESS_ACCOUNT_ID",
    "messaging": [{
      "sender": { "id": "USER_IGSID" },
      "recipient": { "id": "INSTAGRAM_BUSINESS_ACCOUNT_ID" },
      "timestamp": 1234567890,
      "message": {
        "mid": "mid.xxx",
        "text": "Hello"
      }
    }]
  }]
}
```

> **Important:** Echo messages (sent by your own page) will also trigger the webhook. Filter them out by checking `messaging[0].message.is_echo` — if it exists, skip processing.

### Sending Messages (POST)
```
POST https://graph.instagram.com/v24.0/me/messages?access_token={ACCESS_TOKEN}
Content-Type: application/json

{
  "recipient": { "id": "{sender_igsid}" },
  "message": { "text": "Response message here" }
}
```

> **Auth:** The access token is passed as a **query parameter** (`?access_token=...`), not as a Bearer header.

### Fetching User Profile (GET)
```
GET https://graph.instagram.com/v24.0/{IGSID}?fields=name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user&access_token={ACCESS_TOKEN}
```

Response:
```json
{
  "name": "John Doe",
  "username": "johndoe",
  "profile_pic": "https://...",
  "follower_count": 1234,
  "is_user_follow_business": true,
  "is_business_follow_user": false,
  "id": "USER_IGSID"
}
```

> **Note:** Requires `instagram_business_manage_messages` scope. The token is a **User access token** (not a Page token — Instagram doesn't use Page tokens). Profile is fetched on every incoming message to keep data fresh.

## Implementation Plan

### Step 1: Project Setup
- Initialize Next.js project with TypeScript, Tailwind, App Router, `src/` directory
- Install dependencies: `@supabase/supabase-js`, `openai` (for OpenRouter compatibility)
- Set up `.env.local` from `.env.example`
- Configure `next.config.ts` to allow Instagram CDN image domains:
  ```ts
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.cdninstagram.com" },
      { protocol: "https", hostname: "**.fbcdn.net" },
    ],
  }
  ```

### Step 2: Database Schema (Supabase via MCP)
Use the Supabase MCP server (configured in `.mcp.json` as HTTP type) to apply migrations directly.

```sql
create table instagram_conversations (
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

create table instagram_messages (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references instagram_conversations(id) on delete cascade not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  instagram_msg_id text unique,
  created_at timestamp with time zone default now()
);

create index idx_instagram_messages_conversation on instagram_messages(conversation_id);
create index idx_instagram_conversations_updated on instagram_conversations(updated_at desc);
```

After applying, enable Supabase Realtime for both tables (not on by default):
```sql
alter publication supabase_realtime add table instagram_conversations, instagram_messages;
```

> **Critical:** Without this, real-time updates in the dashboard will not work even though the subscription code is correct.

### Step 3: Webhook API Route (`/api/webhook`)
- **GET handler**: Verify webhook with Meta (check verify_token, return challenge)
- **POST handler**:
  1. Parse incoming message from Meta's webhook payload (`entry[0].messaging[0]`)
  2. Ignore echo messages — skip if `messaging[0].message.is_echo` exists
  3. Ignore non-text messages — skip if `message.text` is absent
  4. Find or create conversation by `sender.id` (igsid)
  5. **Fetch Instagram profile** (`name`, `username`, `profile_pic`, `follower_count`, `is_user_follow_business`, `is_business_follow_user`) and upsert into conversation row on every message
  6. Store user message in DB (skip on duplicate `instagram_msg_id`)
  7. Update `updated_at` on conversation
  8. If `mode = 'human'`, stop here — do not auto-reply
  9. Fetch last 20 messages for AI context
  10. Get AI response via fallback model chain
  11. Send AI response back to user via Instagram Graph API
  12. Store AI response in DB
  13. Return 200

### Step 4: Instagram Utility (`src/lib/instagram.ts`)

```typescript
export async function fetchInstagramProfile(igsid: string): Promise<InstagramProfile> {
  const url = new URL(`https://graph.instagram.com/v24.0/${igsid}`);
  url.searchParams.set("fields", "name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user");
  url.searchParams.set("access_token", process.env.INSTAGRAM_ACCESS_TOKEN!);
  const res = await fetch(url.toString());
  const data = await res.json();
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
  const url = new URL("https://graph.instagram.com/v24.0/me/messages");
  url.searchParams.set("access_token", process.env.INSTAGRAM_ACCESS_TOKEN!);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientIgsid }, message: { text } }),
  });
  return res.json();
}
```

### Step 5: AI with Fallback Chain (`src/lib/ai.ts`)

Free models on OpenRouter are frequently rate-limited (429) or unavailable (404). Use a fallback chain that tries each model in order:

```typescript
const FALLBACK_MODELS = [
  process.env.AI_MODEL,
  "google/gemma-3-12b-it:free",
  "google/gemma-3-4b-it:free",
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
].filter(Boolean) as string[];

export async function getAIResponse(messages) {
  for (const model of FALLBACK_MODELS) {
    try {
      const completion = await openai.chat.completions.create({ model, messages: payload });
      return completion.choices[0]?.message?.content || "Sorry, I couldn't generate a response.";
    } catch (err) {
      const status = err?.status;
      if (status !== 429 && status !== 404) throw err;
      console.warn(`Model ${model} failed with ${status}, trying next...`);
    }
  }
  return "Sorry, I'm temporarily unavailable. Please try again shortly.";
}
```

### Step 6: Webhook - Respect mode
In the POST webhook handler, before calling the AI:
1. Check the conversation's `mode` field
2. If `mode = 'agent'` → send message to AI, auto-reply via Instagram
3. If `mode = 'human'` → store the message only, do NOT auto-reply (human replies from the dashboard)

### Step 7: Frontend Dashboard

#### Layout
- **Sidebar (left)**: List of all conversations sorted by latest message
  - Show profile picture (with initials fallback), name, `@username` as subtitle
  - Mode badge (AI = purple, You = amber)
  - Active conversation highlighted with gradient left border
- **Chat panel (right)**: Full message history for selected conversation

#### Chat Header
- Profile picture, display name + `@username`
- Follower count
- "Follows you" badge (purple) and "You follow" badge (pink) — shown conditionally
- Mode toggle button (AI Mode / Human Mode)

#### Chat Panel Features
- Instagram-style chat bubbles — user on left with profile pic avatar, AI/human replies on right with purple→red gradient
- Messages show timestamp and "AI ·" label for assistant messages
- **Mode toggle**: Switch between "Agent" and "Human" per conversation
- **Message input**: Always visible in both modes
- Real-time updates via Supabase Realtime (postgres_changes on `instagram_messages` and `instagram_conversations`)

#### API Routes for Frontend
- `GET /api/conversations` — list all conversations with last message
- `GET /api/conversations/[id]/messages` — get messages for a conversation
- `PATCH /api/conversations/[id]` — update mode (agent/human)
- `POST /api/conversations/[id]/send` — send a manual message from dashboard (calls Instagram Graph API + stores in DB)

### Step 8: Environment Variables
```env
# Meta Instagram Messaging API
INSTAGRAM_ACCESS_TOKEN=   # User access token with instagram_business_manage_messages scope
INSTAGRAM_VERIFY_TOKEN=   # Any string you choose (e.g. "lakshit") — must match Meta webhook config

# AI Model (OpenRouter)
OPENROUTER_API_KEY=       # API key from openrouter.ai
AI_MODEL=google/gemma-3-12b-it:free  # Primary model; fallback chain kicks in on 429/404

# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# App Config
PORT=3001
NEXT_PUBLIC_APP_URL=http://localhost:3001
```

### Step 9: Deployment & Webhook Setup
- Deploy to Vercel (or use ngrok for local testing)
- In Meta App Dashboard → Instagram → Webhooks, set the webhook URL to `https://your-domain/api/webhook`
- Set verify token to match `INSTAGRAM_VERIFY_TOKEN`
- Subscribe to the **`messages`** field under the Instagram webhook

## Key Considerations
- Always return 200 to Meta webhook quickly (within 5 seconds) to avoid retries
- **Echo filter is critical**: Instagram sends an echo for every message your page sends — always skip if `is_echo` is present
- Handle duplicate messages using `instagram_msg_id` (the `mid` field from the payload)
- Store conversation history for AI context (send last 20 messages)
- The `sender.id` is an Instagram-scoped ID (IGSID), not a username — use it as the unique identifier
- **Supabase Realtime must be explicitly enabled** per table via `alter publication supabase_realtime add table ...` — new tables are NOT enrolled automatically
- **Free OpenRouter models get rate-limited frequently** — always implement a fallback model chain, never rely on a single free model
- Profile picture URLs from Instagram CDN expire — they are refreshed on every incoming message
- The access token is a User access token (not Page token); it expires in ~2 months — plan for refresh or use a long-lived token
