# Chat Luck: honest status (updated by the build agent)

Legend: DONE+TESTED = automated tests pass locally; LIVE = also checked on the deployed server; NEEDS = needs an external key/account/action; NO = cannot be done honestly on the free stack.

| Area | Status | Notes |
|---|---|---|
| Chat API, auth, conversations, streaming | LIVE | Gemini only (flash-lite). |
| Task engine (statuses, steps, tool log, retry, final verification, cancel) | DONE+TESTED | 7 statuses incl. waiting_approval, canceled. |
| Approval gate | DONE+TESTED | save_memory requires approval; Telegram inline buttons. |
| Tools: web_search (Gemini grounding), web_read (SSRF-guarded) | DONE+TESTED with a scripted model; search live check pending | Free-tier quota applies. |
| Tools: read_file (PDF, DOCX, XLSX, PPTX, text, images via Gemini vision) | DONE+TESTED (formats); image vision not yet live-checked | 10 MB per file, 60 MB per user. |
| Tools: create_document DOCX/XLSX/PPTX/PDF | DONE+TESTED (files re-opened and parsed) | PDF: Latin text only. Arabic PDF is refused (letters came out in wrong order). Use DOCX for Arabic. |
| Memory (view, delete, on/off, secret filter) | DONE+TESTED | Rejects passwords, cards, API keys. |
| Reminders | DONE+TESTED | Best effort: free server sleeps, so late delivery is possible and labelled. |
| Telegram adapter (pairing, owner-only, commands, files in/out, approvals, reminders) | DONE+TESTED against a fake Telegram | Live test needs the bot token (NEEDS). |
| Voice notes, video | NO (not yet) | Refused with a clear message. |
| Email / calendar / Drive | NEEDS Google OAuth (user declined) | Not built. |
| Browser automation, form filling, account creation | NO | No headless browser on 512 MB; CAPTCHA bypass excluded. |
| Code sandbox, APK/AAB/iOS builds, Docker | NO | Free server cannot. Code writing/reviewing in chat is fine. |
| Flights/hotels/products live prices, bookings | NO for prices (no free source); search links only | No payments. |
| Image/video generation, audio | NEEDS external service, unverified | Not built. |
| Server-side monitoring, scheduled recurring jobs | NO (not reliable on free) | |
| Multi-agent | 4 agents bound to real tools: general, research, files, tasks | Others (email, calendar, browser, shopping, travel, image, audio, video, data analysis) have no tools yet, so they do not exist. |
