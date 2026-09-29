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
| `media.photoUnreadable` | I couldn't open that picture. Could you send it again as a photo? | نەمتوانی ئەو وێنەیە بکەمەوە. دەتوانیت دووبارە وەک وێنە بینێریتەوە؟ | needs native review |
| `media.videoNotUsed` | Thanks! I can't put videos on a design. Could you send a photo instead? You can also just tell me what the design should say. | سوپاس! ناتوانم ڤیدیۆ لەسەر دیزاین دابنێم. دەتوانیت لە جیاتی ئەوە وێنەیەک بنێریت؟ یان تەنها پێم بڵێ دیزاینەکە چی لەسەر بنووسرێت. | needs native review |
| `media.videoWordsUsed` | I can't put the video itself on a design, so I've used your words. Send photos if you'd like pictures on it. | ناتوانم خودی ڤیدیۆکە لەسەر دیزاین دابنێم، بۆیە وشەکانتم بەکارهێنا. ئەگەر وێنەت دەوێت لەسەری بێت، وێنە بنێرە. | needs native review |
| `media.fileUnsupported` | I couldn't open that file. Could you send it as a photo or a PDF, or paste the text here? | نەمتوانی ئەو فایلە بکەمەوە. دەتوانیت وەک وێنە یان PDF بینێریت، یان دەقەکە لێرە بنووسیت؟ | needs native review |
| `media.editApplied` | I saw your edit, and I'll use the new words. | دەستکارییەکەتم بینی، و وشە نوێیەکان بەکاردەهێنم. | needs native review |
| `media.editPassed` | I saw your edit to {title}. I've passed the new wording to the office so it's used. | دەستکارییەکەتم لە {title} بینی. دەقە نوێیەکەم گەیاندە ئۆفیسەکە بۆ ئەوەی بەکاری بهێنن. | needs native review |
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
| `inbox.couldNotRead` | Sorry, I couldn't read that message just now. I've passed it to the office and they'll follow up here. | ببورە، ئێستا نەمتوانی ئەو پەیامە بخوێنمەوە. گەیاندمە ئۆفیسەکە و لێرە وەڵامت دەدەنەوە. | needs native review |

## access

| Id | English | Sorani | Review |
|---|---|---|---|
| `access.notAllowed` | Hi! This design assistant is only set up for the Hawa office team. Please ask the office to add you. | سڵاو! ئەم یاریدەدەرەی دیزاین تەنها بۆ تیمی ئۆفیسی هاوا ئامادە کراوە. تکایە داوا لە ئۆفیسەکە بکە زیادت بکەن. | needs native review |

40 lines.
