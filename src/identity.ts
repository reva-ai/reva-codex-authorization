import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Resolves the human principal's identity.
//
// Some coding-agent hosts store the logged-in account's email as a plain
// string in their own config file. Codex does not: it stores
// $CODEX_HOME/auth.json with the shape
//
//   { "auth_mode": ..., "OPENAI_API_KEY": ...,
//     "tokens": { "id_token": "<raw JWT>", "access_token": ...,
//                 "refresh_token": ..., "account_id": ... },
//     "last_refresh": ... }
//
// where `tokens.id_token` is a RAW JWT string on disk — Codex parses it at
// load time via a custom serde deserializer rather than storing the claims
// (codex-rs/login/src/auth/storage.rs AuthDotJson, and token_data.rs
// parse_chatgpt_jwt_claims, both confirmed at rust-v0.151.0). So the email
// has to be read out of the JWT payload.
//
// Codex reads the email from claim `email`, falling back to the claim
// `https://api.openai.com/profile`.email — this file uses the identical
// order so both agree on who the principal is.
//
// The JWT signature is NOT verified here, and deliberately so: this is a
// local read of a file the user already owns, used only to name the
// principal. RTG's entity store remains authoritative for whether that
// principal may do anything. Verifying the signature locally would require
// OpenAI's JWKS and would not make the claim more trustworthy for
// authorization purposes.

const CODEX_HOME_DIR_NAME = '.codex';

function codexAuthPath(explicitPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  // REVA_CODEX_AUTH_PATH is the test/override seam. It replaces the Claude
  // Code plugin's REVA_CLAUDE_JSON_PATH, renamed because it no longer points
  // at anything named "claude" — see README "Environment variables".
  const override =
    explicitPath ||
    (env.REVA_CODEX_AUTH_PATH?.length ? env.REVA_CODEX_AUTH_PATH : undefined);
  if (override) return override;
  // CODEX_HOME overrides the location of the whole Codex home directory;
  // it defaults to ~/.codex (codex-rs/core/src/config/mod.rs).
  const codexHome = env.CODEX_HOME?.length ? env.CODEX_HOME : path.join(os.homedir(), CODEX_HOME_DIR_NAME);
  return path.join(codexHome, 'auth.json');
}

// JWTs use base64url without padding. Node's 'base64url' decoder handles
// both the alphabet and the missing padding.
function decodeJwtPayload(jwt: string): any | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

function emailFromClaims(claims: any): string | undefined {
  if (claims == null || typeof claims !== 'object') return undefined;
  const direct = claims.email;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const profile = claims['https://api.openai.com/profile'];
  const fromProfile = profile != null && typeof profile === 'object' ? profile.email : undefined;
  if (typeof fromProfile === 'string' && fromProfile.length > 0) return fromProfile;
  return undefined;
}

// The decoded id_token claims, or undefined. Both the human's email and the
// account id come from here, so the file is read and the JWT decoded once.
function readAuthClaims(authPath?: string, env: NodeJS.ProcessEnv = process.env): any | undefined {
  try {
    const raw = fs.readFileSync(codexAuthPath(authPath, env), 'utf8');
    const idToken = JSON.parse(raw)?.tokens?.id_token;
    if (typeof idToken !== 'string' || !idToken) return undefined;
    return decodeJwtPayload(idToken);
  } catch {
    return undefined;
  }
}

