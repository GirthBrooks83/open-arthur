// Verifier spine — typed pipeline contracts, the Critic gate and the
// Verifier invariant checks (Design Note A, parts-scavenge MAP).
//
// The stage contracts and gate semantics are ported from Agent-Me
// (MIT, (c) Agent-Me contributors) — backend/app/collaboration.py and
// backend/app/knowledge.py: the Critic grounds a completion on >=1
// surviving evidence match; an ungrounded completion gets the fixed
// insufficient-evidence refusal instead of a fabricated answer; the
// Verifier checks citation presence/count/non-emptiness and, on
// failure, the completion is replaced with the verification-failed
// status. The Acceptance types are PATTERNS ONLY from the LobeHub
// Acceptance model (LobeHub Community License — no LobeHub code):
// criteria are written before work starts and frozen when the run
// starts, verdicts are per criterion, and evidence counts only when
// its provenance is a captured or imported execution — authored
// examples and bare pasted logs are not evidence.
import { z } from "zod";

// The fixed answers the gates substitute for a completion they cannot
// stand behind (Agent-Me's fixed strings, adapted from "configured
// knowledge files" to this app's evidence sources). A blocked or
// unverified task never ships the model's own summary as if checked.
export const INSUFFICIENT_EVIDENCE =
  "I could not find a grounded answer in the available evidence.";
export const VERIFICATION_FAILED =
  "I could not return a verified answer from the available evidence.";

// The human-readable reason recorded on a task the Critic ends as
// terminally blocked (D1): why it stopped and what to do instead —
// the record a person reads, distinct from the fixed refusal above,
// which stays the task's user-facing result.
export const CRITIC_BLOCKED_REASON =
  "Blocked by the evidence check: this completion was not grounded in any matching memory, task evidence, or successful tool result, so it was not shipped. Start a new task, or point it at the source it should answer from.";

// Agent-Me's retriever threshold (knowledge.py _MIN_QUERY_COVERAGE):
// a recall fact survives into the EvidenceBundle only when it covers
// at least this fraction of the query's non-stop-word tokens, so "no
// evidence" is a measured state, not a vibe.
export const MIN_QUERY_COVERAGE = 0.75;

// The stop-word set Agent-Me's retriever removes before measuring
// coverage (knowledge.py _STOP_WORDS).
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

// Word tokens after NFKC normalization and case folding (Agent-Me
// text.py normalized_tokens, minus its Han-character splitting, which
// this app's Latin-script memory lanes do not need).
export function normalizedTokens(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLowerCase();
  return new Set(normalized.match(/[\p{L}\p{N}]+/gu) ?? []);
}

function queryTokens(value: string): Set<string> {
  const tokens = normalizedTokens(value);
  for (const word of STOP_WORDS) tokens.delete(word);
  return tokens;
}

// Coverage of the query by a candidate evidence text: the fraction of
// the query's non-stop-word tokens that appear in the text (Agent-Me
// knowledge.py search scoring). An empty query covers nothing.
export function queryCoverage(query: string, text: string): number {
  const querySet = queryTokens(query);
  if (!querySet.size) return 0;
  const textTokens = normalizedTokens(text);
  let covered = 0;
  for (const token of querySet) if (textTokens.has(token)) covered += 1;
  return Math.round((covered / querySet.size) * 10000) / 10000;
}

export const agentNameSchema = z.enum(["planner", "researcher", "critic", "writer", "verifier"]);
export type AgentName = z.infer<typeof agentNameSchema>;

export const planSchema = z.object({
  retrievalQuery: z.string(),
  tasks: z.array(z.string()),
  queryTermCount: z.number().int().nonnegative(),
});
export type Plan = z.infer<typeof planSchema>;

export const evidenceMatchSchema = z.object({
  // The source id a written answer cites as [id]: a memory id, a task
  // evidence id, or a tool-result id from the run.
  id: z.string().min(1),
  source: z.string(),
  excerpt: z.string(),
  score: z.number().min(0).max(1),
});
export type EvidenceMatch = z.infer<typeof evidenceMatchSchema>;

