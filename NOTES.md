# Build notes (for future sessions)

Read this first when continuing the project. The assistant that builds this does not remember earlier sessions.

## What this is

A private, local "second brain" chat app for one person (goes by Milorxo). Design plan: "Personal AI Second Brain: Design Plan" (a doc on claude.ai, linked in the conversation). Principles from the plan:

- Memory is plain files the person owns. The AI model is replaceable.
- The raw record is the truth. Everything derived from it must be rebuildable.
- Evidence first: show the person's own words by default, interpret only on request.
- The past is used only when it helps. Readings of the person are held loosely, dated, and correctable.
- Two memory lanes (later): ordinary items save automatically with a visible log and undo; sensitive items and guesses about the person wait for review.

## Decisions already made with the user

- English only. Voice input is required in version 1.
- Local web app on the user's Mac, installable from the browser. Phone access comes later.
- Brain: Claude through the API (prepaid credit, monthly spending cap). Model is a setting in config.json so a local model can be tried later.
- No dependencies on purpose: Node built-ins only, so a beginner has nothing to install but Node.
- Beginner user. Explain steps in plain words. Test before delivering.

## Current state: piece 1 (done and tested)

- `server.js`: local server on 127.0.0.1 only. Routes: GET /api/status, GET /api/conversations, GET /api/conversations/:id, POST /api/chat, static files from public/.
- Each conversation: `memory/conversations/<id>.jsonl` (exact record, first line is meta) and `<id>.md` (readable, regenerated from the jsonl after each message). Ids look like 2026-10-09_2355_ab12.
- The user's message is saved BEFORE the AI is called, so nothing is lost if the AI fails. Consecutive same-role messages are merged when building the API request.
- Security: host check, origin check, JSON-only POST, path traversal guard, text rendered with textContent only (never innerHTML), API key never sent to the browser.
- `public/`: chat page (index.html, style.css, app.js) with past-conversation list and a Mic button using the browser's speech recognition (en-US).
- `prompts/system.md`: behavior prompt, re-read on every request.
- `test.js`: 18 checks against a fake AI (run `node test.js`). Also checked in a real browser (desktop and phone width) with test mode (`MOCK_AI=1`).

## Not verified yet (be honest about this)

- No real call to the Anthropic API has been made: no key was available in the build environment. The request shape (headers x-api-key and anthropic-version 2023-06-01, body model/max_tokens/system/messages) follows the public Messages API and is checked against the fake service only. Confirm with the user's first real message.
- The default model name `claude-sonnet-5-5` should be confirmed against Anthropic's current model list.
- Mic behavior was not tested (no microphone in the build environment). Safari and Chrome differ in speech recognition details.
- The user's Mac model, chip, memory and macOS version are unknown. The link to the user's computer was not connected during this build. An earlier note suggested a Windows laptop, but the user said they use a Mac. Confirm.
- The user has not yet run the app on their own computer.

## Next pieces, in order (from the plan)

1. Search over saved conversations (keyword plus meaning) and bring a few relevant items into the AI's context.
2. Memory items with a visible log and undo: ordinary items automatic, sensitive items and inferences wait for review. Separate sensitive folder.
3. Memory browser, timeline, and a "why was this shown" link on every retrieved item. Show / point / interpret levels.
4. Import of diary, notes and transcripts from a folder.
5. Backups and export. Optional local-model setting.
6. Later versions: threads (ideas, learning, plans), follow-ups, interview mode, weekly review, change tracking, overnight reflection.

## Conventions

- Keep dependencies at zero unless there is a strong reason.
- Plain files first. Anything stored in a database or index must be rebuildable from the files.
- Any new feature that uses the person's history must show its source and date.
- Update this file and the test suite with every piece.
