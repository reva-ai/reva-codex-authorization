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
exports.resolveDataDir = resolveDataDir;
exports.stateDir = stateDir;
exports.safeFileName = safeFileName;
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
// Where the file-backed per-session caches (turns, hops, spawns,
// active-sessions, entity-types) live.
//
// Codex sets PLUGIN_DATA — a per-plugin writable directory — for hooks that
// come from a plugin bundle, and also sets CLAUDE_PLUGIN_DATA to the same
// value purely for out-of-the-box compatibility with plugins built for
// other hosts (confirmed in codex-rs/hooks/src/engine/discovery.rs, which
// comments the alias as exactly that). We read PLUGIN_DATA first because
// it is the real Codex name, and accept the alias so a mixed install still
// works.
//
// IMPORTANT: those variables are injected ONLY for plugin-bundled hooks.
// A hook registered by hand in ~/.codex/hooks.json gets neither — discovery
// passes `env: HashMap::new()` for every non-plugin source — so the
// home-directory fallback below is a real code path, not defensive padding.
//
// The fallback directory is deliberately NOT shared with a Reva governance
// plugin for a different host, which may well be installed on the same
// machine. activeSessions.ts is keyed by the machine's hardware id: sharing
// a directory would make each agent count the other's sessions, changing
// the `activeSessionCount` a Cedar policy sees. Each plugin reports only
// its own agent's sessions.
const FALLBACK_DIR_NAME = '.codex-governance';
function resolveDataDir(env = process.env) {
    const fromPlugin = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
    if (fromPlugin && fromPlugin.trim())
        return fromPlugin;
    return path.join(os.homedir(), FALLBACK_DIR_NAME);
}
// One named subdirectory of the data dir. Callers pass an explicit
// `dataDir` in tests (a temp directory) so nothing ever touches the real one.
function stateDir(name, dataDir) {
    return path.join(dataDir || resolveDataDir(), name);
}
// Session ids and agent ids become file names, so anything that isn't
// clearly filesystem-safe is replaced. Shared by every cache module.
function safeFileName(value) {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
