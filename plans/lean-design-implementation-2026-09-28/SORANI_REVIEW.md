# Sorani lines awaiting native review (ADR-145)

Every Sorani string the bot can send to a requester, generated from the requester message catalogue
(`packages/integrations/src/requester-messages/`) by `npx tsx scripts/sorani_review_list.ts`. **None has had a
native review.** They were written by the engineering agents (ADR-144 and ADR-145) and must be checked by a native
Sorani speaker before release: meaning, register (polite, plain, not literal translation), spelling, and the
quotation marks around the words a requester is asked to say («بەڵێ», «نوێ», «گۆڕانکاری»).

How to review: mark each row OK or give the corrected line in the last column, then edit the catalogue and
re-run the script. `⏎` is a line break; `{title}`, `{text}`, `{list}` are filled in by the bot (a design name,
quoted words, a numbered list) and must stay as they are.

Also awaiting review: the Sorani words the bot *reads* (approval, cancel, status, deadline and change phrases in
`apps/core/src/services/requester-turn.ts`, and the yes-words in `apps/core/src/services/lifecycle-source-reply.ts`).

## sources

| Id | English | Sorani | Review |
|---|---|---|---|
| `sources.askClientVoice` | Thanks for the voice note! Which organisation is it for? | سوپاس بۆ دەنگەکە! بۆ کام دامەزراوەیە؟ | needs native review |
| `sources.askClientPdf` | Thanks for the PDF! Which organisation is it for? | سوپاس بۆ PDFـەکە! بۆ کام دامەزراوەیە؟ | needs native review |
| `sources.clientNotFound` | I couldn't find that organisation. Which organisation is it for? If it's a new one, the office can add it. | ئەو دامەزراوەیەم نەدۆزییەوە. بۆ کام دامەزراوەیە؟ ئەگەر نوێیە، ئۆفیسەکە دەتوانێت زیادی بکات. | needs native review |
| `sources.askChangeOrNew` | Is this for a change to {title}, or for a new design? Just say “change” or “new”. | ئەمە بۆ گۆڕانکارییە لە {title}، یان بۆ دیزاینێکی نوێیە؟ تەنها بنووسە «گۆڕانکاری» یان «نوێ». | needs native review |
| `sources.askWhichDesign` | Which design is this for?⏎{list}⏎⏎Answer with the number or the name. | ئەمە بۆ کام دیزاینە؟⏎{list}⏎⏎بە ژمارە یان ناو وەڵام بدەرەوە. | needs native review |
| `sources.newDesignOption` | A new design | دیزاینێکی نوێ | needs native review |
| `sources.heard` | Here is what I heard:⏎⏎«{text}»⏎⏎Is this exactly the text for the design? Just say “yes”, or send me the corrected text. | ئەمە ئەوەیە کە بیستم:⏎⏎«{text}»⏎⏎ئایا ئەمە ڕێک دەقی دیزاینەکەیە؟ تەنها بنووسە «بەڵێ»، یان دەقە ڕاستکراوەکەم بۆ بنێرە. | needs native review |
| `sources.readPdf` | Here is the text I found in your PDF:⏎⏎«{text}»⏎⏎Is this exactly the text for the design? Just say “yes”, or send me the corrected text. | ئەمە ئەو دەقەیە کە لە PDFـەکەتدا دۆزیمەوە:⏎⏎«{text}»⏎⏎ئایا ئەمە ڕێک دەقی دیزاینەکەیە؟ تەنها بنووسە «بەڵێ»، یان دەقە ڕاستکراوەکەم بۆ بنێرە. | needs native review |
| `sources.readPdfLong` | Thanks, I have read your PDF. It has a lot of text, so please send me the exact words that should go on the design. It starts:⏎⏎«{text}…» | سوپاس، PDFـەکەتم خوێندەوە. دەقێکی زۆری تێدایە، بۆیە تکایە ئەو وشانەم بۆ بنێرە کە دەبێت لەسەر دیزاینەکە بن. سەرەتاکەی ئەمەیە:⏎⏎«{text}…» | needs native review |
| `sources.heardLong` | Thanks, I have listened to your voice note. It has a lot of words, so please send me the exact words that should go on the design. It starts:⏎⏎«{text}…» | سوپاس، گوێم لە دەنگەکەت گرت. وشەیەکی زۆری تێدایە، بۆیە تکایە ئەو وشانەم بۆ بنێرە کە دەبێت لەسەر دیزاینەکە بن. سەرەتاکەی ئەمەیە:⏎⏎«{text}…» | needs native review |
| `sources.sendCorrected` | No problem. Please send me the text exactly as it should appear on the design. | کێشە نییە. تکایە دەقەکەم بۆ بنێرە، ڕێک وەک ئەوەی دەبێت لەسەر دیزاینەکە دەربکەوێت. | needs native review |
| `sources.sendExactWords` | Please send me the words that should go on the design, exactly as they should read. | تکایە ئەو وشانەم بۆ بنێرە کە دەبێت لەسەر دیزاینەکە بن، ڕێک وەک ئەوەی دەبێت بخوێنرێنەوە. | needs native review |
| `sources.sourceNotFound` | I couldn't find the voice note or PDF you mean. Could you send it again? | ئەو دەنگ یان PDFـەی مەبەستتە نەمدۆزییەوە. دەتوانیت دووبارە بینێریتەوە؟ | needs native review |
| `sources.voiceNoText` | Thanks, I've saved your voice note, but I couldn't turn it into text here. Could you type the words that should go on the design? The office can listen to it too. | سوپاس، دەنگەکەتم هەڵگرت، بەڵام نەمتوانی لێرە بیکەمە دەق. دەتوانیت ئەو وشانە بنووسیت کە دەبێت لەسەر دیزاینەکە بن؟ ئۆفیسەکەش دەتوانێت گوێی لێ بگرێت. | needs native review |
| `sources.pdfNoText` | I couldn't read the text in that PDF. Could you paste the words for the design here? The office can look at the file too. | نەمتوانی دەقی ناو ئەو PDFـە بخوێنمەوە. دەتوانیت وشەکانی دیزاینەکە لێرە بنووسیت؟ ئۆفیسەکەش دەتوانێت سەیری فایلەکە بکات. | needs native review |
| `sources.fileUnreadable` | I couldn't open that file. Could you send it again, or paste the text here? | نەمتوانی ئەو فایلە بکەمەوە. دەتوانیت دووبارە بینێریتەوە، یان دەقەکە لێرە بنووسیت؟ | needs native review |
| `sources.voiceUnplayable` | I couldn't play that recording. Could you record it again, or type the text here? | نەمتوانی ئەو تۆمارە لێبدەم. دەتوانیت دووبارە تۆماری بکەیتەوە، یان دەقەکە لێرە بنووسیت؟ | needs native review |
| `sources.voiceTooLong` | That recording is longer than ten minutes, which is more than I can use. Could you send a shorter one, or type the text here? | ئەو تۆمارە لە دە خولەک درێژترە، کە زیاترە لەوەی بتوانم بەکاری بهێنم. دەتوانیت دانەیەکی کورتتر بنێریت، یان دەقەکە لێرە بنووسیت؟ | needs native review |
| `sources.fileProblem` | Something went wrong with that file, so I couldn't use it. Could you send it again? | کێشەیەک لەگەڵ ئەو فایلەدا هەبوو، بۆیە نەمتوانی بەکاری بهێنم. دەتوانیت دووبارە بینێریتەوە؟ | needs native review |
| `sources.clientInactive` | I can't take designs for that organisation right now. Please check with the office. | ئێستا ناتوانم دیزاین بۆ ئەو دامەزراوەیە وەربگرم. تکایە لەگەڵ ئۆفیسەکە قسە بکە. | needs native review |

