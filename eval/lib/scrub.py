#!/usr/bin/env python3
"""Deterministic scrub for files committed under eval/ (port of src/sanitize.ts + host/URL/IP redaction).

usage: scrub.py <src> <dst>      copy src to dst with secrets/PII/hosts replaced; prints hit counts
       scrub.py --check <path>... exit 1 if anything would still be replaced
"""
import re, sys, json, os

RULES = [
    ("pem", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("bearer", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.I)),
    ("api_key", re.compile(r"\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,})")),
    ("credential", re.compile(r"((?<!\[)(?:api[_-]?key|secret|token|password|passwd|auth[_-]?token|access[_-]?key)[\"']?\s*[:=]\s*[\"']?)([^\s\"',;\[\]]{8,})", re.I)),
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("id_card", re.compile(r"(?<![0-9])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9])")),
    ("phone", re.compile(r"(?<![0-9.])(?:\+?86[- ]?)?1[3-9]\d{9}(?![0-9])")),
    # beyond sanitize.ts: URLs (except github.com), webhook/API hosts, IPv4
    ("url", re.compile(r"\b(?:https?|wss?)://(?!github\.com/josheee1117/)[^\s\"'<>)\]，。]+")),
    ("ip", re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?![\d.])")),
    ("host", re.compile(r"\b[a-z]+-svc-\d+\b")),
    ("credential", re.compile(r"((?:account|service)=)(?!\[)([^\s，,）)\]]+)")),
    ("host", re.compile(r"(?<![\w./-])(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|internal|corp|cloud|ai|dev)(?::\d+)?(?![\w-])", re.I)),
]
HOME = re.compile(r"/(?:Users|home)/(?!box\b)[A-Za-z0-9._-]+(?=/|\b)")
HOME_ENC = re.compile(r"(?<=-)(?:Users|home)-(?!box\b)(?!~)[A-Za-z0-9._]+(?=-)")
SECRET = {"pem", "jwt", "bearer", "api_key", "credential"}
KEEP_HOSTS = {"github.com"}

def scrub(text):
    hits = {}
    for kind, rx in RULES:
        def rep(m, kind=kind):
            s = m.group(0)
            if kind == "email" and re.search(r"\[(?:SECRET|PII|REDACTED):", s): return s
            if kind == "host" and s.lower() in KEEP_HOSTS: return s
            hits[kind] = hits.get(kind, 0) + 1
            tag = f"[SECRET:{kind}]" if kind in SECRET else (f"[PII:{kind}]" if kind in ("email", "phone", "id_card") else f"[REDACTED:{kind}]")
            return (m.group(1) if kind == "credential" else "") + tag
        text = rx.sub(rep, text)
    def h(m):
        hits["home_path"] = hits.get("home_path", 0) + 1
        return "~" if m.group(0).startswith("/") else "Users-~"
    text = HOME.sub(h, text)
    text = HOME_ENC.sub(h, text)  # host-encoded transcript dirs, e.g. -Users-<name>-code-me-x
    return text, hits

if __name__ == "__main__":
    if sys.argv[1] == "--check":
        bad = 0
        for p in sys.argv[2:]:
            t = open(p, encoding="utf-8", errors="replace").read()
            _, hits = scrub(t)
            if hits: bad += 1; print(p, hits)
        sys.exit(1 if bad else 0)
    src, dst = sys.argv[1], sys.argv[2]
    t, hits = scrub(open(src, encoding="utf-8").read())
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    open(dst, "w", encoding="utf-8").write(t)
    if dst.endswith(".json"):
        json.loads(t)  # stays valid JSON
    print(dst, hits or "")