export const evidenceBundleSchema = z.object({
  matches: z.array(evidenceMatchSchema),
});
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

export const critiqueSchema = z.object({
  grounded: z.boolean(),
  queryCoverage: z.number().min(0).max(1),
});
export type Critique = z.infer<typeof critiqueSchema>;

export const writtenAnswerSchema = z.object({
  content: z.string(),
  citationCount: z.number().int().nonnegative(),
});
export type WrittenAnswer = z.infer<typeof writtenAnswerSchema>;

export const verificationSchema = z.object({
  approved: z.boolean(),
  citationPathsValid: z.boolean(),
  expectedCitationCount: z.number().int().nonnegative(),
  reportedCitationCount: z.number().int().nonnegative(),
});
export type Verification = z.infer<typeof verificationSchema>;

// One stage's outcome on a task record. Summaries describe workflow
// operations and counts only — never model reasoning (Agent-Me's
// StageTrace discipline).
export const stageTraceSchema = z.object({
  sequence: z.number().int().positive(),
  agent: agentNameSchema,
  outcome: z.enum(["completed", "blocked"]),
  summary: z.string(),
  metrics: z.record(z.string(), z.union([z.boolean(), z.number()])),
});
export type StageTrace = z.infer<typeof stageTraceSchema>;

// --- Acceptance model (patterns only, see the header note) ---

export const criterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  evidenceKind: z.string().min(1),
});
export type Criterion = z.infer<typeof criterionSchema>;

export const acceptancePlanSchema = z.object({
  taskId: z.string().min(1),
  // Criteria are frozen when the run starts; a plan without a frozen
  // timestamp is a draft, not an acceptance plan.
  frozenAt: z.iso.datetime(),
  criteria: z.array(criterionSchema).min(1),
});
export type AcceptancePlan = z.infer<typeof acceptancePlanSchema>;

// Provenance decides whether an item counts as evidence at all: only
// captured or imported executions do. Authored examples and bare
// pasted logs never ground a verdict.
export const evidenceProvenanceSchema = z.enum(["captured", "imported", "authored", "pasted_log"]);
export type EvidenceProvenance = z.infer<typeof evidenceProvenanceSchema>;

export const acceptanceEvidenceSchema = z.object({
  kind: z.string().min(1),
  provenance: evidenceProvenanceSchema,
  ref: z.string().min(1),
});
export type AcceptanceEvidence = z.infer<typeof acceptanceEvidenceSchema>;

export function countsAsEvidence(evidence: AcceptanceEvidence): boolean {
  return evidence.provenance === "captured" || evidence.provenance === "imported";
}

export const checkVerdictSchema = z.object({
  criterionId: z.string().min(1),
  verdict: z.enum(["pass", "fail", "blocked"]),
  score: z.number().min(0).max(1),
  evidenceId: z.string().min(1),
});
export type CheckVerdict = z.infer<typeof checkVerdictSchema>;

// --- Stage logic (Agent-Me roles, ported) ---

// PlannerAgent: an evidence-first plan from the question itself.
export function createPlan(question: string): Plan {
  const retrievalQuery = question.trim();
  return planSchema.parse({
    retrievalQuery,
    tasks: [
      "Retrieve evidence from the available sources.",
      "Check whether the evidence supports the requested answer.",
      "Write a concise answer with source citations.",
    ],
    queryTermCount: normalizedTokens(retrievalQuery).size,
  });
}

// Researcher step for the recall path: keep only the recalled facts
// whose coverage of the query clears the retriever threshold. The
// caller supplies facts in the lanes' merge order (internal store,
// then Mem0, then Graphiti, then Hindsight) and this filter never
// reorders them.
export function survivingMatches(
  query: string,
  facts: { id: string; source: string; text: string }[],
): EvidenceMatch[] {
  const matches: EvidenceMatch[] = [];
  for (const fact of facts) {
    const score = queryCoverage(query, fact.text);
    if (score >= MIN_QUERY_COVERAGE)
      matches.push({ id: fact.id, source: fact.source, excerpt: fact.text, score });
  }
  return matches;
}

