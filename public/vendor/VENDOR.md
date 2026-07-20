# Vendored client libraries

No bundler, no build step — these two files are the entire client-side JS
supply chain, committed to the repo and pinned by hash. Update deliberately,
never automatically.

| File | Package | Version | SHA-256 |
|------|---------|---------|---------|
| `htmx.min.js` | htmx.org | 2.0.10 | `71ea67185bfa8c98c39d31717c6fce5d852370fcdfd129db4543774d3145c0de` |
| `alpine.min.js` | alpinejs | 3.15.12 | `57b37d7cae9a27d965fdae4adcc844245dfdc407e655aee85dcfff3a08036a3f` |

Source URLs (resolved at vendor time, 2026-07-20):

- https://unpkg.com/htmx.org@2.0.10/dist/htmx.min.js
- https://unpkg.com/alpinejs@3.15.12/dist/cdn.min.js

## Verify

```bash
sha256sum -c <<'EOF'
71ea67185bfa8c98c39d31717c6fce5d852370fcdfd129db4543774d3145c0de  htmx.min.js
57b37d7cae9a27d965fdae4adcc844245dfdc407e655aee85dcfff3a08036a3f  alpine.min.js
EOF
```

## Updating

1. Download the new pinned version from unpkg (or the project's GitHub release).
2. Read the diff / release notes.
3. Update the version and hash in this file in the same commit.
