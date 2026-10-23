import 'dotenv/config';

// "3-8" → [3, 8]; a single number means a fixed delay.
function parseRange(value, fallback) {
  if (!value) return fallback;
  const [min, max = min] = String(value).split('-').map(Number);
  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : fallback;
}

/** "a@x.com, @y.com" → ['a@x.com', '@y.com'] (lower-cased). */
export function parseList(value) {
  return String(value ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const AI_PROVIDERS = ['gemini', 'anthropic'];
const AI_KEY_VARS = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
const SEARCH_PROVIDERS = ['tavily', 'gemini', 'none'];
const EMAIL_TRANSPORTS = ['simulated', 'smtp'];
const INBOUND_PROVIDERS = ['none', 'imap'];

/**
 * Builds the app configuration from an environment object and validates it.
 * Pure (takes `env` as input) so every rule can be unit-tested. Throws one error listing all problems.
 */
export function buildConfig(env) {
  const apiKey = env.ANTHROPIC_API_KEY || '';
  // Live AI runs on Gemini or Claude; without AI_PROVIDER, whichever key is set wins (Gemini first).
  const aiProvider = env.AI_PROVIDER || (env.GEMINI_API_KEY ? 'gemini' : 'anthropic');
  const providerKey = env[AI_KEY_VARS[aiProvider]] || '';
  const aiMode = env.AI_MODE || (providerKey ? 'live' : 'mock');
  const transport = env.EMAIL_TRANSPORT || 'simulated';
  const smtpPort = Number(env.SMTP_PORT || 587);

  const cfg = {
    port: Number(env.PORT || 4000),
    corsOrigin: env.CORS_ORIGIN || 'http://localhost:5173',
    databaseUrl: env.DATABASE_URL,
    runWorker: env.RUN_WORKER !== 'false',

    ai: {
      mode: aiMode,
      provider: aiProvider,
      gemini: {
        apiKey: env.GEMINI_API_KEY || '',
        // gemini-2.5-flash is no longer offered to new API keys.
        model: env.GEMINI_MODEL || 'gemini-3.5-flash',
      },
      // Anthropic (Claude) settings:
      apiKey,
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      webSearchTool: env.WEB_SEARCH_TOOL || 'web_search_20250305',
      maxWebSearches: Number(env.MAX_WEB_SEARCHES || 6),
    },

    maxSuppliers: Number(env.MAX_SUPPLIERS || 5),

    // How Gemini finds suppliers online: Tavily web search (free tier) whose results Gemini reads,
    // Gemini's own Google Search grounding (needs billing), or none (knowledge only).
    search: {
      provider: env.SEARCH_PROVIDER || (env.TAVILY_API_KEY ? 'tavily' : 'none'),
      tavilyApiKey: env.TAVILY_API_KEY || '',
    },

    email: {
      // "simulated" (default) records emails without sending; "smtp" really sends them.
      transport,
      smtp: {
        host: env.SMTP_HOST || '',
        port: smtpPort,
        secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : smtpPort === 465,
        user: env.SMTP_USER || '',
        pass: env.SMTP_PASS || '',
      },
      from: env.EMAIL_FROM || '',
      replyTo: env.EMAIL_REPLY_TO || '',
      // With SMTP, only these recipients (exact addresses or "@domain") can be emailed.
      allowedRecipients: parseList(env.EMAIL_ALLOWED_RECIPIENTS),
      allowAnyRecipient: env.EMAIL_ALLOW_ANY_RECIPIENT === 'true',
      inboundWebhookSecret: env.INBOUND_WEBHOOK_SECRET || '',
    },

    inbound: {
      // Reads real supplier replies from our Reply-To mailbox.
      provider: env.INBOUND_PROVIDER || 'none',
      pollSeconds: Number(env.INBOUND_POLL_SECONDS || 15),
      // IMAP with the same account as SMTP (for Gmail: SMTP_USER + its App Password).
      imap: {
        host: env.IMAP_HOST || 'imap.gmail.com',
        port: Number(env.IMAP_PORT || 993),
        secure: env.IMAP_SECURE ? env.IMAP_SECURE === 'true' : true,
        user: env.SMTP_USER || '',
        pass: env.SMTP_PASS || '',
        mailbox: env.IMAP_MAILBOX || 'INBOX',
        sinceDays: Number(env.INBOUND_SINCE_DAYS || 7),
      },
    },

    simulation: {
      // Simulated suppliers answer proposals and counter-offers. Off by default with real email,
      // so they never race real replies.
      suppliers: env.SIMULATE_SUPPLIERS ? env.SIMULATE_SUPPLIERS !== 'false' : transport === 'simulated',
      replyDelaySeconds: parseRange(env.SIM_REPLY_DELAY_SECONDS, [3, 8]),
    },

    // How long to wait for a supplier reply before giving up on that round.
    replyTimeoutSeconds: Number(env.REPLY_TIMEOUT_SECONDS || 45),
  };

  const errors = [];
  if (!cfg.databaseUrl) errors.push('DATABASE_URL is not set. Copy server/.env.example to server/.env and fill it in.');
  if (!AI_PROVIDERS.includes(aiProvider)) {
    errors.push(`AI_PROVIDER must be one of ${AI_PROVIDERS.join(', ')} (got "${aiProvider}").`);
  } else if (aiMode === 'live' && !providerKey) {
    errors.push(`AI_MODE=live with AI_PROVIDER=${aiProvider} requires ${AI_KEY_VARS[aiProvider]}.`);
  }

  if (!SEARCH_PROVIDERS.includes(cfg.search.provider)) {
    errors.push(`SEARCH_PROVIDER must be one of ${SEARCH_PROVIDERS.join(', ')} (got "${cfg.search.provider}").`);
  } else if (cfg.search.provider === 'tavily' && !cfg.search.tavilyApiKey) {
    errors.push('SEARCH_PROVIDER=tavily requires TAVILY_API_KEY.');
  }

  if (!EMAIL_TRANSPORTS.includes(transport)) {
    errors.push(`EMAIL_TRANSPORT must be one of ${EMAIL_TRANSPORTS.join(', ')} (got "${transport}").`);
  }
  if (transport === 'smtp') {
    const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'].filter((k) => !env[k]);
    if (missing.length) errors.push(`EMAIL_TRANSPORT=smtp requires ${missing.join(', ')}.`);
    if (!cfg.email.allowAnyRecipient && !cfg.email.allowedRecipients.length) {
      errors.push('EMAIL_TRANSPORT=smtp requires EMAIL_ALLOWED_RECIPIENTS (the test supplier addresses you may email).');
    }
  }
  if (cfg.email.allowAnyRecipient && aiMode === 'mock') {
    errors.push('EMAIL_ALLOW_ANY_RECIPIENT=true is not allowed with AI_MODE=mock; list test addresses in EMAIL_ALLOWED_RECIPIENTS.');
  }

  if (!INBOUND_PROVIDERS.includes(cfg.inbound.provider)) {
    errors.push(`INBOUND_PROVIDER must be one of ${INBOUND_PROVIDERS.join(', ')} (got "${cfg.inbound.provider}").`);
  }
  if (cfg.inbound.provider === 'imap') {
    const missing = ['SMTP_USER', 'SMTP_PASS'].filter((k) => !env[k]);
    if (missing.length) {
      errors.push(`INBOUND_PROVIDER=imap signs in with the SMTP account and requires ${missing.join(', ')}.`);
    }
  }

  if (errors.length) throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  return cfg;
}

export const config = buildConfig(process.env);
