# RAG-001 Clean Context Plan

## Goal

Implement end-to-end support for manual general RAG notes (plain text) per data source, with automatic async reindex after note create/update/delete.

Also standardize planning workflow:
- Track tickets in GitHub Issues.
- Keep `IMPLEMENTATION_PLAN.md` as the in-repo checklist.
- Remove `PLAN/TICKETS.md`.

## Locked Decisions

- Ticket code: `RAG-001`
- Scope: Full E2E (DB + API + UI)
- Note format: Plain text only (`title`, `content`)
- UI placement: Data Sources page modal
- Reindex behavior: Auto async reindex on note changes
- RAG doc mapping: Index notes as `docType: "policy"` (no `rag_documents.doc_type` constraint change)

## Current System Context

- Existing RAG docs are built in `app/src/services/ragService.js`.
- Existing reindex trigger endpoint exists: `POST /v1/rag/reindex`.
- Existing admin UI page for data source actions exists: `frontend/src/pages/DataSources.tsx`.
- Existing OpenAPI spec lives at `docs/api/openapi.yaml`.
- Frontend API types are generated file: `frontend/src/lib/api/types.ts`.

## Implementation Tasks

## 1) Ticketing and Planning

1. Create GitHub issue:
   - Title: `[RAG-001] General RAG Notes (Plain Text) with Auto Reindex`
   - Labels: `enhancement`, `Frontend`, `Backend`
2. Delete `PLAN/TICKETS.md`.
3. Add `Phase 6 - RAG Authoring` checklist in `IMPLEMENTATION_PLAN.md`.

## 2) Database Migration

Add new migration file:
- `db/migrations/0007_rag_notes.sql`

Create table `rag_notes`:
- `id UUID PRIMARY KEY DEFAULT uuid_generate_v4()`
- `data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE`
- `title TEXT NOT NULL`
- `content TEXT NOT NULL`
- `active BOOLEAN NOT NULL DEFAULT TRUE`
- `created_by TEXT`
- `updated_by TEXT`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Indexes:
- `idx_rag_notes_data_source` on `data_source_id`
- `idx_rag_notes_data_source_active` on `(data_source_id, active)`

## 3) Backend API

Update `app/src/server.js` with new handlers and routes:

1. `GET /v1/rag/notes?data_source_id=...`
   - Validate `data_source_id` presence and UUID format.
   - Return notes list for source.
2. `POST /v1/rag/notes`
   - Upsert semantics:
     - create when `id` is absent
     - update when `id` is present
   - Validate:
     - required: `data_source_id`, `title`, `content`
     - trim values
     - reject empty trimmed title/content
     - max title length 200
     - max content length 20000
   - Trigger async reindex for `data_source_id`.
3. `DELETE /v1/rag/notes/{noteId}`
   - Hard delete.
   - If not found => `404`.
   - Trigger async reindex for deleted note’s `data_source_id`.

Response shape recommendation:
- `GET`: `{ items: [...] }`
- `POST`: `{ id, data_source_id, title, content, active, created_at, updated_at }`
- `DELETE`: `{ ok: true, id }`

## 4) RAG Build Integration

Update `app/src/services/ragService.js`:

1. Include `rag_notes` in `buildRagDocuments(dataSourceId)` query set.
2. For each active note, append RAG doc:
   - `docType: "policy"`
   - `refId: note.id`
   - `metadata: { source: "rag_note", title: note.title }`
   - `content`:
     - line 1: `note <title>`
     - line 2+: note body

No change to `rag_documents` `doc_type` enum needed.

## 5) OpenAPI and Frontend Types

Update `docs/api/openapi.yaml`:
- Add paths:
  - `GET /v1/rag/notes`
  - `POST /v1/rag/notes`
  - `DELETE /v1/rag/notes/{noteId}`
- Add schemas:
  - `RagNoteRequest`
  - `RagNoteResponse`
  - `RagNoteListResponse`

Regenerate or update `frontend/src/lib/api/types.ts` accordingly.

## 6) Frontend UI

Create component:
- `frontend/src/components/DataSources/RagNotesDialog.tsx`

Capabilities:
- List notes for selected data source.
- Add note.
- Edit note.
- Delete note with confirmation.
- Show loading/empty/error states.
- Show toast messages.
- Show hint that indexing runs automatically after changes.

Integrate into:
- `frontend/src/pages/DataSources.tsx`
  - Add new row action button: `RAG Notes`.
  - Open dialog scoped to that row’s `data_source_id`.

## 7) Testing

Backend:
- Migration test (table + indexes exist).
- API tests for:
  - create/update/list/delete happy paths
  - validation failures (`400`)
  - not found (`404`)
- `ragService` test verifies notes become `policy` documents.
- Verify note mutation triggers reindex call path.

Frontend:
- Dialog open/close behavior.
- List/create/edit/delete request flows.
- Toast/error handling.

Manual QA:
1. Create note, run query, verify note appears in `citations.rag_documents`.
2. Update note, rerun query, verify updated context.
3. Delete note, rerun query, note absent from citations.
4. Reindex failure path: note CRUD still succeeds, failure logged.

## Execution Order

1. GitHub issue + planning docs update.
2. DB migration.
3. Backend note CRUD + route wiring.
4. RAG build integration.
5. OpenAPI + frontend types.
6. UI modal + Data Sources integration.
7. Tests.
8. Manual QA.

## Definition of Done

- `RAG-001` issue created and linked in commit/PR.
- `PLAN/TICKETS.md` removed.
- `IMPLEMENTATION_PLAN.md` updated with `Phase 6 - RAG Authoring`.
- Note CRUD works via API and UI.
- Notes are embedded into RAG context after auto reindex.
- OpenAPI and frontend types include new RAG note contracts.
- All relevant tests pass.