## media

| Id | English | Sorani | Review |
|---|---|---|---|
| `media.photoHeld` | Got the photo. Send me the text for the design and I'll use it with the photo. | وێنەکەم وەرگرت. دەقی دیزاینەکەم بۆ بنێرە و لەگەڵ وێنەکە بەکاری دەهێنم. | needs native review |
| `media.photoUsedWithWords` | I'll use the photo you sent with this. | ئەو وێنەیەی ناردت لەگەڵ ئەمەدا بەکاردەهێنم. | needs native review |
| `media.photoAdded` | Got the photo. I've added it to {title}. | وێنەکەم وەرگرت و بۆ {title} زیادم کرد. | needs native review |
| `media.photoPassed` | Got the photo. {title} is already being made, so I've passed the photo to the office to use. | وێنەکەم وەرگرت. {title} پێشتر دەستی پێکراوە، بۆیە وێنەکەم گەیاندە ئۆفیسەکە بۆ ئەوەی بەکاری بهێنن. | needs native review |
| `media.photosUnplaced` | Got the photos, but I'm not sure which design they're for. Please send them again together with what you'd like designed. | وێنەکانم وەرگرت، بەڵام دڵنیا نیم بۆ کام دیزاینن. تکایە دووبارە بیاننێرەوە لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت. | needs native review |
| `media.photoUnreadable` | I couldn't open that picture. Could you send it again as a photo? | نەمتوانی ئەو وێنەیە بکەمەوە. دەتوانیت دووبارە وەک وێنە بینێریتەوە؟ | needs native review |
| `media.videoNotUsed` | Thanks! I can't put videos on a design. Could you send a photo instead? You can also just tell me what the design should say. | سوپاس! ناتوانم ڤیدیۆ لەسەر دیزاین دابنێم. دەتوانیت لە جیاتی ئەوە وێنەیەک بنێریت؟ یان تەنها پێم بڵێ دیزاینەکە چی لەسەر بنووسرێت. | needs native review |
| `media.videoWordsUsed` | I can't put the video itself on a design, so I've used your words. Send photos if you'd like pictures on it. | ناتوانم خودی ڤیدیۆکە لەسەر دیزاین دابنێم، بۆیە وشەکانتم بەکارهێنا. ئەگەر وێنەت دەوێت لەسەری بێت، وێنە بنێرە. | needs native review |
| `media.fileUnsupported` | I couldn't open that file. Could you send it as a photo or a PDF, or paste the text here? | نەمتوانی ئەو فایلە بکەمەوە. دەتوانیت وەک وێنە یان PDF بینێریت، یان دەقەکە لێرە بنووسیت؟ | needs native review |
| `media.editApplied` | I saw your edit, and I'll use the new words. | دەستکارییەکەتم بینی، و وشە نوێیەکان بەکاردەهێنم. | needs native review |
| `media.editPassed` | I saw your edit to {title}. I've passed the new wording to the office so it's used. | دەستکارییەکەتم لە {title} بینی. دەقە نوێیەکەم گەیاندە ئۆفیسەکە بۆ ئەوەی بەکاری بهێنن. | needs native review |
| `media.editSeen` | I saw your edit. If anything should change, just tell me here. | دەستکارییەکەتم بینی. ئەگەر شتێک پێویستی بە گۆڕین هەیە، تەنها لێرە پێم بڵێ. | needs native review |
| `media.editForwarded` | I saw your edit and passed it to the office; they'll follow up here. | دەستکارییەکەتم بینی و گەیاندمە ئۆفیسەکە؛ لێرە وەڵامت دەدەنەوە. | needs native review |

