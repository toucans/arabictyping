#!/usr/bin/env node
/**
 * Renumber audio files in R2 to `NNNN.<ext>` (0000, 0001, …) and rewrite
 * wordlist.json so every entry's `audio` field points at its new name.
 *
 * Numbering is oldest-first within each collection: position 0 in a
 * newest-first wordlist gets the highest number; the bottom of each collection
 * gets 0000. This keeps new uploads (which pick max+1) consistent.
 *
 * Usage:
 *   WORKER_URL=https://arabic-audio.<sub>.workers.dev \
 *   UPLOAD_PASSWORD=hunter2 \
 *   node worker/scripts/renumber-audio.mjs
 *
 * Requires Node 18+ (built-in fetch / FormData / Blob).
 *
 * Strategy (safe for reruns where old and new key sets overlap, e.g. when a
 * prior pass numbered them in the wrong order):
 *
 *   [A] copy each old key → tmp key (a `__renumber_tmp_` prefix on the final name)
 *   [B] delete each old key  (now only temps hold the data)
 *   [C] copy each tmp → final key
 *   [D] push the updated wordlist
 *   [E] delete each tmp
 *
 * At every cut point the data is still reachable somewhere; rerunning re-derives
 * the plan from the current wordlist + bucket state.
 */

const WORKER_URL = process.env.WORKER_URL && process.env.WORKER_URL.replace(/\/$/, '');
const PASSWORD = process.env.UPLOAD_PASSWORD;

if (!WORKER_URL || !PASSWORD) {
  console.error('Set WORKER_URL and UPLOAD_PASSWORD env vars.');
  process.exit(1);
}

const auth = { Authorization: `Bearer ${PASSWORD}` };
const TMP_PREFIX = '__renumber_tmp_';

async function main() {
  console.log(`Fetching wordlist from ${WORKER_URL}…`);
  const wlRes = await fetch(`${WORKER_URL}/wordlist`);
  if (!wlRes.ok) die(`GET /wordlist failed: ${wlRes.status}`);
  const wl = await wlRes.json();
  if (!Array.isArray(wl.collections)) die('Unexpected wordlist shape — no `collections` array.');

  // Wordlist is newest-first; iterate each collection's items in reverse so the
  // oldest entry gets 0000 and new uploads (which pick max+1) extend chronology.
  let counter = 0;
  const renames = []; // { oldName, newName, tmpName, item }
  for (const c of wl.collections) {
    const items = (c.items || []).slice().reverse();
    for (const item of items) {
      if (!item.audio) continue;
      const ext = (item.audio.split('.').pop() || 'mp3').toLowerCase();
      const newName = String(counter).padStart(4, '0') + '.' + ext;
      counter++;
      if (item.audio === newName) continue;
      renames.push({ oldName: item.audio, newName, tmpName: TMP_PREFIX + newName, item });
    }
  }

  console.log(`${renames.length} file(s) to rename.`);
  if (renames.length === 0) { console.log('Nothing to do.'); return; }

  // [A] copy old → tmp
  console.log('\n[A] copying originals → temp names…');
  for (const r of renames) {
    await copyKey(r.oldName, r.tmpName);
    console.log(`  ${r.oldName} → ${r.tmpName}`);
  }

  // [B] delete old
  console.log('\n[B] deleting originals…');
  for (const r of renames) {
    await deleteKey(r.oldName);
    console.log(`  − ${r.oldName}`);
  }

  // [C] copy tmp → final
  console.log('\n[C] copying temp → final names…');
  for (const r of renames) {
    await copyKey(r.tmpName, r.newName);
    console.log(`  ${r.tmpName} → ${r.newName}`);
  }

  // [D] push wordlist
  console.log('\n[D] pushing updated wordlist…');
  for (const r of renames) r.item.audio = r.newName;
  const pushRes = await fetch(`${WORKER_URL}/wordlist`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ collections: wl.collections, lastModified: wl.lastModified }),
  });
  if (!pushRes.ok) {
    die(`Wordlist push failed: ${pushRes.status} — ${await pushRes.text()}\n` +
        'Final files are in place but the wordlist still references the old names.\n' +
        'Re-run the script after fixing.');
  }
  console.log('  ok.');

  // [E] cleanup temps
  console.log('\n[E] deleting temps…');
  for (const r of renames) {
    await deleteKey(r.tmpName);
  }

  console.log(`\nDone. ${renames.length} file(s) renumbered.`);
}

async function copyKey(src, dst) {
  const got = await fetch(`${WORKER_URL}/audio/${encodeURIComponent(src)}`);
  if (!got.ok) die(`GET ${src} failed: ${got.status}`);
  const blob = await got.blob();
  const form = new FormData();
  form.append('file', blob, dst);
  form.append('filename', dst);
  const put = await fetch(`${WORKER_URL}/upload`, { method: 'POST', headers: auth, body: form });
  if (!put.ok) die(`PUT ${dst} failed: ${put.status} — ${await put.text()}`);
}

async function deleteKey(name) {
  const res = await fetch(`${WORKER_URL}/audio/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: auth,
  });
  if (!res.ok) console.error(`  delete ${name} failed: ${res.status}`);
}

function die(msg) { console.error(msg); process.exit(1); }

main().catch(err => { console.error(err); process.exit(1); });