// auth.json's own `tokens.account_id` — the same identifier as the id_token's
// `chatgpt_account_id` claim, stored as a plain field (no JWT decoding needed).
function readTokensAccountId(authPath?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const raw = fs.readFileSync(codexAuthPath(authPath, env), 'utf8');
    const value = JSON.parse(raw)?.tokens?.account_id;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

// The ChatGPT ACCOUNT id backing the Cedar `Agent` entity — stable across
// every machine that account logs in from.
//
// Sourced from the `chatgpt_account_id` claim (under
// `https://api.openai.com/auth`) of auth.json's id_token, falling back to
// auth.json's own `tokens.account_id`, which holds the same value.
//
// What this id is: Codex describes it as the "Organization/workspace
// identifier" the token was issued for (codex-rs/login/src/token_data.rs). On
// a personal plan it maps one-to-one to a person; on a Team / Business /
// Enterprise workspace every member of that workspace shares it, and one person
// in several workspaces has a different id in each. That is the intended scope
// of the Agent: it is the ChatGPT account, not the individual. Who is acting is
// carried by the User entity (email) and the Agent's `user` attribute, which is
// written once at creation and so names the first member to appear.
//
// Deliberately NOT the machine id: a hardware-rooted Agent fragments one
// account into a separate Agent entity per machine it logs in from. Machine
// identity is a genuinely different concept with its own resolver and its own
// legitimate fallback chain — see resolveMachineId() in deviceId.ts. Nor does
// this fall back to the per-person `chatgpt_user_id`: an install that resolved
// to one kind of id on some runs and another on others would split one Agent in
// two.
export function readCodexAccountId(authPath?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const claims = readAuthClaims(authPath, env);
  const auth = claims != null && typeof claims === 'object' ? claims['https://api.openai.com/auth'] : undefined;
  const fromClaim = auth != null && typeof auth === 'object' ? auth.chatgpt_account_id : undefined;
  if (typeof fromClaim === 'string' && fromClaim.length > 0) return fromClaim;
  return readTokensAccountId(authPath, env);
}

export const MISSING_ACCOUNT_ID_MESSAGE =
  'Reva governance cannot resolve a stable account id for this Codex install. The Agent entity is keyed by ' +
  'the ChatGPT account id so it stays the same across every machine that account uses — a machine or random ' +
  'id would silently fragment that. This normally means Codex is signed in with an API key rather than a ChatGPT ' +
  'account, or its auth material lives in an OS keyring rather than $CODEX_HOME/auth.json. Sign in with a ' +
  'ChatGPT account, or set REVA_AGENT_ID explicitly to the account id this install should report.';

// Exported for direct testing against a fixture auth.json.
export function readCodexAccountEmail(authPath?: string): string | undefined {
  try {
    return emailFromClaims(readAuthClaims(authPath));
  } catch {
    // file missing, unreadable, malformed, no tokens.id_token, or an
    // unparseable JWT — fall through to the OS-username fallback.
    //
    // This is also the normal path for two legitimate configurations, not
    // just for errors:
    //   - API-key auth (OPENAI_API_KEY), which carries no email at all;
    //   - installs where the auth material lives in a secrets backend /
    //     OS keyring rather than a plaintext auth.json (AuthDotJson
    //     supports both).
    return undefined;
  }
}

export function resolveUserEmail(): string {
  const accountEmail = readCodexAccountEmail();
  if (accountEmail) return accountEmail;
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown-user';
  }
}

