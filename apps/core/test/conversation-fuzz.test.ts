import { defineConversationFuzz } from './fixtures/conversation-fuzz.js';

/**
 * Conversation fuzz (QA, 2026-10-03), shard 1 of 4. The harness, the conversation families, the invariants J1–J7 and
 * the pinned ratchet (`CONVERSATION_FUZZ_BASELINE`) are in fixtures/conversation-fuzz.ts; the report is
 * output/research/2026-10-03-conversation-fuzz/REPORT.md. Shards 2–4 are conversation-fuzz-2/3/4.test.ts.
 */
// The shard reads TEST_DATABASE_URL and TEST_DATABASE_OWNER_URL (fixtures/conversation-fuzz.ts): naming them here gives
// this file its own database clone (packages/db/test-support/test-database-clone.ts).
defineConversationFuzz(1, 4);
