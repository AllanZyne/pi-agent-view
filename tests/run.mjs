/**
 * Test entry point: node tests/run.mjs [--e2e]
 *
 * Unit tests are offline. The `--e2e` tests start real agents through the pi
 * SDK and therefore need working model credentials.
 */

import "./unit.storage.mjs";
import "./unit.view-model.mjs";
import "./unit.transcript-view.mjs";
import "./e2e.concurrency.mjs";
import { run } from "./harness.mjs";

await run();