## inbox

| Id | English | Sorani | Review |
|---|---|---|---|
| `inbox.answerTaken` | Thanks, I'll use that and carry on with the same design. | سوپاس، ئەوە بەکاردەهێنم و هەمان دیزاین تەواو دەکەم. | needs native review |
| `inbox.whichWaitingDesign` | More than one of your designs is waiting for changes. Which one is this for? Just tell me its name. | زیاتر لە یەک دیزاین چاوەڕێی گۆڕانکارییەکانی تۆن. ئەمە بۆ کامیانە؟ ناوەکەی بنووسە. | needs native review |
| `inbox.staleButton` | That design is now with the office. If anything should change, just tell me here. | ئەو دیزاینە ئێستا لای ئۆفیسەکەیە. ئەگەر شتێک پێویستی بە گۆڕین هەیە، لێرە پێم بڵێ. | needs native review |
| `inbox.whatToDesign` | What would you like designed? Tell me in your own words, with the text that should go on it. | چیت دەوێت دیزاین بکرێت؟ بە وشەی خۆت پێم بڵێ، لەگەڵ ئەو دەقەی دەبێت لەسەری بێت. | needs native review |
| `inbox.lateChangeReview` | Got it. The office is checking this design now, and I've passed your message to them. | تێگەیشتم. ئۆفیسەکە ئێستا سەیری ئەم دیزاینە دەکات، و پەیامەکەتم پێیان گەیاند. | needs native review |
| `inbox.lateChangeDelivering` | This design is being sent to you now; I've passed your message to the office. | ئەم دیزاینە ئێستا بۆت دەنێردرێت؛ پەیامەکەتم گەیاندە ئۆفیسەکە. | needs native review |
| `inbox.lateChangeDelivered` | This design was already delivered; I've passed your message to the office. | ئەم دیزاینە پێشتر گەیەندرابوو؛ پەیامەکەتم گەیاندە ئۆفیسەکە. | needs native review |
| `inbox.lateChangeKept` | Got it. I've kept your message for the office; they'll see it before the design is sent. | تێگەیشتم. پەیامەکەتم بۆ ئۆفیسەکە هەڵگرت؛ پێش ناردنی دیزاینەکە دەیبینن. | needs native review |
| `inbox.changeToOffice` | I've passed your change to the office; they'll make it and send the design here. There's no need to send it again. | گۆڕانکارییەکەتم گەیاندە ئۆفیسەکە؛ ئەوان دەیکەن و دیزاینەکە لێرە بۆت دەنێرن. پێویست ناکات دووبارەی بنێریتەوە. | needs native review |
| `inbox.answerToOffice` | I've passed your answer to the office; they'll finish this design and send it here. | وەڵامەکەتم گەیاندە ئۆفیسەکە؛ ئەوان ئەم دیزاینە تەواو دەکەن و لێرە بۆت دەنێرن. | needs native review |
| `inbox.changeToOfficeToFinish` | I've passed your change to the office; they'll finish this design and send it here. | گۆڕانکارییەکەتم گەیاندە ئۆفیسەکە؛ ئەوان ئەم دیزاینە تەواو دەکەن و لێرە بۆت دەنێرن. | needs native review |
| `inbox.changeNotStarted` | I couldn't make this change by myself just now. Please let the office know, and they'll take care of it. | ئێستا نەمتوانی خۆم ئەم گۆڕانکارییە بکەم. تکایە ئۆفیسەکە ئاگادار بکەرەوە، ئەوان بۆت دەکەن. | needs native review |
| `inbox.buttonPopup` | The office has this design now. Just tell me here if anything should change. | ئەم دیزاینە ئێستا لای ئۆفیسەکەیە. ئەگەر شتێک پێویستی بە گۆڕین هەیە، لێرە پێم بڵێ. | needs native review |
| `inbox.couldNotRead` | Sorry, I couldn't read that message just now. I've passed it to the office and they'll follow up here. | ببورە، ئێستا نەمتوانی ئەو پەیامە بخوێنمەوە. گەیاندمە ئۆفیسەکە و لێرە وەڵامت دەدەنەوە. | needs native review |

## access

| Id | English | Sorani | Review |
|---|---|---|---|
| `access.notAllowed` | Hi! This design assistant is only set up for the Hawa office team. Please ask the office to add you. | سڵاو! ئەم یاریدەدەرەی دیزاین تەنها بۆ تیمی ئۆفیسی هاوا ئامادە کراوە. تکایە داوا لە ئۆفیسەکە بکە زیادت بکەن. | needs native review |

## routing

