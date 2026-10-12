# Karen eval set

Builds a test set for Karen, the after-hours Retell agent, from real calls.

## Stage 1: inventory (read-only)

```bash
cd backend && npm ci && cd ..
node tools/karen-eval/inventory.js            # last 60 days, labelled
node tools/karen-eval/inventory.js --no-label # counts and ids only, no AI
```

Writes `tools/karen-eval/out/` (gitignored): `inventory-<date>.{json,csv}` and
`summary-<date>.md`. Each call row has exactly these fields: `call_id`, `office`,
`did_office`, `start`, `duration_s`, `disconnection_reason`, `label`, and `label_status`.
The tool never writes transcript text to disk or prints it.

- **Calls:** `POST /v3/list-calls` returns the call list. `GET /v2/get-call/{id}` returns
  each transcript, which the tool holds in memory only.
- **Office:** `office` comes from `backend/config/officeAgents.js` (`getOfficeForCall`,
  which maps the agent to an office). `did_office` is the called number looked up in
  `MANGO_LINE_OFFICE`, and reads `unmapped` when the number isn't in that map.
- **Labels:** only Azure OpenAI sees a transcript, through `oai-carein-prod`, which is
  covered by the Microsoft BAA. The labels are a closed set:
  new-patient, existing-appointment, emergency/red-flag, billing/insurance,
  wrong-number/spam, transfer-request, other. If the model returns anything outside
  the set, the tool records `label_failed` and does not convert it to `other`.
- **Secrets:** the tool reads the Retell key from Key Vault `kv-carein-core` in-process.
  It calls Azure OpenAI with an Entra token from your `az login`, so it uses no key.
  It never reads `.env`.
- **What it leaves alone:** Open Dental, the call store, ingestion, and Azure Speech.

## Stage 2: scenarios (not built yet)

After Beau picks the calls, the tool de-identifies the chosen transcripts through
Azure OpenAI into scenario files with these fields: caller goal, key turns, expected
agent behavior, and red flags. Beau reviews them before anything is committed.
