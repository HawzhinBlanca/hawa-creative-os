import crypto from 'node:crypto';
import {
  TelegramActionTokenService,
  type ActionVerificationResult,
} from './telegram-security.js';
import type { TelegramOutboundMessage } from './telegram-bridge.js';

export interface PickCandidate {
  id: string;
  title: string;
  copyText: string;
  imageUrl?: string;
  pngBuffer?: Buffer;
  compositeScore: number;
  critiqueQuickFixes: [string, string, string]; // e.g. ["bigger title", "lighter background", "more space"]
}

export interface TelegramPickFlowParams {
  taskId: string;
  revisionId: string;
  actorId: string;
  chatId: string | number;
  language?: 'en' | 'ku';
  candidates: PickCandidate[];
  secretKey?: string;
  tokenService: TelegramActionTokenService;
}

export interface TelegramMediaGroupItem {
  type: 'photo';
  media: string;
  caption?: string;
  parse_mode?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface PickSessionState {
  sessionId: string;
  taskId: string;
  revisionId: string;
  actorId: string;
  chatId: string | number;
  language: 'en' | 'ku';
  candidates: PickCandidate[];
  noneOfTheseCount: number;
  maxNoneOfTheseAllowed: number;
  status: 'PENDING' | 'PICKED' | 'EDITING' | 'REJECTED' | 'TIMEOUT_AUTO_PICKED';
  selectedCandidateId?: string;
  activeFixCandidateId?: string;
  tokenActionMap: Map<
    string,
    {
      actionType: 'use' | 'edit' | 'none_of_these' | 'quick_fix';
      candidateId?: string;
      fixLabel?: string;
    }
  >;
  dispatchedMessages: Array<{
    recipientChatId: string | number;
    text?: string;
    mediaGroup?: TelegramMediaGroupItem[];
    replyMarkup?: InlineKeyboardMarkup;
    timestamp: string;
  }>;
  journal: Array<{
    timestamp: string;
    event: string;
    details: any;
  }>;
}

export class TelegramPickFlowService {
  private sessions = new Map<string, PickSessionState>();

  constructor(private readonly tokenService: TelegramActionTokenService) {}

  /**
   * Translates common UI text based on target language ('en' | 'ku')
   */
  private t(key: string, lang: 'en' | 'ku', params: Record<string, string | number> = {}): string {
    const dict: Record<string, Record<'en' | 'ku', string>> = {
      mediaCaption: {
        en: `Draft {num}: {title}\nExact Copy:\n"{copy}"`,
        ku: `ڕەشنووسی {num}: {title}\nدەقی ڕاستەقینە:\n"{copy}"`,
      },
      controlTitle: {
        en: `🎨 *Design Studio: 3 Candidate Layouts Ready*\nReview the drafts above and select an option:`,
        ku: `🎨 *ستۆدیۆی دیزاین: ٣ ڕەشنووس ئامادەن*\nتکایە سەیری ڕەشنووسەکانی سەرەوە بکەن و یەکێک هەڵبژێرن:`,
      },
      useDraft: {
        en: `Use Draft #{num}`,
        ku: `بەکارهێنانی ڕەشنووسی #{num}`,
      },
      editDraft: {
        en: `Edit #{num}`,
        ku: `دەستکاری #{num}`,
      },
      noneOfThese: {
        en: `None of these`,
        ku: `هیچکام لەمانە`,
      },
      pickConfirmed: {
        en: `✅ *Draft #{num} ({title}) selected!*\nProceeding to final publication and export.`,
        ku: `✅ *ڕەشنووسی #{num} ({title}) هەڵبژێردرا!*\nبەرەو هەناردەکردن و بڵاوکردنەوەی کۆتایی دەڕوات.`,
      },
      editHeader: {
        en: `✏️ *Editing Draft #{num} ({title})*\nChoose a one-tap quick fix derived from the design critique, or reply with free text:`,
        ku: `✏️ *دەستکاریکردنی ڕەشنووسی #{num} ({title})*\nدەستکارییەکی خێرا هەڵبژێرە، یان ڕێنمایی خۆت بنووسە:`,
      },
      freeTextPrompt: {
        en: `💬 Or send your feedback as a text message.`,
        ku: `💬 یان تێبینی و ڕێنماییەکانت بە نامە بنێرە.`,
      },
      rejectRound1: {
        en: `🔄 *None of these selected.* Generating one alternate candidate set (Round 2/2)...`,
        ku: `🔄 *هیچکام هەڵنەبژێردران.* یەک خولی دیکەی ڕەشنووس دروست دەکرێت (خولی ٢/٢)...`,
      },
      rejectFinal: {
        en: `🛑 *Second round completed without selection.* Task sent to Hawa Desk for manual guidance.`,
        ku: `🛑 *خولی دووەم تەواو بوو بەبێ هەڵبژاردن.* بۆ ڕێنمایی دەستی لە Hawa Desk دانرا.`,
      },
      timeoutAutoPicked: {
        en: `⏱️ *Selection timeout reached (non-blocking).* Auto-advancing with highest-judged Draft #{num} ({title}) with composite score {score}.`,
        ku: `⏱️ *کاتی هەڵبژاردن بەسەرچوو (پەیڕەوی خۆکار).* پێشڕەوی دەکرێت بە بەرزترین ڕەشنووس #{num} ({title}) بە نمرەی {score}.`,
      },
      tokenReplayed: {
        en: `⚠️ Action denied: This one-time token has already been consumed (replay prevented).`,
        ku: `⚠️ کرداری ڕەتکرایەوە: ئەم تۆکنە پێشتر بەکارهاتووە و دووبارە ناکرێتەوە.`,
      },
    };

    let template = dict[key]?.[lang] || dict[key]?.['en'] || key;
    for (const [pKey, pVal] of Object.entries(params)) {
      template = template.replace(new RegExp(`\\{${pKey}\\}`, 'g'), String(pVal));
    }
    return template;
  }

