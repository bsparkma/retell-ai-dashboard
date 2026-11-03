# Fix: the shard runner no longer loses a red run's output

Branch `fix/shard-runner-output` → `develop`. **Not merged** (develop merge hold for the staging probe).
Changes one file: `backend/scripts/shard-runner.mjs`. No `.github`, test-suite or Open Dental changes.

## The problem

When a test failed, `shard-runner.mjs` exited with `process.exit(1)` as soon as the last shard finished.

- In CI, stdout is a pipe. Writing a shard's large output puts about one pipe buffer (64 KiB) through immediately and queues the rest.
- The queue only drains when Node's event loop runs. `spawnSync` blocks the event loop for every later shard.
- `process.exit` then threw the queued output away.

So a red log kept about 64 KiB of shard 1 and lost everything after it: the other shards, the summary, and the `not ok` line naming the failure.

- **staging-cd run #276:** about 68 KB of shard 1 survived (64 KiB plus the shard header), then nothing until the `FAILED` line. The failing test's name was lost.
- **PR #207:** a truncated log sent the fix hunting in an innocent file.

A green run never called `process.exit`, which is why green logs were always complete.

## The fix

1. **Flush each shard before starting the next.** The runner waits for each shard's stdout/stderr write to finish before the next `spawnSync`.
2. **Exit without discarding output.** A failure sets `process.exitCode = 1` instead of calling `process.exit(1)`, so Node finishes writing everything before it exits. Exit codes are unchanged: 1 on any failure, 0 when green, 2 for a bad `TEST_SHARDS`.
3. **Keep each shard's output in a file.** Each shard's raw stdout + stderr is also written to `SHARD_OUTPUT_DIR`, which defaults to `<tmpdir>/carein-shard-runner/shard-N-of-M.log`.
   - A red run lists those files under the `FAILED` line.
   - Writing them is best effort and can never fail the run.
   - Reading them in CI would need a workflow change, which was out of scope here.

A green run prints exactly the same bytes as before.

## Proof: a deliberately failing dummy test

The harness ran in the scratchpad and was never committed. It used Docker `node:22.23.4-bookworm`, CI's Node version, with stdout piped as in CI.

The dummy tree had 16 test files, each with 120 passing tests with long names, about 500 KB of TAP in total. One extra test, `DUMMY-RED-MARKER`, throws on purpose; it was placed in a file that lands in shard 4.

| Runner | Exit | Log bytes | Shards in log | Summary | `not ok … DUMMY-RED-MARKER` in log |
|---|---|---|---|---|---|
| old (`origin/develop`) | 1 | 124,459 | 1 of 4 | missing | **missing** (the #276 failure reproduced) |
| new | 1 | 499,037 | 4 of 4 | present | **present** |

The new runner's red log ends with:

```
  shard 4/4: exit 1 · 481 tests · 480 pass · 1 fail · 0 skipped
  TOTAL: 1921 tests · 1920 pass · 1 fail · 0 skipped

[shard-runner] FAILED: shard 4/4 exited 1; 1 failing test(s)
[shard-runner] full per-shard output kept in:
  shard 1/4: /tmp/carein-shard-runner/shard-1-of-4.log
  ...
```

Other checks:

- **Green run, same tree without the failing test:** both runners exit 0. Stdout is byte-identical once per-test timings and the elapsed seconds are masked (497,971 bytes), and stderr is identical.
- **Output cut off early** (`| head -c 100`): the new runner exits 1 at once. It does not hang.
- **Syntax:** `node --check` is clean.

The dummy tests were never in the repo, so there was nothing to remove.

## Review

One fresh-context review round found no blockers and no should-fix items. The reviewer checked:

- **No hangs:** a slow reader, a file, and a pipe closed early (tested with 3 × 5 MB writes).
- **Exit codes and draining:** the `exitCode` and top-level-await semantics.
- **Green output:** the bytes are identical, including the shard header (`console.log(x)` ≡ write of `x + "\n"`).
- **Test discovery:** `node --test` cannot pick up `scripts/*.mjs` as a test file.

Nits:

- **Applied:** the closed-pipe comment overstated the protection. A closed pipe still ends the run with EPIPE (exit 1), as a plain write always did.
- **Applied:** the comment now says the per-shard files vanish with a CI runner unless a workflow step uploads them.
- **Not applied:** the default directory is a predictable shared `/tmp` path, which matters only on a multi-user machine. Concurrent local runs also overwrite each other's files.
- **Not applied:** a shard bigger than the 256 MB `maxBuffer` is an existing limit, not something this change introduced.

## CI

PR #306 run 41529882227 passed on the first attempt. It ran on `refs/pull/306/merge`, checked out as `4cb67b1 Merge 42a3c3e… into 2f228b7…`.

The new runner's green summary:

```
  shard 1/4: exit 0 · 1120 tests · 1120 pass · 0 fail · 0 skipped
  shard 2/4: exit 0 · 1349 tests · 1349 pass · 0 fail · 0 skipped
  shard 3/4: exit 0 · 1136 tests · 1133 pass · 0 fail · 3 skipped
  shard 4/4: exit 0 · 999 tests · 999 pass · 0 fail · 0 skipped
  TOTAL: 4604 tests · 4601 pass · 0 fail · 3 skipped
[shard-runner] 4 shards, all green
```

**Not merged.** It is waiting for the develop merge hold to be lifted.
