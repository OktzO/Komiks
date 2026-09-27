// Self-check: scripts/migrate-all-4.sh migration safety, checked statically.
// The script is read and parsed, never executed against a database.
// The behaviour block below does execute the script, but only against a mocked
// `npx` on PATH in a temp dir — no real wrangler, no network, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scriptPath = join(root, 'scripts', 'migrate-all-4.sh');
const script = readFileSync(scriptPath, 'utf8');
const lines = script.split('\n');
const migrations = readdirSync(join(root, 'packages', 'db', 'migrations'));

const lineOf = (re, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l));

test('migrate script parses as bash', () => {
  const res = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 0, `bash -n failed: ${res.stderr}`);
});

test('0020 exists in packages/db/migrations and is referenced by the script', () => {
  assert.ok(migrations.includes('0020_admin_inventory.sql'), '0020 migration file exists');
  assert.match(script, /0020/, 'script names 0020');
});

test('apply() consults the _migrations ledger before running a file', () => {
  const applyBody = lineOf(/^apply\(\)\s*\{/);
  const ledgerCheck = lineOf(/ledger_has\s+"\$cfg"\s+"\$name"/);
  const execBody = lineOf(/npx wrangler d1 execute manga-db --remote --file/);
  assert.ok(applyBody > -1, 'apply() exists');
  assert.ok(ledgerCheck > applyBody, 'ledger pre-check lives inside apply()');
  assert.ok(ledgerCheck < execBody, 'ledger pre-check runs before the file is executed');
  assert.match(script, /SELECT 1 AS applied FROM _migrations WHERE name = '\$2' LIMIT 1/, 'ledger query looks up by name');
  assert.match(script, /INSERT OR IGNORE INTO _migrations \(name, applied_at\)/, 'applied files are recorded');
});

test('the ledger probe greps a result-only sentinel, not the echoed filename', () => {
  const start = lineOf(/^ledger_has\(\)\s*\{/);
  const body = lines.slice(start, lineOf(/^\}/, start)).join('\n');
  assert.match(body, /grep -q '"applied":'/, 'only a row from the result set counts as applied');
  assert.doesNotMatch(
    body,
    /grep -q "\$2"/,
    'the filename must never be the match target, or an echoed query fakes a hit',
  );
  assert.match(body, /--json/, 'clean JSON keeps echoed output out of the match path');
});

test('the ledger probe suppresses probe stderr', () => {
  // Behaviour is covered by the runScript cases below ("a failed ledger probe
  // with no output runs the file instead of skipping it"); this only pins the
  // noise suppression, which is cosmetic — stderr never reaches the grep pipe.
  const start = lineOf(/^ledger_has\(\)\s*\{/);
  const body = lines.slice(start, lineOf(/^\}/, start)).join('\n');
  assert.match(body, /2>\/dev\/null/, 'probe errors do not spam the operator log');
});

test('intentional ordering is preserved: 0018, 0001..0017, backfill, 0019, 0020', () => {
  const at0018 = lineOf(/0018_\*\.sql/);
  const atRange = lineOf(/0001 0002 0003/);
  const atBackfill = lineOf(/backfill_entity_decode\.sql/);
  const at0019 = lineOf(/0019_\*\.sql/);
  const at0020 = lineOf(/apply_0020 "\$cfg"/);
  assert.ok([at0018, atRange, atBackfill, at0019, at0020].every((i) => i > -1), 'all ordering stages present');
  assert.ok(at0018 < atRange, '0018 (ledger table) first');
  assert.ok(atRange < atBackfill, 'schema migrations before the backfill');
  assert.ok(atBackfill < at0019, 'backfill before the 0019 drop');
  assert.ok(at0019 < at0020, '0020 follows 0019, keeping 0019 the last drop');
});

test('0019 and 0020 both go through a ledger-guarded entry point', () => {
  assert.match(lines[lineOf(/0019_\*\.sql/)], /apply\s+"\$cfg"/, '0019 goes through the guarded apply()');
  assert.match(lines[lineOf(/apply_0020 "\$cfg"/)], /^\s*apply_0020 "\$cfg"$/, '0020 uses its own guarded entry point');
});

test('0020 is preflighted with PRAGMA table_info so the ADD COLUMN never replays', () => {
  const entry = lineOf(/^apply_0020\(\)\s*\{/);
  const guard = lineOf(/PRAGMA table_info\(lb_accounts\)/, entry);
  assert.ok(entry > -1, 'apply_0020 exists');
  assert.ok(guard > entry, 'the preflight lives inside apply_0020');
  assert.match(script, /last_tested_at/, 'the preflight looks for the column');
  const applyAfterGuard = lineOf(/^\s*apply\s+"\$cfg"\s+"\$f"/, guard);
  assert.ok(applyAfterGuard > -1, 'the file is applied only after the preflight');
  assert.equal(
    lineOf(/^\s*echo "skip .*last_tested_at/, guard) > -1,
    true,
    'an already-present column is reported as skipped'
  );
});

test('the ledger write path stays best-effort', () => {
  assert.match(script, /--config "\$[0-9a-z]+" >\/dev\/null 2>&1 \|\| true/, 'ledger insert never fails the run');
});

/* ----------------------------------------------------------------------- *
 * Behaviour: the guards must decide from the result set, never from echo,  *
 * and a failed migration must not exit 0. Mocked npx, no network, no D1.   *
 * ----------------------------------------------------------------------- */

const NPX_SHIM = `#!/usr/bin/env bash
# Mock wrangler. Never touches the network, never sees a real D1.
printf '%s\\n' "$*" >> "$MOCK_LOG"
args="$*"
list_has() {
  [ -z "$2" ] && return 1
  case ",$2," in *",$1,"*) return 0 ;; esac
  return 1
}
# The statement being run, compared by basename on both sides.
stmt=$(printf '%s' "$args" | sed 's/.*--file //;s/ .*//')
stmt=$(basename "$stmt")
queried=$(printf '%s' "$args" | sed "s/.*name = '//;s/'.*//")
echo_statement() {
  echo "Executing on remote database manga-db:"
  echo "$args"
}
case "$args" in
  *"INSERT OR IGNORE"*) exit 0 ;;
esac
case "$args" in
  *--file*)
    if list_has "$stmt" "\${MOCK_FAIL_FILES:-}"; then
      echo "Error: could not apply migration (mock failure)" >&2
      exit 1
    fi
    echo "executed on remote database (manga-db)"
    exit 0
    ;;
esac
case "$args" in
  *"SELECT 1 AS applied"*)
    if [ -n "\${MOCK_PROBE_FAIL:-}" ]; then
      echo "Error: authentication error [mock] (code: 10000)" >&2
      exit 1
    fi
    applied=0
    list_has "$queried" "\${MOCK_APPLIED:-}" && applied=1
    if [ "$applied" = 1 ] || [ -n "\${MOCK_ECHO_QUERY:-}" ]; then echo_statement; fi
    if [ "$applied" = 1 ]; then
      echo '[{"results":[{"applied":1}],"success":true,"meta":{}}]'
    else
      echo '[{"results":[],"success":true,"meta":{}}]'
    fi
    exit 0
    ;;
esac
case "$args" in
  *"PRAGMA table_info"*)
    if [ -n "\${MOCK_ECHO_QUERY:-}" ]; then echo_statement; fi
    case "\${MOCK_COLUMN:-}" in
      compact)
        echo '[{"results":[{"cid":6,"name":"last_tested_at","type":"INTEGER","notnull":0,"dflt_value":null,"pk":0}],"success":true,"meta":{}}]'
        ;;
      pretty)
        echo '[{"results":[{"cid":6,"name": "last_tested_at","type": "INTEGER","notnull":0,"dflt_value":null,"pk":0}],"success":true,"meta":{}}]'
        ;;
      *) echo '[{"results":[],"success":true,"meta":{}}]' ;;
    esac
    exit 0
    ;;
esac
exit 0
`;

// Runs the real script against a mocked npx. Returns the exit status, stdout
// and every argv string the mock was called with.
const runScript = ({
  applied = [],
  echoQuery = false,
  failFiles = [],
  probeFail = false,
  column = '',
  cfgCount = 1,
  tokens = null,
} = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-ledger-'));
  const shim = join(dir, 'npx');
  const log = join(dir, 'calls.log');
  writeFileSync(shim, NPX_SHIM);
  chmodSync(shim, 0o755);
  const cfgs = Array.from({ length: cfgCount }, (_, index) => {
    const path = join(dir, `fake${index + 1}.toml`);
    writeFileSync(path, `name = "fake${index + 1}"\n`);
    return path;
  });
  const res = spawnSync('bash', [scriptPath], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      MOCK_LOG: log,
      MOCK_APPLIED: applied.join(','),
      MOCK_ECHO_QUERY: echoQuery ? '1' : '',
      MOCK_FAIL_FILES: failFiles.join(','),
      MOCK_PROBE_FAIL: probeFail ? '1' : '',
      MOCK_COLUMN: column,
      WORKER_CFGS: cfgs.join(' '),
      // Tokens are positional: CF_TOKEN_AKUN{i} for the i-th config.
      ...Object.fromEntries(
        (tokens ?? ['dummy-token']).map((value, index) => [`CF_TOKEN_AKUN${index + 1}`, value]),
      ),
      CLOUDFLARE_API_TOKEN: '',
    },
  });
  let calls = '';
  try {
    calls = readFileSync(log, 'utf8');
  } catch {
    calls = '';
  }
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    calls: calls.split('\n').filter(Boolean),
    cfgs,
  };
};

