/**
 * The first reading of a Telegram message: its voice note, its picture or image file, a PDF of brand
 * guidelines, and pictures sent without words (albums included). Moved unchanged from the webhook
 * in app.ts (architecture programme 1.3, SPLIT_PLAN.md G9).
 */
import type { Context } from 'hono';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { OpenAiStudioClient } from '@hawa/creative';
import { escapeTelegramHtml } from '@hawa/integrations';
import { cutText } from '../../core-helpers.js';
import { DEFAULT_TENANT_ID, type CoreContext } from '../../core-context.js';
import { log } from '../../logging.js';
import { persistChatIntake, findRequestAwaitingReference, findAlbumRequest, PICTURE_ONLY_DIRECTIVE } from '../chat-intake.js';
import { sniffImageMime, isUsableImage, TELEGRAM_BOT_DOWNLOAD_MAX_BYTES } from '../telegram-media.js';
import type { GuidelinesModel } from '../brand-guidelines.js';
import { handleGuidelinesPdf, type RulesIntakeDeps } from '../telegram-rules-intake.js';
import { createTelegramUpdateState, type TelegramUpdateJson } from './update-state.js';

/** What the webhook read of an update before its media (routes/telegram-webhook.routes.ts). */
export interface TelegramUpdateRead {
  json: TelegramUpdateJson;
  /** The message, channel post or test body the update carries. */
  msg: TelegramUpdateJson;
  sourceEventId: string;
  /** The Telegram user who sent it or pressed the button. */
  verifiedSender: string;
}

/** A message once its media has been read. */
export type TelegramMediaReading = Exclude<Awaited<ReturnType<TelegramMedia['readMedia']>>, Response>;

export type TelegramMedia = ReturnType<typeof createTelegramMedia>;

