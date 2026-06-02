# ROOTS WissensHub

A browser-based knowledge management tool for ROOTS Brand Strategy Consulting.

## Features

- **Document Management** — Upload and organize internal documents (PDF, DOCX, TXT, MD)
- **Semantic Search & Chat** — Ask questions across your knowledge base using AI-powered retrieval (RAG)
- **Team Access** — Supabase Auth with row-level security ensures only authenticated team members can access content

## Tech Stack

- Frontend: Vanilla HTML/CSS/JS (single-file app)
- Backend: Supabase (Postgres + pgvector + Edge Functions)
- Embeddings: OpenAI `text-embedding-3-small` (1536 dimensions)
- LLM: Claude via the Wissenshub Edge Function

## Setup

1. Copy `config.js` and update `SB_URL` and `SB_ANON` if needed.
2. Deploy the Supabase schema from `supabase/schema.sql`.
3. Deploy the Edge Function from `supabase/functions/`.
4. Open `index.html` in a browser or serve via GitHub Pages.

## Deployment

The `.nojekyll` file ensures GitHub Pages serves the app without Jekyll processing.
