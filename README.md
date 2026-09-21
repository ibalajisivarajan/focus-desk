# Focus Desk — Hosted Edition

A self-hostable version of the **Focus Desk** productivity app (to-dos, habit streaks,
pomodoro timer, quick notes, daily stats header, weather card). Same warm-paper UI as the single-file
version, but all data lives in a **SQLite database on the server**, so it follows you
across devices.

- **Auth:** username + password (scrypt-hashed), 30-day session cookie. Every
  account sees only its own data; the first account created adopts any data
  from before auth existed.
- **Weather:** current conditions + today's high/low via Open-Meteo (free, no
  API key). Location from GPS or city search, °C/°F toggle.

- **Backend:** Node.js + Express, libSQL (`@libsql/client`) — a local SQLite file by
  default, or a free Turso cloud database when `TURSO_URL`/`TURSO_TOKEN` are set.
  Same SQL either way; no native modules, no build step.
- **Frontend:** the original UI, served statically; talks to the server via `fetch()`
- **Offline:** if the API is unreachable, a banner appears, writes are queued in
  `localStorage`, and they sync automatically when the connection returns (best effort)

## Run locally

```bash
cd focus-desk-hosted
npm install
npm start        # → http://localhost:3000
```

Environment variables (see `.env.example`):

| Variable      | Default  | Purpose                                                        |
|---------------|----------|----------------------------------------------------------------|
| `PORT`        | `3000`   | HTTP port to listen on                                         |
| `DATA_DIR`    | `./data` | Directory holding the local `focusdesk.db` (local mode)        |
| `DB_PATH`     | —        | Override the database file directly (local mode)               |
| `TURSO_URL`   | —        | e.g. `libsql://my-db.turso.io` — switches to Turso cloud DB    |
| `TURSO_TOKEN` | —        | Turso auth token (required with `TURSO_URL`)                    |

## API

| Method   | Path                         | Description                          |
|----------|------------------------------|--------------------------------------|
| `GET`    | `/healthz`                   | Health check (`{"ok":true}`)         |
| `GET`    | `/api/state`                 | Everything the UI needs in one call  |
| `POST`   | `/api/todos`                 | Create todo `{text, id?}`            |
| `PATCH`  | `/api/todos/:id`             | Update `{done?, text?}`              |
| `DELETE` | `/api/todos/:id`             | Delete todo                          |
| `POST`   | `/api/habits`                | Create habit `{name, id?}`           |
| `DELETE` | `/api/habits/:id`            | Delete habit (+ its check-ins)       |
| `POST`   | `/api/habits/:id/checkin`    | Toggle today's check-in `{day?}`     |
| `GET`    | `/api/notes`                 | Get quick notes                      |
| `PUT`    | `/api/notes`                 | Save quick notes `{text}`            |
| `POST`   | `/api/focus/sessions`        | Log a session `{mode, minutes}`      |
| `GET`    | `/api/focus/stats`           | Today's focus stats (`?day=` optional)|

All user content is validated server-side and HTML-escaped when rendered.
The API is rate-limited (600 requests / 15 min per IP).

## Hosting

### Recommended: Render (free) + Turso (free) — $0, data persists

Render's free web tier can't keep a database file (no disk), so the app stores its
data in **Turso**, a hosted SQLite database with a generous free tier (no credit
card). The server itself runs free on Render.

