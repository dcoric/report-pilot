# BUG-QUERY-001: SQL Editor Run UX Gaps

## Reported Problems
- `invalid_sql` responses from `/v1/query/sessions/{id}/run` returned a `sql` field, but SQL was not shown in the SQL section.
- Editing SQL in the SQL editor and clicking `Run` did not execute edited SQL because the frontend did not send `sql_override`.

## Expected Behavior
- If backend returns `sql` in an error payload, SQL section should display it so users can inspect and fix it.
- `Run` should execute the SQL currently in the editor.

## Root Cause
- `QueryWorkspace.generateSql` consumed only `data` from `client.POST(.../run)` and ignored `error`.
- `QueryWorkspace.handleRun` sent an empty request body (`{}`) instead of `sql_override`.

## Fix Implemented
- Parse run error payload and surface returned `sql` in the editor.
- Send `sql_override` from editor content on `Run`.
- Keep SQL section expanded on run errors with SQL payload.
- Disable `Run` if there is no active session.

## Status
- Fixed in working tree (`frontend/src/pages/QueryWorkspace.tsx`).
