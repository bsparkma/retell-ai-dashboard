# cursor-audit/scripts

Standalone verification scripts. These are **read-only / safe-to-run** test harnesses that exist to confirm or refute the **Likely** findings in `../11-evidence-and-confidence.md`.

## Available scripts

| Script                          | What it tests                                                         | Audit ref |
|---------------------------------|-----------------------------------------------------------------------|-----------|
| `test-duplicate-webhook.js`     | Sends the same Retell webhook twice; counts CommLog inserts           | LK-01     |
| `test-phone-normalization.js`   | Searches Open Dental for a patient using multiple phone formats       | LK-02     |

## How to run

These are vanilla Node scripts. Run them from the repo root:

```bash
# Make sure backend deps are installed
cd backend && npm install && cd ..

# Run a script (it will read backend/.env)
node cursor-audit/scripts/test-duplicate-webhook.js
node cursor-audit/scripts/test-phone-normalization.js
```

Each script prints a clear PASS / FAIL banner at the end. **None of them write data**; the duplicate-webhook script targets a configurable backend URL (default `http://localhost:5000`) and any inserts it triggers go through the normal sync path — so run it against a sandbox or the office can review and delete the resulting CommLogs afterward.

## Output

Both scripts write a JSON result to `cursor-audit/scripts/results/<script-name>-<timestamp>.json` so the findings can be archived alongside the audit.
