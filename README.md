# SMM Panel — self-hosted reseller panel

A complete, portable SMM (social media marketing) reseller panel built with
**Node.js + Express + SQLite**. No build step — runs with just
`npm install && npm start`. Deploys on **Render's free tier** (or any Node host).

## Features

- **Auth** — signup, login, logout, bcrypt-hashed passwords, sessions. The owner
  account is seeded from `ADMIN_USERNAME`/`ADMIN_PASSWORD`, or the first user to
  sign up becomes admin automatically.
- **Dashboard** — balance, order stats, recent orders.
- **Services catalog** — customers browse services with rates; admin adds/edits/
  deactivates services and links them to wholesale provider service IDs.
- **Orders** — pick a service, enter link + quantity, balance is deducted, order
  is created. Orders auto-forward to the wholesale provider when linked.
- **Funds** — users submit deposit requests; admin approves/rejects; every
  movement is recorded in a transaction ledger.
- **Support tickets** — users open tickets, admin replies/closes.
- **Wholesale provider API (standard v2)** — owner-only settings page:
  - Save provider API URL + key (key is write-only, never displayed)
  - **Sync services** (`action=services`) → stores the wholesale catalog
  - **Check balance** (`action=balance`)
  - **Order forwarding** (`action=add`) on new orders, provider order ID stored
  - **Status sync** (`action=status`, batched) — manual button + automatic
    background polling every `SYNC_INTERVAL_MINUTES`
  - **Refill** requests (`action=refill`)
  - Generic client: switching providers (Peakerr, JAP, FollowersMore, …) means
    changing only the URL and key.

## Run locally

```bash
npm install
cp .env.example .env   # then edit ADMIN_USERNAME / ADMIN_PASSWORD / SESSION_SECRET
npm start
```

Open http://localhost:3000 — log in with your admin credentials.

## Deploy on Render (free tier) — exact steps

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "SMM panel"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/smm-panel.git
   git push -u origin main
   ```

2. **Create the service in Render**
   - Go to [dashboard.render.com](https://dashboard.render.com) → **New +** → **Blueprint**
   - Connect your GitHub account and select the `smm-panel` repo
   - Render reads `render.yaml` and shows the plan — click **Apply**
   - (Alternative without Blueprint: **New +** → **Web Service** → select repo,
     set Build Command `npm install`, Start Command `npm start`, Plan **Free**,
     add the env vars below.)

3. **Check the environment variables** (Render → your service → Environment):
   - `NODE_ENV=production`
   - `SESSION_SECRET` — auto-generated ✔
   - `ADMIN_USERNAME=admin`
   - `ADMIN_PASSWORD` — auto-generated random password. **Copy it now** — you need
     it for your first login, then change it.

4. **Open your app** at the `https://smm-panel.onrender.com` URL Render gives you.
   Log in as admin.

5. **Connect your wholesale provider**: Admin → **Provider** → paste the provider's
   **API URL** (e.g. `https://peakerr.com/api/v2`) and your **API key** → Save →
   **Sync services** → link provider service IDs to your storefront services under
   **Services**.

> **Free-tier notes (important)**
> - Render's free tier has **no persistent disk**: the SQLite database file lives
>   while the service runs but is **wiped on redeploy/restart**. Free is perfect
>   for testing; for a real business add a Render Disk (paid) or move to an
>   external database.
> - Free web services **sleep after inactivity** (~15 min) and take ~30–60s to
>   wake on the next visit. The background status sync only runs while awake.

## Security notes

- Passwords hashed with bcrypt (10 rounds); sessions are HTTP-only cookies.
- All SQL uses parameterized queries (`better-sqlite3` placeholders).
- The provider API key is stored server-side only and never rendered to any page.
- Admin routes are guarded by `requireAdmin`; the settings page is owner-only.
- Set a strong `SESSION_SECRET` in production (Render generates one for you).