| Id | English | Sorani | Review |
|---|---|---|---|
| `routing.statusDesigning` | {title} is being designed right now. The draft usually takes a few minutes; the office checks it before it comes to you. | {title} ئێستا دیزاین دەکرێت. ڕەشنووسەکە زۆرجار چەند خولەکێک دەخایەنێت؛ ئۆفیسەکە پێش ئەوەی بۆت بێت سەیری دەکات. | needs native review |
| `routing.statusManual` | A designer at the office is working on {title}. It will be sent here when it is ready. | دیزاینەرێک لە ئۆفیسەکە کار لەسەر {title} دەکات. کە ئامادە بوو لێرە بۆت دەنێردرێت. | needs native review |
| `routing.statusWaitingForChanges` | {title} is waiting for your changes. Just tell me what you would like changed. | {title} چاوەڕێی گۆڕانکارییەکانی تۆیە. تەنها پێم بڵێ چیت دەوێت بگۆڕدرێت. | needs native review |
| `routing.statusAwaitingAnswer` | {title} is waiting for your answer to one question: {question} | {title} چاوەڕێی وەڵامی تۆیە بۆ یەک پرسیار: {question} | needs native review |
| `routing.statusInReview` | {title} is with the office for a final check. It will be sent here once they approve it. | {title} لای ئۆفیسەکەیە بۆ دوایین پشکنین. کە پەسەندیان کرد لێرە بۆت دەنێردرێت. | needs native review |
| `routing.statusApproved` | {title} is approved and will be sent to you shortly. | {title} پەسەند کراوە و بەم زووانە بۆت دەنێردرێت. | needs native review |
| `routing.statusDelivering` | {title} is being sent to you now. | {title} ئێستا بۆت دەنێردرێت. | needs native review |
| `routing.statusDelivered` | {title} has been delivered. | {title} گەیەندرا. | needs native review |
| `routing.statusNothingOpen` | I don't have a design in progress in this chat right now. Tell me what you'd like designed. | ئێستا هیچ دیزاینێکم لەم چاتەدا لە دەستدا نییە. پێم بڵێ چیت دەوێت دیزاین بکرێت. | needs native review |
| `routing.thanks` | 🙏 Thank you. | 🙏 سوپاس. | needs native review |
| `routing.thanksOneWaiting` | 🙏 Thank you.⏎⏎Whenever you're ready, just tell me what to change on {title}. | 🙏 سوپاس.⏎⏎هەر کاتێک ئامادە بوویت، پێم بڵێ چی لە {title} بگۆڕم. | needs native review |
| `routing.forwardedToOffice` | I've passed your message to the office; they'll follow up here. | پەیامەکەتم گەیاندە ئۆفیسەکە؛ لێرە وەڵامت دەدەنەوە. | needs native review |
| `routing.keptForOffice` | I've kept your message for the office; they'll follow up here. | پەیامەکەتم بۆ ئۆفیسەکە هەڵگرت؛ لێرە وەڵامت دەدەنەوە. | needs native review |
| `routing.nothingToChange` | I don't have a design in progress here to change. Tell me what you'd like designed, with the text that should go on it. | ئێستا هیچ دیزاینێکم لە دەستدا نییە بۆ گۆڕین. پێم بڵێ چیت دەوێت دیزاین بکرێت، لەگەڵ ئەو دەقەی دەبێت لەسەری بێت. | needs native review |
| `routing.askChangeOrNew` | Is this a change to {title}, or a new design? Just say “change” or “new”. | ئەمە گۆڕانکارییە لە {title}، یان دیزاینێکی نوێیە؟ تەنها بنووسە «گۆڕانکاری» یان «نوێ». | needs native review |
| `routing.askCancel` | Do you want me to ask the office to cancel {title}? Just say “yes”. | دەتەوێت داوا لە ئۆفیسەکە بکەم {title} هەڵبوەشێنێتەوە؟ تەنها بنووسە «بەڵێ». | needs native review |
| `routing.askIsThisOne` | Is this for {title}? Just say “yes”. | ئەمە بۆ {title}ە؟ تەنها بنووسە «بەڵێ». | needs native review |
| `routing.askWhichDesign` | Which design is this for?⏎{list}⏎⏎Answer with the number or the name. | ئەمە بۆ کام دیزاینە؟⏎{list}⏎⏎بە ژمارە یان ناو وەڵام بدەرەوە. | needs native review |
| `routing.aNewDesign` | A new design | دیزاینێکی نوێ | needs native review |
| `routing.cancelAsked` | OK. I've asked the office to cancel {title}. | باشە. داوام لە ئۆفیسەکە کرد کە {title} هەڵبوەشێنێتەوە. | needs native review |
| `routing.changeAddedWhileDesigning` | Got it. I've added that to {title}; the office will see it before the design is sent to you. | تێگەیشتم. ئەوەم بۆ {title} زیاد کرد؛ ئۆفیسەکە پێش ناردنی دیزاینەکە دەیبینێت. | needs native review |
| `routing.changePassedInReview` | Got it. The office is checking {title} now, and I've passed your change to them. | تێگەیشتم. ئۆفیسەکە ئێستا سەیری {title} دەکات، و گۆڕانکارییەکەتم پێیان گەیاند. | needs native review |
| `routing.changePassedDelivering` | {title} is being sent to you now; I've passed your change to the office. | {title} ئێستا بۆت دەنێردرێت؛ گۆڕانکارییەکەتم گەیاندە ئۆفیسەکە. | needs native review |
| `routing.changePassedDelivered` | {title} was already delivered; I've passed your change to the office. | {title} پێشتر گەیەندرابوو؛ گۆڕانکارییەکەتم گەیاندە ئۆفیسەکە. | needs native review |
| `routing.approvalPassed` | Thanks! I've told the office you're happy with {title}. They give it a final check before it's sent. | سوپاس! بە ئۆفیسەکەم ڕاگەیاند کە تۆ ڕازیت بە {title}. پێش ناردن بۆ دواجار سەیری دەکەن. | needs native review |
| `routing.deadlinePassed` | Noted. I've told the office about the timing for {title}. | تێبینی کرا. سەبارەت بە کاتی {title} ئۆفیسەکەم ئاگادار کردەوە. | needs native review |

## conversation

