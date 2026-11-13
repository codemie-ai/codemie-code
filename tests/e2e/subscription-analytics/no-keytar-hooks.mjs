// Keeps CredentialStore off the real OS keychain: synthetic creds go to the scratch CODEMIE_HOME file store only.
export async function resolve(s, c, n) {
  if (s === 'keytar') throw Object.assign(new Error('keytar blocked for probes'), { code: 'ERR_MODULE_NOT_FOUND' });
  return n(s, c);
}