**Step 1 — create the free database (~2 min):**
1. Go to [dashboard.turso.tech](https://dashboard.turso.tech) and sign up (GitHub login works).
2. Click **Create Database**, name it e.g. `focus-desk`.
3. Open the database → copy the **URL** (looks like `libsql://focus-desk-….turso.io`).
4. Create a token: in the database view, **Tokens → Create Token** (or `turso db tokens create focus-desk` in their CLI) and copy it.

**Step 2 — deploy with one click:**
1. Click: [Deploy to Render](https://render.com/deploy?repo=https://github.com/ibalajisivarajan/focus-desk)
   (or: Render dashboard → *New → Blueprint* → paste the repo URL).
2. Log in with GitHub if asked. Render reads `render.yaml` and shows the plan (free).
3. When prompted, paste `TURSO_URL` and `TURSO_TOKEN` from step 1.
4. Click **Apply**. A few minutes later your app is live at
   `https://focus-desk-….onrender.com`.

Notes: Render's free tier spins the service down after ~15 min idle and wakes it on
the next visit (a few seconds of cold start). Your data is safe in Turso regardless.

### Fly.io (needs CLI + token)

`fly.toml` is included (region `sea`, 1 GB volume at `/data`, scale-to-zero).
`fly apps create`, `fly volumes create focusdesk_data --size 1`, `fly deploy`.
Local-file mode is used (no Turso needed).

### Railway / any VPS via Docker

The `Dockerfile` still works. For persistence without Turso, mount a volume at
`/data` (local-file mode). Or set `TURSO_URL`/`TURSO_TOKEN` and skip the volume.

### Static-only alternative

If you don't need server-side storage, the original **single HTML file**
(`../focus-desk/index.html`) can be dropped onto Netlify, Vercel, or GitHub Pages
as-is. But this backend version needs a host that runs Node (like the options above),
because the API and database live on the server.

## Google sign-in (optional)

The app supports username/password accounts out of the box, plus
"Continue with Google" via OAuth 2.0. Google sign-in only appears when the
server is configured with a Google OAuth client — no credit card needed,
Google Cloud OAuth clients are free.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create
   a project (free).
2. **APIs & Services → OAuth consent screen**: choose *External*, fill in the
   app name, and add your own Google account under *Test users*.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**,
   type *Web application*. Under **Authorized redirect URIs** add:
   - `https://focus-desk-y1b9.onrender.com/api/auth/google/callback`
   - `http://localhost:3000/api/auth/google/callback` (for local testing)
4. Copy the **Client ID** and **Client secret** into the server's environment:
   - Locally: `GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node server.js`
   - Render: Dashboard → your service → **Environment** → add
     `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Render redeploys
     automatically).

The first Google sign-in creates an account; if it's the very first account
on the server it adopts any pre-existing data, same as email signup.
Google-created accounts have no password and can only sign in via Google —
until the owner sets one through the forgot-password flow, which emails a
temporary password. If the Google email is already registered (and Google
verified it), the Google login links to that existing account automatically.

## Email: signup, "account created" mail, forgot password (optional)

New accounts sign up with an **email address** (plus display name and
password) and sign in with email or username. On signup the server sends an
**"account created"** email (it doubles as the email-verification mail — the
verification link inside lasts 24 hours). The **Forgot password?** link on
the sign-in page emails a **temporary password**: the user signs in with it,
then opens their **Profile** (top-right, next to the sign-out button) to set
a real password. The Profile page also lets them edit their display name at
any time. These email features only activate when outgoing email is
configured — otherwise signup still works and the forgot-password link stays
hidden.

Free, no-credit-card option: send through your own Gmail account using an
[app password](https://myaccount.google.com/apppasswords):

1. In your Google account, turn on **2-Step Verification**, then create an
   **App password** (choose *Mail*). Google shows a 16-character password —
   copy it.
2. Add to the server's environment:
   - `SMTP_USER` — your Gmail address (e.g. `you@gmail.com`)
   - `SMTP_APP_PASSWORD` — the 16-character app password (no spaces)
   - `SMTP_FROM` — optional, defaults to `SMTP_USER`
   - Locally: `SMTP_USER=... SMTP_APP_PASSWORD=... node server.js`
   - Render: Dashboard → your service → **Environment** → add the variables
     (Render redeploys automatically). Never paste the app password in chat —
     enter it directly in Render.

Temporary passwords are single-use in spirit (the app flags the account and
prompts a real password change on next sign-in) and can't be requested more
than 3 times per email per hour. The forgot-password endpoint always responds
the same way whether or not the email is registered, so it can't be used to
probe for accounts.

## Security notes

- `helmet` security headers, including a strict CSP (only `'self'` + inline
  styles/scripts for the single-file frontend).
- API rate limiting; JSON body size capped at 256 KB; stricter limits on auth
  endpoints.
- All inputs validated (lengths, id format, `YYYY-MM-DD` dates, enum modes).
- Auth: email/username + password (scrypt-hashed) or Google OAuth (ID token
  signature verified against Google's keys, CSRF state token, 15 s upstream
  timeouts). Email-verification tokens are single-use, hashed at rest, and
  short-lived (24 h); forgotten passwords are replaced by emailed temporary
  passwords and flagged for change. Sessions are HTTP-only
  `SameSite=Lax` cookies, 30-day expiry.
- Container runs as a non-root user; database lives on a mounted volume.
