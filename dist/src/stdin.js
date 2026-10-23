"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readStdin = readStdin;
// UTF-8 standard-input reader for hook payloads.
function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        // A leading UTF-8 BOM is stripped before the caller sees the payload.
        //
        // This strip exists for Windows. Codex itself serializes hook stdin
        // with serde and never emits a BOM, but PowerShell 5.1 DOES: piping a
        // file into a native process (`Get-Content x.json | node hook.js`)
        // re-encodes through $OutputEncoding and prepends U+FEFF. Without this,
        // the documented manual-fixture workflow fails with
        // `Unexpected token '﻿'` — and because every entrypoint fails
        // CLOSED, that surfaces as a governance deny rather than as the encoding
        // problem it actually is.
        //
        // JSON.parse rejects a leading BOM by spec, so this cannot mask a real
        // malformed payload: it removes exactly one leading U+FEFF and nothing
        // else.
        process.stdin.on('end', () => resolve(data.charCodeAt(0) === 0xfeff ? data.slice(1) : data));
        process.stdin.on('error', reject);
    });
}
