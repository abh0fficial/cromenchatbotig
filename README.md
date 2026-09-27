# Cromen Instagram DM AI Agent

AI-powered Instagram DM assistant for **Cromen** — a premium bathware brand (est. 2012) based in Morbi, Gujarat.

The agent replies to Instagram DMs automatically, speaks **English and Hinglish**, keeps messages short and emoji-friendly, and is tuned for **sales conversion** — driving showroom visits, contact exchanges, and orders.

## Features

- **Instagram webhook** (`/api/webhook`) — receives DMs via the Meta Instagram Messaging API and replies with AI
- **Cromen knowledge base** — brand story, full product range, materials, contact details, showroom hours, and the sales playbook live in `src/lib/system-prompt.ts`
- **Dashboard** (`/`) — view all conversations, read message history, and take over any chat manually
- **Agent / human mode** — switch a conversation to human mode to reply yourself
- **Model fallback** — cascades through OpenRouter models if one is rate-limited or retired
- **Connection doctor** — `npm run doctor` verifies Supabase, OpenRouter, and the Instagram token in one command

## Tech Stack

- Next.js 16 (App Router) + React 19 + Tailwind CSS 4
- Supabase (conversation + message storage)
- OpenRouter (AI responses)
- Meta Instagram Messaging API

## Getting Started

```bash
npm install
cp .env.example .env.local   # then fill in your credentials
npm run doctor               # verify every service is connected
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the dashboard.

### Verifying the connection

```bash
npm run doctor
```

Checks that all env vars are set, both Supabase tables are reachable, the
Instagram token is valid, and that a real completion comes back from
OpenRouter — printing which model answered. Exits non-zero on failure, so it
works in CI too.

## Environment Variables

Create a `.env.local` file:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# Instagram / Meta
INSTAGRAM_ACCESS_TOKEN=
INSTAGRAM_VERIFY_TOKEN=

# AI (OpenRouter)
OPENROUTER_API_KEY=
AI_MODEL=
```

> `.env*` is gitignored — never commit real credentials.

## Database Schema

Apply `supabase/schema.sql` in the Supabase SQL editor (Dashboard > SQL Editor >
New query). It creates `instagram_conversations` and `instagram_messages`, their
indexes, and adds both tables to the `supabase_realtime` publication — without
that last step the dashboard will not live-update.

## AI Model

`AI_MODEL` is tried first, then the cascade in `src/lib/ai.ts` falls through on
rate limits (429), retired models (404), and upstream errors — so one bad model
never takes the bot offline. Default: `google/gemini-2.0-flash-exp:free`.

Free models are rate-limited. For production traffic, set `AI_MODEL` to a paid
model (e.g. `google/gemini-2.5-flash`) and add credit on OpenRouter.

Replies are capped at 400 tokens to keep DMs short, and any `<think>` reasoning
some models emit is stripped before sending.

## Customising the Chatbot

All brand knowledge and sales behaviour is in a single file:

```
src/lib/system-prompt.ts
```

Edit that file to change products, contact details, tone, or the sales flow — no other code changes needed.

## Deployment

Deploy to Vercel, then point the Meta webhook to:

```
https://<your-domain>/api/webhook
```

Use the same value for `INSTAGRAM_VERIFY_TOKEN` in Vercel and in the Meta App webhook setup.

## Cromen

- Website: [cromen.in](https://cromen.in)
- Phone: +91 91267 55555
- Email: info@cromen.in
- Showroom: Lunsar Road, Morbi – 363621, Gujarat, India
- Hours: Mon–Sat 10:00 AM – 7:00 PM · Sun 11:00 AM – 5:00 PM