// CriticAgent: grounded is the only gate condition — at least one
// surviving evidence match, or (the Open Arthur extension from Design
// Note A) at least one successful tool result in the run. The
// queryCoverage metric is computed the donor's way — over the raw
// query tokens, no stop-word removal — and is reported, never gated
// on.
export function critiqueAnswer(
  question: string,
  bundle: EvidenceBundle,
  successfulToolResults: number,
): Critique {
  const querySet = normalizedTokens(question);
  const evidenceTokens = normalizedTokens(bundle.matches.map((match) => match.excerpt).join("\n"));
  let covered = 0;
  for (const token of querySet) if (evidenceTokens.has(token)) covered += 1;
  return critiqueSchema.parse({
    grounded: bundle.matches.length > 0 || successfulToolResults > 0,
    queryCoverage: querySet.size ? Math.round((covered / querySet.size) * 10000) / 10000 : 0,
  });
}

// --- Critic scope (D1) ---
//
// The evidence gate exists to stop a completion that CLAIMS facts —
// about the user's stored data or the world — it cannot back. It was
// applied to every completion, so a general instruction whose output
// is the work itself (formatting, drafting, transforming supplied
// text) was blocked for having no memory match: production task
// 18ee7f55 ("Reply with exactly: PING OK", evidence_count 0) parked
// with the refusal. requiresEvidence draws the line on the prompt:
// a task requires evidence when it asks a factual question, or asks
// to recall/report the user's own stored state. The service ALSO
// applies the gate when the run attempted work tools (a completion
// reporting tool outcomes needs backing whatever the prompt's
// shape); this function judges the prompt alone. Round 4 (below):
// the BLOCK's scope is gateRequiresEvidence — requiresEvidence
// still classifies every factual claim, but only stored-state and
// current-fact claims (and tool-outcome reports) block when
// ungrounded; general-knowledge claims are checked, not blocked.
// Pure small talk (round 3): a greeting or pleasantry that is the
// WHOLE prompt asserts nothing and stays ungated. The guard is
// anchored at both ends so "Hello, what is my balance?" still
// reaches the factual checks below.
const SMALL_TALK =
  /^(hi|hello|hey|good (morning|afternoon|evening)|thanks|thank you|how are you( doing)?|how'?s it going)[\s!.?]*$/;

// Polite and modal lead-ins (round 3, Claude review of PR #47):
// the anchored checks judge the request's CORE, so strip the
// wrappers people actually type — "Please tell me…", "Can you
// tell me…", "Could you please check…" — before matching them.
// The strip removes only the wrapper; the core still has to match
// a gated pattern on its own, so politeness alone never gates
// ("Can you write me a poem?" stays ungated).
function requestCore(text: string): string {
  return text.replace(/^(please[,\s]+)?((can|could|would|will)\s+you\s+)?(please[,\s]+)?/, "");
}

// The factual-signal markers (round 2): a temporal marker (today,
// current, latest, now, ...) or a live-topic marker (weather,
// price, news, score, forecast, ...) — the signs that a claim is
// about the CURRENT state of the world, which the model cannot
// know from training and must source.
const CURRENT_FACT_SIGNALS =
  /\b(today|todays|current|currently|latest|now|tonight|tomorrow|yesterday|weather|forecast|price|prices|pricing|news|headlines?|scores?|stock|stocks|temperature|exchange rate)\b/;

// The request's core in question form: a wh-question, or a yes/no
// question (auxiliary lead-in and a question mark).
function isQuestionForm(core: string): boolean {
  if (/^(what|when|where|who|whom|whose|which|why|how)\b/.test(core)) return true;
  return (
    /^(is|are|was|were|do|does|did|have|has|can|could|will|would|should|may|might)\b/.test(core) &&
    core.includes("?")
  );
}

// Claims about the user's own stored state, however phrased:
// explicit recall asks, "my <stored thing>" references, and
// imperatives that ask to report stored state ("List my tasks").
// These facts live in the user's memory, mail, calendar and task
// records — nowhere else — so a completion asserting them needs
// backing from those sources.
function asksAboutStoredState(text: string, core: string): boolean {
  if (/\b(remind me|do you remember|remember when)\b/.test(text)) return true;
  if (
    /\bmy\b[^.?!]{0,24}\b(email|inbox|files?|documents?|tasks?|goals?|notes?|memories|records?|schedule|priorities)\b/.test(
      text,
    )
  )
    return true;
  if (/\bmy (calendar|events?|name|address|phone|accounts?)\b/.test(text)) return true;
  if (/^(list|show|find|report)\b/.test(core) && /\bmy\b/.test(core)) return true;
  return false;
}

export function requiresEvidence(prompt: string): boolean {
  const text = prompt.trim().toLowerCase();
  if (!text) return false;
  if (SMALL_TALK.test(text)) return false;
  const core = requestCore(text);
  // A question asking for a fact: the completion asserts an answer.
  if (isQuestionForm(core)) return true;
  // Recall of stored facts, however phrased.
  if (asksAboutStoredState(text, core)) return true;
  // Factual imperatives (round 2, ATLAS review of PR #47): an
  // information-fetch lead verb ("Tell me today's weather", "Give
  // me the current price of Bitcoin") asserts a world fact exactly
  // like the question form, and round 1 let it bypass the gate when
  // the model answered without tools. The gate applies only when
  // the imperative ALSO carries a factual signal — a temporal
  // marker (today, current, latest, now, ...) or a factual-topic
  // marker (weather, price, news, score, forecast, ...). The signal
  // requirement is the false-positive guard: creative imperatives
  // ("Tell me a joke", "Give me a poem about autumn") carry neither
  // and stay ungated, as do fetching verbs aimed at supplied or
  // creative content ("Check this draft", "Get me a coffee").
  if (
    /^(tell|give|show|check|fetch|get|find|search|report|look up|find out)\b/.test(core) &&
    CURRENT_FACT_SIGNALS.test(core)
  )
    return true;
  // "Tell me" fact requests without a topic signal (round 3): the
  // round-2 signal requirement guards creative objects, but a
  // request to be TOLD a fact — "Can you tell me the capital of
  // France?", "Please tell me when the meeting starts" — asserts a
  // world fact with no signal word in it. Gate the tell-me form
  // when it embeds a question word or asks for a definite thing
  // ("tell me the…", "tell me about the…"), unless the thing asked
  // for is a creative work (a joke, a story, a poem) — those stay
  // ungated, like round 2's examples.
  if (
    /\btell me\b/.test(core) &&
    !/\b(jokes?|story|stories|poems?|poetry|songs?|tales?|riddles?|limericks?|haiku)\b/.test(
      core,
    ) &&
    (/\b(what|when|where|who|whom|whose|which|why|how)\b/.test(core) ||
      /\btell me (the|about the)\b/.test(core))
  )
    return true;
  return false;
}

// --- Critic gate scope (round 4) ---
//
// requiresEvidence above classifies CLAIMS: a completion that
// asserts any fact. The gate's BLOCK is narrower, and round 3's
// scope was the defect Joseph hit live on 2026-11-17: a plain
// general question ("What is the capital of France?" is the test
// suite's own exemplar) failed with the insufficient-evidence
// refusal because no memory matched it and no tool ran — it had
// no path to "grounded", ever, no matter how ordinary the
// question. A block exists for claims the model cannot
// legitimately make from its own knowledge:
// - facts about the user's stored state (their calendar, mail,
//   tasks, memories) — those live in the lanes and records, and
//   an ungrounded assertion about them is a fabrication about
//   the user's own life;
// - current world facts (today's weather, the current price) —
//   training knowledge is stale the moment it matters, so the
//   claim needs a source: memory evidence or a tool result.
// A general-knowledge question is ordinary conversation: the
// model's own knowledge is the source, there is no memory it
// should match, and the completion ships — still CHECKED (the
// critique is computed and recorded on the trace), just not
// blocked. The service ALSO applies the gate when the run
// attempted work tools: a completion reporting tool outcomes
// needs backing whatever the prompt's shape.
export function gateRequiresEvidence(prompt: string): boolean {
  const text = prompt.trim().toLowerCase();
  if (!text) return false;
  if (SMALL_TALK.test(text)) return false;
  const core = requestCore(text);
  // Stored state, however phrased.
  if (asksAboutStoredState(text, core)) return true;
  // A question about the user's own state in any other phrasing
  // ("When is my dentist appointment?", "Is my calendar free on
  // Friday?"): the possessive on a question is the tell — the
  // answer is a fact about the user, not the world.
  if (isQuestionForm(core) && /\bmy\b/.test(core)) return true;
  // Current world facts: a temporal or live-topic signal on a
  // question, a fetch imperative, or a tell-me request (the same
  // signal set as round 2's factual imperatives).
  if (
    CURRENT_FACT_SIGNALS.test(core) &&
    (isQuestionForm(core) ||
      /^(tell|give|show|check|fetch|get|find|search|report|look up|find out)\b/.test(core) ||
      /\btell me\b/.test(core))
  )
    return true;
  return false;
}

// The distinct source ids an answer may cite as [id].
export function citedIds(content: string): string[] {
  return [...new Set([...content.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]))];
}

