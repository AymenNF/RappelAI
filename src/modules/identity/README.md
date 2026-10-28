# Identity boundary

Local M1 implemented: sender mapping, version-bound consent/audit, timezone confirmation, revocation, replay-safe onboarding, tenant profiles/preferences, and forced RLS with scoped runtime roles. See `docs/onboarding.md` and `docs/tenant-isolation.md`. Authenticated sessions remain to be implemented before exposing user APIs. Never infer a trusted user ID from model output or arbitrary request fields.
