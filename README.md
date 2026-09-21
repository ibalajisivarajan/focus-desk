# Focus Desk — Hosted Edition

A self-hostable version of the **Focus Desk** productivity app (to-dos, habit streaks,
pomodoro timer, quick notes, daily stats header). Same warm-paper UI as the single-file
version, but all data lives in a **SQLite database on the server**, so it follows you
across devices.

- **Backend:** Node.js + Express, built-in `node:sqlite` (no native modules, no build step)
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

| Variable   | Default  | Purpose                              |
|------------|----------|--------------------------------------|
| `PORT`     | `3000`   | HTTP port to listen on               |
| `DATA_DIR` | `./data` | Directory holding `focusdesk.db`     |
| `DB_PATH`  | —        | Override the database file directly  |

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

**Easiest path: Render one-click deploy.** Push this folder to a GitHub repo, then in
Render: *New → Blueprint* → select the repo. `render.yaml` builds the Docker image,
attaches a 1 GB persistent disk at `/data`, and wires the health check. Note: Render
disks require a paid instance, so the blueprint uses the **Starter** plan (~$7/mo);
the free plan works for a demo but wipes the SQLite database on every restart.

### Railway

1. Push to GitHub, then *New Project → Deploy from GitHub repo* in Railway.
2. It auto-detects the Dockerfile. Add a **Volume** (e.g. 1 GB) mounted at `/data`.
3. Set the `DATA_DIR` variable to `/data`. Done — Railway gives you a public URL.

### Fly.io

```bash
fly launch            # accept the detected Dockerfile setup
fly volumes create focus_data --size 1 --region <nearest, e.g. sjc>
```

Then in `fly.toml` add:

```toml
[mounts]
  source = "focus_data"
  destination = "/data"

[env]
  DATA_DIR = "/data"
```

```bash
fly deploy
```

Fly's free allowance includes small volumes, so this is the cheapest way to run it
with real persistence.

### Any VPS via Docker

```bash
docker build -t focus-desk .
docker run -d --name focus-desk \
  -p 3000:3000 \
  -v focus-desk-data:/data \
  --restart unless-stopped \
  focus-desk
```

Put it behind Caddy/Nginx for HTTPS (e.g. Caddy: `yourdomain.com { reverse_proxy localhost:3000 }`).
Back up `/var/lib/docker/volumes/focus-desk-data/_data/focusdesk.db` (or wherever
your volume lives) — it's a single file.

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