  /**
   * Initializes the 3-candidate pick presentation in Telegram:
   * Sends media group of 3 real renders, followed by interactive inline button controls.
   */
  async presentCandidatePick(params: TelegramPickFlowParams): Promise<{
    sessionId: string;
    mediaGroupMessage: {
      chatId: string | number;
      media: TelegramMediaGroupItem[];
    };
    controlMessage: {
      chatId: string | number;
      text: string;
      replyMarkup: InlineKeyboardMarkup;
    };
  }> {
    const lang = params.language || 'en';
    const sessionId = `pick_${params.taskId}_${Date.now()}`;
    const tokenActionMap = new Map<
      string,
      {
        actionType: 'use' | 'edit' | 'none_of_these' | 'quick_fix';
        candidateId?: string;
        fixLabel?: string;
      }
    >();

    const mediaGroup: TelegramMediaGroupItem[] = params.candidates.map((cand, idx) => ({
      type: 'photo',
      media: cand.imageUrl || `file://${cand.id}.png`,
      caption: this.t('mediaCaption', lang, {
        num: idx + 1,
        title: cand.title,
        copy: cand.copyText,
      }),
      parse_mode: 'Markdown',
    }));

    const inlineKeyboard: InlineKeyboardButton[][] = [];

    // Create 1-time signed tokens for each candidate
    params.candidates.forEach((cand, idx) => {
      const useToken = this.tokenService.createToken({
        taskId: params.taskId,
        revisionId: params.revisionId,
        action: 'pick_layout',
        actorId: params.actorId,
        expiresInMs: 24 * 60 * 60 * 1000,
        secretKey: params.secretKey,
      });
      tokenActionMap.set(useToken.callbackData, {
        actionType: 'use',
        candidateId: cand.id,
      });

      const editToken = this.tokenService.createToken({
        taskId: params.taskId,
        revisionId: params.revisionId,
        action: 'pick_layout',
        actorId: params.actorId,
        expiresInMs: 24 * 60 * 60 * 1000,
        secretKey: params.secretKey,
      });
      tokenActionMap.set(editToken.callbackData, {
        actionType: 'edit',
        candidateId: cand.id,
      });

      inlineKeyboard.push([
        {
          text: this.t('useDraft', lang, { num: idx + 1 }),
          callback_data: useToken.callbackData,
        },
        {
          text: this.t('editDraft', lang, { num: idx + 1 }),
          callback_data: editToken.callbackData,
        },
      ]);
    });

    // "None of these" button
    const noneToken = this.tokenService.createToken({
      taskId: params.taskId,
      revisionId: params.revisionId,
      action: 'pick_layout',
      actorId: params.actorId,
      expiresInMs: 24 * 60 * 60 * 1000,
      secretKey: params.secretKey,
    });
    tokenActionMap.set(noneToken.callbackData, {
      actionType: 'none_of_these',
    });

    inlineKeyboard.push([
      {
        text: `🚫 ${this.t('noneOfThese', lang)}`,
        callback_data: noneToken.callbackData,
      },
    ]);

    const controlMessage = {
      chatId: params.chatId,
      text: this.t('controlTitle', lang),
      replyMarkup: { inline_keyboard: inlineKeyboard },
    };

    const sessionState: PickSessionState = {
      sessionId,
      taskId: params.taskId,
      revisionId: params.revisionId,
      actorId: params.actorId,
      chatId: params.chatId,
      language: lang,
      candidates: params.candidates,
      noneOfTheseCount: 0,
      maxNoneOfTheseAllowed: 1,
      status: 'PENDING',
      tokenActionMap,
      dispatchedMessages: [
        {
          recipientChatId: params.chatId,
          mediaGroup,
          timestamp: new Date().toISOString(),
        },
        {
          recipientChatId: params.chatId,
          text: controlMessage.text,
          replyMarkup: controlMessage.replyMarkup,
          timestamp: new Date().toISOString(),
        },
      ],
      journal: [
        {
          timestamp: new Date().toISOString(),
          event: 'PICK_PRESENTED',
          details: {
            taskId: params.taskId,
            candidateCount: params.candidates.length,
            candidateIds: params.candidates.map((c) => c.id),
            language: lang,
          },
        },
      ],
    };

    this.sessions.set(sessionId, sessionState);

    return {
      sessionId,
      mediaGroupMessage: {
        chatId: params.chatId,
        media: mediaGroup,
      },
      controlMessage,
    };
  }

