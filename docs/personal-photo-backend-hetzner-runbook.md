# Personal Photo Backend Hetzner Runbook

This is the narrow deployment path for the personal photo backend used by PastPresentYou.

It assumes:
- one rented Hetzner server
- static frontend build
- personal photo backend running as a separate Node process
- nginx in front of both frontend and backend
- server dataset in the existing `timeline-user-data` layout

## What gets deployed

- frontend: static Vite build
- personal photo backend: `npm run personal:server`
- personal dataset: `manifest.json`, `images/`, `previews/`

## Recommended server layout

Example paths:

```text
/srv/pastpresentyou/app
/srv/pastpresentyou/data/timeline-user-data
/etc/pastpresentyou/personal-photo-backend.env
```

Recommended ownership:
- app code: deploy user
- dataset: same user that runs backend service
- env file: readable only by root and the service user

## 1. Prepare and upload the dataset

Use the existing export/migration flow on your local machine.

Preferred source:
- folder backup `timeline-user-data/`

Optional source:
- embedded JSON backup

Import into a server dataset path with the dev/admin-only import tool:

```bash
cd /srv/pastpresentyou/app
npm ci
npm run personal:import -- --source "/srv/pastpresentyou/uploads/timeline-user-data" --target "/srv/pastpresentyou/data/timeline-user-data"
```

You can also import from an embedded JSON backup:

```bash
npm run personal:import -- --source "/srv/pastpresentyou/uploads/personal-backup.json" --target "/srv/pastpresentyou/data/timeline-user-data"
```

The import is id-based upsert:
- first run creates missing series/photos
- repeated run updates matching ids instead of duplicating them

## 2. Backend env

Create `/etc/pastpresentyou/personal-photo-backend.env` from the example template.

Required for Hetzner deployment:
- `PERSONAL_PHOTO_DATA_DIR`
- `PERSONAL_PHOTO_WRITE_TOKEN`

Recommended:
- `PERSONAL_PHOTO_SERVER_HOST=127.0.0.1`
- `PERSONAL_PHOTO_SERVER_PORT=8787`
- `PERSONAL_PHOTO_PUBLIC_BASE_URL=https://your-domain.example`

## 3. Start the backend with systemd

Install the provided unit template:

```bash
sudo cp deploy/hetzner/personal-photo-backend.service /etc/systemd/system/personal-photo-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now personal-photo-backend.service
sudo systemctl status personal-photo-backend.service
```

Useful commands:

```bash
sudo journalctl -u personal-photo-backend -f
sudo systemctl restart personal-photo-backend
```

## 4. Put nginx in front of the backend

Use the example nginx location config from `deploy/hetzner/nginx-personal-photo-backend.conf.example`.

Important production recommendation:
- do not expose `VITE_PERSONAL_PHOTO_WRITE_TOKEN` in the public frontend bundle
- let nginx inject `X-Personal-Write-Token` when proxying `/api/personal/`

That keeps the shared secret on the server side instead of shipping it to the browser.

## 5. Frontend env for server mode

Use the example in `deploy/hetzner/frontend-server-mode.env.example`.

For production behind nginx, the minimal frontend env is:

```bash
VITE_PERSONAL_PHOTO_STORAGE=server
VITE_PERSONAL_PHOTO_API_BASE_PATH=/api/personal
```

Recommended for production:
- do not set `VITE_PERSONAL_PHOTO_WRITE_TOKEN`

That variable is still useful for direct-to-backend local dev, but not recommended for a public deployment because browser users can inspect frontend env-derived values.

## 6. Read/write smoke checks

### Public read check through nginx

```bash
curl -fsS https://your-domain.example/api/personal/series | jq '.series | length'
curl -fsS https://your-domain.example/api/personal/photos | jq '.photos | length'
```

### Direct backend write protection check

Pick a real photo id and current title:

```bash
PHOTO_ID=$(curl -fsS https://your-domain.example/api/personal/photos | jq -r '.photos[0].id')
PHOTO_TITLE=$(curl -fsS https://your-domain.example/api/personal/photos | jq -r '.photos[0].title')
```

Unauthorized direct write should fail:

```bash
curl -i -X PATCH "http://127.0.0.1:8787/api/personal/photos/${PHOTO_ID}/metadata" \
  -H "Content-Type: application/json" \
  --data "{\"title\":\"${PHOTO_TITLE}\"}"
```

Expected result:
- HTTP `401`

Authorized direct write should succeed:

```bash
curl -i -X PATCH "http://127.0.0.1:8787/api/personal/photos/${PHOTO_ID}/metadata" \
  -H "Content-Type: application/json" \
  -H "X-Personal-Write-Token: YOUR_WRITE_TOKEN" \
  --data "{\"title\":\"${PHOTO_TITLE}\"}"
```

Expected result:
- HTTP `200`

Because the title is patched to its current value, this is effectively a no-op write check.

### Browser/app check

After deploying the frontend in server mode:
- open the app
- verify personal photos load
- edit metadata of one existing photo
- add one test photo
- delete that same test photo

This confirms:
- read path
- nginx proxy
- token injection
- backend dataset writes

## 7. Updating the dataset later

If you need to re-import local data later:

```bash
cd /srv/pastpresentyou/app
npm run personal:import -- --source "/srv/pastpresentyou/uploads/timeline-user-data" --target "/srv/pastpresentyou/data/timeline-user-data"
sudo systemctl restart personal-photo-backend
```

## Notes / limits

This runbook intentionally does not include:
- CI/CD
- Docker/Kubernetes
- user accounts
- JWT/sessions
- series cleanup for empty series
- backup/import UI for end users
- observability stack beyond `systemd` logs

It is a practical one-server deployment path for the existing one-user personal photo backend.
