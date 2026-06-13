/* PPCBench private-beta gate (client-side).
 *
 * Approve a tester:  run `node gen-code.mjs` → it prints a code + its SHA-256 hash.
 *                    Add the hash to VALID_HASHES below, commit/push, and give the
 *                    tester the plaintext code.
 * Revoke a tester:   remove their hash from VALID_HASHES and push (this also signs
 *                    out anyone already using that code on their next navigation).
 *
 * Note: this is a lightweight gate to keep the public out of a private beta. The
 * code hashes are public, so it is not meant to stop a determined technical user.
 */
(function () {
  const VALID_HASHES = [
    "327d6e3c5e95a06030c9a5abbd796979a2a09b07743c058baa0922b43320fa8f",
    "c6c6bdeeff2d5794e0e90e4eb67100fa00de87803b6dff2048fd637d1dd2a9ae",
    "95b5542b6490c0a7079065466f11f66cbf7550d7974f8d6d2460e590ea49a31c"
  ];
  const KEY = 'ppcb_access';

  async function sha256hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Verify a code; on success persist access locally and return true.
  window.ppcbVerify = async function (code) {
    try {
      const h = await sha256hex((code || '').trim());
      if (VALID_HASHES.includes(h)) { localStorage.setItem(KEY, h); return true; }
    } catch (e) {}
    return false;
  };

  // True only if the stored token matches a currently-valid hash (revocation-aware).
  window.ppcbIsAuthed = function () {
    try { return VALID_HASHES.includes(localStorage.getItem(KEY)); } catch (e) { return false; }
  };

  window.ppcbSignOut = function () {
    try { localStorage.removeItem(KEY); } catch (e) {}
  };
})();
