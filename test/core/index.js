// Node resolves an explicit directory argument through index.js. Keep this
// static entrypoint so `node --test test/core` works without package changes.
import './json.test.js';
import './canonical-diff.test.js';
import './fingerprint.test.js';
import './aggregate.test.js';
import './policy.test.js';
import './risk.test.js';
import './redact.test.js';
import './anonymity.test.js';
import './digest.test.js';
import './minutes-template.test.js';
import './error-codes.test.js';
