// Read-only check of the catalog settings: reads products.js from GitHub with the token in .env
// and prints how many products the site has. Changes nothing. Never prints the token.
// Run from backend/:  npx tsx scripts/catalog-check.ts
import { CatalogClient } from '../src/catalog/catalog';
import { catalogConfig } from '../src/config';
import { loadEnvFile } from '../src/env';

loadEnvFile();
const c = catalogConfig(process.env);
if (!c.repo || !c.token) {
  console.log('Catalog is off:', c.problems.join(' '));
  process.exit(1);
}
const client = new CatalogClient({ repo: c.repo, branch: c.branch, folder: c.folder, token: c.token, siteUrl: c.siteUrl, timeoutMs: 30_000 });
try {
  console.log(`OK: ${c.repo} (branch ${c.branch}${c.folder ? `, folder ${c.folder}` : ''}) has ${await client.productCount()} products. Site: ${c.siteUrl}`);
} catch (e) {
  console.log('Problem:', (e as Error).message);
  process.exit(1);
}
