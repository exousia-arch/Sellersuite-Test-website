// Mint a PPCBench access code (or hash an existing one).
//   node gen-code.mjs            -> random code + hash
//   node gen-code.mjs my-code    -> hash for "my-code"
// Add the printed hash to VALID_HASHES in auth.js, push, and give the tester the code.
import crypto from 'node:crypto';

let code = process.argv[2];
if (!code) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += a[crypto.randomBytes(1)[0] % a.length];
  code = 'ppcb-' + s;
}
const hash = crypto.createHash('sha256').update(code).digest('hex');
console.log('Code (give to tester):', code);
console.log('Hash (add to auth.js) :', `"${hash}",`);
