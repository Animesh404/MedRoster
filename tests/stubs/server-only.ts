// Test-only stand-in for the `server-only` package.
//
// `server-only`'s real implementation throws unconditionally on import unless
// resolved under the `react-server` export condition — a condition Next's
// bundler sets and Vitest does not. Aliased in here (see vitest.config.ts)
// purely so route modules that import `@/lib/supabase/admin` (which opens
// with `import 'server-only'`) can be loaded by Vitest at all, including by
// tests/rbac/routes.test.ts's dynamic `import()` of every route file.
//
// This is not the guard against the service-role key reaching the client —
// tests/auth/admin-containment.test.ts is, via a static import-graph scan
// that never executes this stub and is unaffected by it.
export {}