// WriterAgent's ungrounded branch: the fixed refusal, no citations.
export function insufficientEvidenceAnswer(): WrittenAnswer {
  return writtenAnswerSchema.parse({ content: INSUFFICIENT_EVIDENCE, citationCount: 0 });
}

// VerifierAgent, donor-faithful: every bundle source must be cited as
// [id] in the answer (or, ungrounded, the content must be exactly the
// insufficient-evidence refusal), the reported citation count must
// equal the expected count, and the content must be non-empty. This
// checks citation presence/count/non-emptiness only — never that the
// evidence supports the claim.
export function verifyAnswer(
  bundle: EvidenceBundle,
  critique: Critique,
  written: WrittenAnswer,
): Verification {
  const paths = [...new Set(bundle.matches.map((match) => match.id))];
  const expectedCount = critique.grounded ? paths.length : 0;
  const citationPathsValid = critique.grounded
    ? paths.every((path) => written.content.includes(`[${path}]`))
    : written.content === INSUFFICIENT_EVIDENCE;
  return verificationSchema.parse({
    approved:
      written.citationCount === expectedCount &&
      citationPathsValid &&
      Boolean(written.content.trim()),
    citationPathsValid,
    expectedCitationCount: expectedCount,
    reportedCitationCount: written.citationCount,
  });
}

// The wired completion check for write tasks (see service.ts): the
// donor invariants that apply to a user-facing completion summary —
// non-empty content, and every citation the summary actually makes
// must name a source from the EvidenceBundle (a fabricated citation
// fails). The full all-sources-cited donor check above stays
// available for answers built to cite every source.
export function verifyCompletionCitations(
  bundle: EvidenceBundle,
  written: WrittenAnswer,
): Verification {
  const known = new Set(bundle.matches.map((match) => match.id));
  const cited = citedIds(written.content);
  const citationPathsValid = cited.every((id) => known.has(id));
  return verificationSchema.parse({
    approved: citationPathsValid && Boolean(written.content.trim()),
    citationPathsValid,
    expectedCitationCount: known.size,
    reportedCitationCount: cited.length,
  });
}