| Id | English | Sorani | Review |
|---|---|---|---|
| `conversation.welcome` | 👋 Hi! Tell me what you'd like designed, in English or Kurdish, with the text that should go on it. You can add photos, a voice note or a PDF, and tell me any changes in your own words. The office checks every design before it's sent to you here. | 👋 سڵاو! پێم بڵێ چیت دەوێت دیزاین بکرێت، بە کوردی یان ئینگلیزی، لەگەڵ ئەو دەقەی دەبێت لەسەری بێت. دەتوانیت وێنە، تۆمارێکی دەنگی یان PDF زیاد بکەیت، و هەر گۆڕانکارییەک بە وشەی خۆت پێم بڵێیت. ئۆفیسەکە پێش ئەوەی هەر دیزاینێک لێرە بۆت بنێردرێت سەیری دەکات. | needs native review |
| `conversation.greeting` | 👋 Hi! What would you like designed? Tell me in your own words, with the text that should go on it. | 👋 سڵاو! چیت دەوێت دیزاین بکرێت؟ بە وشەی خۆت پێم بڵێ، لەگەڵ ئەو دەقەی دەبێت لەسەری بێت. | needs native review |
| `conversation.question` | Happy to help. Tell me what you'd like designed and the text that should go on it, such as the date, time and place. | بە خۆشحاڵییەوە. پێم بڵێ چیت دەوێت دیزاین بکرێت و ئەو دەقەی دەبێت لەسەری بێت، وەک بەروار، کات و شوێن. | needs native review |
| `conversation.officeGivesFinalCheck` | Thanks! The office gives every design a final check before it's sent to you. If anything should change, just tell me here. | سوپاس! ئۆفیسەکە پێش ناردنی هەر دیزاینێک بۆت، بۆ دواجار سەیری دەکات. ئەگەر شتێک پێویستی بە گۆڕین هەیە، لێرە پێم بڵێ. | needs native review |
| `conversation.officeRestarts` | The office looks after every design. If something should be made again or changed, just tell me here in your own words. | ئۆفیسەکە ئاگای لە هەموو دیزاینەکانە. ئەگەر شتێک دەبێت دووبارە دروست بکرێتەوە یان بگۆڕدرێت، لێرە بە وشەی خۆت پێم بڵێ. | needs native review |
| `conversation.officeOnly` | That's something the office does. | ئەوە کاری ئۆفیسەکەیە. | needs native review |
| `conversation.statusHeader` | 📊 Your designs | 📊 دیزاینەکانت | needs native review |
| `conversation.statusNone` | 📊 I haven't made any designs for this chat yet. Tell me what you'd like designed. | 📊 هێشتا هیچ دیزاینێکم بۆ ئەم چاتە دروست نەکردووە. پێم بڵێ چیت دەوێت دیزاین بکرێت. | needs native review |
| `conversation.statusUnavailable` | I can't check on your designs just now. Please ask me again in a minute. | ئێستا ناتوانم سەیری دیزاینەکانت بکەم. تکایە دوای خولەکێک دووبارە لێم بپرسەوە. | needs native review |
| `conversation.stateDesigning` | being designed | دیزاین دەکرێت | needs native review |
| `conversation.stateChecking` | being checked | پشکنینی بۆ دەکرێت | needs native review |
| `conversation.stateInReview` | with the office for a final check | لای ئۆفیسەکەیە بۆ دوایین پشکنین | needs native review |
| `conversation.stateReplaced` | replaced by a newer version | وەشانێکی نوێتر جێگەی گرتەوە | needs native review |
| `conversation.stateApproved` | approved, and will be sent to you shortly | پەسەند کراوە و بەم زووانە بۆت دەنێردرێت | needs native review |
| `conversation.stateDelivering` | being sent to you now | ئێستا بۆت دەنێردرێت | needs native review |
| `conversation.stateDelivered` | delivered | گەیەندرا | needs native review |
| `conversation.stateWaitingForAnswer` | waiting for your answer to a question | چاوەڕێی وەڵامی تۆیە بۆ پرسیارێک | needs native review |
| `conversation.stateNoLongerWaiting` | no longer waiting: answered, or replaced by a newer change | چیتر چاوەڕێ ناکات: وەڵام درایەوە، یان گۆڕانکارییەکی نوێتر جێگەی گرتەوە | needs native review |
| `conversation.stateDelayed` | delayed; I'm trying again | دواکەوتووە؛ دووبارە هەوڵ دەدەمەوە | needs native review |
| `conversation.stateWithOffice` | a designer at the office is finishing it | دیزاینەرێک لە ئۆفیسەکە تەواوی دەکات | needs native review |
| `conversation.stateStopped` | stopped by the office | ئۆفیسەکە ڕایگرت | needs native review |
| `conversation.stateCancelled` | cancelled | هەڵوەشێنرایەوە | needs native review |
| `conversation.stateInProgress` | in progress | لە کاردایە | needs native review |
| `conversation.preferenceSaved` | Noted. From now on every {client} design will follow this:⏎"{rule}"⏎⏎If you want it changed, just tell me or the office. | تێبینی کرا. لەمەودوا هەموو دیزاینێکی {client} ئەمە ڕەچاو دەکات:⏎"{rule}"⏎⏎ئەگەر دەتەوێت بگۆڕدرێت، تەنها بە من یان بە ئۆفیسەکە بڵێ. | needs native review |
| `conversation.preferenceAlreadySaved` | I already have this for every {client} design:⏎"{rule}"⏎⏎If you want it changed, just tell me or the office. | ئەمە پێشتر بۆ هەموو دیزاینێکی {client} تۆمار کراوە:⏎"{rule}"⏎⏎ئەگەر دەتەوێت بگۆڕدرێت، تەنها بە من یان بە ئۆفیسەکە بڵێ. | needs native review |
| `conversation.whichOrganisation` | Which organisation is this for? Please tell me again with its name in the same message. | ئەمە بۆ کام دامەزراوەیە؟ تکایە دووبارە پێم بڵێوە و ناوەکەی لە هەمان پەیامدا بنووسە. | needs native review |
| `conversation.preferencesNone` | I have no lasting preferences saved for {client} yet. Tell me one in your own words, for example "from now on, put the logo bottom-right", and every later {client} design will follow it. | هێشتا هیچ ڕێنماییەکی هەمیشەییم بۆ {client} تۆمار نەکردووە. بە وشەی خۆت یەکێکم پێ بڵێ، بۆ نموونە «لەمەودوا لۆگۆکە لە خوارەوەی لای ڕاست دابنێ»، و هەموو دیزاینێکی دواتری {client} ڕەچاوی دەکات. | needs native review |
| `conversation.preferencesHeader` | What every {client} design follows ({count}): | ئەوەی هەموو دیزاینێکی {client} ڕەچاوی دەکات ({count}): | needs native review |
| `conversation.preferencesMore` | … and {count} more. | … و {count} دانەی تر. | needs native review |
| `conversation.preferencesFooter` | A later one wins over an earlier one, and what you ask for in a request wins over both. If one should change, just tell me or the office. | ئەوەی دواتر هاتووە لە پێشترەکە بەهێزترە، و ئەوەی لە داواکارییەکدا دەیخوازیت لە هەردووکیان بەهێزترە. ئەگەر یەکێکیان دەبێت بگۆڕدرێت، تەنها بە من یان بە ئۆفیسەکە بڵێ. | needs native review |
| `conversation.preferencesRemoved` | No longer applied to {client} designs: | چیتر لە دیزاینەکانی {client} جێبەجێ ناکرێت: | needs native review |
| `conversation.preferencesUnmatched` | {count} of those numbers did not match a saved preference. | {count} لەو ژمارانە لەگەڵ هیچ ڕێنماییەکی تۆمارکراو نەگونجا. | needs native review |

