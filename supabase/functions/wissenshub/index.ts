import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  "https://pgoutzeris-stack.github.io",
  "http://localhost",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1",
];

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin =
    requestOrigin && ALLOWED_ORIGINS.some((o) => requestOrigin.startsWith(o))
      ? requestOrigin
      : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
  };
}

function corsResponse(
  requestOrigin: string | null,
  body: unknown,
  status = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(requestOrigin),
      "Content-Type": "application/json",
    },
  });
}


const jsonResponse = corsResponse;

function errorResponse(
  requestOrigin: string | null,
  message: string,
  status = 400
): Response {
  return corsResponse(requestOrigin, { error: message }, status);
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Fallback env vars (used if not overridden in knowledge.settings)
const OPENAI_API_KEY_ENV = Deno.env.get("OPENAI_API_KEY") || "";
const ANTHROPIC_API_KEY_ENV = Deno.env.get("ANTHROPIC_API_KEY") || "";
const GOOGLE_API_KEY_ENV = Deno.env.get("GOOGLE_API_KEY") || "";
const VOYAGE_API_KEY_ENV = Deno.env.get("VOYAGE_API_KEY") || "";

// ---------------------------------------------------------------------------
// Supabase admin client (service role — bypasses RLS for internal ops)
// ---------------------------------------------------------------------------
function getAdminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

// ---------------------------------------------------------------------------
// API key resolver — reads from knowledge.settings, falls back to env vars
// Keys are stored in Supabase, never exposed to frontend clients.
// ---------------------------------------------------------------------------
const _keyCache: Record<string, string> = {};
const _keyCacheAt: Record<string, number> = {};
const KEY_CACHE_TTL = 5 * 60 * 1000; // 5 min

async function getApiKey(name: "openai" | "anthropic" | "google" | "voyage"): Promise<string> {
  const now = Date.now();
  if (_keyCache[name] && now - (_keyCacheAt[name] || 0) < KEY_CACHE_TTL) {
    return _keyCache[name];
  }
  const dbKey = `api_key_${name}`;
  const { data } = await getAdminClient()
    .schema("knowledge").from("settings").select("value").eq("key", dbKey).maybeSingle();
  const val = (data?.value as string | null) || {
    openai: OPENAI_API_KEY_ENV, anthropic: ANTHROPIC_API_KEY_ENV,
    google: GOOGLE_API_KEY_ENV, voyage: VOYAGE_API_KEY_ENV,
  }[name] || "";
  _keyCache[name] = val.trim();
  _keyCacheAt[name] = now;
  return _keyCache[name];
}

// ---------------------------------------------------------------------------
// Daily budget guard — max $5/day across embed + chat
// ---------------------------------------------------------------------------
const DAILY_LIMIT_USD = 5.0;

// Token cost constants (USD per 1 token)
const COST = {
  embed_input:       0.02  / 1_000_000, // text-embedding-3-small
  gpt4o_input:       2.50  / 1_000_000,
  gpt4o_output:     10.00  / 1_000_000,
  gpt4o_mini_input:  0.15  / 1_000_000,
  gpt4o_mini_output: 0.60  / 1_000_000,
  claude_input:      3.00  / 1_000_000, // claude-sonnet conservative
  claude_output:    15.00  / 1_000_000,
};

function estimateEmbedCost(chars: number): number {
  const tokens = Math.ceil(chars / 4);
  return tokens * COST.embed_input;
}

function estimateChatCost(model: string, inputTokens: number, outputTokens: number): number {
  if (model.includes("gpt-4o-mini")) {
    return inputTokens * COST.gpt4o_mini_input + outputTokens * COST.gpt4o_mini_output;
  }
  if (model.includes("gpt")) {
    return inputTokens * COST.gpt4o_input + outputTokens * COST.gpt4o_output;
  }
  // Claude / default
  return inputTokens * COST.claude_input + outputTokens * COST.claude_output;
}

async function checkBudget(estimatedCost: number, origin: string | null): Promise<Response | null> {
  try {
    const admin = getAdminClient();
    // Must use .schema("knowledge") — functions live in knowledge schema, not public
    const { data } = await admin.schema("knowledge").rpc("check_daily_budget", { p_estimated_cost: estimatedCost });
    // Only block if data is non-null AND ok is explicitly false
    // (null data = RPC error → allow request rather than false-block)
    if (data !== null && data !== undefined && !data.ok) {
      return limitReachedResponse(origin);
    }
  } catch (e) {
    console.error("Budget check failed (allowing request):", e);
  }
  return null;
}

async function checkHardLimit(operation: "chat" | "upload", origin: string | null): Promise<Response | null> {
  try {
    const admin = getAdminClient();
    const { data } = await admin.schema("knowledge").rpc("check_hard_limits", { p_operation: operation });
    if (data !== null && data !== undefined && !data.ok) {
      return limitReachedResponse(origin);
    }
  } catch (e) {
    console.error("Hard limit check failed (allowing request):", e);
  }
  return null;
}

function limitReachedResponse(origin: string | null): Response {
  return new Response(JSON.stringify({
    error: "limit_reached",
    message: "Tageslimit erreicht. Morgen wieder verfügbar.",
  }), {
    status: 429,
    headers: { ...getCorsHeaders(origin), "Content-Type": "application/json" },
  });
}

async function logUsage(
  operation: "embed" | "chat",
  model: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  documentId?: string,
  userId?: string,
): Promise<void> {
  try {
    const admin = getAdminClient();
    await admin.schema("knowledge").from("usage_log").insert({
      operation, model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      document_id: documentId || null,
      user_id: userId || null,
    });
  } catch (e) {
    console.error("Failed to log usage:", e);
  }
}

// User-scoped client from JWT
function publicServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function getUserClient(authHeader: string) {
  return createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------
async function authenticateRequest(req: Request): Promise<{ userId: string } | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;
  const client = getUserClient(authHeader);
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return null;
  return { userId: user.id };
}

async function requireAuth(req: Request): Promise<{ userId: string } | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;
  const client = getUserClient(authHeader);
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) return null;
  return { userId: user.id };
}

