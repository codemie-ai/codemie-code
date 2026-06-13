import { config } from 'dotenv';
import { resolve } from 'node:path';

// override: true — file always wins over stale shell exports when running locally.
// On CI there is no .env.test.local, so CI env vars are never touched.
config({ path: resolve(process.cwd(), '.env.test.local'), override: true });
