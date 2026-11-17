// Where the audit reads a brand file's canonical bytes. raw.githubusercontent.com/<repo>/main/... is cached for
// about five minutes, so the audit that a merge triggers can read the previous bytes of a file that merge changed.
// A URL pinned to a commit has never been requested before that commit exists, so no cache can hold older bytes.
// ref: the commit under audit (a pull request's head, or the push's commit); empty falls back to main.
export function canonicalUrl(canonicalRaw, path, ref) {
  return (ref ? canonicalRaw.replace("/main/brand/", `/${ref}/brand/`) : canonicalRaw) + path;
}
