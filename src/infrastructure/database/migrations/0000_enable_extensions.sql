-- Custom migration (written by hand, see docs/db-design.md §2).
-- pgvector: vector columns + HNSW indexes for embeddings (used from Phase 5).
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
-- citext: case-insensitive text, used for users.email.
CREATE EXTENSION IF NOT EXISTS citext;
