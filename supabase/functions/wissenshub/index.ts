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
  _keyCache[name] = val;
  _keyCacheAt[name] = now;
  return val;
}

// User-scoped client from JWT
function getUserClient(authHeader: string) {
  return createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------
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
  origin: string | null
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
      uploader_name: uploader_name ?? null,
      uploader_kuerzel: uploader_kuerzel ?? null,
      uploaded_by: uploaded_by ?? null,
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

    // Delete old chunks (re-embed scenario)
    await supabase
      .schema("knowledge")
      .from("chunks")
      .delete()
      .eq("document_id", document_id);

    let successCount = 0;
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

    return corsResponse(origin, {
      document_id,
      chunks_total: chunks.length,
      chunks_embedded: successCount,
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
    model = "claude-sonnet-4-5",
  } = body as {
    message: string;
    session_id?: string;
    folder_id?: string;
    tags?: string[];
    model?: string;
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

  // Embed user message
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(message);
  } catch (err) {
    return errorResponse(origin, `Embedding error: ${err}`, 500);
  }

  // Retrieve relevant chunks via RPC
  const vectorStr = `[${queryEmbedding.join(",")}]`;
  const rpcParams: Record<string, unknown> = {
    query_embedding: vectorStr,
    match_threshold: 0.5,
    match_count: 5,
  };
  if (folder_id) rpcParams.filter_folder_id = folder_id;
  if (tags && tags.length > 0) rpcParams.filter_tags = tags;

  const { data: matchedChunks, error: rpcErr } = await supabase.rpc(
    "knowledge.match_chunks",
    rpcParams
  );

  // Fallback: try without schema prefix if the above fails
  let chunks = matchedChunks;
  if (rpcErr || !chunks) {
    const { data: fallbackChunks } = await supabase.rpc("match_chunks", rpcParams);
    chunks = fallbackChunks ?? [];
  }

  // Build context for Claude
  const sources: Array<{
    document_id: string;
    title: string;
    excerpt: string;
    similarity: number;
    heading: string | null;
  }> = [];

  let contextText = "";
  if (chunks && chunks.length > 0) {
    for (const chunk of chunks) {
      const sourceEntry = {
        document_id: chunk.document_id,
        title: chunk.document_title,
        excerpt: (chunk.chunk_content as string).slice(0, 200),
        similarity: chunk.similarity,
        heading: chunk.heading ?? null,
      };
      sources.push(sourceEntry);
      contextText += `\n\n---\n**Quelle: ${chunk.document_title}**${
        chunk.heading ? ` > ${chunk.heading}` : ""
      }\n${chunk.chunk_content}`;
    }
  }

  const systemPrompt = `Du bist ein intelligenter Wissensassistent für ROOTS Brand Strategy Consulting.
Du hilfst dem Team dabei, schnell relevante Informationen aus der internen Wissensdatenbank zu finden.

${
  contextText
    ? `Nutze die folgenden Auszüge aus der Wissensdatenbank, um die Frage zu beantworten:
${contextText}

Wenn du auf diese Quellen referenzierst, nenne den Dokumententitel.`
    : "Für diese Frage wurden keine direkten Treffer in der Wissensdatenbank gefunden. Antworte basierend auf deinem allgemeinen Wissen und weise darauf hin, dass du keine spezifischen internen Quellen gefunden hast."
}

Antworte immer auf Deutsch, präzise und hilfreich. Wenn du unsicher bist, sage es klar.`;

  // Call Anthropic Claude
  let assistantContent = "";
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": await getApiKey("anthropic"),
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return errorResponse(origin, `Anthropic API error: ${errText}`, 502);
    }

    const anthropicJson = await anthropicRes.json();
    assistantContent =
      anthropicJson.content?.[0]?.text ?? "Keine Antwort erhalten.";
    promptTokens = anthropicJson.usage?.input_tokens ?? 0;
    completionTokens = anthropicJson.usage?.output_tokens ?? 0;
  } catch (err) {
    return errorResponse(origin, `Anthropic call failed: ${err}`, 500);
  }

  // Persist messages
  await supabase.schema("knowledge").from("chat_messages").insert([
    {
      session_id: activeSessionId,
      role: "user",
      content: message,
      sources: [],
    },
    {
      session_id: activeSessionId,
      role: "assistant",
      content: assistantContent,
      sources: sources,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    },
  ]);

  // Update session updated_at
  await supabase
    .schema("knowledge")
    .from("chat_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", activeSessionId);

  return corsResponse(origin, {
    response: assistantContent,
    sources,
    session_id: activeSessionId,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  });
}

// ---------------------------------------------------------------------------
// ACTION: folders
// ---------------------------------------------------------------------------
async function handleFolders(origin: string | null): Promise<Response> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .schema("knowledge")
    .from("folders")
    .select("*")
    .order("name");

  if (error) {
    return errorResponse(origin, error.message, 500);
  }
  return corsResponse(origin, { folders: data });
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
async function handleDocuments(
  body: Record<string, unknown>,
  origin: string | null
): Promise<Response> {
  const { folder_id, tags, search } = body as {
    folder_id?: string;
    tags?: string[];
    search?: string;
  };

  const supabase = getAdminClient();
  let query = supabase
    .schema("knowledge")
    .from("documents")
    .select(
      "id, title, filename, folder_id, tags, metadata, chunk_count, embedding_status, uploader_name, uploader_kuerzel, created_at, updated_at, file_size_bytes"
    )
    .order("created_at", { ascending: false });

  if (folder_id) query = query.eq("folder_id", folder_id);
  if (tags && tags.length > 0) query = query.overlaps("tags", tags);
  if (search) query = query.ilike("title", `%${search}%`);

  const { data, error } = await query;
  if (error) return errorResponse(origin, error.message, 500);
  return corsResponse(origin, { documents: data });
}

// ---------------------------------------------------------------------------
// ACTION: tags
// ---------------------------------------------------------------------------
async function handleTags(origin: string | null): Promise<Response> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .schema("knowledge")
    .from("documents")
    .select("tags");

  if (error) return errorResponse(origin, error.message, 500);

  const tagCounts: Record<string, number> = {};
  for (const row of data ?? []) {
    for (const tag of (row.tags as string[]) ?? []) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
  }

  const tags = Object.entries(tagCounts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  return corsResponse(origin, { tags });
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

  if (req.method !== "POST") {
    return errorResponse(origin, "Method not allowed", 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse(origin, "Invalid JSON body");
  }

  const action = body.action as string;
  if (!action) {
    return errorResponse(origin, "action is required");
  }

  try {
    switch (action) {
      case "upload":
        return await handleUpload(body, origin);

      case "embed":
        return await handleEmbed(body, origin);

      case "chat":
        return await handleChat(body, req, origin);

      case "folders":
        return await handleFolders(origin);

      case "create_folder":
        return await handleCreateFolder(body, req, origin);

      case "update_folder":
        return await handleUpdateFolder(body, req, origin);

      case "delete_folder":
        return await handleDeleteFolder(body, req, origin);

      case "documents":
        return await handleDocuments(body, origin);

      case "tags":
        return await handleTags(origin);

      case "delete_document":
        return await handleDeleteDocument(body, req, origin);

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
