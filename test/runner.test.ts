/**
 * Runner behavior, driven end-to-end through the real SDK against the fake
 * server: dry-run stays silent, live runs call once per check, unverified
 * lines are refused, the disclosure preamble is always on the wire, and one
 * failing call never takes down the rest of the run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeCalle, type FakeCalle } from "../fake/calle-server.js";
import { createSdkPort } from "../src/calle.js";
import { openStore, type BaselineStore } from "../src/baseline.js";
import { runChecks, DISCLOSURE_PREAMBLE } from "../src/runner.js";
import type { Config } from "../src/config.js";

function config(): Config {
  return {
    lines: [
      { id: "main-office", phone: "+15550100", region: "US", locale: "en-US", ownership: { method: "greeting_code", code: "LC-1" } },
      { id: "second-line", phone: "+15550101", ownership: { method: "greeting_code", code: "LC-2" } },
    ],
    checks: [
      {
        id: "hours",
        line: "main-office",
        task: "Ask for Saturday hours.",
        resultSchema: { type: "object", properties: { answered: { type: "boolean" } }, required: ["answered"], additionalProperties: false },
        assert: [{ path: "answered", equals: true }],
      },
      {
        id: "greeting",
        line: "second-line",
        task: "Listen to the greeting and report the business name.",
        resultSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
        assert: [{ path: "name", contains: "acme" }],
      },
    ],
    baselineDir: "unused",
    historyLimit: 200,
  };
}

function verify(store: BaselineStore, lineId: string, phone: string): void {
  store.recordVerification({ lineId, phone, method: "greeting_code", verifiedAt: "2026-08-02T09:00:00Z", callId: "call_v" });
}

function freshStore(): BaselineStore {
  return openStore(join(mkdtempSync(join(tmpdir(), "linecanary-runner-")), "baselines"));
}

const PASSING_SCENARIOS = [
  { phone: "+15550100", structuredResult: { answered: true }, turns: [{ speaker: "user" as const, text: "Front desk.", offsetSeconds: 4 }] },
  { phone: "+15550101", structuredResult: { name: "ACME Plumbing" }, turns: [{ speaker: "user" as const, text: "ACME.", offsetSeconds: 3 }] },
];

async function withLiveRun(
  scenarios: Parameters<typeof startFakeCalle>[0],
  run: (fake: FakeCalle, store: BaselineStore) => Promise<void>,
): Promise<void> {
  const fake = await startFakeCalle(scenarios);
  try {
    const store = freshStore();
    verify(store, "main-office", "+15550100");
    verify(store, "second-line", "+15550101");
    await run(fake, store);
  } finally {
    await fake.close();
  }
}

test("dry-run plans every check, calls nothing and writes nothing", async () => {
  const fake = await startFakeCalle(PASSING_SCENARIOS);
  try {
    const store = freshStore();
    const report = await runChecks(config(), null, store, { live: false, timeoutMs: 5_000, intervalMs: 10 });
    assert.equal(report.live, false);
    assert.equal(report.ok, true);
    assert.equal(report.runs.length, 2);
    assert.ok(report.runs.every((run) => run.skipped === "dry-run" && run.outcome === null));
    assert.equal(report.runs[0].planned.phone, "+15550100");
    assert.equal(fake.created.length, 0);
    assert.deepEqual(store.history("hours"), []);
  } finally {
    await fake.close();
  }
});

test("live run calls once per check, appends outcomes and reports ok on first run", async () => {
  await withLiveRun(PASSING_SCENARIOS, async (fake, store) => {
    const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
    const report = await runChecks(config(), port, store, { live: true, timeoutMs: 5_000, intervalMs: 10 });
    assert.equal(report.ok, true);
    assert.equal(fake.created.length, 2);
    assert.equal(store.history("hours").length, 1);
    assert.equal(store.history("greeting").length, 1);
    assert.deepEqual(report.regressions, []);
    const task = fake.created[0].task;
    assert.ok(task.startsWith(DISCLOSURE_PREAMBLE), "disclosure preamble must lead the task");
    assert.ok(task.includes("Ask for Saturday hours."));
    assert.ok(fake.created[0].idempotencyKey?.startsWith("linecanary:hours:+15550100:"), "key must be scoped by check AND phone");
  });
});

test("a regression on the second run is detected and fails the report", async () => {
  await withLiveRun(PASSING_SCENARIOS, async (fake, store) => {
    const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
    await runChecks(config(), port, store, { live: true, timeoutMs: 5_000, intervalMs: 10 });
    fake.setScenario({ phone: "+15550100", structuredResult: { answered: false }, turns: [] });
    const report = await runChecks(config(), port, store, { live: true, timeoutMs: 5_000, intervalMs: 10 });
    assert.equal(report.ok, false);
    const kinds = report.regressions.map((entry) => entry.kind).sort();
    assert.deepEqual(kinds, ["assertion_regressed", "new_failure"]);
    assert.equal(store.history("hours").length, 2);
  });
});

test("unverified lines are skipped without any call", async () => {
  const fake = await startFakeCalle(PASSING_SCENARIOS);
  try {
    const store = freshStore();
    verify(store, "main-office", "+15550100"); // second-line stays unverified
    const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
    const report = await runChecks(config(), port, store, { live: true, timeoutMs: 5_000, intervalMs: 10 });
    assert.equal(fake.created.length, 1);
    const skipped = report.runs.find((run) => run.planned.checkId === "greeting");
    assert.equal(skipped?.skipped, "unverified-line");
    assert.equal(skipped?.outcome, null);
    // Fail closed: a live run that skipped a check as unverified is not
    // monitoring it, so the report must not be ok.
    assert.equal(report.ok, false);
  } finally {
    await fake.close();
  }
});

test("a verification recorded for a different phone does not cover the line", async () => {
  const fake = await startFakeCalle(PASSING_SCENARIOS);
  try {
    const store = freshStore();
    verify(store, "main-office", "+15559999"); // stale: config phone changed since
    verify(store, "second-line", "+15550101");
    const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
    const report = await runChecks(config(), port, store, { live: true, timeoutMs: 5_000, intervalMs: 10 });
    const skipped = report.runs.find((run) => run.planned.checkId === "hours");
    assert.equal(skipped?.skipped, "unverified-line");
    assert.equal(fake.created.length, 1);
    // The stale verification skip fails the report, like any unverified skip.
    assert.equal(report.ok, false);
  } finally {
    await fake.close();
  }
});

test("an API error on one check is captured and the rest still run", async () => {
  await withLiveRun(
    [
      { phone: "+15550100", apiError: { status: 500, code: "internal_error" } },
      PASSING_SCENARIOS[1],
    ],
    async (fake, store) => {
      const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
      const report = await runChecks(config(), port, store, { live: true, timeoutMs: 5_000, intervalMs: 10 });
      assert.equal(report.ok, false);
      const errored = report.runs.find((run) => run.planned.checkId === "hours");
      assert.match(errored?.error ?? "", /internal_error/);
      assert.equal(errored?.outcome, null);
      const succeeded = report.runs.find((run) => run.planned.checkId === "greeting");
      assert.equal(succeeded?.outcome?.status, "pass");
      assert.equal(store.history("greeting").length, 1);
      assert.deepEqual(store.history("hours"), []);
    },
  );
});

test("--only filters checks and marks the rest filtered", async () => {
  await withLiveRun(PASSING_SCENARIOS, async (fake, store) => {
    const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
    const report = await runChecks(config(), port, store, { live: true, only: ["greeting"], timeoutMs: 5_000, intervalMs: 10 });
    assert.equal(fake.created.length, 1);
    assert.equal(report.runs.find((run) => run.planned.checkId === "hours")?.skipped, "filtered");
    assert.equal(report.runs.find((run) => run.planned.checkId === "greeting")?.outcome?.status, "pass");
    // A filtered skip is the operator's own choice; it never fails the report.
    assert.equal(report.ok, true);
  });
});

test("live calls are refused outside the configured call window", async () => {
  await withLiveRun(PASSING_SCENARIOS, async (fake, store) => {
    const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
    const windowed: Config = {
      ...config(),
      callWindow: { timezone: "UTC", start: "08:00", end: "20:00" },
    };
    // 03:00 UTC — outside the window.
    const night = await runChecks(windowed, port, store, {
      live: true, timeoutMs: 5_000, intervalMs: 10, now: () => new Date("2026-08-04T03:00:00Z"),
    });
    assert.ok(night.runs.every((run) => run.skipped === "outside-call-window"));
    assert.equal(fake.created.length, 0);
    assert.equal(night.ok, true);
    // 12:00 UTC — inside; calls go out.
    const day = await runChecks(windowed, port, store, {
      live: true, timeoutMs: 5_000, intervalMs: 10, now: () => new Date("2026-08-04T12:00:00Z"),
    });
    assert.equal(day.runs.filter((run) => run.outcome !== null).length, 2);
    assert.equal(fake.created.length, 2);
    // Day-of-week restriction: Tuesday 2026-08-04 excluded when days=[0,6].
    const weekend: Config = { ...config(), callWindow: { timezone: "UTC", start: "08:00", end: "20:00", days: [0, 6] } };
    const tuesday = await runChecks(weekend, port, store, {
      live: true, timeoutMs: 5_000, intervalMs: 10, now: () => new Date("2026-08-04T12:00:00Z"),
    });
    assert.ok(tuesday.runs.every((run) => run.skipped === "outside-call-window"));
  });
});

test("a failing first run fails the report even with no baseline to diff against", async () => {
  await withLiveRun(
    [
      { phone: "+15550100", structuredResult: { answered: false }, turns: [] },
      PASSING_SCENARIOS[1],
    ],
    async (fake, store) => {
      const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
      const report = await runChecks(config(), port, store, { live: true, timeoutMs: 5_000, intervalMs: 10 });
      // First run establishes the baseline, so no regressions exist yet —
      // but a failing outcome must still fail the report (fail closed).
      assert.equal(report.runs.find((run) => run.planned.checkId === "hours")?.outcome?.status, "fail");
      assert.deepEqual(report.regressions, []);
      assert.equal(report.ok, false);
    },
  );
});

test("an ambiguous create is reconciled on the next run with the same key — the line rings once", async () => {
  await withLiveRun(
    [
      { ...PASSING_SCENARIOS[0], apiError: { status: 500, code: "internal_error", times: 1, afterCreate: true } },
      PASSING_SCENARIOS[1],
    ],
    async (fake, store) => {
      const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
      const first = await runChecks(config(), port, store, { live: true, timeoutMs: 5_000, intervalMs: 10 });
      assert.equal(first.ok, false);
      assert.match(first.runs.find((run) => run.planned.checkId === "hours")?.error ?? "", /ambiguous/);
      const pending = store.pending("hours");
      assert.ok(pending !== null, "an ambiguous create must persist a pending attempt");

      const second = await runChecks(config(), port, store, { live: true, only: ["hours"], timeoutMs: 5_000, intervalMs: 10 });
      assert.equal(second.ok, true);
      assert.equal(second.runs.find((run) => run.planned.checkId === "hours")?.outcome?.status, "pass");
      // The provider replayed the stored create for the reused key:
      // exactly one call ever reached the line.
      assert.equal(fake.created.filter((call) => call.phones.includes("+15550100")).length, 1);
      assert.equal(store.history("hours").length, 1);
      assert.equal(store.pending("hours"), null);
    },
  );
});

test("a poll timeout is recovered on the next run by its call id, without dialing again", async () => {
  await withLiveRun(
    [
      { ...PASSING_SCENARIOS[0], pollsBeforeTerminal: 999 },
      PASSING_SCENARIOS[1],
    ],
    async (fake, store) => {
      const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
      const first = await runChecks(config(), port, store, { live: true, only: ["hours"], timeoutMs: 150, intervalMs: 25 });
      assert.equal(first.ok, false);
      assert.match(first.runs.find((run) => run.planned.checkId === "hours")?.error ?? "", /timeout/);
      const pending = store.pending("hours");
      assert.ok(pending?.callId, "a timeout after create must persist the call id");

      fake.setScenario(PASSING_SCENARIOS[0]);
      const second = await runChecks(config(), port, store, { live: true, only: ["hours"], timeoutMs: 5_000, intervalMs: 10 });
      assert.equal(second.ok, true);
      assert.equal(fake.created.filter((call) => call.phones.includes("+15550100")).length, 1);
      assert.equal(store.history("hours").length, 1);
      assert.equal(store.pending("hours"), null);
    },
  );
});

test("a pending call that never reaches a terminal state is abandoned, not re-polled forever", async () => {
  await withLiveRun(
    [
      { ...PASSING_SCENARIOS[0], pollsBeforeTerminal: 999 },
      PASSING_SCENARIOS[1],
    ],
    async (fake, store) => {
      const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
      const at = (iso: string) => () => new Date(iso);

      // The provider accepts the create, then never dials and never reaches a
      // terminal state, so the poll times out and the call id is persisted.
      const first = await runChecks(config(), port, store, {
        live: true, only: ["hours"], timeoutMs: 150, intervalMs: 25, now: at("2026-08-10T18:34:00Z"),
      });
      assert.match(first.runs.find((run) => run.planned.checkId === "hours")?.error ?? "", /timeout/);
      assert.ok(store.pending("hours")?.callId, "the timed-out call id must be persisted for reconciliation");
      assert.equal(fake.created.length, 1);

      // Eleven days on, that dead call id is still all the runner has. It must
      // give up on it rather than spend every future run re-polling it.
      const second = await runChecks(config(), port, store, {
        live: true, only: ["hours"], timeoutMs: 150, intervalMs: 25, now: at("2026-08-21T18:34:00Z"),
      });
      assert.equal(second.ok, false, "abandoning a call we believed was placed must page");
      assert.match(second.runs.find((run) => run.planned.checkId === "hours")?.error ?? "", /abandoned/);
      assert.equal(store.pending("hours"), null, "the dead pending attempt must be cleared");
      assert.equal(fake.created.length, 1, "abandoning must not also dial inside the same run");

      // With the deadlock broken, the next run dials this check again.
      fake.setScenario(PASSING_SCENARIOS[0]);
      const third = await runChecks(config(), port, store, {
        live: true, only: ["hours"], timeoutMs: 5_000, intervalMs: 10, now: at("2026-08-22T06:34:00Z"),
      });
      assert.equal(third.ok, true);
      assert.equal(third.runs.find((run) => run.planned.checkId === "hours")?.outcome?.status, "pass");
      assert.equal(fake.created.length, 2, "monitoring must resume once the pending is abandoned");
      assert.equal(store.history("hours").length, 1);
    },
  );
});

test("a pending attempt younger than the abandon bound is still reconciled, not abandoned", async () => {
  await withLiveRun(
    [
      { ...PASSING_SCENARIOS[0], pollsBeforeTerminal: 999 },
      PASSING_SCENARIOS[1],
    ],
    async (fake, store) => {
      const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
      const first = await runChecks(config(), port, store, {
        live: true, only: ["hours"], timeoutMs: 150, intervalMs: 25, now: () => new Date("2026-08-10T18:00:00Z"),
      });
      assert.match(first.runs.find((run) => run.planned.checkId === "hours")?.error ?? "", /timeout/);

      // Still inside the bound: the call may yet land, so reconcile by id and
      // do not dial the line a second time.
      fake.setScenario(PASSING_SCENARIOS[0]);
      const second = await runChecks(config(), port, store, {
        live: true, only: ["hours"], timeoutMs: 5_000, intervalMs: 10, now: () => new Date("2026-08-10T18:59:00Z"),
      });
      assert.equal(second.ok, true);
      assert.equal(fake.created.length, 1, "a reconcilable pending must never dial again");
      assert.equal(store.history("hours").length, 1);
      assert.equal(store.pending("hours"), null);
    },
  );
});

test("a pending attempt with an unreadable timestamp is abandoned rather than trusted forever", async () => {
  await withLiveRun(PASSING_SCENARIOS, async (fake, store) => {
    const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
    store.recordPending({ checkId: "hours", idempotencyKey: "linecanary:hours:+15550100:whenever", callId: "call_unknowable", at: "not-a-timestamp" });

    const report = await runChecks(config(), port, store, { live: true, only: ["hours"], timeoutMs: 5_000, intervalMs: 10 });
    assert.equal(report.ok, false);
    assert.match(report.runs.find((run) => run.planned.checkId === "hours")?.error ?? "", /abandoned/);
    assert.equal(store.pending("hours"), null);
    assert.equal(fake.created.length, 0);
  });
});

test("a live run whose --only matches no check fails closed rather than reporting OK", async () => {
  await withLiveRun(PASSING_SCENARIOS, async (fake, store) => {
    const port = await createSdkPort({ apiKey: "calle_test_key", baseUrl: fake.baseUrl });
    const report = await runChecks(config(), port, store, { live: true, only: ["does-not-exist"], timeoutMs: 5_000, intervalMs: 10 });
    assert.equal(fake.created.length, 0, "no calls should be placed");
    assert.equal(report.ok, false, "a live run that placed zero calls must not be green");
  });
});