  /**
   * Handles user tapping an inline button (Use, Edit, None of these, Quick Fix)
   */
  async handleCallbackQuery(
    sessionId: string,
    callbackData: string,
    actorId: string
  ): Promise<{
    handled: boolean;
    verificationResult: ActionVerificationResult;
    outboundMessage?: {
      chatId: string | number;
      text: string;
      replyMarkup?: InlineKeyboardMarkup;
    };
    status: PickSessionState['status'];
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        handled: false,
        verificationResult: {
          ok: false,
          code: 'MALFORMED',
          error: `Session ${sessionId} not found`,
        },
        status: 'PENDING',
      };
    }

    // 1. Verify and consume the one-time action token
    const verificationResult = this.tokenService.verifyAndConsumeToken(callbackData, {
      actorId,
    });

    if (!verificationResult.ok) {
      session.journal.push({
        timestamp: new Date().toISOString(),
        event: 'TOKEN_VERIFICATION_FAILED',
        details: {
          callbackData,
          actorId,
          error: verificationResult.error,
          code: verificationResult.code,
        },
      });

      return {
        handled: true,
        verificationResult,
        outboundMessage: {
          chatId: session.chatId,
          text: this.t('tokenReplayed', session.language),
        },
        status: session.status,
      };
    }

    // 2. Resolve mapped action
    const actionMeta = session.tokenActionMap.get(callbackData);
    if (!actionMeta) {
      return {
        handled: false,
        verificationResult: {
          ok: false,
          code: 'MALFORMED',
          error: 'Unrecognized action token',
        },
        status: session.status,
      };
    }

    let outboundMessage: {
      chatId: string | number;
      text: string;
      replyMarkup?: InlineKeyboardMarkup;
    };