// Which Codex surface this session is running on, reported as
// context.sessionEntryPoint on every request.
//
// Codex sets CODEX_INTERNAL_ORIGINATOR_OVERRIDE in the hook process
// environment. Measured on 0.151.0 across both surfaces:
//   Codex Desktop -> "Codex Desktop"
//   Codex CLI     -> unset
//
// The value is passed through VERBATIM rather than remapped, so this field
// always reports what the host actually said. "Codex Desktop" is the only
// value confirmed by observation.
//
// UNSET IS NOT THE SAME AS "CLI", so the CLI is identified by its OWN
// positive marker rather than by the absence of the desktop one. The npm/
// bun/pnpm launcher (@openai/codex/bin/codex.js) stamps the environment
// before exec'ing the real binary:
//
//   const env = { ...process.env, CODEX_MANAGED_PACKAGE_ROOT: codexPackageRoot };
//   env[packageManagerEnvVar] = "1";   // CODEX_MANAGED_BY_{NPM,BUN,PNPM}
//
// CODEX_MANAGED_PACKAGE_ROOT is set for all three package managers, so one
// check covers them. Measured across 55 real hook invocations on 0.151.0:
//
//   marker                       desktop   CLI
//   CODEX_INTERNAL_ORIGINATOR_…    26/26   0/29
//   CODEX_MANAGED_PACKAGE_ROOT      0/26  29/29
//
// Perfect separation in both directions, and each branch below is backed by
// evidence that something IS present — never by inference from absence.
//
// 'unknown' remains for the cases neither marker covers, and those are real:
// a standalone-binary CLI install (Homebrew, direct download) goes through
// no launcher and stamps nothing, and an MCP-driven session sets neither.
// Reporting 'unknown' there is deliberate — better an honest gap than a
// wrong-but-plausible label in a field policies match on.
//
// KNOWN IMPRECISION: `codex exec` runs through the same launcher, so it is
// reported as 'cli' too. codex-rs's SessionSource distinguishes Cli
// from Exec, but that enum is not exposed to hook processes; from the
// launcher's point of view both are the CLI package.
//
// IDE: Codex running inside an editor — typed into the editor's integrated
// terminal, or driven by the Codex extension's chat panel — reports
// 'ide-<editor>' ('ide-vscode', 'ide-cursor', 'ide-windsurf'). Both cases
// get the same value; the agent itself is already named by agentType.
//
// Being in an editor is detected from two markers the editor itself sets:
//   - TERM_PROGRAM=vscode in every integrated-terminal shell (VS Code forks
//     such as Cursor and Windsurf set the same value, so it cannot name the
//     editor; a multiplexer like tmux inside the terminal overwrites it);
//   - VSCODE_CODE_CACHE_PATH in the extension host, which the Codex
//     extension passes on to the codex process it spawns.
// Which editor is read from the editor's user-data folder — see
// resolveEditor(). The extension's own originator ('codex_vscode') is the
// same constant in every editor, so it is not used.
//
// The editor check runs BEFORE the originator: the extension sets an
// originator too, and this ordering is what lets the plugin ignore it.
// Accepted edge: a desktop app started from an editor's terminal inherits
// TERM_PROGRAM and reports 'ide-<editor>' rather than 'Codex Desktop'.
//
// THESE STRINGS ARE POLICY-VISIBLE: a Cedar policy or dashboard filter
// matches them exactly, so renaming any of them is a breaking change.
export const UNKNOWN_ENTRYPOINT = 'unknown';
export const CLI_ENTRYPOINT = 'cli';
// Inside an editor whose name could not be read. Deliberately no default
// editor: guessing 'vscode' would mislabel Cursor or Windsurf.
export const IDE_ENTRYPOINT = 'ide';
export const IDE_ENTRYPOINT_PREFIX = 'ide-';

function inEditor(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VSCODE_CODE_CACHE_PATH?.trim()) || env.TERM_PROGRAM?.trim().toLowerCase() === 'vscode';
}

// The path segment just before `marker` ('Code' in ...\Code\CachedData\...).
// Split on both separators so a Windows path parses the same on any OS.
function segmentBefore(value: string | undefined, marker: string): string | undefined {
  const parts = (value || '').split(/[\\/]+/);
  const index = parts.findIndex((p) => p.toLowerCase() === marker.toLowerCase());
  return index > 0 && parts[index - 1].trim() ? parts[index - 1].trim() : undefined;
}

// The editor's executable name: Code.exe -> Code, and on macOS
// "Code Helper (Plugin)" -> Code.
function executableName(value: string | undefined): string | undefined {
  const base = (value || '').split(/[\\/]+/).pop()?.trim() || '';
  const name = base.replace(/\.exe$/i, '').replace(/ Helper\b.*$/, '').trim();
  return name || undefined;
}

