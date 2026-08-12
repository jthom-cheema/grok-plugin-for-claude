import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSentinelResumePrompt,
  interpretGrokResult,
  outputHasSentinel,
  parseEffortError,
  pickSupportedEffort,
  SENTINEL_MAX_RESUMES
} from "../plugins/grok/scripts/lib/grok.mjs";

// --- sentinel matching -------------------------------------------------------

test("outputHasSentinel matches the sentinel on its own line", () => {
  assert.equal(outputHasSentinel("1. No findings.\nDONE", "DONE"), true);
  assert.equal(outputHasSentinel("1. No findings.\n  DONE  \n", "DONE"), true);
});

test("outputHasSentinel rejects substring hits inside prose", () => {
  assert.equal(outputHasSentinel("The work is DONE now.", "DONE"), false);
  assert.equal(outputHasSentinel("ALMOSTDONE", "DONE"), false);
});

test("outputHasSentinel treats a missing sentinel declaration as satisfied", () => {
  assert.equal(outputHasSentinel("any text", null), true);
  assert.equal(outputHasSentinel("any text", ""), true);
});

test("outputHasSentinel handles CRLF output", () => {
  assert.equal(outputHasSentinel("findings\r\nDONE\r\n", "DONE"), true);
});

test("buildSentinelResumePrompt names the sentinel and the tool-call rule", () => {
  const prompt = buildSentinelResumePrompt("DONE");
  assert.match(prompt, /"DONE" on its own line/);
  assert.match(prompt, /tool call/);
});

test("SENTINEL_MAX_RESUMES is the documented hard cap", () => {
  assert.equal(SENTINEL_MAX_RESUMES, 2);
});

// --- unsupported-effort detection -------------------------------------------
// The CLI reports an unsupported effort level with EXIT 0 and the error as its
// only output. Under --output-format json it arrives as {"type":"error"} on
// stdout; the plain rendering lands in finalMessage via the stderr fallback.
// Both channels observed live 2026-08-12 against grok CLI 0.2.118.

const JSON_EFFORT_ERROR = JSON.stringify({
  type: "error",
  message: "--effort/--reasoning-effort: unknown effort level 'max'; use one of: xhigh, high, medium, low"
});

test("parseEffortError reads the structured JSON error channel", () => {
  const result = interpretGrokResult({ stdout: JSON_EFFORT_ERROR, stderr: "", status: 0 });
  const parsed = parseEffortError(result);
  assert.ok(parsed);
  assert.equal(parsed.requested, "max");
  assert.deepEqual(parsed.supported, ["xhigh", "high", "medium", "low"]);
});

test("parseEffortError reads the plain stderr channel (grok-4.5 list)", () => {
  const result = interpretGrokResult({
    stdout: "",
    stderr: "Error: --effort/--reasoning-effort: unknown effort level 'xhigh'; use one of: high, medium, low",
    status: 0
  });
  const parsed = parseEffortError(result);
  assert.ok(parsed);
  assert.equal(parsed.requested, "xhigh");
  assert.deepEqual(parsed.supported, ["high", "medium", "low"]);
});

test("parseEffortError returns null on a normal answer", () => {
  const result = interpretGrokResult({
    stdout: JSON.stringify({ text: "OK", sessionId: "abc", stopReason: "EndTurn" }),
    stderr: "",
    status: 0
  });
  assert.equal(parseEffortError(result), null);
});

// --- downgrade selection -----------------------------------------------------

test("pickSupportedEffort steps max down to xhigh when the model supports it", () => {
  assert.equal(pickSupportedEffort("max", ["xhigh", "high", "medium", "low"]), "xhigh");
});

test("pickSupportedEffort steps xhigh down to high on models without it", () => {
  assert.equal(pickSupportedEffort("xhigh", ["high", "medium", "low"]), "high");
});

test("pickSupportedEffort falls back to the CLI's first offer for unknown levels", () => {
  assert.equal(pickSupportedEffort("banana", ["high", "medium", "low"]), "high");
});
