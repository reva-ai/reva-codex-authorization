// Tiny CLI used only by spawnCounter.test.ts's concurrency test: calling
// nextSpawnIndex() directly within one test process can't exercise the
// cross-process lock at all (it's synchronous — nothing else can run
// "at the same time" in a single Node process). This script lets the test
// fire off many *real* OS processes against the same session/dir and see
// whether the lock actually serializes them.
import { nextSpawnIndex } from '../../src/spawnCounter';

const [sessionId, dataDir] = process.argv.slice(2);
process.stdout.write(String(nextSpawnIndex(sessionId, dataDir)));