// Which editor, from the user-data folder each editor keeps its state in
// ("Code", "Code - Insiders", "Cursor", "Windsurf" — the same name on
// Windows, macOS and Linux), with the executable name as a last resort:
//   extension host: VSCODE_CODE_CACHE_PATH  = ...\Code\CachedData\<hash>
//   terminal:       VSCODE_GIT_ASKPASS_MAIN = ...\Code\User\globalStorage\...
//                   VSCODE_GIT_ASKPASS_NODE = ...\Microsoft VS Code\Code.exe
// Both observed live on VS Code 1.143.1 / Windows. Returns undefined when
// nothing names the editor (e.g. Git terminal authentication turned off).
export function resolveEditor(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw =
    segmentBefore(env.VSCODE_CODE_CACHE_PATH, 'CachedData') ||
    segmentBefore(env.VSCODE_GIT_ASKPASS_MAIN, 'User') ||
    executableName(env.VSCODE_GIT_ASKPASS_NODE);
  if (!raw) return undefined;
  const name = raw.toLowerCase().replace(/\s+/g, ' ');
  if (name === 'code') return 'vscode';
  if (name === 'code - insiders' || name === 'code-insiders') return 'vscode-insiders';
  return name.replace(/ /g, '-');
}

export function resolveSessionEntrypoint(env: NodeJS.ProcessEnv = process.env): string {
  // 1. Inside an editor: its terminal or the Codex extension's chat panel.
  if (inEditor(env)) {
    const editor = resolveEditor(env);
    return editor ? IDE_ENTRYPOINT_PREFIX + editor : IDE_ENTRYPOINT;
  }

  // 2. A surface that names itself, passed through verbatim so a future
  //    surface reports itself rather than being bucketed into a known one.
  const originator = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE?.trim();
  if (originator) return originator;

  // 3. Otherwise, the CLI launcher's own marker.
  const launchedByPackageManager =
    env.CODEX_MANAGED_PACKAGE_ROOT?.trim() ||
    env.CODEX_MANAGED_BY_NPM?.trim() ||
    env.CODEX_MANAGED_BY_BUN?.trim() ||
    env.CODEX_MANAGED_BY_PNPM?.trim();
  if (launchedByPackageManager) return CLI_ENTRYPOINT;

  // 4. Nothing detectable. Let the operator declare it, because on some
  //    installs there is genuinely nothing to detect: a Homebrew or
  //    direct-download Codex runs no launcher wrapper, so neither marker
  //    above exists. Observed live — the same build reports 'cli' on an
  //    npm install and 'unknown' on a Homebrew one.
  //
  //    DELIBERATELY LAST, not first. As a fallback it only fills a real gap;
  //    promoted above the detection it would let a value exported for the CLI
  //    mislabel a desktop session that inherited the same environment. A
  //    surface that names itself always wins over a static declaration.
  const declared = env.REVA_SESSION_ENTRYPOINT?.trim();
  if (declared) return declared;

  // 5. Nothing detected and nothing declared — say so rather than guess.
  return UNKNOWN_ENTRYPOINT;
}

// "AgentContext" here means "the calling entity's context" (main session vs
// subagent) — a naming coincidence with the Cedar `Agent` entity type, not
// a reference to it; don't conflate the two.
export interface AgentContext {
  agentId: string;
  isSubAgent: boolean;
  subAgentId?: string;
  subAgentType?: string;
}

// Codex populates agent_id/agent_type on the hook input when a tool call
// originates inside a thread-spawn subagent; their absence means this is a
// top-level session tool call.
//
// UNVERIFIED against a real payload: the 0.151.0 capture session made no
// spawn_agent call and no record carried agent_id. The fields are declared
// optional on the PreToolUse/PostToolUse input schemas and required on
// SubagentStart, but this plugin has not observed one. See hopChain.ts.
export function resolveAgentContext(
  configuredAgentId: string,
  hookInput: { agent_id?: string; agent_type?: string },
): AgentContext {
  const isSubAgent = Boolean(hookInput.agent_id);
  return {
    agentId: configuredAgentId,
    isSubAgent,
    subAgentId: hookInput.agent_id,
    subAgentType: hookInput.agent_type,
  };
}
