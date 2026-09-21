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

## Security notes

- `helmet` security headers, including a strict CSP (only `'self'` + inline
  styles/scripts for the single-file frontend).
- API rate limiting; JSON body size capped at 256 KB.
- All inputs validated (lengths, id format, `YYYY-MM-DD` dates, enum modes).
- Container runs as a non-root user; database lives on a mounted volume.
- There is no login system — anyone with the URL can read/write the data. Fine for
  personal use behind an unlisted URL; add auth (e.g. a reverse-proxy password) if
  you expose it publicly.
