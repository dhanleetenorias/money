# Money sync — Apps Script deploy

`Code.gs` in this folder is a **reference copy**. Nothing here deploys itself.
Paste it into the Apps Script project bound to the spreadsheet, by hand, using
the steps below.

**Target sheet:** `money_tracker_today`
`1R1ySUNnxUsY1cEr93_dBnu-bFj9KxYnBys4Kj0PA9wE`

The script writes to a tab named **`App Log`**, which it creates on first run.
It never reads or writes the existing `Expense Log` tab — that tab has live
formulas in G/H/I and an older category dropdown in K, and appending to it
would corrupt both.

---

## 1. Open the script editor

1. Open the spreadsheet.
2. **Extensions → Apps Script**. A project opens, bound to this sheet
   (that binding is what lets `SpreadsheetApp.getActiveSpreadsheet()` work —
   do **not** create a standalone script instead).
3. Delete the stub `myFunction` in `Code.gs`.
4. Paste the entire contents of `apps-script/Code.gs` from this repo.
5. Save (⌘S).

## 2. Set the token

The token is a shared secret. Pick a long random one — e.g. in Terminal:

```sh
openssl rand -base64 24
```

Then in the Apps Script editor:

1. **Project Settings** (gear icon, left sidebar).
2. Scroll to **Script Properties → Add script property**.
3. Property: `TOKEN` Value: _the random string you just generated_
4. **Save script properties**.

Do not put the token in `Code.gs`, in this file, or in any repo file. If it
ever leaks, generate a new one, update this property, and re-enter it in the
app's Settings — no redeploy needed, the property is read at request time.

## 3. Deploy as a Web App

1. **Deploy → New deployment**.
2. Click the gear next to "Select type" → **Web app**.
3. Description: `money sync v1`
4. **Execute as: Me** (your account owns the sheet, so the script can write it).
5. **Who has access: Anyone with the link** — this is _required_. "Anyone with
   a Google account" makes Apps Script serve an HTML login page instead of
   JSON, and the app will report `bad response (check deployment access)`.
   Access control is the `TOKEN`, not Google's ACL.
6. **Deploy**, then authorise when prompted. Google will warn that the app is
   unverified — **Advanced → Go to \<project\> (unsafe)** → **Allow**. It is
   your own script.
7. Copy the **Web app URL**. It ends in `/exec`.

## 4. Point the app at it

In Money → **Settings → Sync**:

- **URL**: the `/exec` URL from step 3
- **Token**: the value you put in the `TOKEN` script property

Save. The app validates the URL shape (https, ends in `/exec`, no query
string) and immediately tries to drain the outbox. Watch the sync pill.

---

## Re-deploying after an edit

**Editing `Code.gs` and saving does NOT change what the `/exec` URL serves.**
A Web App serves a published _version_. You must publish a new one:

1. **Deploy → Manage deployments**.
2. Click the pencil (Edit) on the existing deployment.
3. **Version → New version**. Add a short description.
4. **Deploy**.

The `/exec` URL stays the same, so nothing needs re-entering in the app. If you
instead use "New deployment" you get a _different_ URL and the phone keeps
talking to the old code — the usual cause of "my fix didn't do anything".

## Testing with curl

Replace `PASTE_EXEC_URL_HERE` and `PASTE_TOKEN_HERE`. Note `-L` (Apps Script
302s to `script.googleusercontent.com`) and the `text/plain` content type —
that is deliberate, see the CORS note in `js/sync.js`.

Connection check (zero ops, writes nothing):

```sh
curl -sL -X POST 'PASTE_EXEC_URL_HERE' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"v":1,"token":"PASTE_TOKEN_HERE","ops":[]}'
```

Expected: `{"ok":true,"accepted":[],"duplicates":[],"rejected":[],"rows":0}`

Write one row (run it **twice** — the second run must report the id as a
duplicate and add no row, which is the idempotency guarantee):

```sh
curl -sL -X POST 'PASTE_EXEC_URL_HERE' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"v":1,"token":"PASTE_TOKEN_HERE","ops":[{
        "id":"curl-test-1","op":"append","ts":1753600000000,
        "monthKey":"2026-07","kind":"expense","categoryId":"coffee",
        "category":"Coffee","cent":-18000,"note":"curl test"}]}'
```

First run: `"accepted":["curl-test-1"],"duplicates":[],"rows":1`
Second run: `"accepted":["curl-test-1"],"duplicates":["curl-test-1"],"rows":0`

Delete the test row from `App Log` by hand when you're done.

## Troubleshooting

| Symptom                             | Cause                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `{"ok":false,"err":"auth"}`         | Token mismatch. Re-check the `TOKEN` script property (trailing space?) and the value in Settings. |
| `{"ok":false,"err":"unconfigured"}` | The `TOKEN` script property doesn't exist. Step 2.                                                |
| HTML instead of JSON                | Deployment access isn't "Anyone with the link". Step 3.5.                                         |
| Changes have no effect              | You saved but didn't publish a new version. See "Re-deploying".                                   |
| `{"ok":false,"err":"busy"}`         | Another execution held the lock >25s. Harmless — the client backs off and retries.                |
| `{"ok":false,"err":"toolarge"}`     | >200 ops in one request. The client caps at 50, so this means something else is posting.          |

## App Log columns

| Col | Field      | Notes                                                      |
| --- | ---------- | ---------------------------------------------------------- |
| A   | Date       | `yyyy-MM-dd`, Asia/Manila                                  |
| B   | Time       | `HH:mm`, Asia/Manila                                       |
| C   | Type       | `expense` / `income` / `sweep` / `void`                    |
| D   | Category   | display name, e.g. `Food`                                  |
| E   | Amount     | **signed pesos** — expenses negative, so `SUM(E:E)` is net |
| F   | Note       | free text; a void is prefixed `VOID — `                    |
| G   | Month      | month key, `2026-07`                                       |
| H   | CategoryId | stable id, survives a rename                               |
| I   | TxnId      | idempotency key — read back as a single column             |
| J   | SyncedAt   | server-side write time, Manila                             |

Append-only. A void never edits or deletes the original row; it appends a
compensating row with the opposite sign, so the sheet stays an audit trail.
Never add a formula to a whole column here — the script writes ranges directly
and a spilled formula would be overwritten.
