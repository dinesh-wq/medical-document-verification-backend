# MedFlow API (medical-document-verification-backend)

Express + PostgreSQL backend for the Medical Document Verification & Decision Hub.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (e.g. Supabase). |
| `JWT_SECRET` | Yes (prod) | Secret used to sign JWTs. |
| `GEMINI_API_KEY` | Optional | Google Gemini API key for AI features. |
| `GEMINI_MODEL` | Optional | Override the default Gemini model. |
| `FRONTEND_ORIGIN` | Optional | Comma-separated allowed CORS origins. |
| `PORT` | No | Defaults to `4000`. |

---

## Deploying to Vercel (with Supabase)

### 1. Create a Supabase project & get the connection string
1. Go to [supabase.com](https://supabase.com) and create a project.
2. In the project dashboard, open **Project Settings → Database → Connection string**.
3. Copy the **URI** connection string. It looks like:
   ```
   postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true
   ```
4. **Important:** Append the connection string with `?sslmode=require` if it isn't already present (or keep the `?pgbouncer=true` value). The backend already enables SSL for non-local hosts.

### 2. Add environment variables in Vercel
1. In your Vercel project, go to **Settings → Environment Variables**.
2. Add the following:
   - `DATABASE_URL` = your Supabase connection string
   - `JWT_SECRET` = a long random string (e.g. `openssl rand -hex 32`)
   - `GEMINI_API_KEY` = your Gemini key (optional)
   - `FRONTEND_ORIGIN` = your deployed frontend URL (e.g. `https://your-app.vercel.app`)
3. Apply to **Production**, **Preview**, and **Development** as needed.

### 3. Configure `vercel.json`
A `vercel.json` is already included in this repo. It routes all `/api/*` traffic to the Express serverless function and exports the app for Vercel.

### 4. Deploy
- Connect your backend repo (the `medical-document-verification-backend` folder) to Vercel.
- Set the **Root Directory** to `medical-document-verification-backend` if you deploy from the monorepo root.
- Vercel will detect the `vercel.json` and build the serverless function automatically.
- After the first deploy, **Redeploy** so the new env vars take effect.

### 5. Verify
Visit `https://<your-backend-url>.vercel.app/api/v1/health`. It should return:
```json
{
  "status": "ok",
  "database": true,
  "geminiConfigured": false,
  "timestamp": "..."
}
```
If `database` is `false`, the `DATABASE_URL` is either missing or unreachable.

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Create a .env file with DATABASE_URL, JWT_SECRET, etc.
cp .env.example .env

# 3. Run migrations / seed
npm run db:migrate

# 4. Start the dev server
npm run dev
```

The API will listen on `http://localhost:4000`.

---

## Scripts

- `npm start` — start the production server
- `npm run dev` — start with auto-reload
- `npm run db:migrate` — apply schema and seed demo data
- `npm test` — run the test suite
