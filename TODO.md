# Plan: Fix DATABASE_URL / DB connection error on Vercel

## Completed Steps
- [x] Analyzed task and read relevant files (db.js, server.js, package.json, schema.sql, frontend App.js)
- [x] Confirmed root cause: `requireDatabase` fires when `pool` is null because `DATABASE_URL` is not set in Vercel env
- [x] Confirmed DB provider: Supabase

## Implementation Steps
- [x] 1. Create `vercel.json` to route `/api/*` traffic to the Express serverless function
- [x] 2. Modify `server.js` to export the Express app for Vercel while preserving local `app.listen()`
- [x] 3. Modify `db.js` to add connection/idle timeouts and robust Supabase SSL config
- [x] 4. Update README.md with Supabase + Vercel deployment instructions

## Follow-up (user actions on Vercel dashboard)
- [ ] Add `DATABASE_URL` (Supabase connection string) to Vercel env vars + Redeploy
- [ ] Add `JWT_SECRET`, `GEMINI_API_KEY`, `FRONTEND_ORIGIN` env vars
- [ ] Verify `/api/v1/health` returns `database: true`