const ledgerProbes = (calls) =>
  calls.filter((line) => line.includes('_migrations') && line.includes('SELECT'));

const pragmaProbes = (calls) => calls.filter((line) => line.includes('PRAGMA table_info'));

const executedFiles = (calls) =>
  calls
    .filter((line) => line.includes('--file '))
    .map((line) => line.split('--file ')[1].split(' ')[0]);

const ranFile = (calls, name) => executedFiles(calls).some((f) => f.endsWith(name));

/* --- ledger guard --------------------------------------------------- */

test('the ledger probe asks for JSON and greps a result-only sentinel', () => {
  const { calls } = runScript();
  const probes = ledgerProbes(calls);
  assert.ok(probes.length > 0, 'the script probed the ledger at least once');
  for (const probe of probes) {
    assert.match(probe, / --json /, `probe must request clean JSON: ${probe}`);
    assert.match(probe, /--command SELECT 1 AS applied/, `probe must select a sentinel key: ${probe}`);
    assert.doesNotMatch(
      probe,
      /SELECT name FROM _migrations/,
      `probe must not echo the migration filename as the matched value: ${probe}`,
    );
  }
});

test('a row returned by the ledger skips the file', () => {
  const { stdout, calls } = runScript({ applied: ['0018_migrations.sql'] });
  assert.match(stdout, /skip .*0018_migrations\.sql: already applied/);
  assert.equal(ranFile(calls, '0018_migrations.sql'), false, 'an already-applied file is never executed');
});

