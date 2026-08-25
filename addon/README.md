# addon — the Apps Script half

The sidebar's host, and everything that touches your spreadsheet. It is a
**container-bound** script: it lives inside one spreadsheet rather than in your
account, so installing it is per-sheet, and nothing is published to the Google
Workspace Marketplace.

It talks only to the local app on your own machine. It holds no credential of
any kind and reaches no network destination except `https://localhost:8443`.

| File | Does |
|---|---|
| `Code.gs` | Menu, sidebar host, the `google.script.run` entry points |
| `Sheet.gs` | Reading — context, ranges, the hash the mid-turn guard compares |
| `Ops.gs` | Every write, and the inverse recorded for each one |
| `History.gs` | Snapshots and the hidden `__claude_history__` sheet |
| `Sidebar.html` | The whole UI — markup, style, and the turn loop |
| `appsscript.json` | The manifest, including the Sheets advanced service |
| `dist/Claude.gs` | The four `.gs` files concatenated, for the paste install |

---

## Install it — two files

**Start here.** No clasp, no Node, nothing to install, five minutes. Nothing
about the add-on depends on how the code got into the project.

1. **Extensions ▸ Apps Script**
2. Paste [`dist/Claude.gs`](dist/Claude.gs) over the default `Code.gs`
3. Add an HTML file named exactly **`Sidebar`** — the `.html` is implied — and
   paste [`Sidebar.html`](Sidebar.html) into it
4. **Services ▸ +** and add **Google Sheets API**
5. Save, reload the spreadsheet tab, **Claude ▸ Open sidebar**, authorize

Step 4 is what the manifest does for you on the clasp route, and it is not
optional: borders and conditional formatting can be *written* through Apps
Script but not *read back*, so without the advanced service their undo entries
have nothing to restore.

`dist/Claude.gs` is generated — `npm run bundle` from the repo root — because
Apps Script shares one global scope across every file in a project, so four
files and one file behave identically and one is less to paste.

---

## Install it — with clasp

Worth it only if you intend to track this repo: `git pull && clasp push --force`
beats re-pasting two files every update. For a one-time install it is strictly
more setup for the same result.

Five steps, once per spreadsheet. Google's CLI is
[`@google/clasp`](https://github.com/google/clasp); this was written against
**3.4.0**.

**1. Get clasp and sign in.**

```bash
npm install -g @google/clasp && clasp login
```

`clasp login` opens a browser and asks for access to your Apps Script projects.
Nothing about this repo is involved — it is between you and Google.

**2. Turn on the Apps Script API for your account.**

Open **https://script.google.com/home/usersettings** and switch **Google Apps
Script API** to **On**.

This is the step everyone misses. It is an account-level setting, off by
default, and without it every `clasp push` fails with an error about the Apps
Script API not being enabled — which reads like a permissions problem with the
spreadsheet rather than a switch you have never seen.

**3. Create the bound project and copy its ID.**

In the spreadsheet you want Claude in: **Extensions ▸ Apps Script**. Opening
that editor is what *creates* the bound project — there is nothing to make by
hand. Then **⚙ Project Settings ▸ Script ID**, and copy it.

**4. Point the repo at it.**

```bash
cp addon/.clasp.json.example addon/.clasp.json
```

Paste your Script ID into `scriptId`. `.clasp.json` is deliberately not in the
repo: it names *your* spreadsheet's project, and a shared one would have every
clone pushing at whoever committed it first.

**5. Push.**

```bash
cd addon && clasp push
```

The first push asks whether to overwrite the remote manifest. **Say yes.**
`appsscript.json` is how the Sheets advanced service gets enabled, which is why
this route needs no toggle in the editor — and declining leaves the manifest
untouched, so borders and conditional formatting install with an undo that has
nothing to restore. `clasp push --force` answers yes without asking, which is
what you want for every later push.

Measured, so it is worth knowing: a push whose stdin is not a terminal — a
script, a CI step — takes the *default*, which is to skip the manifest. Use
`--force` anywhere that is not a person at a prompt.

Then reload the spreadsheet tab, **Claude ▸ Open sidebar**, and authorize. The
consent screen asks for access to your spreadsheets and is worth reading — the
root [`README`](../README.md) explains why the broad scope is unavoidable and
what it is spent on.

---

## Updating

`git pull`, then `clasp push --force`. Paste installs re-paste both files.

Two things that will not update themselves:

**The local app is the other half.** A sidebar newer than the daemon calls
routes the daemon does not have. It says so now — "running an older build" —
rather than claiming the app is unreachable, but the fix is yours: quit it from
the dashboard and start it again. `git pull` alone leaves the old process
running, and start-at-login means there usually *is* one.

**The sidebar is cached per session.** Close and reopen it from the Claude menu
after a push. Reloading the spreadsheet tab is usually but not always enough.

---

## A second spreadsheet

The add-on is bound to one file, so a second sheet needs its own install. Two
ways, and the difference is whether you want the repo to keep pushing to both:

- **Install again.** Paste the two files, or repeat the clasp steps with the new
  sheet's Script ID. Swapping that ID in `.clasp.json` retargets the repo, so
  keep a note of which is which — clasp gives no indication of which spreadsheet
  it is pushing to.
- **Copy a spreadsheet that already has it.** The bound script travels with the
  copy — verified 2026-08-25. The copy asks for authorization once, then works.
  Nothing to install, and the easiest route by some distance.

Pairing is separate and per-spreadsheet either way: the first turn in a new
sheet waits for you to approve it in the local app, however the code got there.

---

## `.claspignore` earns its place

`clasp push` uploads everything under `rootDir` by default, and this folder
contains a Node test suite. Apps Script would either fail to load it or pull its
helpers — including a fake `SpreadsheetApp` — into the same global namespace the
real files share. The add-on breaks on load, with no obvious cause.

[`.claspignore`](.claspignore) excludes `test/`, `bundle.js`, and `dist/`. It
ships with the repo, so this is a reason not to delete it rather than something
to set up. `clasp status` lists exactly what a push would send:

```bash
cd addon && clasp status
```

Seven files: the five sources, the manifest, and `Diagnostic.html`. Anything
else in that list means the ignore file is not being read.

---

## Tests

```bash
npm test          # from the repo root
```

The add-on half runs against a fake `SpreadsheetApp` in `test/`, so no browser
and no Google account are involved. `Sidebar.html` is checked statically — it
needs a browser to run, but its worst failure is calling a helper that no longer
exists, and that is catchable without one.
