// After a D1 Time Travel restore to a point BEFORE some accounts were deleted, those accounts are back. This
// finds them again, so they can be deleted again (docs/architecture/organizations.md › After a restore).
//
// A `person.delete` audit row never holds the old handle, only `detail.ref` = base64url(HMAC-SHA256(
// "person-delete:" + lower(handle), COOKIE_SECRET)) — src/deletion/person.ts `deletionRef`. This computes the
// same for every handle given and prints the ones whose ref is in the list.
//
//   1. BEFORE the restore, save the deletion rows the restore will undo:
//        npx wrangler d1 execute trov --remote --json --command \
//          "SELECT detail FROM org_admin_audit WHERE action = 'person.delete' AND at > '<bookmark time>'" > refs.json
//   2. Restore. Then list every handle:
//        npx wrangler d1 execute trov --remote --json --command "SELECT handle FROM persons" > handles.json
//   3. COOKIE_SECRET=<the production secret> node scripts/deletion-refs.mjs refs.json handles.json
//      → one handle per line: delete each again (Platform › Admins › Delete a person's account).
// Organizations are simpler: an `org.delete` row's target IS the slug — delete it again in Platform.
// The secret is read from the environment only, never written anywhere. It must be the one in use when the
// deletions happened (a rotated COOKIE_SECRET matches nothing).
import { readFileSync } from "node:fs";

const [refsFile, handlesFile] = process.argv.slice(2);
const secret = process.env.COOKIE_SECRET;
if (!refsFile || !handlesFile || !secret) {
  console.error("usage: COOKIE_SECRET=… node scripts/deletion-refs.mjs refs.json handles.json");
  process.exit(2);
}
/** `wrangler d1 execute --json` prints `[{ results: [...] }]`; a plain array of rows is accepted too. */
const rowsOf = (file) => {
  const j = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(j) && j[0] && Array.isArray(j[0].results) ? j.flatMap((x) => x.results) : j;
};
const refs = new Set(rowsOf(refsFile).map((r) => { try { return JSON.parse(r.detail).ref; } catch { return null; } }).filter(Boolean));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
for (const { handle } of rowsOf(handlesFile)) {
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`person-delete:${String(handle).toLowerCase()}`));
  if (refs.has(b64url(sig))) process.stdout.write(`${handle}\n`);
}
