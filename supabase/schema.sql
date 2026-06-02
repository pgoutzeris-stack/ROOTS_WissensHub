-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Schema
CREATE SCHEMA IF NOT EXISTS knowledge;

-- Folders (hierarchical)
CREATE TABLE knowledge.folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES knowledge.folders(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  icon text DEFAULT 'fa-folder',
  color text DEFAULT '#206efb',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Documents
CREATE TABLE knowledge.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid REFERENCES knowledge.folders(id) ON DELETE SET NULL,
  title text NOT NULL,
  filename text,
  content text NOT NULL,
  file_size_bytes int,
  tags text[] DEFAULT '{}',
  metadata jsonb DEFAULT '{}',
  chunk_count int DEFAULT 0,
  embedding_status text DEFAULT 'pending' CHECK (embedding_status IN ('pending','processing','done','error')),
  embedding_error text,
  uploaded_by uuid REFERENCES auth.users(id),
  uploader_name text,
  uploader_kuerzel text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Chunks with embeddings
CREATE TABLE knowledge.chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES knowledge.documents(id) ON DELETE CASCADE NOT NULL,
  chunk_index int NOT NULL,
  content text NOT NULL,
  heading text, -- nearest markdown heading above this chunk
  token_count int,
  embedding vector(1536), -- text-embedding-3-small
  created_at timestamptz DEFAULT now()
);

-- HNSW index for fast cosine similarity search
CREATE INDEX knowledge_chunks_embedding_hnsw
  ON knowledge.chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Full-text search index on document content
CREATE INDEX knowledge_docs_content_fts
  ON knowledge.documents USING gin(to_tsvector('german', content));
CREATE INDEX knowledge_docs_tags_idx ON knowledge.documents USING gin(tags);

-- Chat sessions
CREATE TABLE knowledge.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  user_name text,
  title text DEFAULT 'Neues Gespräch',
  model text DEFAULT 'claude-sonnet-4-5',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Chat messages
CREATE TABLE knowledge.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES knowledge.chat_sessions(id) ON DELETE CASCADE NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  sources jsonb DEFAULT '[]', -- [{document_id, title, excerpt, similarity}]
  prompt_tokens int,
  completion_tokens int,
  created_at timestamptz DEFAULT now()
);

-- RLS: all authenticated users can read, write own content, admins can delete all
ALTER TABLE knowledge.folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.chat_messages ENABLE ROW LEVEL SECURITY;

-- Permissive policies (adjust per security needs)
CREATE POLICY "authenticated read folders" ON knowledge.folders FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "authenticated write folders" ON knowledge.folders FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "authenticated read documents" ON knowledge.documents FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "authenticated write documents" ON knowledge.documents FOR ALL USING (auth.uid() IS NOT NULL);
CREATE POLICY "authenticated read chunks" ON knowledge.chunks FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "service write chunks" ON knowledge.chunks FOR ALL USING (true);
CREATE POLICY "own sessions" ON knowledge.chat_sessions FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own messages" ON knowledge.chat_messages FOR ALL USING (
  EXISTS (SELECT 1 FROM knowledge.chat_sessions s WHERE s.id = session_id AND s.user_id = auth.uid())
);

-- Helper function: match chunks by similarity
CREATE OR REPLACE FUNCTION knowledge.match_chunks(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 5,
  filter_folder_id uuid DEFAULT NULL,
  filter_tags text[] DEFAULT NULL
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  document_title text,
  folder_id uuid,
  chunk_content text,
  heading text,
  similarity float,
  tags text[]
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    d.id,
    d.title,
    d.folder_id,
    c.content,
    c.heading,
    1 - (c.embedding <=> query_embedding) AS similarity,
    d.tags
  FROM knowledge.chunks c
  JOIN knowledge.documents d ON d.id = c.document_id
  WHERE
    c.embedding IS NOT NULL
    AND (1 - (c.embedding <=> query_embedding)) >= match_threshold
    AND (filter_folder_id IS NULL OR d.folder_id = filter_folder_id)
    AND (filter_tags IS NULL OR d.tags && filter_tags)
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
