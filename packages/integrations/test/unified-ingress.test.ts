import { describe, it, expect, beforeEach } from 'vitest';
import {
  UnifiedIngressService,
  MemoryIngressPersistenceAdapter,
  validateFetchDestination,
  sanitizeIngressContent,
  validateIngressAttachment,
  evaluateIngressIntent,
  MAX_ATTACHMENT_SIZE_BYTES,
  KAAE_CLIENT_ID,
} from '../src/unified-ingress.js';
import { createHash } from 'node:crypto';

describe('CV-06: Unified Desk, Telegram, and WhatsApp Ingress Engine', () => {
  let persistence: MemoryIngressPersistenceAdapter;
  let service: UnifiedIngressService;
  const tenantId = '00000000-0000-4000-a000-000000000001';

  beforeEach(() => {
    persistence = new MemoryIngressPersistenceAdapter();
    service = new UnifiedIngressService(persistence);
  });

  describe('1. Multi-Channel Normalization into MessageEnvelope', () => {
    it('normalizes Desk task submission into verified MessageEnvelope', async () => {
      const result = await service.ingest({
        tenantId,
        channel: 'hawa_desk',
        sourceAccountId: 'desk_operator',
        sourceEventId: 'desk_evt_101',
        sourceChannelId: 'hawa_desk_main',
        sourceMessageId: 'desk_msg_101',
        senderExternalId: 'operator_hawzhin',
        senderDisplayName: 'Hawzhin Operator',
        text: 'KAAE National Quality Standards Announcement 2026',
        rawPayload: { title: 'KAAE Standards', channel: 'hawa_desk' },
        verified: true,
        verificationMethod: 'session_token',
        isTaskSubmission: true,
        explicitClientId: KAAE_CLIENT_ID,
      });

      expect(result.acknowledged).toBe(true);
      expect(result.actionTaken).toBe('task_created');
      expect(result.taskId).toBeDefined();
      expect(result.normalizedEnvelope.schemaVersion).toBe(1);
      expect(result.normalizedEnvelope.adapter.kind).toBe('hawa_desk');
      expect(result.normalizedEnvelope.direction).toBe('ltr');
      expect(result.normalizedEnvelope.language).toBe('en');
      expect(result.normalizedEnvelope.verification.verified).toBe(true);
    });

    it('normalizes Telegram update with Kurdish Sorani orthography and RTL direction', async () => {
      const rawKurdish = 'ئۆفەری تايبەتي بۆ دەرمانخانەی دروستی'; // Includes legacy Arabic Yeh (\u064A)
      const result = await service.ingest({
        tenantId,
        channel: 'telegram',
        sourceAccountId: 'office_main_bot',
        sourceEventId: 'tg_upd_501',
        sourceChannelId: 'tg_chat_888',
        sourceMessageId: 'tg_msg_777',
        senderExternalId: 'tg_user_999',
        senderDisplayName: 'Drustee Partner',
        text: `/task ${rawKurdish}`,
        rawPayload: { update_id: 501, message: { text: rawKurdish } },
        verified: true,
        verificationMethod: 'x-telegram-bot-api-secret-token',
      });

      expect(result.acknowledged).toBe(true);
      expect(result.actionTaken).toBe('task_created');
      expect(result.normalizedEnvelope.direction).toBe('rtl');
      expect(result.normalizedEnvelope.language).toBe('ckb');
      expect(result.normalizedEnvelope.text).not.toContain('\u064A');
      expect(result.normalizedEnvelope.text).toContain('ی');
    });

    it('normalizes WAHA payload with media attachment and computes payload hash', async () => {
      const sampleBuf = Buffer.from('Mock image binary content for WAHA');
      const sha256 = createHash('sha256').update(sampleBuf).digest('hex');

      const result = await service.ingest({
        tenantId,
        channel: 'waha',
        sourceAccountId: 'waha_office_session',
        sourceEventId: 'waha_evt_301',
        sourceChannelId: '9647501234567@c.us',
        sourceMessageId: 'waha_msg_999',
        senderExternalId: '9647501234567@c.us',
        senderDisplayName: 'Drustee Pharmacy',
        text: '/brief New Vitamin D3+K2 Social Campaign',
        rawPayload: { id: 'waha_msg_999', body: 'New Vitamin D3+K2' },
        verified: true,
        verificationMethod: 'waha_hmac_sha256',
        attachments: [
          {
            filename: 'vitamin_bottle.png',
            mimeType: 'image/png',
            byteSize: sampleBuf.length,
            content: sampleBuf,
            sha256,
          },
        ],
      });

      expect(result.acknowledged).toBe(true);
      expect(result.actionTaken).toBe('task_created');
      expect(result.normalizedEnvelope.attachments.length).toBe(1);
      expect(result.normalizedEnvelope.attachments[0].sha256).toBe(sha256);
      expect(result.normalizedEnvelope.attachments[0].scanState).toBe('clean');
    });
  });

  describe('2. Conversational Gate: MESSAGE_ONLY vs Explicit Promotion', () => {
    it('keeps ordinary group conversation as MESSAGE_ONLY and creates ZERO tasks', async () => {
      const chitChats = [
        'سڵاو کاک هاوژین، چۆنی باشیت؟',
        'Good morning team! See you at 10am.',
        'دەستت خۆش بێت کاکە گیان زۆر سوپاس.',
        'Ok noted, thanks.',
        'Are we having the meeting today?',
      ];

      for (let i = 0; i < chitChats.length; i++) {
        const text = chitChats[i];
        const res = await service.ingest({
          tenantId,
          channel: 'telegram',
          sourceAccountId: 'office_main_bot',
          sourceEventId: `chat_evt_${i}`,
          sourceChannelId: 'office_group_chat',
          sourceMessageId: `chat_msg_${i}`,
          senderExternalId: `user_${i}`,
          text,
          rawPayload: { update_id: i, message: { text } },
          verified: true,
        });

        expect(res.acknowledged).toBe(true);
        expect(res.actionTaken).toBe('message_only');
        expect(res.taskId).toBeUndefined();
      }

      expect(persistence.tasks.size).toBe(0);
      expect(persistence.inboxEvents.size).toBe(chitChats.length);
      expect(persistence.messageEvents.size).toBe(chitChats.length);
    });

    it('promotes to task on explicit slash command /task or /brief', async () => {
      const res = await service.ingest({
        tenantId,
        channel: 'telegram',
        sourceAccountId: 'office_main_bot',
        sourceEventId: 'promote_evt_1',
        sourceChannelId: 'office_group_chat',
        sourceMessageId: 'promote_msg_1',
        senderExternalId: 'director_user',
        text: '/task KAAE 2026 Institutional Accreditation Announcement',
        rawPayload: { update_id: 101, message: { text: '/task KAAE...' } },
        verified: true,
      });

      expect(res.acknowledged).toBe(true);
      expect(res.actionTaken).toBe('task_created');
      expect(res.taskId).toBeDefined();
      expect(persistence.tasks.size).toBe(1);
    });

    it('promotes to task on explicit Kurdish prefix داواکاری: or دیزاین:', async () => {
      const res = await service.ingest({
        tenantId,
        channel: 'waha',
        sourceAccountId: 'waha_office_session',
        sourceEventId: 'promote_kurdish_evt',
        sourceChannelId: '9647501234567@c.us',
        sourceMessageId: 'promote_kurdish_msg',
        senderExternalId: '9647501234567@c.us',
        text: 'داواکاری: دیزاینی پۆستەری ڕاگەیاندنی فەرمیی خولی نوێ',
        rawPayload: { id: 'kurdish_msg_1' },
        verified: true,
      });

      expect(res.acknowledged).toBe(true);
      expect(res.actionTaken).toBe('task_created');
      expect(res.taskId).toBeDefined();
      expect(persistence.tasks.size).toBe(1);
    });

    it('returns clarification_needed for ambiguous requests lacking key details', async () => {
      const res = await service.ingest({
        tenantId,
        channel: 'telegram',
        sourceAccountId: 'office_main_bot',
        sourceEventId: 'ambig_evt_1',
        sourceChannelId: 'tg_chat_333',
        sourceMessageId: 'ambig_msg_1',
        senderExternalId: 'ambig_user',
        text: 'Can we make a poster please?', // Ambiguous: no client, no dimensions, no copy
        rawPayload: { text: 'Can we make a poster please?' },
        verified: true,
      });

      expect(res.acknowledged).toBe(true);
      expect(res.actionTaken).toBe('clarification_needed');
      expect(res.clarificationPrompt).toBeDefined();
      expect(res.taskId).toBeUndefined();
      expect(persistence.tasks.size).toBe(0);
    });
  });

  describe('3. Idempotency & Duplicate Replay Protection', () => {
    it('creates exactly ONE logical task when duplicate event is replayed', async () => {
      const payload = {
        tenantId,
        channel: 'telegram' as const,
        sourceAccountId: 'office_main_bot',
        sourceEventId: 'dup_evt_100',
        sourceChannelId: 'tg_group_55',
        sourceMessageId: 'dup_msg_100',
        senderExternalId: 'user_456',
        text: '/task KAAE Annual Conference Poster',
        rawPayload: { update_id: 100, text: '/task KAAE Annual Conference Poster' },
        verified: true,
      };

      // 1st transmission
      const res1 = await service.ingest(payload);
      expect(res1.acknowledged).toBe(true);
      expect(res1.isDuplicate).toBe(false);
      expect(res1.actionTaken).toBe('task_created');
      const originalTaskId = res1.taskId;

      // 2nd transmission (identical replay)
      const res2 = await service.ingest(payload);
      expect(res2.acknowledged).toBe(true);
      expect(res2.isDuplicate).toBe(true);
      expect(res2.actionTaken).toBe('duplicate_acknowledged');
      expect(res2.taskId).toBe(originalTaskId);

      // Verify no extra task was created
      expect(persistence.tasks.size).toBe(1);
      expect(persistence.inboxEvents.size).toBe(1);
      expect(persistence.messageEvents.size).toBe(1);
    });
  });

  describe('4. Message Edits & Source Immutability', () => {
    it('records message edit as a new revision preserving provenance', async () => {
      // 1. Initial message
      const res1 = await service.ingest({
        tenantId,
        channel: 'telegram',
        sourceAccountId: 'office_main_bot',
        sourceEventId: 'msg_v1_evt',
        sourceChannelId: 'client_chat_1',
        sourceMessageId: 'msg_tracked_1',
        sourceRevisionId: 'rev_1',
        senderExternalId: 'client_rep',
        text: '/task Initial Brief Draft for KAAE',
        rawPayload: { update_id: 201 },
        verified: true,
      });

      expect(res1.actionTaken).toBe('task_created');
      const taskId = res1.taskId!;

      // 2. Client edits the message while still in draft
      const res2 = await service.ingest({
        tenantId,
        channel: 'telegram',
        sourceAccountId: 'office_main_bot',
        sourceEventId: 'msg_v2_evt',
        sourceChannelId: 'client_chat_1',
        sourceMessageId: 'msg_tracked_1',
        sourceRevisionId: 'rev_2',
        senderExternalId: 'client_rep',
        text: '/task Updated Brief Draft for KAAE with Additional Requirements',
        rawPayload: { update_id: 202, edited_message: true },
        verified: true,
      });

      expect(res2.acknowledged).toBe(true);
      expect(res2.taskId).toBe(taskId);
      expect(res2.revisionId).toBe('rev_2');
      expect(persistence.messageEvents.size).toBe(2);
    });

    it('refuses to silently alter an approved brief when source message is edited, creating a revision request instead', async () => {
      // 1. Create task
      const res1 = await service.ingest({
        tenantId,
        channel: 'telegram',
        sourceAccountId: 'office_main_bot',
        sourceEventId: 'approved_flow_evt_1',
        sourceChannelId: 'kaae_board_chat',
        sourceMessageId: 'kaae_msg_approved',
        sourceRevisionId: 'rev_original',
        senderExternalId: 'kaae_minister',
        text: '/task KAAE National Accreditation Framework 2026',
        rawPayload: { update_id: 301 },
        verified: true,
      });

      const taskId = res1.taskId!;
      const task = persistence.tasks.get(taskId)!;

      // Simulate human approval
      task.state = 'approved';
      task.current_brief_id = 'brief_approved_999';

      // 2. Now client edits the source message on Telegram after approval
      const editResult = await service.ingest({
        tenantId,
        channel: 'telegram',
        sourceAccountId: 'office_main_bot',
        sourceEventId: 'approved_flow_evt_2',
        sourceChannelId: 'kaae_board_chat',
        sourceMessageId: 'kaae_msg_approved',
        sourceRevisionId: 'rev_post_approval_edit',
        senderExternalId: 'kaae_minister',
        text: 'KAAE Accreditation Framework 2026 - Changed venue to Erbil Rotana',
        rawPayload: { update_id: 302, edited_message: true },
        verified: true,
      });

      expect(editResult.acknowledged).toBe(true);
      // Invariant: cannot silently alter approved brief
      expect(editResult.actionTaken).toBe('revision_requested');
      expect(editResult.taskId).toBe(taskId);
      expect(persistence.revisionRequests.length).toBe(1);
      expect(persistence.revisionRequests[0].newRevisionId).toBe('rev_post_approval_edit');
    });
  });

  describe('5. Attachment Validation, Deduplication & SSRF Protection', () => {
    it('rejects attachments exceeding 50MB bound', () => {
      const oversized = {
        filename: 'heavy_archive.zip',
        mimeType: 'image/png',
        byteSize: MAX_ATTACHMENT_SIZE_BYTES + 1024,
      };
      const val = validateIngressAttachment(oversized);
      expect(val.valid).toBe(false);
      expect(val.scanState).toBe('rejected');
      expect(val.reason).toContain('exceeds 50MB limit');
    });

    it('rejects dangerous executable extensions', () => {
      const dangerous = [
        { filename: 'trojan.exe', mimeType: 'application/octet-stream', byteSize: 1024 },
        { filename: 'malware.sh', mimeType: 'text/x-shellscript', byteSize: 1024 },
        { filename: 'script.bat', mimeType: 'application/x-bat', byteSize: 1024 },
      ];

      for (const d of dangerous) {
        const val = validateIngressAttachment(d);
        expect(val.valid).toBe(false);
        expect(val.scanState).toBe('rejected');
        expect(val.reason).toContain('Disallowed dangerous file extension');
      }
    });

    it('deduplicates identical attachments across multiple messages using SHA-256', async () => {
      const assetData = Buffer.from('Official KAAE High-Res Crest Vector SVG');
      const sha256 = createHash('sha256').update(assetData).digest('hex');

      // First message with attachment
      await service.ingest({
        tenantId,
        channel: 'telegram',
        sourceAccountId: 'office_main_bot',
        sourceEventId: 'att_evt_1',
        sourceChannelId: 'chat_1',
        sourceMessageId: 'msg_att_1',
        senderExternalId: 'sender_1',
        text: 'Sharing the logo',
        rawPayload: { update_id: 1 },
        verified: true,
        attachments: [
          {
            filename: 'kaae_crest.svg',
            mimeType: 'image/svg+xml',
            byteSize: assetData.length,
            content: assetData,
            sha256,
          },
        ],
      });

      // Second message with identical attachment
      await service.ingest({
        tenantId,
        channel: 'telegram',
        sourceAccountId: 'office_main_bot',
        sourceEventId: 'att_evt_2',
        sourceChannelId: 'chat_2',
        sourceMessageId: 'msg_att_2',
        senderExternalId: 'sender_2',
        text: 'Re-sharing the same logo in another chat',
        rawPayload: { update_id: 2 },
        verified: true,
        attachments: [
          {
            filename: 'kaae_crest.svg',
            mimeType: 'image/svg+xml',
            byteSize: assetData.length,
            content: assetData,
            sha256,
          },
        ],
      });

      // Two messages recorded, but attachment SHA-256 is deduplicated
      expect(persistence.messageEvents.size).toBe(2);
      expect(persistence.attachments.size).toBe(2);
      const hashes = Array.from(persistence.attachments.values()).map(a => a.sha256);
      expect(new Set(hashes).size).toBe(1);
      expect(hashes[0]).toBe(sha256);
    });

    it('SSRF Defense: blocks private IP ranges and internal hostnames', () => {
      const maliciousUrls = [
        'http://127.0.0.1:8080/exploit.png',
        'http://127.0.0.2/exploit.png',
        'http://localhost:3000/keys.json',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/admin.jpg',
        'http://172.16.0.1/private.png',
        'http://192.168.1.1/secret.jpg',
        'http://internal.corp/asset.png',
        'ftp://evil.com/file.png',
        'file:///etc/passwd',
      ];

      for (const url of maliciousUrls) {
        const check = validateFetchDestination(url);
        expect(check.valid).toBe(false);
      }

      // Valid public URLs are allowed
      const validUrls = [
        'https://api.telegram.org/file/botToken/photos/file_0.jpg',
        'https://storage.googleapis.com/hawa-assets/kaae.png',
        'https://images.unsplash.com/photo-1234.jpg',
      ];

      for (const url of validUrls) {
        const check = validateFetchDestination(url);
        expect(check.valid).toBe(true);
      }
    });
  });

  describe('6. Content Sanitization & Script Injection Defense', () => {
    it('neutralizes XSS and script tags from message content', () => {
      const dirty = '<script>alert("XSS")</script>Hello Kurdish Team <iframe src="evil.com"></iframe>';
      const clean = sanitizeIngressContent(dirty);

      expect(clean.sanitized).not.toContain('<script');
      expect(clean.sanitized).not.toContain('<iframe');
      expect(clean.sanitized).toContain('Hello Kurdish Team');
      expect(clean.violations.length).toBeGreaterThan(0);
    });

    it('strips null bytes and non-printable control characters', () => {
      const malicious = 'Secret\x00Message\x08Payload\x1F';
      const clean = sanitizeIngressContent(malicious);

      expect(clean.sanitized).toBe('SecretMessagePayload');
      expect(clean.violations).toContain('Stripped ASCII control characters or null bytes');
    });

    it('adversarially strips unclosed, self-closing scripts, iframes, embeds, and event handlers', () => {
      const dirty = '<script src="evil.js"/>Hello <iframe src="javascript:alert(1)"> <embed src="evil.swf"/> <img src=x onerror=alert(1)> <svg/onload=alert(2)>';
      const clean = sanitizeIngressContent(dirty);

      expect(clean.sanitized).not.toContain('<script');
      expect(clean.sanitized).not.toContain('<iframe');
      expect(clean.sanitized).not.toContain('<embed');
      expect(clean.sanitized).not.toContain('onerror=');
      expect(clean.sanitized).not.toContain('onload=');
      expect(clean.violations.length).toBeGreaterThan(0);
    });
  });

  describe('7. Ingress Attachment Hash Integrity & Storage Traversal Defense', () => {
    it('rejects attachment when supplied sha256 checksum does not match content bytes (forged hash attack)', () => {
      const fakePayload = Buffer.from('Malicious payload posing as official logo');
      const forgedCleanHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // Hash of empty string

      const result = validateIngressAttachment({
        filename: 'trusted_logo.png',
        mimeType: 'image/png',
        byteSize: fakePayload.length,
        content: fakePayload,
        sha256: forgedCleanHash,
      });

      expect(result.valid).toBe(false);
      expect(result.scanState).toBe('rejected');
      expect(result.reason).toContain('mismatch');
    });

    it('neutralizes path traversal in attachment filename storage key', () => {
      const content = Buffer.from('Safe binary');
      const sha256 = createHash('sha256').update(content).digest('hex');

      const result = validateIngressAttachment({
        filename: '../../../../etc/passwd',
        mimeType: 'image/png',
        byteSize: content.length,
        content,
        sha256,
      });

      expect(result.valid).toBe(true);
      expect(result.storageKey).not.toContain('..');
      expect(result.storageKey).toContain('passwd');
      expect(result.storageKey.startsWith('attachments/')).toBe(true);
    });
  });
});
