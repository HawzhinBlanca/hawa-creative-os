# ADR-008: Use PostgreSQL for Client DNA and hybrid retrieval

**Status:** Accepted  
**Date:** 2026-09-03

## Context

Most memory is authoritative relational data—rules, versions, approvals, exact assets—not only semantic vectors. A separate vector database adds synchronization and security boundaries.

## Decision

Store Client DNA, documents, chunks, vectors, feedback, and task state in PostgreSQL 18 with pgvector. Use exact/trigram/full-text plus multimodal embedding/reranking. Filter tenant/client before similarity search.

## Consequences

One ACID/security boundary and simpler backups. Very large vector scale may eventually require another store, but office scale does not justify it now.

## Alternatives considered

Pinecone/Qdrant plus Postgres: extra system. Provider file-search: weak ownership/permissions. Knowledge graph first: unnecessary until concrete relation queries demand it.

## Revisit trigger

Revisit only when executable evidence shows that the decision no longer meets reliability, editability, security, or office-operation goals.