// ---------------------------------------------------------------------------
// OpenAI embedding
// ---------------------------------------------------------------------------
async function embedText(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getApiKey('openai')}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000), // safety cap
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI embeddings error: ${err}`);
  }
  const json = await res.json();
  return json.data[0].embedding as number[];
}

// ---------------------------------------------------------------------------
// Markdown chunker
// ---------------------------------------------------------------------------
interface Chunk {
  content: string;
  heading: string | null;
  index: number;
}

const MAX_CHUNK_CHARS = 3000; // ~750 tokens
const MIN_CHUNK_CHARS = 100;

function chunkMarkdown(content: string): Chunk[] {
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  // Split on ## headings (level 2+)
  const headingRe = /^(#{1,6}\s+.+)$/m;
  const sections = content.split(/(^#{1,6}\s+.+$)/m);

  let currentHeading: string | null = null;
  let buffer = "";

  function flushBuffer(heading: string | null) {
    const text = buffer.trim();
    buffer = "";
    if (text.length < MIN_CHUNK_CHARS) return;

    if (text.length <= MAX_CHUNK_CHARS) {
      chunks.push({ content: text, heading, index: chunkIndex++ });
      return;
    }

    // Split oversized chunks on double newlines
    const paragraphs = text.split(/\n{2,}/);
    let sub = "";
    for (const para of paragraphs) {
      if ((sub + "\n\n" + para).length > MAX_CHUNK_CHARS && sub.length > 0) {
        if (sub.trim().length >= MIN_CHUNK_CHARS) {
          chunks.push({ content: sub.trim(), heading, index: chunkIndex++ });
        }
        sub = para;
      } else {
        sub = sub ? sub + "\n\n" + para : para;
      }
    }
    if (sub.trim().length >= MIN_CHUNK_CHARS) {
      chunks.push({ content: sub.trim(), heading, index: chunkIndex++ });
    }
  }

  for (const section of sections) {
    if (headingRe.test(section)) {
      // Flush what we have before setting new heading
      flushBuffer(currentHeading);
      currentHeading = section.trim();
      // Start new buffer with the heading itself
      buffer = section + "\n";
    } else {
      buffer += section;
    }
  }
  flushBuffer(currentHeading);

  return chunks;
}

// ---------------------------------------------------------------------------
// ACTION: upload
// ---------------------------------------------------------------------------
async function handleUpload(
  body: Record<string, unknown>,
  origin: string | null,
  req?: Request
): Promise<Response> {
  const {
    title,
    content,
    filename,
    folder_id,
    tags,
    uploader_name,
    uploader_kuerzel,
    uploaded_by,
  } = body as {
    title: string;
    content: string;
    filename?: string;
    folder_id?: string;
    tags?: string[];
    uploader_name?: string;
    uploader_kuerzel?: string;
    uploaded_by?: string;
  };

  if (!title || !content) {
    return errorResponse(origin, "title and content are required");
  }

  // Wenn kein Uploader-Name vom Frontend → aus JWT+Profil holen
  let resolvedUploaderName = uploader_name || '';
  let resolvedUploaderKuerzel = uploader_kuerzel || '';
  let resolvedUploadedBy = uploaded_by || null;
  if (req) {
    const uploadAuth = await requireAuth(req);
    if (uploadAuth?.userId) {
      resolvedUploadedBy = resolvedUploadedBy || uploadAuth.userId;
      if (!resolvedUploaderName) {
        const { data: prof } = await getAdminClient().schema("users").from("profiles")
          .select("full_name, kuerzel").eq("id", uploadAuth.userId).maybeSingle();
        resolvedUploaderName = prof?.full_name || '';
        resolvedUploaderKuerzel = prof?.kuerzel || resolvedUploaderKuerzel;
      }
    }
  }

  const supabase = getAdminClient();

  const { data: doc, error } = await supabase
    .schema("knowledge")
    .from("documents")
    .insert({
      title,
      content,
      filename: filename ?? null,
      folder_id: folder_id ?? null,
      tags: tags ?? [],
      uploader_name: resolvedUploaderName || null,
      uploader_kuerzel: resolvedUploaderKuerzel || null,
      uploaded_by: resolvedUploadedBy ?? null,
      file_size_bytes: new TextEncoder().encode(content).length,
      embedding_status: "pending",
    })
    .select()
    .single();

  if (error) {
    return errorResponse(origin, `DB insert error: ${error.message}`, 500);
  }

  // Fire-and-forget: trigger embed action asynchronously
  const selfUrl = `${SUPABASE_URL}/functions/v1/wissenshub`;
  fetch(selfUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ action: "embed", document_id: doc.id }),
  }).catch((e) => console.error("Async embed trigger failed:", e));

  return corsResponse(origin, { document: doc });
}

// ---------------------------------------------------------------------------
// ACTION: embed
// ---------------------------------------------------------------------------
async function handleEmbed(
  body: Record<string, unknown>,
  origin: string | null
): Promise<Response> {
  const { document_id } = body as { document_id: string };
  if (!document_id) {
    return errorResponse(origin, "document_id is required");
  }

  const supabase = getAdminClient();

  // Mark as processing
  await supabase
    .schema("knowledge")
    .from("documents")
    .update({ embedding_status: "processing", updated_at: new Date().toISOString() })
    .eq("id", document_id);

  // Load document
  const { data: doc, error: fetchErr } = await supabase
    .schema("knowledge")
    .from("documents")
    .select("id, content")
    .eq("id", document_id)
    .single();

  if (fetchErr || !doc) {
    return errorResponse(origin, `Document not found: ${fetchErr?.message}`, 404);
  }

  try {
    const chunks = chunkMarkdown(doc.content);
    
    // Budget check before calling OpenAI
    const estimatedCost = estimateEmbedCost(doc.content.length);
    const budgetErr = await checkBudget(estimatedCost, origin);
    if (budgetErr) {
      await supabase.schema("knowledge").from("documents")
        .update({ embedding_status: "error", embedding_error: "Tageslimit ($5/Tag) erreicht", updated_at: new Date().toISOString() })
        .eq("id", document_id);
      return budgetErr;
    }

    // Delete old chunks (re-embed scenario)
    await supabase
      .schema("knowledge")
      .from("chunks")
      .delete()
      .eq("document_id", document_id);

    let successCount = 0;
    let lastChunkError = "";
    for (const chunk of chunks) {
      try {
        const embedding = await embedText(chunk.content);
        const vectorStr = `[${embedding.join(",")}]`;

        await supabase.schema("knowledge").from("chunks").insert({
          document_id,
          chunk_index: chunk.index,
          content: chunk.content,
          heading: chunk.heading,
          token_count: Math.ceil(chunk.content.length / 4),
          embedding: vectorStr,
        });
        successCount++;
      } catch (chunkErr) {
        console.error(`Chunk ${chunk.index} embedding failed:`, chunkErr);
        lastChunkError = String(chunkErr);
      }
    }

    // Update document status
    await supabase
      .schema("knowledge")
      .from("documents")
      .update({
        embedding_status: successCount > 0 ? "done" : "error",
        chunk_count: successCount,
        embedding_error: successCount === 0 ? "All chunks failed to embed" : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", document_id);

    // Log embedding usage
    const totalChars = chunks.reduce((sum, ch) => sum + ch.content.length, 0);
    const inputTokens = Math.ceil(totalChars / 4);
    const cost = inputTokens * (0.02 / 1_000_000);
    await logUsage("embed", "text-embedding-3-small", inputTokens, 0, cost, document_id);

    return corsResponse(origin, {
      document_id,
      chunks_total: chunks.length,
      chunks_embedded: successCount,
      last_error: lastChunkError || undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .schema("knowledge")
      .from("documents")
      .update({
        embedding_status: "error",
        embedding_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", document_id);

    return errorResponse(origin, `Embedding failed: ${message}`, 500);
  }
}

// ---------------------------------------------------------------------------
// ACTION: chat
// ---------------------------------------------------------------------------
async function handleChat(
  body: Record<string, unknown>,
  req: Request,
  origin: string | null
): Promise<Response> {
  const {
    message,
    session_id,
    folder_id,
    tags,
    model = "gpt-4o-mini",
    history = [],
  } = body as {
    message: string;
    session_id?: string;
    folder_id?: string;
    tags?: string[];
    model?: string;
    history?: Array<{role: string; content: string}>;
  };

  if (!message) {
    return errorResponse(origin, "message is required");
  }

  // Auth
  const auth = await requireAuth(req);

  const supabase = getAdminClient();

  // Resolve or create session
  let activeSessionId = session_id;
  if (!activeSessionId) {
    const { data: session, error: sessErr } = await supabase
      .schema("knowledge")
      .from("chat_sessions")
      .insert({
        user_id: auth?.userId ?? null,
        title: message.slice(0, 60),
        model,
      })
      .select()
      .single();
    if (sessErr) {
      return errorResponse(origin, `Session create error: ${sessErr.message}`, 500);
    }
    activeSessionId = session.id;
  }

  // ── Spezialfall: Nutzer fragt gezielt nach Dokumenten in der KB ──────────────
  // Enge Regex: nur wenn explizit nach Dateien/Dokumenten in der KB gefragt wird
  const isDocListQuery = /welche\s+(datei|dokument)en?\s+(hast|siehst|kennst|gibt\s+es|sind|liegen)|zeig\s+(mir\s+)?(alle\s+)?(datei|dokument|inhalt)|liste\s+(alle\s+)?(datei|dokument)|(datei|dokument)en?\s+in\s+(der\s+)?(wissensdatenbank|kb|knowledge)|(wissensdatenbank|knowledge\s*base).*(inhalt|datei|dokument)/i.test(message);

  if (isDocListQuery) {
    // Return document list directly without RAG (saves costs + always correct)
    const { data: allDocsForList } = await supabase.schema("knowledge").from("documents")
      .select("title, chunk_count, tags").eq("embedding_status", "done").order("title");

    const listText = allDocsForList?.map((d: Record<string, unknown>) => {
      const tags = Array.isArray(d.tags) && d.tags.length > 0 ? ` _(${(d.tags as string[]).join(", ")})_` : "";
      return `• **${d.title}**${tags}`;
    }).join("\n") ?? "– Keine Dokumente vorhanden";

    const directResponse = `In meiner Wissensdatenbank habe ich aktuell **${allDocsForList?.length ?? 0} Dokumente**:\n\n${listText}\n\nZu welchem Thema kann ich dir helfen?`;

    await supabase.schema("knowledge").from("chat_messages").insert([
      { session_id: activeSessionId, role: "user", content: message, sources: [] },
      { session_id: activeSessionId, role: "assistant", content: directResponse, sources: [], prompt_tokens: 0, completion_tokens: 0 },
    ]);

    return corsResponse(origin, {
      response: directResponse,
      sources: [],
      session_id: activeSessionId,
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });
  }

  // Embed user message
  let queryEmbedding: number[];
  try {
    // Hard limit: max 300 chat messages per day
    const chatLimitErr = await checkHardLimit("chat", origin);
    if (chatLimitErr) return chatLimitErr;

    // Cost safety check
    const queryBudgetErr = await checkBudget(estimateEmbedCost(message.length), origin);
    if (queryBudgetErr) return queryBudgetErr;

    queryEmbedding = await embedText(message);
  } catch (err) {
    return errorResponse(origin, `Embedding error: ${err}`, 500);
  }

  // Retrieve relevant chunks via RPC (lower threshold = better recall)
  const vectorStr = `[${queryEmbedding.join(",")}]`;
  const rpcParams: Record<string, unknown> = {
    query_embedding: vectorStr,
    match_threshold: 0.35,
    match_count: 8,
  };
  if (folder_id) rpcParams.filter_folder_id = folder_id;
  if (tags && tags.length > 0) rpcParams.filter_tags = tags;

  const { data: matchedChunks, error: rpcErr } = await supabase.schema("knowledge").rpc(
    "match_chunks",
    rpcParams
  );
  let chunks = (!rpcErr && matchedChunks) ? matchedChunks : [];

  // Query Expansion: wenn keine Chunks → Anfrage umformulieren und nochmal suchen
  if (chunks.length === 0) {
    try {
      const rephraseRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${await getApiKey("openai")}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini", max_tokens: 80,
          messages: [
            { role: "system", content: "Reformuliere die Frage auf 2 verschiedene Arten für eine semantische Suche. Nur die 2 Varianten, eine pro Zeile." },
            { role: "user", content: message }
          ],
        }),
      });
      if (rephraseRes.ok) {
        const rephraseData = await rephraseRes.json();
        const variants = (rephraseData.choices?.[0]?.message?.content || "").split("\n").filter(Boolean).slice(0, 2);
        for (const variant of variants) {
          const varEmbed = await embedText(variant);
          const { data: varChunks } = await supabase.schema("knowledge").rpc("match_chunks", {
            query_embedding: `[${varEmbed.join(",")}]`,
            match_threshold: 0.30,
            match_count: 5,
          });
          if (varChunks && varChunks.length > 0) {
            chunks.push(...varChunks);
            break;
          }
        }
      }
    } catch { /* query expansion optional */ }
  }

  // Deduplicate chunks by document (max 2 chunks per doc to avoid flooding context)
  const chunksByDoc: Record<string, number> = {};
  const dedupedChunks = chunks.filter((chunk: Record<string, unknown>) => {
    const docId = chunk.document_id as string;
    chunksByDoc[docId] = (chunksByDoc[docId] || 0) + 1;
    return chunksByDoc[docId] <= 2;
  });

  // Fetch all document titles for context (so bot knows what's available)
  const { data: allDocs } = await supabase.schema("knowledge").from("documents")
    .select("title").eq("embedding_status", "done").order("title");
  const docList = allDocs?.map((d: Record<string, unknown>) => `• ${d.title}`).join("\n") ?? "";

  // Build sources + context text
  const sources: Array<{
    document_id: string;
    title: string;
    excerpt: string;
    similarity: number;
    heading: string | null;
  }> = [];

  let contextText = "";
  if (dedupedChunks.length > 0) {
    for (const chunk of dedupedChunks) {
      const sourceEntry = {
        document_id: chunk.document_id as string,
        title: chunk.document_title as string,
        excerpt: (chunk.chunk_content as string).slice(0, 300),
        similarity: chunk.similarity as number,
        heading: (chunk.heading as string) ?? null,
      };
      // Only add to sources if not already listed
      if (!sources.find(s => s.document_id === sourceEntry.document_id && s.heading === sourceEntry.heading)) {
        sources.push(sourceEntry);
      }
      contextText += `\n\n---\n**${chunk.document_title}**${
        chunk.heading ? ` › ${chunk.heading}` : ""
      }\n${chunk.chunk_content}`;
    }
  }

  const systemPrompt = `Du bist ROOTS-KI, der interne Wissensassistent von ROOTS Brand Strategy Consulting.