export function createTelegramMedia(deps: Pick<CoreContext, 'db' | 'voiceTranscriber' | 'options' | 'guidelineReadings' | 'telegramAllowedUsers' | 'problem' | 'broadcastEvent' | 'telegramBridge'>, acknowledgedAlbums: Set<string>) {
  const { db, voiceTranscriber, options, guidelineReadings, telegramAllowedUsers, problem, broadcastEvent: broadcast } = deps;
  // createApp always builds the bridge; the shared context types it as optional.
  const telegramBridge = deps.telegramBridge ?? (() => { throw new Error('Telegram intake needs the Telegram bridge'); })();
  const { markTelegramUpdateHandled, studioRunInProgressForChat } = createTelegramUpdateState(deps);

  /**
   * A message's words, voice, picture or file: transcribed, downloaded, checked, and a PDF read as
   * brand guidelines. A picture with no words joins the request it belongs to, or waits for one. The
   * answer when the message ends here; otherwise what was read, for the rest of intake.
   */
  async function readMedia(c: Context, update: TelegramUpdateRead) {
    const { json, msg, sourceEventId, verifiedSender } = update;
    const sourceChannelId = String(msg.chat?.id || json.sourceChannelId || 'tg_default');
    let rawText = msg.text || msg.caption || json.text || '';
    let voiceTranscript: string | undefined = undefined;

    // Detect Voice or Audio Ingress (Telegram voice or audio message)
    const voiceObj = msg.voice || msg.audio || json.voice || json.audio;
    if (voiceObj) {
      const fileId = voiceObj.file_id;
      let audioBuf: Buffer | undefined;
      if (fileId) {
        try {
          const downloaded = await telegramBridge.downloadFile(fileId);
          if (downloaded) {
            audioBuf = downloaded;
          }
        } catch (err) {
          log.warn('[TelegramIngress] Failed to download audio file:', err);
        }
      } else if (json.audioBase64) {
        audioBuf = Buffer.from(json.audioBase64, 'base64');
      }

      const duration = voiceObj.duration || json.durationSeconds || 15;
      const transcription = await voiceTranscriber.transcribe(
        {
          audioBuffer: audioBuf,
          audioBase64: json.audioBase64,
          audioMimeType: voiceObj.mime_type || 'audio/ogg',
          durationSeconds: duration,
          languageHint: 'ckb',
        },
        rawText || json.transcriptFallback
      );

      // Intake has not selected and locked a client yet. Treat the audio as unavailable even if
      // a caption exists: it may contain instructions beyond the caption. Do not create a design
      // from only part of the request while implying the voice was read.
      if (audioBuf?.length && transcription.audioStatus === 'policy_blocked') {
        await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_voice_policy_blocked',
          { audioStatus: transcription.audioStatus, hadCaption: Boolean(rawText) }, true);
        if (sourceChannelId !== 'tg_default') {
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
            text: 'Your voice note was received but cannot be sent for transcription until the client is confirmed. Please resend the full brief as text so no spoken instruction is missed.',
          }).catch(() => undefined);
        }
        return c.json({ ok: true, ignored: true, reason: 'VOICE_POLICY_UNRESOLVED', updateId: sourceEventId }, 200);
      }

      voiceTranscript = transcription.audioStatus === 'transcribed' ? transcription.transcript : undefined;
      // The caption and what was said, together (the transcriber joins them).
      rawText = transcription.normalizedText || rawText;
    }

    // Detect Photo or Image Reference Ingress (Telegram photo or document image)
    let referenceImageBase64: string | undefined = undefined;
    const photoList = msg.photo || json.photo;
    const docObj = msg.document || json.document;
    let photoFileId: string | undefined;

    if (Array.isArray(photoList) && photoList.length > 0) {
      photoFileId = photoList[photoList.length - 1]?.file_id;
    } else if (docObj && typeof docObj.mime_type === 'string' && docObj.mime_type.startsWith('image/')) {
      photoFileId = docObj.file_id;
    }

    const imageDocument = Boolean(photoFileId && docObj && photoFileId === docObj.file_id);
    const refuseImageFile = async (why: string, reason: string) => {
      const chat = String(msg.chat?.id || json.sourceChannelId || '');
      if (chat) {
        await telegramBridge.dispatchOutboundMessage(chat, {
          text: `📎 <b>${escapeTelegramHtml(String(docObj?.file_name || 'This picture'))} ${why}</b>\n\n` +
            `<i>Send it as a photo instead of a file (Telegram converts it), or as a JPEG or PNG file. Nothing was started.</i>`,
          parse_mode: 'HTML',
        }).catch(() => undefined);
      }
      return c.json({ ok: true, ignored: true, reason, updateId: sourceEventId }, 200);
    };
    // Telegram refuses a bot any file over 20 MB: the download failed, the update was retried for
    // about a minute, holding up every chat, and then parked with a generic notice (review of 2026-09-24).
    if (imageDocument && Number(docObj.file_size) > TELEGRAM_BOT_DOWNLOAD_MAX_BYTES) {
      return refuseImageFile('is larger than 20 MB, which Telegram does not let the bot download.', 'IMAGE_FILE_TOO_LARGE');
    }

    if (photoFileId) {
      let unusable: string | undefined;
      try {
        const photoBuf = await telegramBridge.downloadFile(photoFileId);
        if (photoBuf && photoBuf.length > 0) {
          // An image sent as a file keeps its own format (a PNG with transparency, a WebP); it was
          // labelled JPEG whatever it was, and the models and the deck read the label.
          const mime = sniffImageMime(photoBuf);
          if (imageDocument && !isUsableImage(mime)) unusable = mime.slice('image/'.length).toUpperCase();
          else referenceImageBase64 = `data:${mime};base64,${photoBuf.toString('base64')}`;
        }
      } catch (err) {
        log.warn('[TelegramIngress] Failed to download reference photo:', err);
      }
      if (unusable) return refuseImageFile(`is a ${unusable} file, which the design cannot use.`, 'IMAGE_FORMAT_UNSUPPORTED');
      // A picture Telegram could not hand over is fetched again with the whole update: the poller
      // retries a 503 and, after its last try, tells the sender. Going ahead without it made a paid
      // design without the picture, and a picture sent again later no longer joined that request.
      if (!referenceImageBase64) {
        return problem(c, 503, 'Picture Not Downloaded', 'The picture could not be downloaded from Telegram; the update is retried');
      }
    } else if (json.referenceImageBase64) {
      referenceImageBase64 = json.referenceImageBase64;
    }

    if ((!rawText || !rawText.trim()) && referenceImageBase64) {
      rawText = PICTURE_ONLY_DIRECTIVE;
    }

    const rulesDeps: RulesIntakeDeps | null = db
      ? {
          db,
          tenantId: DEFAULT_TENANT_ID,
          userId: SYSTEM_AUTOMATION_USER_ID,
          bridge: telegramBridge,
          trustNamedClient: telegramAllowedUsers.includes(verifiedSender),
        }
      : null;

    // A document that is not an image. A PDF is read as brand guidelines and its rules saved for the
    // client; anything else is refused out loud. A PDF used to be answered "this message contained
    // no text or media", or, with a caption, the caption became a design brief and the PDF was
    // dropped: a client's new brand guidelines never reached a design (2026-09-22).
    if (docObj && !photoFileId && !voiceObj && sourceChannelId !== 'tg_default') {
      const docName = String(docObj.file_name || '');
      const isPdfDocument = String(docObj.mime_type || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(docName);
      if (!isPdfDocument || !rulesDeps) {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text:
            `📎 <b>${escapeTelegramHtml(docName || 'This file')} cannot be read here.</b>\n\n` +
            `<i>Send brand guidelines as a PDF, pictures as photos or image files, and the text for a design as a message.</i>`,
          parse_mode: 'HTML',
        }).catch(() => undefined);
        return c.json({ ok: true, ignored: true, reason: 'UNSUPPORTED_DOCUMENT', updateId: sourceEventId }, 200);
      }
      const model: GuidelinesModel = options?.guidelinesModel || new OpenAiStudioClient({ apiKey: process.env.OPENAI_API_KEY || '', timeoutMs: 180000 });
      const reading = await handleGuidelinesPdf({ ...rulesDeps, model }, {
        sourceChannelId,
        fileId: String(docObj.file_id || ''),
        fileUniqueId: docObj.file_unique_id ? String(docObj.file_unique_id) : undefined,
        fileName: docName,
        fileSize: Number(docObj.file_size) || undefined,
        caption: String(msg.caption || ''),
      });
      if (reading.done) {
        // The set held the reading itself and deleted a different promise, so it only grew.
        const tracked: Promise<void> = reading.done.finally(() => guidelineReadings.delete(tracked));
        guidelineReadings.add(tracked);
      }
      // A PDF read is a paid call: the same update delivered again is not read twice.
      if (reading.accepted) await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_guidelines_pdf', json);
      return c.json({ ok: true, guidelines: reading.accepted ? 'reading' : 'refused', updateId: sourceEventId }, 200);
    }

    // An update without usable text (sticker, photo without caption, chat-member event, or a voice
    // note that could not be transcribed) is acknowledged and skipped. Persisting it would throw,
    // the poller would retry the same update forever, and every later message would be blocked.
    if (typeof rawText !== 'string' || !rawText.trim()) {
      // A sticker (a 👍 on a draft) is a reaction, not an empty message: it was answered "this message
      // contained no text or media" (review of 2026-09-24). No model is asked about it.
      if (msg.sticker && sourceChannelId !== 'tg_default') {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: msg.reply_to_message
            ? '🙏 Thank you. If the design is right, tap ✅ Approve design under it; to change anything, reply to the design with the change in words.'
            : 'Stickers are not read as requests. Send the request, or a change to a design, as text.',
        }).catch(() => undefined);
        await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_sticker', { replied: Boolean(msg.reply_to_message) });
        return c.json({ ok: true, ignored: true, reason: 'STICKER', updateId: sourceEventId }, 200);
      }
      const reason = voiceObj ? 'VOICE_NOT_TRANSCRIBED' : (photoFileId ? 'PHOTO_DOWNLOAD_FAILED' : 'NO_TEXT');
      if (sourceChannelId !== 'tg_default' && (msg.chat?.id || voiceObj)) {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text: voiceObj
            ? 'Your voice note was received but could not be transcribed. Please send the brief as text so nothing is guessed.'
            : photoFileId
              // The picture came, and could not be fetched from Telegram: saying the message had no
              // media told the sender their photo never arrived.
              ? 'Your picture arrived but could not be downloaded from Telegram, so nothing was saved. Please send it again.'
              : 'Please send your design brief as text (or an image reference / voice note); this message contained no text or media to work with.',
        }).catch(() => undefined);
      }
      return c.json({ ok: true, ignored: true, reason, updateId: sourceEventId }, 200);
    }

    // A photo sent without a caption right after a request is part of that request. Telegram sends
    // the text and the photo as two messages; on 2026-09-19 the photo became a "revision" (task
    // 936c5c6f) and a second full design run. If the request's design has not reached layout
    // generation, the photo is saved as an instruction-only task pointing at it and the studio
    // follows it; otherwise it takes the revision path below, as before.
    const captionless = Boolean(referenceImageBase64) && !String(msg.caption || msg.text || json.text || '').trim();
    const albumId = msg.media_group_id ? String(msg.media_group_id) : undefined;
    // One answer per album: each of its photos arrives as its own message.
    const firstOfAlbum = (() => {
      if (!albumId) return true;
      const key = `${sourceChannelId}:${albumId}`;
      if (acknowledgedAlbums.has(key)) return false;
      acknowledgedAlbums.add(key);
      if (acknowledgedAlbums.size > 500) acknowledgedAlbums.delete(acknowledgedAlbums.values().next().value as string);
      return true;
    })();
    // An album sent as a reply to a draft carries the reply on every photo: only the first is read
    // as the change, and the album's other photos join the revision it made (one paid run, one
    // answer). Each used to start its own revision.
    if (captionless && (!msg.reply_to_message || (albumId && !firstOfAlbum)) && db && sourceChannelId !== 'tg_default') {
      // A photo from the album whose captioned photo is the request belongs to that request.
      const album = albumId
        ? await findAlbumRequest(db, { sourceChannelId, mediaGroupId: albumId }).catch((err) => {
            log.warn('[TelegramIngress] Could not look for the album request:', err);
            return null;
          })
        : null;
      // An album photo belongs to its album's request or to none yet: with the caption on a later
      // photo, the first one was attached to whichever request the chat made last.
      const target = album || (albumId ? null : await findRequestAwaitingReference(db, { sourceChannelId }).catch((err) => {
        log.warn('[TelegramIngress] Could not look for a request to attach the photo to:', err);
        return null;
      }));
      if (target) {
        const persisted = await persistChatIntake(db, {
          platform: 'telegram',
          sourceEventId,
          sourceChannelId,
          rawText,
          rawJson: json,
          clientId: target.clientId,
          title: `${target.title} (reference image)`,
          designInstructions: rawText,
          exactCopy: [],
          isInstructionOnly: true,
          autoGenerate: false,
          studioOptions: { referenceFor: target.taskId, referenceImageBase64, ...(albumId ? { mediaGroupId: albumId } : {}) },
        });
        // The album's request was already acknowledged with its first photo.
        if (!album && firstOfAlbum) {
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
            text:
              `🖼️ <b>Picture added to your request</b> "${escapeTelegramHtml(target.title)}"\n\n` +
              `<i>The design uses it as your message says: placed in the design, or followed as the style to match. No separate draft is made.</i>`,
            parse_mode: 'HTML',
          });
        }
        broadcast('task:created', persisted.task);
        return c.json({ ok: true, referenceFor: target.taskId, album: Boolean(album), task: persisted.task }, 201);
      }
      // A picture that comes after the design has passed its brief cannot join it, and "send the
      // request text now" made the sender send the request again: a second paid design (2026-09-23).
      if (!albumId) {
        const running = await studioRunInProgressForChat(sourceChannelId).catch(() => null);
        if (running) {
          await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
            text:
              `🖼️ <b>Your design "${escapeTelegramHtml(running.title)}" is already being made</b> with the pictures it had.\n\n` +
              `<i>When the draft arrives, reply to it with this picture and say what to do with it. Nothing new was started.</i>`,
            parse_mode: 'HTML',
          }).catch(() => undefined);
          await markTelegramUpdateHandled(sourceChannelId, sourceEventId, 'telegram_late_picture', json);
          return c.json({ ok: true, ignored: true, reason: 'DESIGN_ALREADY_RUNNING', taskId: running.taskId }, 200);
        }
      }
      // No request to attach to yet: the image is kept as a reference for the request that follows.
      // It used to fall through to intake as a brief whose copy was the sentence "Apply the attached
      // visual reference image…" (two such tasks on 2026-09-22), which a design would then print.
      const persisted = await persistChatIntake(db, {
        platform: 'telegram',
        sourceEventId,
        sourceChannelId,
        rawText,
        rawJson: json,
        clientId: null,
        title: `${[msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Client'}: reference image (awaiting request)`,
        designInstructions: rawText,
        exactCopy: [],
        isInstructionOnly: true,
        autoGenerate: false,
        studioOptions: { referenceImageBase64, ...(albumId ? { mediaGroupId: albumId } : {}) },
      });
      if (firstOfAlbum) {
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text:
            `🖼️ <b>${albumId ? 'Pictures' : 'Picture'} saved.</b>\n\n` +
            (albumId
              // The album's caption can be on a later photo, which arrives after this answer: "send the
              // request text now" had the sender send the request again, a second paid design.
              ? `<i>If one of these pictures carries your request as its caption, nothing more is needed: it is being read now. Otherwise, send the request text and the design will use them.</i>`
              : `<i>Send the request text now and the design will use it. Nothing is designed from pictures alone.</i>`),
          parse_mode: 'HTML',
        });
      }
      broadcast('task:created', persisted.task);
      return c.json({ ok: true, referenceAwaitingRequest: true, task: persisted.task }, 201);
    }

    // An album sent as a reply to a draft whose caption is on a later photo: the first photo, which
    // had no words, already started the change. This photo and its caption join that change (the
    // studio waits for the album to settle before it reads the change), instead of meeting "your
    // previous change is still being made" and being dropped with the caption (review of 2026-09-24).
    if (albumId && !firstOfAlbum && msg.reply_to_message && referenceImageBase64 && !captionless && db && sourceChannelId !== 'tg_default') {
      const album = await findAlbumRequest(db, { sourceChannelId, mediaGroupId: albumId }).catch((err) => {
        log.warn('[TelegramIngress] Could not look for the album change:', err);
        return undefined;
      });
      if (album === undefined) return problem(c, 503, 'Database unavailable', 'The album this photo belongs to could not be looked up; retry');
      if (album) {
        const caption = rawText.trim().slice(0, 2000);
        const persisted = await persistChatIntake(db, {
          platform: 'telegram',
          sourceEventId,
          sourceChannelId,
          rawText,
          rawJson: json,
          clientId: album.clientId,
          title: `${album.title} (album picture)`,
          designInstructions: caption,
          exactCopy: [],
          isInstructionOnly: true,
          autoGenerate: false,
          studioOptions: { referenceFor: album.taskId, referenceImageBase64, mediaGroupId: albumId, albumCaption: caption },
        });
        await telegramBridge.dispatchOutboundMessage(sourceChannelId, {
          text:
            `✏️ <b>Change received:</b> "${escapeTelegramHtml(cutText(caption, 500))}"\n\n` +
            `<i>It is being made with the pictures you sent together with it. The new draft comes to this chat when ready.</i>\n\n` +
            `🆔 Task ID: <code>${escapeTelegramHtml(album.taskId)}</code>`,
          parse_mode: 'HTML',
        }).catch(() => undefined);
        broadcast('task:created', persisted.task);
        return c.json({ ok: true, status: 'ALBUM_CAPTION_JOINED', referenceFor: album.taskId, task: persisted.task }, 201);
      }
    }
    return { ...update, rawText, voiceTranscript, referenceImageBase64, sourceChannelId, rulesDeps, albumId, firstOfAlbum };
  }

  return { readMedia };
}
