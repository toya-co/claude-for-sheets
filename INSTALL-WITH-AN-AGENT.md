# Installing with an AI agent

Hand Claude, Cursor, or any agent that can run commands these prompts in order
to get it running. One at a time, letting each finish.

Two things only you can do, and the prompts stop and ask: approving Google's
consent screen, and clicking Allow the first time a spreadsheet connects.

---

## Prompt 1 — the local app

```
Install and start the local half of Claude for Sheets. Do the work yourself
rather than handing me instructions, and report only what you did and anything
you could not.

1. Node 18+. If it is missing or too old, install it for me using whatever my
   platform provides — winget or the official installer on Windows, Homebrew on
   macOS, the distro package manager or nvm on Linux. Say which you used.
2. Claude Code. If `claude --version` fails, install it with
   `npm install -g @anthropic-ai/claude-code`. Then start the sign-in for me:
   run `claude` in a terminal, which opens the browser auth page, or open
   https://claude.ai/login and tell me to finish signing in there. I have to
   complete the login myself, but get me to the page — do not just tell me to
   install it. The app runs on my own Claude subscription through this CLI, so
   it is required. Wait until `claude --version` works before continuing.
3. Clone https://github.com/toya-co/claude-for-sheets somewhere sensible for my
   OS.
4. From daemon/: run `npm run certs`. It needs openssl on PATH — on Windows it
   ships with Git; install it if it is genuinely absent. Do NOT run
   `npm install`: there are no dependencies, and a node_modules means something
   went wrong.
5. Start the app and leave it running in the background. Confirm it is serving
   by fetching https://localhost:8443/ping with certificate verification
   disabled, expecting {"ok":true}. Retry for up to 30 seconds before failing.

Then report the repo path, the daemon status, the Claude Code version, and the
exact command to restart it later. Tell me to open https://localhost:8443/ once
and click through the certificate warning — that one needs my browser.
```

---

## Prompt 2 — the add-on

```
Install the Google Sheets half. Pick the route by what you can actually drive.

IF you can control a browser (Claude in Chrome, computer use, Playwright), do
the whole thing yourself: open my spreadsheet, Extensions > Apps Script, replace
everything in Code.gs with addon/dist/Claude.gs, add an HTML file named exactly
"Sidebar" containing addon/Sidebar.html, add Google Sheets API under Services,
and save. Stop at Google's consent screen — I have to click that.

IF you are terminal-only, do not narrate a tutorial. Make my part mechanical:
copy each file's contents to my clipboard one at a time, or write them to two
files on my Desktop and give me the paths. Then print the four clicks as a short
numbered list and wait for me to say done.

Either way, do not skip adding the Google Sheets API service. Without it,
borders and conditional formatting can be written but not read back, so their
undo has nothing to restore.

The consent screen will say the add-on can see and edit ALL my spreadsheets.
That is expected: Apps Script's narrow scope and SpreadsheetApp.openById() are
mutually exclusive, and openById is what keeps the agent's edits out of my
native Ctrl+Z so the undo history works.
```

---

## Prompt 3 — verify it end to end

```
Verify the install rather than leaving me to guess whether it worked.

- Fetch https://localhost:8443/ping and confirm the app answers.
- Read the dashboard's own state: GET / to get the token out of the page, then
  GET /status with it as an X-Dashboard-Token header. Report the Claude Code
  version, how many spreadsheets are paired, and whether anything is pending.
- Tell me to open the sidebar and send: put today's date in A1 and bold it.
- The first turn from a new spreadsheet blocks on approval. Poll /status, and
  the moment a pending entry appears, tell me — I have to click Allow at
  https://localhost:8443/ myself, because that approval is deliberately outside
  the sidebar's reach.
- Then keep polling until a new activity entry lands, and report whether it
  succeeded, how long it took, and what it cost.

If it fails, diagnose before reporting: is the app running, is Claude Code
working, was the spreadsheet approved.
```

---

## Prompt 4 — persistence and cost

```
Turn on start-at-login and tell me what this costs to run.

- Enable autostart through the dashboard API rather than telling me to click a
  toggle, then verify it by reading /status and confirming it shows registered
  and not stale. On Windows it is a single .cmd in my Startup folder — no admin,
  no installer, no registry — and deleting that file is how I turn it off.
- Read the current model from /status. Tell me roughly what a turn costs on it
  and on the cheaper options. Every turn pays about 25,000 tokens of fixed
  overhead whatever the model, so the model matters far more than message
  length. There is a model picker beside the message box for switching
  mid-conversation.
- Leave "ask before changes" on the stricter setting.
- Tell me where state lives: ~/.claude-sheets/state.json for pairings and
  activity, and a hidden sheet inside each spreadsheet for the undo history — so
  it travels with the file and restores even with the local app closed.
```

---

## If something goes wrong

```
The Claude for Sheets sidebar is not working. Diagnose in this order and fix
what you can yourself. Report which layer was broken rather than guessing.

1. If the sidebar says PERMISSION_DENIED reading from storage, that is usually a
   transient Google error. Wait 60 seconds and have me retry before changing
   anything at all.
2. Is the local app running? Fetch https://localhost:8443/ping with certificate
   verification disabled. If not, restart it.
3. Does the sidebar say the local app is an OLDER build? The repo was pulled
   without restarting. Quit it with POST /quit and the dashboard token, then
   start it again yourself.
4. Is Claude Code working? Run:
   claude -p "reply with the word ok" --output-format json
   If that fails or hangs, the problem is my Claude credential, not this app.
5. Is a spreadsheet waiting for approval? Check /status for a pending entry.

Do not edit any source files unless I ask.
```

---

## What the agent should not do

- **Don't run `npm install`.** There are no dependencies, on either half. A
  `node_modules` means something has gone wrong.
- **Don't edit the source to "fix" the certificate warning.** It's self-signed
  for localhost on purpose; clicking through it once per browser is the design.
- **Don't put an API key anywhere** unless you specifically want BYOK. The
  default path uses your existing Claude subscription through Claude Code, and
  the credential never leaves your machine.
- **Don't approve the spreadsheet pairing on my behalf** — it can't, and that is
  the point. Approval happens in the dashboard, out of the browser's reach.
