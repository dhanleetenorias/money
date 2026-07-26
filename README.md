# Money

A personal fixed-percentage money tracker. Enter your income once at the start of
the month; it splits into envelopes and you spend each one down.

**Live:** https://dhanleetenorias.github.io/money/ — add it to your iPhone home
screen (Share → Add to Home Screen) so it installs as a real app.

## The model

Income arrives monthly and splits by fixed percentages:

| Category    | %   | At ₱25,000 |
| ----------- | --- | ---------- |
| Save/Invest | 45% | ₱11,250    |
| Food        | 30% | ₱7,500     |
| Gas         | 9%  | ₱2,250     |
| Coffee      | 8%  | ₱2,000     |
| Buffer      | 5%  | ₱1,250     |
| Misc        | 3%  | ₱750       |

Save/Invest is a **vault** — it's excluded from "safe to spend today", because
money you've already saved isn't money you can spend. At month end every leftover
peso in the spending envelopes is **swept into the vault**, so the real savings
rate lands above 45%.

Percentages are editable in Settings behind a "must total 100%" guard.

## How it's built

Zero-build: plain HTML, CSS, and ES modules. No npm, no bundler, no framework, no
backend. That's deliberate — the build step is the part that rots, and this needs
to still work in five years.

```
js/money.js    integer-centavo math; splitByPct uses largest-remainder so
               allocations always sum to income exactly
js/budget.js   pure derived state — reads month.alloc snapshots, never Settings
js/store.js    localStorage: settings + months, versioned with a migrate() seam
js/idb.js      IndexedDB: transactions + sync outbox
js/sync.js     offline-first push to Google Sheets
js/render.js   screens as template strings + targeted DOM patchers
js/main.js     boot, routing, delegated events
```

### Two invariants worth knowing

**Money is integer centavos everywhere.** Floats are only allowed at display time.

**`budget.js` never reads Settings.** Each month snapshots its own allocation when
income is entered, so changing a percentage today cannot rewrite what last March
looked like.

## Data

Transactions live on-device in IndexedDB and push to a Google Sheet (`App Log`
tab) through a Google Apps Script Web App — see `apps-script/README.md`. The
sheet is the durable backstop: iOS can evict browser storage, and a lost phone
shouldn't mean lost history. There's also a one-tap JSON export in Settings.

No secrets live in this repo. The sync token is typed once on the device and
stored locally; it is excluded from exports.

## Development

```sh
python3 -m http.server 8080     # then open http://localhost:8080/
node --test test/               # pure-module tests
```

The service worker deliberately skips `localhost`, so you never chase a stale-JS
ghost while developing. Bump `V` in `sw.js` on every deploy — that string is the
cache-bust. Deploy is `git push`.
