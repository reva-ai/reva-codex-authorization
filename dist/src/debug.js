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
exports.debugLog = debugLog;
exports._resetDebugCacheForTests = _resetDebugCacheForTests;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const codexRevaConfig_1 = require("./codexRevaConfig");
const pluginPaths_1 = require("./pluginPaths");
const LOG_FILENAME = 'debug.log';
// Opt-in via REVA_DEBUG (env or ~/.codex/config.toml [reva] / [reva.env]).
// Always writes to stderr (unmodified — a live terminal watching a hook run
// directly still sees exactly this). Also appends a timestamped copy to
// PLUGIN_DATA/debug.log (via resolveDataDir): stderr alone isn't enough
// when Codex's TUI hides hook stderr. Timestamped on the file specifically
// because it accumulates across every hook invocation.
let cachedEnabled;
function debugEnabled() {
    if (cachedEnabled !== undefined)
        return cachedEnabled;
    const fromEnv = process.env.REVA_DEBUG?.trim();
    if (fromEnv && fromEnv !== '0' && fromEnv.toLowerCase() !== 'false') {
        cachedEnabled = true;
        return true;
    }
    cachedEnabled = Boolean((0, codexRevaConfig_1.readCodexRevaConfig)().debug);
    return cachedEnabled;
}
function debugLog(message) {
    if (!debugEnabled())
        return;
    process.stderr.write(`[reva-security] ${message}\n`);
    try {
        const dataDir = (0, pluginPaths_1.resolveDataDir)();
        fs.mkdirSync(dataDir, { recursive: true });
        fs.appendFileSync(path.join(dataDir, LOG_FILENAME), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    }
    catch {
        // best effort — this plugin's own logging must never itself crash a hook
    }
}
function _resetDebugCacheForTests() {
    cachedEnabled = undefined;
}
