# Installing with an AI agent

If you have Claude Code, Claude Desktop with terminal access, Cursor, or any
agent that can run commands on your machine, you can hand it these four prompts
instead of following the README yourself.

Paste them **one at a time** and let each finish. They are written to be given to
an agent, not typed into a shell — the agent does the work and tells you when it
needs you.

Two things only you can do, and the prompts stop and ask: approving Google's
consent screen, and clicking Allow the first time a spreadsheet connects.

---

## Prompt 1 — the local app

```
Install the local half of Claude for Sheets on my machine.

1. Check I have Node 18 or newer (`node --version`). If not, stop and tell me
   how to install it for my OS — don't install it yourself.
2. Check I have Claude Code installed and signed in: run `claude --version`.
   If it's missing or not authenticated, stop and tell me what to do. The app
   runs on my own Claude subscription through that CLI, so this is required.
3. Clone https://github.com/toya-co/claude-for-sheets somewhere sensible for my
   OS and tell me the path you chose.
4. From the repo's `daemon` folder, run `npm run certs` once. It needs openssl
   on PATH; if it's missing, tell me where to get it rather than guessing.
   There are no npm dependencies to install — don't run `npm install`.
5. Start it with `npm start` and confirm it's serving by fetching
   https://localhost:8443/ping (expect {"ok":true,...}). It's a self-signed
   certificate for my own machine, so your fetch will need to skip verification
   — that's expected, not a problem to fix.

Then tell me the repo path, and that I should open https://localhost:8443/ in my
browser once and click through the certificate warning. Don't do that part for
me — I need to see the page.
```

---

## Prompt 2 — the add-on

```
Now install the Google Sheets half. Do NOT use clasp — the paste route is
simpler and I'm doing this once.

From the repo you just cloned, print the full contents of `addon/dist/Claude.gs`
to a file I can open, and do the same for `addon/Sidebar.html`. Then give me a
numbered checklist to follow in my browser, with the exact clicks:

  - open my spreadsheet, Extensions > Apps Script
  - replace everything in the default Code.gs with the Claude.gs contents
  - add an HTML file named exactly "Sidebar" (Apps Script adds the .html itself)
    and paste the Sidebar.html contents into it
  - Services > + > add "Google Sheets API"
  - Save, reload the spreadsheet tab, then Claude > Open sidebar, and authorize

Warn me about two things in that flow, because both look alarming and both are
expected:

  - The consent screen will say the add-on can see and edit ALL my spreadsheets.
    Explain briefly why that's unavoidable — Apps Script's narrow scope and
    SpreadsheetApp.openById() are mutually exclusive, and openById is what keeps
    the agent's edits out of my native Ctrl+Z so the undo history works.
  - Step 4 is not optional. Without the Sheets API service, borders and
    conditional formatting can be written but not read back, so their undo has
    nothing to restore.

Wait for me to say it's installed before continuing.
```

---

## Prompt 3 — first run

```
Walk me through the first turn.

Tell me to reload the spreadsheet tab and open the sidebar, and that the status
dot should be green saying "local app connected". If it isn't, help me work out
which half is wrong — check whether the local app is still running on port 8443
first, since that's the usual answer.

Then tell me to type a simple request like "put today's date in A1 and bold it"
and press Send. Explain that the FIRST request from any new spreadsheet is held
until I approve it at https://localhost:8443/ — the approval is deliberately
outside the sidebar so a web page can't grant itself access. I have to click
Allow there before anything happens.

After it works, tell me to try a follow-up that refers back ("now make it
italic") so I can see the conversation carry, and to open History (the clock
icon) to see that the change is individually undoable.
```

---

## Prompt 4 — make it survive a reboot

```
Set the local app to start automatically, and explain the running cost.

Open https://localhost:8443/ , go to "The app itself", and tell me to turn on
"Start at login". Explain what it actually does on my OS — on Windows it's a
single .cmd file in my Startup folder, no admin, no installer, no registry, and
deleting that file is how I turn it off.

Then check the Settings page with me and explain the two that matter:

  - Model. Every turn pays a fixed overhead of roughly 25,000 tokens whatever
    the model, so the model dominates cost far more than message length does.
    Tell me what the current setting is and roughly what a turn costs on it
    versus the cheaper options. There's also a model picker next to the message
    box for switching mid-conversation.
  - Ask before changes. Leave it on the stricter setting until I've seen it work
    a few times.

Finally, tell me where things live: my paired sheets and activity are in
~/.claude-sheets/state.json, and the undo history lives in a hidden sheet inside
each spreadsheet — so it travels with the file and restores even with the local
app closed.
```

---

## If something goes wrong

```
The Claude for Sheets sidebar isn't working. Diagnose it in this order and tell
me which layer is broken rather than guessing:

1. Is the local app running? Fetch https://localhost:8443/ping (skip certificate
   verification). No answer means it isn't started.
2. Does the sidebar say the local app is an OLDER build? Then I pulled the repo
   without restarting it — the running copy is the previous version. Quit it from
   the dashboard and start it again.
3. Is Claude Code itself working? Run:
   claude -p "reply with the word ok" --output-format json
   If that fails or hangs, the problem is my Claude credential, not this app.
4. Is the spreadsheet approved? Check https://localhost:8443/ for a pending
   approval waiting on me.

Report which of those four is the failure. Don't change any files unless I ask.
```

---

## What the agent should not do

Worth saying explicitly if your agent is the enthusiastic kind:

- **Don't run `npm install`.** There are no dependencies, on either half. If it
  creates a `node_modules`, something has gone wrong.
- **Don't edit the source to "fix" the certificate warning.** It's self-signed
  for localhost on purpose; clicking through it once per browser is the design.
- **Don't put an API key anywhere** unless you specifically want BYOK. The
  default path uses your existing Claude subscription through Claude Code, and
  the credential never leaves your machine.
- **Don't approve the spreadsheet pairing on your behalf** — it can't, and that
  is the point. Approval happens in the dashboard, out of the browser's reach.