## lifecycle

| Id | English | Sorani | Review |
|---|---|---|---|
| `lifecycle.yourDesign` | your design | دیزاینەکەت | needs native review |
| `lifecycle.receivedForDesigner` | Got it. A designer will make {title} and send it to you here. | تێگەیشتم. دیزاینەرێک {title} دروست دەکات و لێرە بۆت دەنێرێت. | needs native review |
| `lifecycle.receivedDrafting` | Got it. I'm making a first draft of {title}; the office checks it before you get it. | تێگەیشتم. یەکەم ڕەشنووسی {title} دروست دەکەم؛ ئۆفیسەکە پێش ئەوەی بۆت بێت سەیری دەکات. | needs native review |
| `lifecycle.officeNote` | The office has a note on {title}:⏎⏎{comment}⏎⏎What would you like changed? Just write it here. | ئۆفیسەکە تێبینییەکی لەسەر {title} هەیە:⏎⏎{comment}⏎⏎چیت دەوێت بگۆڕدرێت؟ تەنها لێرە بینووسە. | needs native review |
| `lifecycle.oneQuestion` | One question about {title}:⏎⏎{question}⏎⏎{options}⏎⏎Answer with a number or in your own words. | پرسیارێک دەربارەی {title}:⏎⏎{question}⏎⏎{options}⏎⏎بە ژمارە یان بە وشەی خۆت وەڵام بدەرەوە. | needs native review |
| `lifecycle.questionReminder` | {title} is still waiting for one answer:⏎⏎{question}⏎⏎{options}⏎⏎Answer with a number or in your own words. | {title} هێشتا چاوەڕێی یەک وەڵامە:⏎⏎{question}⏎⏎{options}⏎⏎بە ژمارە یان بە وشەی خۆت وەڵام بدەرەوە. | needs native review |
| `lifecycle.changesReminder` | {title} is still waiting for your changes. What should I change? | {title} هێشتا چاوەڕێی گۆڕانکارییەکانی تۆیە. چی بگۆڕم؟ | needs native review |
| `lifecycle.officeWillFollowUp` | Someone from the office will follow up here. | کەسێک لە ئۆفیسەکە لێرە بەدواداچوونی بۆ دەکات. | needs native review |

## outcomes

