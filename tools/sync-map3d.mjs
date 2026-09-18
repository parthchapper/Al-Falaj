/**
 * Keep site/map3d in step with map3d/src.
 *
 * The globe module has one source of truth (`map3d/src`), but GitHub Pages
 * only serves `site/`, so a copy has to live there. A copy nobody checks is a
 * copy that silently goes stale, so this syncs it and, with --check, fails if
 * the two have diverged.
 *
 *   node tools/sync-map3d.mjs           # copy map3d/src -> site/map3d
 *   node tools/sync-map3d.mjs --check   # verify only, non-zero on drift
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'map3d', 'src');
const DST = join(ROOT, 'site', 'map3d');
const CHECK = process.argv.includes('--check');

function walk(dir, base = dir, out = new Map()) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.set(relative(base, p), createHash('sha1').update(readFileSync(p)).digest('hex'));
  }
  return out;
}

if (CHECK) {
  const a = walk(SRC);
  const b = walk(DST);
  const problems = [];
  for (const [f, h] of a) {
    if (!b.has(f)) problems.push(`missing in site/map3d: ${f}`);
    else if (b.get(f) !== h) problems.push(`differs: ${f}`);
  }
  for (const f of b.keys()) if (!a.has(f)) problems.push(`extra in site/map3d: ${f}`);

  if (problems.length) {
    console.log(`\nsite/map3d has drifted from map3d/src:\n`);
    for (const p of problems) console.log(`  ${p}`);
    console.log(`\nrun: node tools/sync-map3d.mjs\n`);
    process.exit(1);
  }
  console.log(`site/map3d matches map3d/src (${a.size} files)`);
} else {
  mkdirSync(DST, { recursive: true });
  cpSync(SRC, DST, { recursive: true });
  console.log(`synced ${walk(SRC).size} files: map3d/src -> site/map3d`);
}
