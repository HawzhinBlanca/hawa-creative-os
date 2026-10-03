import { defineConversationFuzz } from './fixtures/conversation-fuzz.js';

/** Conversation fuzz, shard 2 of 4 (see conversation-fuzz.test.ts and fixtures/conversation-fuzz.ts). */
// The shard reads TEST_DATABASE_URL and TEST_DATABASE_OWNER_URL (fixtures/conversation-fuzz.ts): naming them here gives
// this file its own database clone (packages/db/test-support/test-database-clone.ts).
defineConversationFuzz(2, 4);