| Id | English | Sorani | Review |
|---|---|---|---|
| `outcomes.draftReady` | Your draft of {title} is ready, and the office is giving it a final check. They'll send it to you here once it's approved. If anything should change, just tell me. | ڕەشنووسی {title} ئامادەیە و ئۆفیسەکە بۆ دواجار سەیری دەکات. کە پەسەند کرا لێرە بۆت دەنێردرێت. ئەگەر شتێک پێویستی بە گۆڕین هەیە، تەنها پێم بڵێ. | needs native review |
| `outcomes.draftBeingFixed` | Your draft of {title} is made; the office is fixing a small detail before you get it. | ڕەشنووسی {title} دروست کرا؛ ئۆفیسەکە پێش ئەوەی بۆت بێت وردەکارییەکی بچووک چاک دەکات. | needs native review |
| `outcomes.organisationUnknown` | I couldn't tell which organisation {title} is for, so a designer at the office will make it and send it to you here. | نەمزانی {title} بۆ کام دامەزراوەیە، بۆیە دیزاینەرێک لە ئۆفیسەکە دروستی دەکات و لێرە بۆت دەنێرێت. | needs native review |
| `outcomes.designerMakes` | A designer will make {title} and send it to you here. | دیزاینەرێک {title} دروست دەکات و لێرە بۆت دەنێرێت. | needs native review |
| `outcomes.designerSetsText` | A designer will set the text of {title} by hand and send it to you here. | دیزاینەرێک دەقی {title} بە دەست دادەنێت و لێرە بۆت دەنێرێت. | needs native review |
| `outcomes.designerMakesChange` | A designer will make this change to {title} by hand and send it to you here. | دیزاینەرێک ئەم گۆڕانکارییە لە {title} بە دەست دەکات و لێرە بۆت دەنێرێت. | needs native review |
| `outcomes.textNeeded` | What text should go on {title}? Send it just as you would like it to read. | چ دەقێک دەبێت لەسەر {title} بێت؟ بە هەمان شێوە بینێرە کە دەتەوێت بخوێندرێتەوە. | needs native review |
| `outcomes.alreadyInProgress` | {title} is already being worked on; you'll get it here. | ئێستا کار لەسەر {title} دەکرێت؛ لێرە بۆت دێت. | needs native review |
| `outcomes.officeCheckingDraft` | The office is checking the draft of {title} and will send it to you here. | ئۆفیسەکە سەیری ڕەشنووسی {title} دەکات و لێرە بۆت دەنێرێت. | needs native review |
| `outcomes.questionWithButtons` | One question about {title} before I make your change:⏎⏎{question}⏎⏎{options}⏎⏎Tap an answer below, or answer in your own words. Everything else you asked for goes into the same draft. | پرسیارێک دەربارەی {title} پێش ئەوەی گۆڕانکارییەکەت بکەم:⏎⏎{question}⏎⏎{options}⏎⏎لە خوارەوە وەڵامێک هەڵبژێرە، یان بە وشەی خۆت وەڵام بدەرەوە. هەموو ئەوانی تری داوات کردووە دەچنە هەمان ڕەشنووسەوە. | needs native review |
| `outcomes.designerMakesPart` | A designer will make this part by hand:⏎{list} | دیزاینەرێک ئەم بەشە بە دەست دەکات:⏎{list} | needs native review |
| `outcomes.changeByDesignerList` | A designer will make this part of your change to {title} by hand:⏎{list}⏎Your last draft stays as it is. Anything else to change? Just write it. | دیزاینەرێک ئەم بەشەی گۆڕانکارییەکەت لە {title} بە دەست دەکات:⏎{list}⏎دوایین ڕەشنووست وەک خۆی دەمێنێتەوە. شتێکی تر هەیە بگۆڕدرێت؟ تەنها بینووسە. | needs native review |
| `outcomes.changeByDesigner` | A designer will make your change to {title} by hand. Your last draft stays as it is. Anything else to change? Just write it. | دیزاینەرێک گۆڕانکارییەکەت لە {title} بە دەست دەکات. دوایین ڕەشنووست وەک خۆی دەمێنێتەوە. شتێکی تر هەیە بگۆڕدرێت؟ تەنها بینووسە. | needs native review |
| `outcomes.designTakingLonger` | {title} needs a little more time. The office is on it and will send your draft here; you don't need to send anything again. | {title} کەمێک کاتی زیاتری پێویستە. ئۆفیسەکە کاری لەسەر دەکات و ڕەشنووسەکەت لێرە بۆت دەنێرێت؛ پێویست ناکات هیچ شتێک دووبارە بنێریتەوە. | needs native review |
| `outcomes.officeWillFinish` | The office will finish {title} and send it to you here. | ئۆفیسەکە {title} تەواو دەکات و لێرە بۆت دەنێرێت. | needs native review |
| `outcomes.delivered` | Here is your final {title}. 🎉 | فەرموو، ئەمە وەشانی کۆتایی {title}. 🎉 | needs native review |
| `outcomes.deliveredUnconfirmed` | I've sent your final {title}, but Telegram didn't confirm that it arrived. The office will check, and send it again if it didn't. | وەشانی کۆتایی {title}م بۆ ناردیت، بەڵام تێلێگرام دڵنیایی نەدا کە گەیشتووە. ئۆفیسەکە سەیری دەکات، و ئەگەر نەگەیشتبوو دووبارە دەینێرێتەوە. | needs native review |
| `outcomes.deliveredInDrive` | Also in Google Drive: | هەروەها لە گووگڵ درایڤدا: | needs native review |
| `outcomes.deliveryFolder` | the delivery folder | بوخچەی گەیاندن | needs native review |
| `outcomes.deliveredCaption` | {title}, final | {title}، وەشانی کۆتایی | needs native review |
| `outcomes.couldNotStart` | Sorry, I couldn't start your design request. The office has been told and will follow up with you here. | ببورە، نەمتوانی داواکاری دیزاینەکەت دەست پێ بکەم. ئۆفیسەکە ئاگادار کرایەوە و لێرە بەدواداچوونت بۆ دەکات. | needs native review |
| `outcomes.draftMadeNotSaved` | Your draft of {title} is made, but I couldn't finish saving it. The office will follow up with you here. | ڕەشنووسی {title} دروست کرا، بەڵام نەمتوانی بە تەواوی پاشەکەوتی بکەم. ئۆفیسەکە لێرە بەدواداچوونت بۆ دەکات. | needs native review |
| `outcomes.couldNotFinish` | I couldn't finish {title} automatically. The office will follow up with you here. | نەمتوانی {title} بە شێوەی خۆکار تەواو بکەم. ئۆفیسەکە لێرە بەدواداچوونت بۆ دەکات. | needs native review |