## DEINE ROLLE
Du unterstützt das ROOTS-Team bei professionellen und arbeitsbezogenen Fragen — sowohl aus der internen Wissensdatenbank als auch aus deinem allgemeinen Wissen über Business, Consulting, Kommunikation und Zusammenarbeit.

## WAS DU KANNST (und tust):
- Fragen aus der internen Wissensdatenbank beantworten (Onboarding, Prozesse, Laufwerke, Tools, Guidelines)
- Allgemeine Business-Fragen: Präsentationen, E-Mails, Meetings, Strategie, Kommunikation, Führung
- Beratungs-Methoden, Consulting Best Practices, Projektarbeit
- Produktivitäts- und Organisations-Tipps für den Arbeitsalltag
- HR-Themen, Onboarding, Teamkultur
- Erklärungen zu Marketing, Branding, Brand Strategy

## WAS DU NICHT TUT (freundlich ablehnen):
- Code schreiben, debuggen oder erklären (kein Programmierassistent)
- Schulaufgaben, Hausarbeiten, akademische Essays
- Kreatives Schreiben ohne Arbeitsbezug (Gedichte, Kurzgeschichten)
- Persönliche oder private Beratung (Beziehungen, Gesundheit, Recht, Finanzen)
- Themen komplett außerhalb von Arbeit, Business und Consulting