test('an empty result set does not skip the file', () => {
  const { calls } = runScript();
  assert.ok(ledgerProbes(calls).length > 0, 'a probe ran');
  assert.equal(ranFile(calls, '0018_migrations.sql'), true, 'an empty result means the file still has to run');
});

test('an echoed query containing the filename is not treated as a result', () => {
  const { stdout, calls } = runScript({ echoQuery: true });
  assert.ok(ledgerProbes(calls).length > 0, 'a probe ran');
  assert.equal(
    ranFile(calls, '0018_migrations.sql'),
    true,
    'the filename appearing in echoed output must not count as an applied row',
  );
  assert.equal(
    /0018_migrations\.sql: already applied/.test(stdout),
    false,
    'no file may be skipped on the strength of an echoed query',
  );
});

test('a failed ledger probe with no output runs the file instead of skipping it', () => {
  const { stdout, calls } = runScript({ probeFail: true });
  assert.equal(
    ranFile(calls, '0018_migrations.sql'),
    true,
    'a probe that failed must never be read as "already applied"',
  );
  assert.equal(
    /already applied/.test(stdout),
    false,
    'nothing may be reported as already applied when every probe failed',
  );
});

/* --- 0020 column guard ---------------------------------------------- */

test('the 0020 column probe uses JSON and a result-row sentinel', () => {
  const { calls } = runScript();
  const probes = pragmaProbes(calls);
  assert.ok(probes.length > 0, 'the script preflighted the 0020 column');
  for (const probe of probes) {
    assert.match(probe, / --json /, `PRAGMA probe must request clean JSON: ${probe}`);
  }
  const start = lineOf(/^apply_0020\(\)\s*\{/);
  const body = lines.slice(start, lineOf(/^\}/, start)).join('\n');
  assert.match(
    body,
    /grep -qE '"name":\[\[:space:\]\]\*"last_tested_at"'/,
    'the guard must match the column name as a JSON result key, not as loose text',
  );
});