## albums

| Id | English | Sorani | Review |
|---|---|---|---|
| `albums.question` | I have your {count} photos. What would you like me to design with them? Please tell me what it is for and the exact words to put on it. | {count} وێنەکەتم پێگەیشت. دەتەوێت چ دیزاینێکیان پێ دروست بکەم؟ تکایە بۆم بنووسە بۆ چییە و ئەو دەقانەی دەبێت لەسەری بنووسرێن. | needs native review |
| `albums.followUp` | Happy to. What should I design with these photos? Tell me what it is for and the exact words to put on it. | بە دڵخۆشییەوە. چ دیزاینێک بەم وێنانە دروست بکەم؟ پێم بڵێ بۆ چییە و ئەو دەقانەی دەبێت لەسەری بنووسرێن. | needs native review |
| `albums.latePhoto` | This photo arrived after I had started your design, so it isn't part of it. When the draft is ready, just send the photo again and tell me what to change. | ئەم وێنەیە دوای دەستپێکردنی دیزاینەکەت گەیشت، بۆیە بەشێک نییە لێی. کاتێک ڕەشنووسەکە ئامادە بوو، تەنها وێنەکە دووبارە بنێرەوە و پێم بڵێ چی بگۆڕدرێت. | needs native review |
| `albums.captionCut` | Telegram kept only the first part of the text you sent with the photos. Please send the rest as a message and I'll use it with these photos. | تێلیگرام تەنها بەشی یەکەمی ئەو دەقەی لەگەڵ وێنەکان ناردت هێشتەوە. تکایە ئەوەی ماوەتەوە وەک نامەیەک بنێرە و لەگەڵ ئەم وێنانە بەکاری دەهێنم. | needs native review |
| `albums.photoMissing` | One of your photos could not be saved, so I have not started a design. Please send the photos again. | یەکێک لە وێنەکانت پاشەکەوت نەکرا، بۆیە هێشتا دیزاینم دەست پێنەکردووە. تکایە وێنەکان دووبارە بنێرەوە. | needs native review |
| `albums.onePhoto` | I received only one photo from this album. Please send the photos again together with what you would like designed. | تەنها یەک وێنەم لەم ئەلبومە پێگەیشت. تکایە وێنەکان دووبارە بنێرەوە لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت. | needs native review |
| `albums.captions` | Your photos came with different captions, so I am not sure which one is the brief. Please send the brief again as one message. | وێنەکانت چەند نووسینێکی جیاوازیان لەگەڵ بوو، بۆیە نازانم کامیان داواکارییەکەیە. تکایە داواکارییەکە وەک یەک نامە دووبارە بنێرەوە. | needs native review |
| `albums.mixedReplies` | Some of these photos answer a different message than the others. Please send them again together, with one brief. | هەندێک لەم وێنانە وەڵامی نامەیەکی جیاوازن. تکایە وەک یەک ئەلبوم لەگەڵ یەک داواکاری دووبارە بیاننێرەوە. | needs native review |
| `albums.noAlbum` | I could not find photos from you waiting in this chat. Please send the photos again with what you would like designed. | هیچ وێنەیەکی چاوەڕوانکراوی تۆم لەم چاتەدا نەدۆزییەوە. تکایە وێنەکان دووبارە بنێرەوە لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت. | needs native review |
| `albums.tooMany` | That is more than ten photos, which is more than one design can use. Please send up to ten, with what you would like designed. | ئەوە زیاتر لە دە وێنەیە، کە زیاترە لەوەی یەک دیزاین بتوانێت بەکاری بهێنێت. تکایە تا دە وێنە بنێرە، لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت. | needs native review |
| `albums.notPhotos` | I can only use photos in a design, not videos or other files. Please send just the photos again, with what you would like designed. | تەنها دەتوانم وێنە لە دیزایندا بەکاربهێنم، نەک ڤیدیۆ یان فایلی تر. تکایە تەنها وێنەکان دووبارە بنێرەوە، لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت. | needs native review |
| `albums.photoUnreadable` | One of these photos could not be opened. Please send the photos again. | یەکێک لەم وێنانە نەکرایەوە. تکایە وێنەکان دووبارە بنێرەوە. | needs native review |
| `albums.notFound` | I could not find the photos you mean. Please send them again with what you would like designed. | ئەو وێنانەی مەبەستتە نەمدۆزییەوە. تکایە دووبارە بیاننێرەوە لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت. | needs native review |
| `albums.alreadyStarted` | I have already started a design with these photos, so I did not start another one. | پێشتر دیزاینێکم بەم وێنانە دەست پێکردووە، بۆیە یەکێکی ترم دەست پێنەکرد. | needs native review |
| `albums.needsTwo` | I did not receive all of these photos. Please send them again together. | هەموو ئەم وێنانەم پێنەگەیشت. تکایە پێکەوە دووبارە بیاننێرەوە. | needs native review |
| `albums.somethingWrong` | Something went wrong with these photos. Please send them again, with what you would like designed. | کێشەیەک لەگەڵ ئەم وێنانەدا ڕوویدا. تکایە دووبارە بیاننێرەوە، لەگەڵ ئەوەی دەتەوێت چی دیزاین بکرێت. | needs native review |
| `albums.tooLarge` | These photos are too large together. Please send fewer or smaller photos. | ئەم وێنانە پێکەوە زۆر گەورەن. تکایە ژمارەیەکی کەمتر یان وێنەی بچووکتر بنێرە. | needs native review |

154 lines.
