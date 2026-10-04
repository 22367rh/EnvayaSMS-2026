# Step 10 — Persistence & Database Migration

**Objective.** Review and, if needed, migrate the SQLite layer (`DatabaseHelper`, DB version 4)
so it is compatible with a modern `compileSdk`/SQLite and has a safe upgrade path that preserves
pending messages across app updates. The domain (backup of in-memory Inbox/Outbox) stays identical.

---

## Current state

- `DatabaseHelper` manages `envayasms.db`, **version 4**, two tables:
  - `pending_incoming_messages` (_id, message_type, messaging_id, from_number, to_number, message, direction, timestamp)
  - `pending_outgoing_messages` (_id, message_type, from_number, to_number, message, priority, server_id)
- `onCreate()` documents intent: restore pending messages after reboot/crash.
- `restorePendingMessages()` rehydrates Inbox/Outbox on boot/enable by reconstructing subclasses per `message_type`.

---

## Target state

- Database version bumped to **5** with an `onUpgrade()` that migrates v4 → v5 (or a no-op if the schema is unchanged).
- If the schema is unchanged, keep both tables and bump only the version with a safe upgrade path; otherwise add a migration.
- Pending-message restore logic preserved so no in-flight message is lost across an update.

---

## Incremental actions

1. Confirm whether any column changes are required for API 33 compatibility (the current schema uses only common types and should remain valid). **If unchanged**, bump `DATABASE_VERSION` 4 → 5 and add:
   ```java
   protected void onUpgrade(SQLiteDatabase db, int oldV, int newV) {
       // no schema change; version bump preserves existing data
   }
   ```
2. If a column is added/changed, implement `onUpgrade()` to `ALTER TABLE` both tables and run `restorePendingMessages()` afterward so the in-memory queues repopulate from the migrated rows.
3. Keep the message-type reconstruction order (`IncomingSms`/`IncomingMms`/`IncomingCall`, `OutgoingSms`) identical — this is data-dependent logic, not schema.
4. Add a unit test that opens an existing v4 DB file (fixture) and verifies `onUpgrade` leaves both tables intact with all rows present.

---

## Acceptance criteria

- [ ] Existing users upgrading from the old app retain pending incoming/outgoing messages.
- [ ] Fresh install creates the DB at version 5; no crash on first run of API 33.
- [ ] A v4 fixture upgrades cleanly with all rows preserved.

---

## Dependencies / risks

- Low risk if schema is unchanged — this can be done near the end as a data-integrity pass.
- Do not drop/rename tables without a migration; `restorePendingMessages()` depends on exact column names.
