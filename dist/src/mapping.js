"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BASH_RESOURCES = exports.DELETE_ACTION = void 0;
exports.extractShellTargets = extractShellTargets;
exports.parseApplyPatchTargets = parseApplyPatchTargets;
exports.canonicalToolName = canonicalToolName;
exports.mapToolToCedar = mapToolToCedar;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const mcpConfig_1 = require("./mcpConfig");
const mcpServerIdentity_1 = require("./mcpServerIdentity");
// ---------------------------------------------------------------------------
// Codex tool surface -> Cedar action/resource.
//
// Confirmed tool identities (codex-rs/core/src/tools/hook_names.rs and the
// per-handler pre_tool_use_payload implementations, rust-v0.151.0), and
// corroborated by a real 12-call capture on Codex 0.151.0 / Windows 11 /
// gpt-5.6-terra / permission_mode "default":
//
//   exec_command  -> tool_name "Bash",        tool_input { command: <string> }
//   apply_patch   -> tool_name "apply_patch", tool_input { command: <patch text> }
//   MCP tools     -> tool_name "mcp__<server>__<tool>"
//   spawn_agent   -> tool_name "spawn_agent"
//
// THE BIG DIFFERENCE FROM CLAUDE CODE: Codex has no Read, Glob or Grep tool
// at all. Reads and searches run through the shell, so they arrive as
// executeBash. Cedar `read`/`glob`/`grep` are therefore UNREACHABLE on
// Codex — they are not rare here, they are impossible. This file does not
// pretend otherwise: it never infers `read` from a `Get-Content`, because
// inferring the ACTION from a command string is a much stronger claim than
// inferring the resource, and getting it wrong in the permissive direction
// would build a bypass with a convincing audit trail behind it. See the
// "Cross-agent policy divergence" section of the README.
// ---------------------------------------------------------------------------
// A deletion has no dedicated Cedar action in the CodingAgent schema, whose
// verbs are executeBash/read/write/edit/glob/grep/invokeTool/spawn/
// invokeAgent. `write` is the interim stand-in, isolated behind this single
// constant so it can be flipped to a real `delete` action (or to a deny)
// without touching any call site.
//
// KNOWN, DOCUMENTED FAILURE while this stands: a policy that grants `write`
// on a directory implicitly grants DELETION of everything in it. "Can create
// files here" is not "can delete files here", and no policy author reading
// the Cedar schema would expect those to be the same permission. Tracked as
// the first entry under "Schema requests for the Reva side" in the README.
exports.DELETE_ACTION = 'write';
// One Bash call in the capture chained 4-6 commands; the widest touched six
// distinct paths. Ten leaves real headroom above that while still bounding
// the fan-out. THIS CONSTANT HAS POLICY SIGNIFICANCE: above it, the call is
// denied outright rather than partially evaluated, so raising it widens how
// much a single command can do per RTG round trip and lowering it makes
// legitimate wide commands fail. It is not a performance knob.
exports.MAX_BASH_RESOURCES = 10;
// Fallback only — an extension-based guess misclassifies real extensionless
// files (/etc/hosts, Makefile, Dockerfile) as directories. Used only when the
// path doesn't exist on disk yet (e.g. a file a patch is about to create).
function looksLikeFile(pathValue) {
    const base = pathValue.replace(/\\/g, '/').split('/').pop() || '';
    return base.includes('.') && !base.startsWith('.');
}
// The hook runs on the same machine as the actual repo, so prefer a real
// stat over guessing from the path string whenever the path already exists.
function classifyPath(absolutePath) {
    try {
        return fs.statSync(absolutePath).isDirectory() ? 'Directory' : 'File';
    }
    catch {
        return looksLikeFile(absolutePath) ? 'File' : 'Directory';
    }
}
function existsSafe(absolutePath) {
    try {
        return fs.existsSync(absolutePath);
    }
    catch {
        return false;
    }
}
// Directory portion of a glob pattern, stopping at the first wildcard
// segment — a Cedar policy on a literal folder path can never match a
// resource id that still contains "**" or "*" as a path segment.
function literalDirOf(patternValue) {
    const segments = patternValue.replace(/\\/g, '/').split('/');
    const literal = [];
    for (const seg of segments) {
        if (/[*?{}[\]]/.test(seg))
            break;
        literal.push(seg);
    }
    // If nothing was a wildcard, the last segment is the filename itself, not
    // a directory — drop it so we return the containing directory.
    if (literal.length === segments.length && literal.length > 0) {
        literal.pop();
    }
    return literal.join('/') || '.';
}
function hasWildcard(value) {
    return /[*?]/.test(value);
}
// path.resolve does NOT do shell-style "~" expansion — it treats "~" as a
// literal folder name. Without this, a command like
// "Set-Content ~/Desktop/file.txt" resolves against cwd as if "~" were a
// real subdirectory *inside* the repo, which then incorrectly gets a
// Repository ancestor for a file that isn't in the repo at all — a real
// policy bypass, not just a cosmetic bug. Handled explicitly because
// PowerShell expands "~" to the home directory too, so the same bypass
// exists on this target.
// Only handles the current user's home ("~" or "~/..." or "~\..."); other
// users' homes are left unexpanded (rare, and Node has no simple builtin).
function expandHome(pathValue) {
    if (pathValue === '~')
        return os.homedir();
    if (pathValue.startsWith('~/') || pathValue.startsWith('~\\')) {
        return path.join(os.homedir(), pathValue.slice(2));
    }
    return pathValue;
}
function resolveAgainst(cwd, pathValue) {
    return path.resolve(cwd, expandHome(pathValue));
}
// Walks up from cwd looking for a `.git` entry to find the repo root.
function findRepoRoot(startDir) {
    let dir = startDir;
    for (;;) {
        if (existsSafe(path.join(dir, '.git')))
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
// Cedar policies are authored once against a portable id like
// "domain-services/utility/agents.md" so the same policy applies no matter
// whose machine or home directory the repo is cloned into — an absolute
// path like "C:\Users\alice\repos\domain-services\..." is specific to one
// person's machine and could never be referenced from a policy meant to
// apply to every developer. Falls back to the raw absolute path only when
// no git repo root can be found, or the path falls outside it entirely.
function toPortableId(absolutePath, cwd) {
    const repoRoot = findRepoRoot(cwd);
    if (!repoRoot)
        return absolutePath;
    const repoName = path.basename(repoRoot);
    const rel = path.relative(repoRoot, absolutePath);
    if (rel === '')
        return repoName;
    if (rel.startsWith('..'))
        return absolutePath;
    return `${repoName}/${rel.split(path.sep).join('/')}`;
}
function baseName(pathValue) {
    return pathValue.replace(/\\/g, '/').split('/').pop() || pathValue;
}
function extension(pathValue) {
    const base = baseName(pathValue);
    const idx = base.lastIndexOf('.');
    return idx > 0 ? base.slice(idx + 1) : undefined;
}
// File/Directory entities declare `name`/`path` as required attributes in
// the CodingAgent schema — these helpers keep that consistent everywhere a
// File or Directory resource gets built. Operate on the portable id, same
// as resourceId, so nothing machine-specific leaks into these either.
function fileProperties(portableId) {
    const ext = extension(portableId);
    return { name: baseName(portableId), ...(ext ? { extension: ext } : {}) };
}
function directoryProperties(portableId) {
    return { path: portableId };
}
// The RTG expects a FLAT list of every ancestor, not just the immediate
// parent — Cedar's `in` needs the whole chain present to match a policy
// like `resource in Directory::"domain-services"` regardless of how deep
// the file actually is. No ancestor chain for the absolute-path fallback
// (outside any repo) — there's no meaningful Directory/Repository lineage
// to report for those.
function buildAncestorParents(portableId) {
    // path.isAbsolute (not a bare '/' check) so the fallback is recognized on
    // Windows too, where toPortableId()'s absolute-path fallback returns a
    // raw "C:\Users\..." path rather than a POSIX-style one.
    if (path.isAbsolute(portableId))
        return [];
    const segments = portableId.split('/');
    const repoName = segments[0];
    if (!repoName)
        return [];
    const parents = [];
    for (let i = segments.length - 1; i > 1; i--) {
        parents.push({ type: 'Directory', id: segments.slice(0, i).join('/') });
    }
    if (segments.length > 1) {
        parents.push({ type: 'Directory', id: repoName });
    }
    parents.push({ type: 'Repository', id: repoName });
    return parents;
}
function resourceMapping(actionName, absolutePath, cwd, forceType, extras = {}) {
    const id = toPortableId(absolutePath, cwd);
    const type = forceType || classifyPath(absolutePath);
    return {
        actionName,
        resourceType: type,
        resourceId: id,
        resourceProperties: type === 'File' ? fileProperties(id) : directoryProperties(id),
        resourceParents: buildAncestorParents(id),
        ...extras,
    };
}
// Quote-aware scan producing one entry per command segment. Segment breaks
// are ';', '|' and newlines OUTSIDE quotes — critical, because a regex
// argument like "liked|Like|songRoutes" contains a pipe that must not split
// the command.
function scanSegments(command) {
    const segments = [];
    let tokens = [];
    let current = '';
    let quote;
    const endToken = () => {
        if (current)
            tokens.push(current);
        current = '';
    };
    const endSegment = () => {
        endToken();
        if (tokens.length)
            segments.push({ tokens });
        tokens = [];
    };
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            if (ch === quote) {
                quote = undefined;
            }
            else {
                current += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            // Remember that this token was quoted by keeping its content only;
            // the quote characters themselves never reach the candidate test.
            continue;
        }
        if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
            endSegment();
            continue;
        }
        if (ch === ' ' || ch === '\t') {
            endToken();
            continue;
        }
        current += ch;
    }
    endSegment();
    return segments;
}
// Decides whether one already-unquoted token names a filesystem path.
//
// Ordering matters: "does it exist on disk" is the strongest available
// signal and is checked first, so a real path containing awkward characters
// (Windows' "Program Files (x86)") is still recognized while an expression
// that merely looks path-ish ("require('./routes/x')") is not.
function isPathCandidate(token, cwd) {
    if (!token)
        return false;
    // Cmdlet parameters (-Raw, -ErrorAction), variables ($env:X), splats (@x),
    // and cmd-style variables (%FOO%) are never resources.
    if (/^[-$`@%]/.test(token))
        return false;
    if (existsSafe(resolveAgainst(cwd, token)))
        return true;
    // Characters that appear in expressions, redirections and regexes but
    // effectively never in a path that does not already exist.
    if (/[()'"=|<>;&{}]/.test(token))
        return false;
    if (token.includes('/') || token.includes('\\'))
        return true;
    const base = baseName(token);
    const dot = base.lastIndexOf('.');
    return dot > 0 && dot < base.length - 1;
}
// Every distinct filesystem path a shell command appears to touch, deduped
// by resolved absolute path and preserving first-seen order.
function extractShellTargets(command, cwd) {
    const seen = new Set();
    const targets = [];
    for (const segment of scanSegments(command)) {
        // Token 0 of each segment is the command/cmdlet name, not a resource.
        for (const rawToken of segment.tokens.slice(1)) {
            // PowerShell accepts comma-separated path lists:
            //   Get-ChildItem routes,controllers,models
            for (const piece of rawToken.split(',')) {
                const token = piece.trim();
                if (!isPathCandidate(token, cwd))
                    continue;
                // A wildcard must never survive into a resource id — no real folder
                // is named "*", so no path policy could ever match one.
                const literal = hasWildcard(token) ? literalDirOf(token) : token;
                const absolute = resolveAgainst(cwd, literal);
                if (seen.has(absolute))
                    continue;
                seen.add(absolute);
                targets.push(absolute);
            }
        }
    }
    return targets;
}
// ---------------------------------------------------------------------------
// apply_patch envelope parsing.
//
// Grammar markers confirmed in codex-rs/apply-patch/src/parser.rs at
// rust-v0.151.0:
//   "*** Begin Patch" / "*** End Patch" / "*** End of File"
//   "*** Environment ID: " <name>
//   "*** Add File: "    <path>
//   "*** Delete File: " <path>
//   "*** Update File: " <path>   (optionally followed by "*** Move to: " <path>)
//
// Paths appear in both absolute and repo-relative form, so each is resolved
// against cwd (path.resolve leaves an already-absolute path alone).
// ---------------------------------------------------------------------------
const ADD_FILE_MARKER = '*** Add File: ';
const DELETE_FILE_MARKER = '*** Delete File: ';
const UPDATE_FILE_MARKER = '*** Update File: ';
const MOVE_TO_MARKER = '*** Move to: ';
function parseApplyPatchTargets(patchText, cwd) {
    const targets = [];
    // An Update hunk's action is not known until we see whether a "Move to:"
    // line follows it, so it is held back until the next marker or EOF.
    let pendingUpdate;
    const flushPendingUpdate = () => {
        if (pendingUpdate !== undefined) {
            targets.push({ actionName: 'edit', absolutePath: resolveAgainst(cwd, pendingUpdate) });
            pendingUpdate = undefined;
        }
    };
    for (const rawLine of patchText.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (line.startsWith(ADD_FILE_MARKER)) {
            flushPendingUpdate();
            targets.push({ actionName: 'write', absolutePath: resolveAgainst(cwd, line.slice(ADD_FILE_MARKER.length).trim()) });
        }
        else if (line.startsWith(DELETE_FILE_MARKER)) {
            flushPendingUpdate();
            targets.push({
                actionName: exports.DELETE_ACTION,
                absolutePath: resolveAgainst(cwd, line.slice(DELETE_FILE_MARKER.length).trim()),
            });
        }
        else if (line.startsWith(UPDATE_FILE_MARKER)) {
            flushPendingUpdate();
            pendingUpdate = line.slice(UPDATE_FILE_MARKER.length).trim();
        }
        else if (line.startsWith(MOVE_TO_MARKER)) {
            // A move is genuinely TWO resources: the content leaves the source and
            // arrives at the destination. Composing them under deny-if-any is the
            // only way a policy protecting either end actually holds.
            const destination = line.slice(MOVE_TO_MARKER.length).trim();
            if (pendingUpdate !== undefined) {
                targets.push({ actionName: exports.DELETE_ACTION, absolutePath: resolveAgainst(cwd, pendingUpdate) });
                pendingUpdate = undefined;
            }
            targets.push({ actionName: 'write', absolutePath: resolveAgainst(cwd, destination) });
        }
    }
    flushPendingUpdate();
    // Dedupe on action+path: the same file updated twice in one patch is one
    // resource, but the same path appearing as both a delete and a write
    // (a move onto itself) stays two.
    const seen = new Set();
    return targets.filter((t) => {
        const key = `${t.actionName}\u0000${t.absolutePath}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function mapBash(toolInput, cwd) {
    const command = toolInput.command || '';
    const targets = extractShellTargets(command, cwd);
    // No identifiable path: the working directory is the honest resource.
    if (targets.length === 0) {
        return {
            mappings: [resourceMapping('executeBash', path.resolve(cwd), cwd, 'Directory', { command })],
            candidateCount: 0,
        };
    }
    if (targets.length > exports.MAX_BASH_RESOURCES) {
        // Deliberately NOT degraded to a common-ancestor directory. Widening the
        // resource upward destroys the Cedar `in` relationship that path-scoped
        // policies rely on, so an over-wide command would come back allowed
        // against a policy that should have denied it. Denying and asking for a
        // narrower command fails in the visible direction instead.
        return { mappings: [], candidateCount: targets.length, overCap: true };
    }
    return {
        mappings: targets.map((absolute) => resourceMapping('executeBash', absolute, cwd, undefined, { command })),
        candidateCount: targets.length,
    };
}
function mapApplyPatch(toolInput, cwd) {
    const patchText = toolInput.command || '';
    const targets = parseApplyPatchTargets(patchText, cwd);
    return {
        // Every path is exact (parsed from a structured envelope, not guessed),
        // N is bounded by the patch itself, and every one is a mutation — so
        // this set is evaluated in full, uncapped.
        //
        // An empty result means the envelope could not be understood at all. The
        // caller denies rather than guessing: a mutation whose target cannot be
        // identified is exactly the case that must not pass silently.
        mappings: targets.map((t) => resourceMapping(t.actionName, t.absolutePath, cwd, 'File', { tool: 'apply_patch' })),
        candidateCount: targets.length,
    };
}
function mapMcpTool(toolName, configPath) {
    const parts = toolName.split('__');
    const token = parts[1] || 'unknown-server';
    const tool = parts.slice(2).join('__') || toolName;
    // Slug so this matches what mcpConfig / ingest write as the MCPServer
    // entity id. Fully fault-tolerant inside (see mcpServerIdentity.ts).
    const slug = (0, mcpServerIdentity_1.slugifyMcpServerName)(token) || token;
    // The url, when config.toml has one for this server — readAllMcpServers
    // is a cheap, synchronous, best-effort read (see mcpConfig.ts), so this is
    // safe to do on every MCP tool call rather than needing a cache. A miss
    // just means "not configured with a url" (a stdio server, an app-provided
    // one, or one not yet in config.toml) — never a fabricated url.
    const knownUrl = (0, mcpConfig_1.readAllMcpServers)(configPath).find((entry) => entry.name === slug)?.url;
    const server = (0, mcpServerIdentity_1.resolveMcpServerIdentity)(token, knownUrl);
    const label = server.displayName || server.slug;
    return {
        mappings: [
            {
                actionName: 'invokeTool',
                resourceType: 'Tool',
                resourceId: `${server.slug}/${tool}`,
                // name/description are required on Tool; the hook input doesn't give
                // us a real description, so this is synthesized from what is
                // genuinely known rather than invented.
                resourceProperties: { name: tool, description: `MCP tool "${tool}" on server "${label}"`, connectionType: 'mcp' },
                resourceParents: [{ type: 'MCPServer', id: server.slug }],
                // No known url for this server — never ingested (see
                // ingestionClient.ts) and RTG has no MCPServer entity to evaluate
                // this call against. Covers a stdio server, an app-provided one, or
                // one simply not yet discovered. authorize.ts/authorizePost.ts treat
                // this as out of governance scope entirely: true pass-through, no
                // RTG call.
                ...(server.url ? {} : { skipReason: `MCP server "${label}" has no known URL — not evaluated` }),
            },
        ],
        candidateCount: 1,
    };
}
function mapSpawnAgent(toolInput) {
    // UNVERIFIED field name: no spawn_agent call was captured on 0.151.0, so
    // which key carries the agent type is not confirmed. The plausible keys
    // are tried and 'subagent' is the honest fallback — deliberately NOT
    // `task_name`, which names the task, not the agent type, and would put a
    // fabricated value in a Cedar resource id.
    const subagentType = toolInput.agent_type || toolInput.subagent_type || toolInput.subagentType || 'subagent';
    return {
        mappings: [
            {
                actionName: 'spawn',
                resourceType: 'SubAgent',
                resourceId: subagentType,
                resourceProperties: { agentType: subagentType },
            },
        ],
        candidateCount: 1,
    };
}
// Codex exposes some tools to the model inside a namespace, and the hook
// payload's tool_name is namespace + name concatenated with NO separator.
// Captured live on CLI 0.162.1: the rollout records
//   {"name":"spawn_agent","namespace":"collaboration"}
// while the hook receives tool_name "collaborationspawn_agent". Without this,
// spawns fall through to the generic invokeTool fallback below, so the
// `spawn` action, the SubAgent resource and context.subagentIndex are never
// sent and a per-turn spawn cap can never fire.
//
// Only exact, known namespaced forms are stripped back to the official tool
// name — never a prefix/suffix match — so an unrelated tool whose name merely
// contains "spawn_agent" can't be promoted into a spawn.
const NAMESPACED_TOOL_NAMES = {
    collaborationspawn_agent: 'spawn_agent',
};
function canonicalToolName(toolName) {
    return NAMESPACED_TOOL_NAMES[toolName] ?? toolName;
}
function mapToolToCedar(toolName, toolInput, cwd, configPath) {
    if (toolName === 'Bash')
        return mapBash(toolInput, cwd);
    if (toolName === 'apply_patch')
        return mapApplyPatch(toolInput, cwd);
    if (toolName.startsWith('mcp__'))
        return mapMcpTool(toolName, configPath);
    if (toolName === 'spawn_agent')
        return mapSpawnAgent(toolInput);
    // The registered matcher only routes Bash/apply_patch/mcp__*/spawn_agent,
    // so nothing else should reach this. Codex matches a non-exact matcher as
    // an UNANCHORED regex, though, so a tool whose name merely contains one of
    // those substrings can arrive — a safe generic fallback beats dropping it.
    return {
        mappings: [
            {
                actionName: 'invokeTool',
                resourceType: 'Tool',
                resourceId: toolName,
                resourceProperties: { name: toolName, description: `Codex tool: ${toolName}` },
            },
        ],
        candidateCount: 1,
    };
}
