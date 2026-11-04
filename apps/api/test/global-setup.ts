import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const TEST_DB = 'herp_api_test';
export const JWT_SECRET = 'test-secret-test-secret-test-secret-0123';

/** Fresh database per run: migrations + seed + RLS + herp_api role + fixtures. */
export default function setup() {
  execFileSync(resolve(__dirname, '../../../scripts/dev-db.sh'), [TEST_DB, '--fixtures'], { stdio: 'pipe' });
}
