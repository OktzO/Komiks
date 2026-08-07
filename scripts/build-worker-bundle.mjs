// Build single ESM worker bundle for auto-provision deploy.
// Output: apps/api-cf/dist/worker.js (~600KB, minified)
// Also seeds the schema + migration into KV so provision.ts can read them
// without fetching from untrusted GitHub URLs at runtime.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

await build({
  entryPoints: ['apps/api-cf/src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'apps/api-cf/dist/worker.js',
  external: [],
  legalComments: 'none',
  sourcemap: false,
  minify: true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  loader: { '.ts': 'ts' },
  tsconfig: 'apps/api-cf/tsconfig.json',
});
console.log('Worker bundle built → apps/api-cf/dist/worker.js');

// Print KV seed instructions for schema + migration so they can be seeded
// alongside the worker bundle. provision.ts reads these from KV instead of
// fetching from raw.githubusercontent.com (SSRF/integrity risk).
const schemaSql = readFileSync('packages/db/schema.sql', 'utf8');
const migrationSql = readFileSync('packages/db/migrations/0001_manga_data.sql', 'utf8');
console.log('\nSeed KV with schema + migration (run after bundle seed):');
console.log(`  npx wrangler kv key put --namespace-id=<KV_ID> "provision:schema:latest" --path=- < packages/db/schema.sql`);
console.log(`  npx wrangler kv key put --namespace-id=<KV_ID> "provision:migration:latest" --path=- < packages/db/migrations/0001_manga_data.sql`);
console.log(`\nSchema size: ${schemaSql.length} bytes, migration size: ${migrationSql.length} bytes`);
