/**
 *
 */

const ZWSP = '​';

const PATTERNS: Array<[RegExp, string]> = [
  // Anthropic
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED:anthropic-key]'],
  // Generic sk-…
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED:sk-token]'],
  // GitHub
  [/\bghp_[A-Za-z0-9_-]{30,}/g, '[REDACTED:github-token]'],
  [/\bgho_[A-Za-z0-9_-]{30,}/g, '[REDACTED:github-oauth]'],
  [/\bghs_[A-Za-z0-9_-]{30,}/g, '[REDACTED:github-server]'],
  [/\bghu_[A-Za-z0-9_-]{30,}/g, '[REDACTED:github-user]'],
  // AWS
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-akid]'],
  [/\bASIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-temp]'],
  // Google API keys — AIza + 35 chars.
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:google-key]'],
  // Slack
  [/\bxox[bpaors]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  // OpenAI project keys — sess-… / rk_live_
  [/\bsess-[A-Za-z0-9]{20,}/g, '[REDACTED:openai-session]'],
  [/\brk_(?:live|test)_[A-Za-z0-9]{20,}/g, '[REDACTED:stripe-restricted]'],
  // Stripe
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g, '[REDACTED:stripe]'],
  // HuggingFace
  [/\bhf_[A-Za-z0-9]{30,}/g, '[REDACTED:hf-token]'],
  // NVIDIA / Perplexity
  [/\bnvapi-[A-Za-z0-9_-]{20,}/g, '[REDACTED:nvapi]'],
  [/\bpplx-[A-Za-z0-9]{20,}/g, '[REDACTED:pplx]'],
  // Discord bot token — 3 base64url segments split by `.`
  [/\b[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, '[REDACTED:discord-token]'],
  // Discord interaction callback URLs contain a short-lived webhook token.
  [/(\/interactions\/\d+\/)[A-Za-z0-9_-]{20,}(\/callback)/g, '$1[REDACTED:interaction-token]$2'],
  // JWT — header.payload.signature (base64url).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED:jwt]'],
  [/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  // Authorization header (Bearer / Basic)
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer [REDACTED]'],
  [/\bBasic\s+[A-Za-z0-9+/=]{16,}/gi, 'Basic [REDACTED]'],
  // Generic key=value / "key": "value" for known-sensitive keys.
  [
    /(["']?[A-Za-z0-9_]*(?:api|auth|secret|token|password|passwd|pwd)[A-Za-z0-9_]*["']?\s*[:=]\s*["'])([^"']{8,})(["'])/gi,
    '$1[REDACTED]$3',
  ],
];

/**
 * Initialize once at module load.
 */
const LITERAL_SECRETS = new Set<string>();
let literalSecretsPattern: RegExp | null = null;
{
  const push = (v: string | undefined): void => {
    if (v && v.length >= 12) LITERAL_SECRETS.add(v);
  };
  push(process.env.ANTHROPIC_AUTH_TOKEN);
  push(process.env.ANTHROPIC_API_KEY);
  push(process.env.BOT_TOKEN);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function registerSecret(secret: string | undefined): void {
  if (secret && secret.length >= 12 && !LITERAL_SECRETS.has(secret)) {
    LITERAL_SECRETS.add(secret);
    literalSecretsPattern = null;
  }
}

function getLiteralSecretsPattern(): RegExp | null {
  if (LITERAL_SECRETS.size === 0) return null;
  if (!literalSecretsPattern) {
    literalSecretsPattern = new RegExp([...LITERAL_SECRETS].map(escapeRegExp).join('|'), 'g');
  }
  literalSecretsPattern.lastIndex = 0;
  return literalSecretsPattern;
}

/**
 */
export function escapeCodeFences(s: string): string {
  return s.replace(/```/g, '`' + ZWSP + '`' + ZWSP + '`');
}

export function scrub(text: string): string {
  let s = text;
  const literal = getLiteralSecretsPattern();
  if (literal) s = s.replace(literal, '[REDACTED:env-secret]');
  for (const [re, sub] of PATTERNS) {
    s = s.replace(re, sub);
  }
  return s;
}
