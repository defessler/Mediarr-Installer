# Verifying a Fix

Moved out of `CLAUDE.md` on 2026-08-16 to keep the standing load small. The rule itself
stays there. This page keeps the two worked cases.

Before a green check counts, say what would turn it red. If that answer doesn't name
what you just changed, it isn't verification. Two cases from this tree:

- The Prowlarr field-casing bug (bb87b8a) passed against a camelCase schema either way.
  Only a PascalCase case could ever have caught it.
- A ComicVine test (44b2a10) hardcoded `'CV'`/`'comicvine_api'` on both sides of its
  own comparison. Pointing the caller at the plausible-but-wrong `comicvine_api_key`
  left all three cases green. The fix parses the section and option out of the shipped
  call site so the two sides can actually disagree.

Prefer an executable oracle over a note in a doc. A note gets read by whoever already
knows to look. A test under `installer/test/cross-lang/` meets the next session whether
or not they thought to ask. That's why 14 files live there, and why `helpers/shell.ts`
exists at all.