test('a present last_tested_at column skips 0020 in either JSON spacing', () => {
  for (const column of ['compact', 'pretty']) {
    const { stdout, calls } = runScript({ column });
    assert.equal(
      ranFile(calls, '0020_admin_inventory.sql'),
      false,
      `${column}: an existing column must not be re-added`,
    );
    assert.match(stdout, /last_tested_at already present/, `${column}: the skip is reported`);
  }
});

test('an absent column applies 0020, and an echoed probe is not a false skip', () => {
  for (const options of [{}, { echoQuery: true }]) {
    const label = options.echoQuery ? 'echo-only' : 'empty-result';
    const { calls } = runScript(options);
    assert.equal(ranFile(calls, '0020_admin_inventory.sql'), true, `${label}: 0020 must still be applied`);
  }
});

/* --- failure propagation -------------------------------------------- */

test('a migration that fails to apply is reported and exits non-zero', () => {
  const { status, stdout, calls } = runScript({ failFiles: ['0016_outbox.sql'] });
  assert.match(stdout, /FAILED .*0016_outbox\.sql/, 'the failing file is named');
  assert.notEqual(status, 0, 'a failed migration must not exit 0');
  assert.equal(ranFile(calls, '0016_outbox.sql'), true, 'the failing file was attempted');
});

test('a failed migration does not stop the remaining files, and the exit code reports it', () => {
  const { status, calls } = runScript({ failFiles: ['0016_outbox.sql', '0017_b2_temp_objects.sql'] });
  assert.equal(ranFile(calls, '0017_b2_temp_objects.sql'), true, 'the run continues past a failure');
  assert.equal(
    ranFile(calls, '0020_admin_inventory.sql'),
    true,
    'later stages still run so the operator sees every problem at once',
  );
  assert.notEqual(status, 0, 'two failures must still exit non-zero');
});

test('a clean run exits 0', () => {
  const { status, stdout } = runScript();
  assert.equal(status, 0);
  assert.doesNotMatch(stdout, /FAILED/, 'nothing failed');
});

test('a config with no token is a failure, and the other configs still run', () => {
  // Tokens are positional: config 1 has none, config 2 has one.
  const { status, stdout, calls, cfgs } = runScript({ cfgCount: 2, tokens: ['', 'token-two'] });
  assert.match(stdout, new RegExp(`skip ${cfgs[0].replace(/[/.]/g, '\\$&')}: token AKUN1 unset`), 'the config without a token is named');
  assert.equal(
    calls.some((line) => line.endsWith(`--config ${cfgs[1]}`)),
    true,
    'the config that does have a token is still processed',
  );
  assert.equal(
    calls.some((line) => line.endsWith(`--config ${cfgs[0]}`)),
    false,
    'the config without a token is never touched',
  );
  assert.notEqual(status, 0, 'a skipped config is a failure, not a silent success');
});

test('every config missing a token still exits non-zero', () => {
  const { status, stdout } = runScript({ cfgCount: 2, tokens: ['', ''] });
  assert.match(stdout, /token AKUN1 unset/);
  assert.match(stdout, /token AKUN2 unset/);
  assert.notEqual(status, 0, 'nothing was migrated, so nothing may report success');
});