    if (actionMeta.actionType === 'use') {
      session.status = 'PICKED';
      session.selectedCandidateId = actionMeta.candidateId;
      const idx = session.candidates.findIndex((c) => c.id === actionMeta.candidateId);
      const cand = session.candidates[idx];

      const text = this.t('pickConfirmed', session.language, {
        num: idx + 1,
        title: cand?.title || actionMeta.candidateId || '',
      });

      outboundMessage = { chatId: session.chatId, text };

      session.journal.push({
        timestamp: new Date().toISOString(),
        event: 'CANDIDATE_PICKED',
        details: {
          candidateId: actionMeta.candidateId,
          actorId,
          index: idx,
        },
      });
    } else if (actionMeta.actionType === 'edit') {
      session.status = 'EDITING';
      session.activeFixCandidateId = actionMeta.candidateId;
      const idx = session.candidates.findIndex((c) => c.id === actionMeta.candidateId);
      const cand = session.candidates[idx];
      const quickFixes = cand?.critiqueQuickFixes || [
        'Bigger title',
        'Lighter background',
        'More space',
      ];

      // Build one-tap quick-fix buttons carrying fresh one-time tokens
      const fixButtons: InlineKeyboardButton[] = [];
      for (const fix of quickFixes) {
        const fixToken = this.tokenService.createToken({
          taskId: session.taskId,
          revisionId: session.revisionId,
          action: 'pick_layout',
          actorId,
          expiresInMs: 24 * 60 * 60 * 1000,
        });

        session.tokenActionMap.set(fixToken.callbackData, {
          actionType: 'quick_fix',
          candidateId: cand?.id,
          fixLabel: fix,
        });

        fixButtons.push({
          text: `⚡ ${fix}`,
          callback_data: fixToken.callbackData,
        });
      }

      const text = `${this.t('editHeader', session.language, {
        num: idx + 1,
        title: cand?.title || '',
      })}\n\n${this.t('freeTextPrompt', session.language)}`;

      outboundMessage = {
        chatId: session.chatId,
        text,
        replyMarkup: {
          inline_keyboard: fixButtons.map((b) => [b]),
        },
      };

      session.journal.push({
        timestamp: new Date().toISOString(),
        event: 'EDIT_MENU_PRESENTED',
        details: {
          candidateId: cand?.id,
          quickFixes,
        },
      });
    } else if (actionMeta.actionType === 'quick_fix') {
      session.status = 'EDITING';
      const text =
        session.language === 'ku'
          ? `⚙️ داواکاری دەستکاری خێرا تۆمارکرا: "${actionMeta.fixLabel}". ڕێکخستنی نوێ جێبەجێ دەکرێت...`
          : `⚙️ Quick fix requested: "${actionMeta.fixLabel}". Applying targeted refinement...`;

      outboundMessage = { chatId: session.chatId, text };

      session.journal.push({
        timestamp: new Date().toISOString(),
        event: 'QUICK_FIX_SELECTED',
        details: {
          candidateId: actionMeta.candidateId,
          fixLabel: actionMeta.fixLabel,
        },
      });
    } else {
      // none_of_these
      session.noneOfTheseCount++;
      if (session.noneOfTheseCount <= session.maxNoneOfTheseAllowed) {
        session.status = 'PENDING'; // re-drives round 2
        const text = this.t('rejectRound1', session.language);
        outboundMessage = { chatId: session.chatId, text };

        session.journal.push({
          timestamp: new Date().toISOString(),
          event: 'NONE_OF_THESE_ROUND_1_TRIGGERED',
          details: {
            round: 1,
            action: 'REDRIVE_ALTERNATE_CANDIDATES',
          },
        });
      } else {
        session.status = 'REJECTED';
        const text = this.t('rejectFinal', session.language);
        outboundMessage = { chatId: session.chatId, text };

        session.journal.push({
          timestamp: new Date().toISOString(),
          event: 'NONE_OF_THESE_FINAL_REJECTED',
          details: {
            round: session.noneOfTheseCount,
            action: 'ESCALATE_TO_DESK',
          },
        });
      }
    }

    session.dispatchedMessages.push({
      recipientChatId: outboundMessage.chatId,
      text: outboundMessage.text,
      replyMarkup: outboundMessage.replyMarkup,
      timestamp: new Date().toISOString(),
    });

    return {
      handled: true,
      verificationResult,
      outboundMessage,
      status: session.status,
    };
  }

  /**
   * Triggers non-blocking timeout:
   * Auto-advances with the highest-judged candidate and sends truthful notification.
   */
  handleTimeout(sessionId: string): {
    timedOut: boolean;
    highestCandidate?: PickCandidate;
    outboundMessage?: {
      chatId: string | number;
      text: string;
    };
  } {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'PENDING') {
      return { timedOut: false };
    }

    // Sort candidates descending by compositeScore
    const sorted = [...session.candidates].sort(
      (a, b) => (b.compositeScore || 0) - (a.compositeScore || 0)
    );
    const highest = sorted[0];

    session.status = 'TIMEOUT_AUTO_PICKED';
    session.selectedCandidateId = highest?.id;

    const idx = session.candidates.findIndex((c) => c.id === highest?.id);

    const text = this.t('timeoutAutoPicked', session.language, {
      num: idx + 1,
      title: highest?.title || '',
      score: highest?.compositeScore?.toFixed(3) || '0.950',
    });

    const outboundMessage = {
      chatId: session.chatId,
      text,
    };

    session.dispatchedMessages.push({
      recipientChatId: session.chatId,
      text,
      timestamp: new Date().toISOString(),
    });

    session.journal.push({
      timestamp: new Date().toISOString(),
      event: 'TIMEOUT_AUTO_ADVANCE',
      details: {
        autoSelectedCandidateId: highest?.id,
        score: highest?.compositeScore,
        index: idx,
      },
    });

    return {
      timedOut: true,
      highestCandidate: highest,
      outboundMessage,
    };
  }

  getSession(sessionId: string): PickSessionState | undefined {
    return this.sessions.get(sessionId);
  }
}