Bei abgelehnten Anfragen: Kurze freundliche Erklärung + Hinweis auf verfügbare Hilfe.

## ANTWORT-REGELN:
${contextText
  ? `Relevante Dokument-Auszüge aus der Wissensdatenbank:
${contextText}

→ Priorisiere diese Quellen. Nenne den Dokumenttitel als Quelle, z.B. (Quelle: E-Mail Ethikette).
→ Ergänze mit allgemeinem Wissen wenn sinnvoll, kennzeichne das aber klar.`
  : `Kein passendes Dokument in der KB gefunden. Beantworte die Frage aus deinem allgemeinen Business-Wissen — solange sie in den erlaubten Bereich fällt.`
}

Antworte immer auf Deutsch, strukturiert und präzise. Nutze Markdown für Listen und Überschriften.`;

  // ── Provider-Routing: Claude → Anthropic, GPT/o1 → OpenAI ─────────────────
  const isOpenAIModel = model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3");
  const isGeminiModel = model.startsWith("gemini");

  // Auto-fallback: wenn kein Anthropic-Key verfügbar und Claude-Modell, auf OpenAI wechseln
  let effectiveModel = model;
  let effectiveIsOpenAI = isOpenAIModel;
  if (!isOpenAIModel && !isGeminiModel) {
    const anthropicKey = await getApiKey("anthropic");
    if (!anthropicKey) {
      effectiveModel = "gpt-4o-mini";
      effectiveIsOpenAI = true;
    }
  }

  // ── Streaming Response via SSE ──────────────────────────────────────────────
  const finalModel = effectiveModel;
  const finalIsOpenAI = effectiveIsOpenAI;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const sendEvent = async (data: unknown) => {
    await writer.write(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // Async background task: stream LLM, then save to DB
  (async () => {
    let assistantContent = "";
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      if (finalIsOpenAI) {
        const oRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${await getApiKey("openai")}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: finalModel, max_tokens: 2048, stream: true,
            messages: [
              { role: "system", content: systemPrompt },
              ...history.slice(-10).map((h: {role: string; content: string}) => ({ role: h.role as "user"|"assistant", content: h.content })),
              { role: "user", content: message },
            ],
          }),
        });
        if (!oRes.ok) {
          const errText = await oRes.text();
          await sendEvent({ error: `OpenAI error: ${errText}` });
          await writer.close(); return;
        }
        const reader = oRes.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const d = line.slice(6).trim();
            if (d === "[DONE]") continue;
            try {
              const j = JSON.parse(d);
              const delta = j.choices?.[0]?.delta?.content || "";
              if (delta) { assistantContent += delta; await sendEvent({ delta }); }
              if (j.usage) { promptTokens = j.usage.prompt_tokens || 0; completionTokens = j.usage.completion_tokens || 0; }
            } catch { /* skip malformed */ }
          }
        }
      } else if (!isGeminiModel) {
        // Anthropic streaming
        const aRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": await getApiKey("anthropic"), "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          body: JSON.stringify({
            model: finalModel, max_tokens: 2048, stream: true,
            system: systemPrompt,
            messages: [
              ...history.slice(-10).map((h: {role: string; content: string}) => ({ role: h.role as "user"|"assistant", content: h.content })),
              { role: "user", content: message },
            ],
          }),
        });
        if (!aRes.ok) {
          const errText = await aRes.text();
          await sendEvent({ error: `Anthropic error: ${errText}` });
          await writer.close(); return;
        }
        const reader = aRes.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const d = line.slice(6).trim();
            try {
              const j = JSON.parse(d);
              if (j.type === "content_block_delta" && j.delta?.text) {
                assistantContent += j.delta.text;
                await sendEvent({ delta: j.delta.text });
              }
              if (j.type === "message_delta") {
                promptTokens = j.usage?.input_tokens || promptTokens;
                completionTokens = j.usage?.output_tokens || 0;
              }
            } catch { /* skip */ }
          }
        }
      } else {
        // Gemini non-streaming fallback (no streaming API used here)
        const geminiKey = await getApiKey("google");
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${finalModel}:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + message }] }],
            }),
          }
        );
        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          await sendEvent({ error: `Gemini error: ${errText}` });
          await writer.close(); return;
        }
        const geminiJson = await geminiRes.json();
        assistantContent = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text ?? "Keine Antwort erhalten.";
        promptTokens = geminiJson.usageMetadata?.promptTokenCount ?? 0;
        completionTokens = geminiJson.usageMetadata?.candidatesTokenCount ?? 0;
        await sendEvent({ delta: assistantContent });
      }

      // Generate follow-up suggestions (quick separate call, non-streaming)
      let suggestions: string[] = [];
      try {
        const sugRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${await getApiKey("openai")}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini", max_tokens: 120,
            messages: [
              { role: "system", content: "Schlage 3 kurze Folgefragen auf Deutsch vor, die der Nutzer als nächstes stellen könnte. Nur die Fragen, eine pro Zeile, kein Numbering, keine Erklärung." },
              { role: "user", content: `Frage: ${message}\nAntwort: ${assistantContent.slice(0, 400)}` },
            ],
          }),
        });
        if (sugRes.ok) {
          const sugData = await sugRes.json();
          suggestions = (sugData.choices?.[0]?.message?.content || "").split("\n").filter((s: string) => s.trim().length > 5).slice(0, 3);
        }
      } catch { /* suggestions optional */ }

      // Send done event with sources + suggestions
      await sendEvent({ done: true, sources, session_id: activeSessionId, suggestions });

      // Save messages to DB
      await supabase.schema("knowledge").from("chat_messages").insert([
        { session_id: activeSessionId, role: "user", content: message, sources: [] },
        { session_id: activeSessionId, role: "assistant", content: assistantContent, sources, prompt_tokens: promptTokens, completion_tokens: completionTokens },
      ]);
      await supabase.schema("knowledge").from("chat_sessions").update({ updated_at: new Date().toISOString() }).eq("id", activeSessionId);

      // Log usage
      const cost = estimateChatCost(finalModel, promptTokens, completionTokens);
      await logUsage("chat", finalModel, promptTokens, completionTokens, cost, undefined, auth?.userId);

    } catch (err) {
      await sendEvent({ error: String(err) }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      ...getCorsHeaders(origin),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// ACTION: folders
// ---------------------------------------------------------------------------
async function handleFolders(origin: string, _url?: URL): Promise<Response> {
  const admin = getAdminClient();
  const { data, error } = await admin.schema("knowledge").from("folders").select("*").order("name");
  if (error) return errorResponse(origin, "DB error: " + error.message, 500);
  return jsonResponse(origin, { folders: data || [] });
}

// ---------------------------------------------------------------------------
// ACTION: create_folder
// ---------------------------------------------------------------------------
async function handleCreateFolder(
  body: Record<string, unknown>,
  req: Request,
  origin: string | null
): Promise<Response> {
  const auth = await requireAuth(req);
  if (!auth) return errorResponse(origin, "Unauthorized", 401);

  const { name, parent_id, icon, color, description } = body as {
    name: string;
    parent_id?: string;
    icon?: string;
    color?: string;
    description?: string;
  };

  if (!name) return errorResponse(origin, "name is required");

  const supabase = getAdminClient();
  const { data, error } = await supabase
    .schema("knowledge")
    .from("folders")
    .insert({
      name,
      parent_id: parent_id ?? null,
      icon: icon ?? "fa-folder",
      color: color ?? "#206efb",
      description: description ?? null,
      created_by: auth.userId,
    })
    .select()
    .single();

  if (error) return errorResponse(origin, error.message, 500);
  return corsResponse(origin, { folder: data });
}

// ---------------------------------------------------------------------------
// ACTION: update_folder
// ---------------------------------------------------------------------------
async function handleUpdateFolder(
  body: Record<string, unknown>,
  req: Request,
  origin: string | null
): Promise<Response> {
  const auth = await requireAuth(req);
  if (!auth) return errorResponse(origin, "Unauthorized", 401);

  const { id, name, parent_id, icon, color, description } = body as {
    id: string;
    name?: string;
    parent_id?: string;
    icon?: string;
    color?: string;
    description?: string;
  };

  if (!id) return errorResponse(origin, "id is required");

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined) updates.name = name;
  if (parent_id !== undefined) updates.parent_id = parent_id;
  if (icon !== undefined) updates.icon = icon;
  if (color !== undefined) updates.color = color;
  if (description !== undefined) updates.description = description;

  const supabase = getAdminClient();
  const { data, error } = await supabase
    .schema("knowledge")
    .from("folders")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return errorResponse(origin, error.message, 500);
  return corsResponse(origin, { folder: data });
}

// ---------------------------------------------------------------------------
// ACTION: delete_folder
// ---------------------------------------------------------------------------
async function handleDeleteFolder(
  body: Record<string, unknown>,
  req: Request,
  origin: string | null
): Promise<Response> {
  const auth = await requireAuth(req);
  if (!auth) return errorResponse(origin, "Unauthorized", 401);

  const { id } = body as { id: string };
  if (!id) return errorResponse(origin, "id is required");

  const supabase = getAdminClient();

  // Move documents to no-folder first
  await supabase
    .schema("knowledge")
    .from("documents")
    .update({ folder_id: null, updated_at: new Date().toISOString() })
    .eq("folder_id", id);

  // Unlink child folders
  await supabase
    .schema("knowledge")
    .from("folders")
    .update({ parent_id: null, updated_at: new Date().toISOString() })
    .eq("parent_id", id);

  const { error } = await supabase
    .schema("knowledge")
    .from("folders")
    .delete()
    .eq("id", id);

  if (error) return errorResponse(origin, error.message, 500);
  return corsResponse(origin, { deleted: id });
}

// ---------------------------------------------------------------------------
// ACTION: documents
// ---------------------------------------------------------------------------
async function handleDocuments(params: Record<string, unknown>, origin: string): Promise<Response> {
  const admin = getAdminClient();
  let query = admin.schema("knowledge").from("documents")
    .select("id,title,filename,folder_id,tags,chunk_count,embedding_status,uploader_name,uploader_kuerzel,uploaded_by,file_size_bytes,created_at,updated_at");
  if (params.folder_id) query = query.eq("folder_id", String(params.folder_id));
  if (params.search) query = query.or(`title.ilike.%${params.search}%,content.ilike.%${params.search}%`);
  if (params.tags) {
    const tags = Array.isArray(params.tags) ? params.tags : String(params.tags).split(",");
    query = query.overlaps("tags", tags);
  }
  const sortMap: Record<string, string> = { oldest: "created_at", alpha: "title", newest: "created_at" };
  const sortCol = sortMap[String(params.sort || "newest")] || "created_at";
  const ascending = params.sort === "oldest" || params.sort === "alpha";
  query = query.order(sortCol, { ascending });
  const { data, error } = await query;
  if (error) return errorResponse(origin, "DB error: " + error.message, 500);
  return jsonResponse(origin, { documents: data || [] });
}

// ---------------------------------------------------------------------------
// ACTION: tags
// ---------------------------------------------------------------------------
async function handleTags(origin: string): Promise<Response> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("kh_get_tags");
  if (error) return errorResponse(origin, "DB error: " + error.message, 500);
  return jsonResponse(origin, { tags: data || [] });
}

// ---------------------------------------------------------------------------
// ACTION: delete_document
// ---------------------------------------------------------------------------
async function handleDeleteDocument(
  body: Record<string, unknown>,
  req: Request,
  origin: string | null
): Promise<Response> {
  const auth = await requireAuth(req);
  if (!auth) return errorResponse(origin, "Unauthorized", 401);

  const { id } = body as { id: string };
  if (!id) return errorResponse(origin, "id is required");

  const supabase = getAdminClient();

  // Chunks cascade-delete via FK
  const { error } = await supabase
    .schema("knowledge")
    .from("documents")
    .delete()
    .eq("id", id);

  if (error) return errorResponse(origin, error.message, 500);
  return corsResponse(origin, { deleted: id });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }

  // Support both GET ?action=xxx and POST { action: "xxx", ... }
  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  let action: string = url.searchParams.get("action") || "";

  if (req.method === "POST") {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try {
        body = await req.json();
        if (!action) action = (body.action as string) || "";
      } catch {
        return errorResponse(origin, "Invalid JSON body");
      }
    }
    // multipart/form-data handled per-action below
  } else if (req.method !== "GET") {
    return errorResponse(origin, "Method not allowed", 405);
  }

  if (!action) {
    return errorResponse(origin, "action is required");
  }

  try {
    switch (action) {
      case "upload":
        return await handleUpload(body, origin, req);

      case "embed":
        return await handleEmbed(body, origin);

      case "embed_all_pending": {
        // Re-embed all documents with status 'error' or 'pending' (admin action)
        const admin = getAdminClient();
        const { data: pendingDocs } = await admin.schema("knowledge").from("documents")
          .select("id, title")
          .in("embedding_status", ["error", "pending"])
          .limit(50);
        if (!pendingDocs || pendingDocs.length === 0) {
          return corsResponse(origin, { message: "Keine ausstehenden Dokumente.", count: 0 });
        }
        let triggered = 0;
        for (const doc of pendingDocs) {
          // Reset to pending first
          await admin.schema("knowledge").from("documents")
            .update({ embedding_status: "pending", embedding_error: null })
            .eq("id", doc.id);
          // Call embed inline (not fire-and-forget)
          await handleEmbed({ document_id: doc.id }, origin);
          triggered++;
        }
        return corsResponse(origin, { message: `${triggered} Dokument(e) neu eingebettet.`, count: triggered });
      }

      case "chat":
        return await handleChat(body, req, origin);

      case "folders":
        return await handleFolders(origin, url);

      case "create_folder":
        return await handleCreateFolder(body, req, origin);

      case "update_folder":
        return await handleUpdateFolder(body, req, origin);

      case "delete_folder":
        return await handleDeleteFolder(body, req, origin);

      case "documents":
        return await handleDocuments(body.folder_id ? body : Object.fromEntries(url.searchParams), origin);

      case "tags":
        return await handleTags(origin);

      case "check_duplicate": {
        const fn = url.searchParams.get("filename") || "";
        const admin = getAdminClient();
        const { data } = await admin.rpc("check_duplicate_filename", { p_filename: fn });
        return corsResponse(origin, data || { exists: false });
      }

      case "delete_document":
        return await handleDeleteDocument(body, req, origin);

      case "get_settings": {
        // Return which API keys are set (not their values)
        const admin = getAdminClient();
        const { data } = await admin.schema("knowledge").from("settings")
          .select("key").in("key", ["api_key_anthropic","api_key_openai","api_key_google","api_key_voyage"]);
        const keys = (data || []).map((r: { key: string }) => r.key);
        return new Response(JSON.stringify({ keys }), {
          status: 200, headers: { ...getCorsHeaders(origin), "Content-Type": "application/json" }
        });
      }

      case "save_keys": {
        const auth = await authenticateRequest(req);
        if (!auth) return errorResponse(origin, "Unauthorized", 401);
        // Only admins can save keys
        const pub = publicServiceClient();
        const { data: prof } = await pub.schema("users").from("profiles")
          .select("app_role").eq("id", auth.userId).maybeSingle();
        if (prof?.app_role !== "admin") return errorResponse(origin, "Forbidden", 403);
        const keys = body.keys as Record<string, string>;
        const admin = getAdminClient();
        const upserts = Object.entries(keys)
          .filter(([, v]) => v)
          .map(([k, v]) => ({ key: k, value: v, updated_by: auth.userId, updated_at: new Date().toISOString() }));
        if (upserts.length > 0) {
          await admin.schema("knowledge").from("settings").upsert(upserts, { onConflict: "key" });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { ...getCorsHeaders(origin), "Content-Type": "application/json" }
        });
      }

      case "get_sessions": {
        const sessAuth = await requireAuth(req);
        const admin = getAdminClient();
        const { data: sessions } = await admin.schema("knowledge").from("chat_sessions")
          .select("id, title, model, created_at, updated_at")
          .eq("user_id", sessAuth?.userId ?? "")
          .order("updated_at", { ascending: false })
          .limit(30);
        return corsResponse(origin, { sessions: sessions || [] });
      }

      case "get_session_messages": {
        const sessionId = body.session_id as string;
        if (!sessionId) return errorResponse(origin, "session_id required");
        const admin = getAdminClient();
        const { data: messages } = await admin.schema("knowledge").from("chat_messages")
          .select("id, role, content, sources, created_at")
          .eq("session_id", sessionId)
          .order("created_at", { ascending: true });
        return corsResponse(origin, { messages: messages || [] });
      }

      case "delete_session": {
        const delSessId = body.session_id as string;
        if (!delSessId) return errorResponse(origin, "session_id required");
        const admin = getAdminClient();
        await admin.schema("knowledge").from("chat_messages").delete().eq("session_id", delSessId);
        await admin.schema("knowledge").from("chat_sessions").delete().eq("id", delSessId);
        return corsResponse(origin, { ok: true });
      }

      case "get_document_content": {
        const docId = body.document_id as string || (url.searchParams.get("document_id") ?? "");
        if (!docId) return errorResponse(origin, "document_id required");
        const admin = getAdminClient();
        const { data: doc } = await admin.schema("knowledge").from("documents")
          .select("id, title, filename, content, tags, folder_id, chunk_count, uploader_name, created_at")
          .eq("id", docId).maybeSingle();
        if (!doc) return errorResponse(origin, "Document not found", 404);
        return corsResponse(origin, doc);
      }

      default:
        return errorResponse(origin, `Unknown action: ${action}`, 400);
    }
  } catch (err) {
    console.error("Unhandled error:", err);
    return errorResponse(
      origin,
      `Internal error: ${err instanceof Error ? err.message : String(err)}`,
      500
    );
  }
});
