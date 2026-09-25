// Redaction: never let credential-looking values leave the machine's disk into the UI.
const KEY_RE = /(key|token|secret|password|passwd|credential|auth|bearer|cookie)/i;
const VALUE_RE = /(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|npm_[A-Za-z0-9]{36,}|AKIA[0-9A-Z]{12,}|xox[abp]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;
// Whole rest-of-line after the scheme word, so multi-parameter schemes like
// Digest (comma-separated, quoted params) are fully covered. [ \t] (not \s) and
// [^\r\n] keep the match from crossing into the next header line, and the
// ^...$ anchors keep it from firing inside a header embedded in other text
// (e.g. a quoted curl -H "Authorization: ..." argument), which would eat
// unrelated trailing content.
// A whole PEM/OpenSSH/PGP private-key block, BEGIN through END (or to the end of the text if the END line is missing),
// so the key body never survives with only its header removed.
const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g;
// npm registry credentials: //host/:_authToken=…, _auth=…, _password=… (.npmrc syntax, which the key = value rule misses).
const NPM_AUTH_RE = /((?:^|[\s:"'])_(?:authToken|auth|password)[ \t]*=[ \t]*)[^\s"']+/gim;
// netrc passwords: "machine host login me password x" on one line, or a "password x" line of a multi-line entry.
const NETRC_RE = /^([ \t]*(?:machine[ \t]+\S+|default)(?:[ \t]+(?:login|account)[ \t]+\S+)*[ \t]+password[ \t]+)\S+|^([ \t]*password[ \t]+)\S+([ \t]*)$/gim;
const redactValues = (s) => s.replace(PRIVATE_KEY_RE, '<redacted>').replace(VALUE_RE, '<redacted>');

const AUTH_HEADER_RE = /^([ \t]*\bauthorization[ \t]*:[ \t]*)(\S+)([ \t]+)([^\r\n]+)$/gim;

// A name that looks sensitive: KEY_RE's words, except that "auth" starting author/authority is not (package.json's "author").
const SENSITIVE_NAME = '[A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential|auth(?!or(?!i[sz]))|bearer|cookie)[A-Za-z0-9_.-]*';
// Quoted "key": "value" pairs (JSON, or TOML's "key" = "value") anywhere on a line, so minified/inline JSON and keys the line
// rule below does not list (Authorization, cookie, …) are covered. Only string values; the quotes stay, so the JSON stays readable.
const QUOTED_PAIR_RE = /("((?:[^"\\\r\n]|\\.)*)"[ \t]*[:=][ \t]*)"(?:[^"\\\r\n]|\\.)*"/g;
const SENSITIVE_KEY_RE = new RegExp(`^${SENSITIVE_NAME}$`, 'i');
// Inside a URL (MCP and hook URLs, config text): a sensitive query parameter's value (?api_key=…) and a userinfo password.
// Each URL is found first and its parameters redacted inside it (a lookbehind for "inside a URL" rescans the URL at every ? and &).
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const URL_QUERY_RE = new RegExp(`([?&]${SENSITIVE_NAME}=)[^&#]+`, 'gi');
const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:)[^\s/?#@]+@/gi;
// TOML bare keys with a quoted value, first on the line or inside an inline table ({ Authorization = "…" }), which the line
// rule below misses: it needs the key first on the line and lists fewer names (no auth/cookie/bearer).
const TOML_BARE_PAIR_RE = new RegExp(`((?:^|[{,])[ \\t]*${SENSITIVE_NAME}[ \\t]*=[ \\t]*)(?:"(?:[^"\\\\\\r\\n]|\\\\.)*"|'[^'\\r\\n]*')(?!["'])`, 'gim');
// Elements of a quoted-string array (JSON or TOML args lists), only between [ , ] so a quoted header in a command line
// (curl -H "…") is untouched: a header element ("X-Api-Key: …"), a NAME=value element ("--token=…"), and the element after
// a sensitive flag element ("--api-key", "…").
const EL = '(?:[^"\\\\\\r\\n]|\\\\.)';
const EL_END = '(?="[ \\t\\r\\n]*[,\\]])';
const ARRAY_HEADER_RE = new RegExp(`([[,][ \\t\\r\\n]*")(${SENSITIVE_NAME})([ \\t]*:[ \\t]*)(${EL}+)${EL_END}`, 'gi');
const ARRAY_ASSIGN_RE = new RegExp(`([[,][ \\t\\r\\n]*"-{0,2}${SENSITIVE_NAME}=)${EL}+${EL_END}`, 'gi');
const ARRAY_FLAG_PAIR_RE = new RegExp(`([[,][ \\t\\r\\n]*"--?${SENSITIVE_NAME}"[ \\t\\r\\n]*,[ \\t\\r\\n]*")${EL}*${EL_END}`, 'gi');
// A header's value redacted; an Authorization header keeps its scheme word (Bearer, Basic, …) visible.
function headerValue(name, v) {
  const scheme = /authorization$/i.test(name) && v.match(/^(\S+[ \t]+)\S/);
  return (scheme ? scheme[1] : '') + '<redacted>';
}

export function redactText(text) {
  if (typeof text !== 'string') return text;
  // Runs before VALUE_RE so a recognized token shape inside the credential
  // (e.g. an sk-... prefix) can't get partially replaced first and dodge
  // the full-line Authorization redaction below.
  let out = text.replace(AUTH_HEADER_RE, (m, prefix, scheme, sep) => prefix + scheme + sep + '<redacted>');
  out = redactValues(out);
  out = out.replace(QUOTED_PAIR_RE, (m, head, key) => (SENSITIVE_KEY_RE.test(key) ? head + '"<redacted>"' : m));
  out = out.replace(URL_RE, (u) => u.replace(URL_QUERY_RE, (m, k) => k + '<redacted>')).replace(URL_USERINFO_RE, (m, k) => k + '<redacted>@');
  out = out.replace(TOML_BARE_PAIR_RE, (m, head) => head + '"<redacted>"');
  out = out.replace(ARRAY_HEADER_RE, (m, open, name, sep, v) => open + name + sep + headerValue(name, v))
    .replace(ARRAY_ASSIGN_RE, (m, k) => k + '<redacted>').replace(ARRAY_FLAG_PAIR_RE, (m, k) => k + '<redacted>');
  // key = value / key: value lines where the key looks sensitive (a quoted pair or array element the rules above already
  // redacted is left as is, so its closing quote survives)
  out = out.replace(/^(\s*["']?[A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(.+)$/gim,
    (m, k, v) => (/^\s*"/.test(k) && /^"?<redacted>"/.test(v) ? m : k + (v.trim().length ? '<redacted>' : v)));
  out = out.replace(NPM_AUTH_RE, (m, k) => k + '<redacted>');
  out = out.replace(NETRC_RE, (m, one, multi, tail) => one != null ? one + '<redacted>' : multi + '<redacted>' + tail);
  return out;
}

// Hook commands and hook/MCP URLs: one-line strings where a credential sits mid-line, which redactText's line-anchored rules
// miss by design. On top of redactText: a sensitive header inside a quoted argument (curl -H "Authorization: Bearer …"),
// NAME=value assignments and flags (API_KEY=…, --token=…), and a --token … flag value. Names and structure stay visible.
const QUOTED_HEADER_RE = new RegExp(`(["'])([ \\t]*(${SENSITIVE_NAME})[ \\t]*:[ \\t]*)([^"'\\r\\n]+)\\1`, 'gi');
const INLINE_ASSIGN_RE = new RegExp(`((?:^|[\\s;&|(,"'])${SENSITIVE_NAME}=)("[^"]*"|'[^']*'|[^\\s&;|"'#]+)`, 'gi');
const FLAG_VALUE_RE = new RegExp(`((?:^|\\s)--?${SENSITIVE_NAME}[ \\t]+)("[^"]*"|'[^']*'|[^\\s"';&|-][^\\s"';&|]*)`, 'gi');
export function redactInline(text) {
  if (typeof text !== 'string') return text;
  return redactText(text)
    .replace(QUOTED_HEADER_RE, (m, q, head, name, v) => q + head + headerValue(name, v) + q)
    .replace(INLINE_ASSIGN_RE, (m, k) => k + '<redacted>')
    .replace(FLAG_VALUE_RE, (m, k) => k + '<redacted>');
}

// MCP server args, one argv word per element: a sensitive flag's value is the next element (["--api-key", "…"]), a header is a
// whole element ("Authorization: Bearer …", "X-Api-Key: …"), and any other element gets redactInline (--token=…, API_KEY=…).
// A value that is not an array (an unparsed TOML list) is text.
const ARG_FLAG_RE = new RegExp(`^--?${SENSITIVE_NAME}$`, 'i');
const ARG_HEADER_RE = new RegExp(`^(${SENSITIVE_NAME})([ \\t]*:[ \\t]*)(.+)$`, 'is');
export function redactArgs(args) {
  if (typeof args === 'string') return redactInline(args);
  if (!Array.isArray(args)) return redactObject(args);
  return args.map((a, i) => {
    if (typeof a !== 'string') return redactObject(a);
    if (typeof args[i - 1] === 'string' && ARG_FLAG_RE.test(args[i - 1])) return '<redacted>';
    const h = a.match(ARG_HEADER_RE);
    return h ? h[1] + h[2] + headerValue(h[1], h[3]) : redactInline(a);
  });
}

// String values under these keys are commands or URLs (hook commands, MCP/hook URLs in settings and config objects); args are argv lists.
const INLINE_HINT_RE = /^(command|url)$/i;

export function redactObject(value, keyHint = '') {
  if (Array.isArray(value)) return keyHint === 'args' ? redactArgs(value) : value.map((v) => redactObject(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (KEY_RE.test(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = '<redacted>';
      else out[k] = redactObject(v, k);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (KEY_RE.test(keyHint)) return '<redacted>';
    if (keyHint === 'args') return redactArgs(value);
    return INLINE_HINT_RE.test(keyHint) ? redactInline(value) : redactValues(value);
  }
  return value;
}

// Env var names are safe to show; values are never shown. Filter to AI/dev-tool relevant names.
const ENV_NAME_RE = /^(CLAUDE|ANTHROPIC|CODEX|OPENAI|GEMINI|GOOGLE_API|MCP|OLLAMA|LMSTUDIO|NODE|NPM|NVM|PNPM|BUN|DENO|GIT|GH_|HOMEBREW|EDITOR|VISUAL|SHELL|TERM|LANG|PATH$|HOME$|USER$|XDG)/;
export function safeEnvNames(env = process.env) {
  return Object.keys(env).filter((k) => ENV_NAME_RE.test(k)).sort().map((name) => ({
    name,
    set: env[name] !== undefined && env[name] !== '',
    sensitive: KEY_RE.test(name),
    length: env[name] ? env[name].length : 0,
  }));
}
