# Personal Photo Backend First Launch Checklist

Use this for the first real Hetzner launch of server-backed personal photos.

This checklist is intentionally short and operational.

## 0. Inputs you must have before starting

- server SSH access
- domain already pointing to the server
- local project copy with the current dataset/export source
- final write token value
- target paths agreed in advance

Suggested paths:

```text
/srv/pastpresentyou/app
/srv/pastpresentyou/data/timeline-user-data
/srv/pastpresentyou/uploads
/etc/pastpresentyou/personal-photo-backend.env
```

## 1. Prepare the server folders

Run on the server:

```bash
sudo mkdir -p /srv/pastpresentyou/app
sudo mkdir -p /srv/pastpresentyou/data
sudo mkdir -p /srv/pastpresentyou/uploads
sudo mkdir -p /etc/pastpresentyou
```

If you use a dedicated deploy user, make sure it owns `/srv/pastpresentyou`.

## 2. Upload the app

Put the repository contents into:

```text
/srv/pastpresentyou/app
```

Then on the server:

```bash
cd /srv/pastpresentyou/app
npm ci
```

## 3. Upload the dataset source

Preferred:
- upload folder backup `timeline-user-data/` into `/srv/pastpresentyou/uploads`

Alternative:
- upload embedded JSON backup into `/srv/pastpresentyou/uploads`

## 4. Import the dataset into the server dataset path

Folder source:

```bash
cd /srv/pastpresentyou/app
npm run personal:import -- --source "/srv/pastpresentyou/uploads/timeline-user-data" --target "/srv/pastpresentyou/data/timeline-user-data"
```

JSON source:

```bash
cd /srv/pastpresentyou/app
npm run personal:import -- --source "/srv/pastpresentyou/uploads/personal-backup.json" --target "/srv/pastpresentyou/data/timeline-user-data"
```

Immediate check:

```bash
ls /srv/pastpresentyou/data/timeline-user-data
ls /srv/pastpresentyou/data/timeline-user-data/images | head
```

You should see:
- `manifest.json`
- `images/`
- `previews/`

## 5. Create backend env

Start from:

```text
deploy/hetzner/personal-photo-backend.env.example
```

Create:

```text
/etc/pastpresentyou/personal-photo-backend.env
```

Required values:

```bash
PERSONAL_PHOTO_SERVER_HOST=127.0.0.1
PERSONAL_PHOTO_SERVER_PORT=8787
PERSONAL_PHOTO_DATA_DIR=/srv/pastpresentyou/data/timeline-user-data
PERSONAL_PHOTO_PUBLIC_BASE_URL=https://your-domain.example
PERSONAL_PHOTO_WRITE_TOKEN=your-long-random-secret
```

Protect the file:

```bash
sudo chmod 600 /etc/pastpresentyou/personal-photo-backend.env
```

## 6. Install and start systemd unit

Start from:

```text
deploy/hetzner/personal-photo-backend.service
```

Adjust `User=` and `Group=` if needed, then install:

```bash
sudo cp /srv/pastpresentyou/app/deploy/hetzner/personal-photo-backend.service /etc/systemd/system/personal-photo-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now personal-photo-backend.service
sudo systemctl status personal-photo-backend.service
```

If status is not healthy:

```bash
sudo journalctl -u personal-photo-backend -n 100 --no-pager
```

## 7. Connect nginx

Start from:

```text
deploy/hetzner/nginx-personal-photo-backend.conf.example
```

Put the `/api/personal/` location block into your nginx server config.

Important:
- set `proxy_pass http://127.0.0.1:8787;`
- set `proxy_set_header X-Personal-Write-Token "your-long-random-secret";`

Then reload nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 8. Smoke test before switching frontend to server mode

### 8.1 Backend process check

```bash
curl -fsS http://127.0.0.1:8787/api/personal/photos | jq '.photos | length'
curl -fsS http://127.0.0.1:8787/api/personal/series | jq '.series | length'
```

### 8.2 Public read check through nginx

```bash
curl -fsS https://your-domain.example/api/personal/photos | jq '.photos | length'
curl -fsS https://your-domain.example/api/personal/series | jq '.series | length'
```

### 8.3 Write protection check

Pick one real id and current title:

```bash
PHOTO_ID=$(curl -fsS https://your-domain.example/api/personal/photos | jq -r '.photos[0].id')
PHOTO_TITLE=$(curl -fsS https://your-domain.example/api/personal/photos | jq -r '.photos[0].title')
```

Unauthorized direct write must fail:

```bash
curl -i -X PATCH "http://127.0.0.1:8787/api/personal/photos/${PHOTO_ID}/metadata" \
  -H "Content-Type: application/json" \
  --data "{\"title\":\"${PHOTO_TITLE}\"}"
```

Expected:
- HTTP `401`

Authorized direct write must succeed:

```bash
curl -i -X PATCH "http://127.0.0.1:8787/api/personal/photos/${PHOTO_ID}/metadata" \
  -H "Content-Type: application/json" \
  -H "X-Personal-Write-Token: your-long-random-secret" \
  --data "{\"title\":\"${PHOTO_TITLE}\"}"
```

Expected:
- HTTP `200`

## 9. Switch frontend to server mode

Start from:

```text
deploy/hetzner/frontend-server-mode.env.example
```

Use at minimum:

```bash
VITE_PERSONAL_PHOTO_STORAGE=server
VITE_PERSONAL_PHOTO_API_BASE_PATH=/api/personal
```

Recommended for public deployment:
- do not set `VITE_PERSONAL_PHOTO_WRITE_TOKEN`

Build and deploy the frontend with these env values.

## 10. Smoke test immediately after switching frontend

Open the app in the browser and check in this order:

1. Personal photos load.
2. Series labels/load state look normal.
3. Edit metadata of one existing photo and refresh.
4. Add one test photo and refresh.
5. Replace that test photo and refresh.
6. Delete that test photo and refresh.

If all six pass, the first launch is operational.

## 11. Fast rollback plan

If anything goes wrong after switching frontend:

### Rollback A: stop using server mode in frontend

Rebuild/redeploy frontend without:

```bash
VITE_PERSONAL_PHOTO_STORAGE=server
```

That returns the UI to local/browser mode.

### Rollback B: disable the public backend path

If nginx config is the issue:

```bash
sudo systemctl reload nginx
```

after removing or disabling the `/api/personal/` location block.

### Rollback C: stop backend service

```bash
sudo systemctl stop personal-photo-backend
```

### Rollback D: restore dataset from backup copy

Before first production import, make a server-side copy:

```bash
cp -a /srv/pastpresentyou/data/timeline-user-data /srv/pastpresentyou/data/timeline-user-data.backup-first-launch
```

If needed:

```bash
rm -rf /srv/pastpresentyou/data/timeline-user-data
cp -a /srv/pastpresentyou/data/timeline-user-data.backup-first-launch /srv/pastpresentyou/data/timeline-user-data
sudo systemctl restart personal-photo-backend
```

## 12. Done criteria

Do not call the launch complete until all are true:

- backend service is active
- nginx read proxy works
- direct unauthorized write returns `401`
- authorized write returns `200`
- frontend in server mode loads personal photos
- add / replace / delete work in browser and survive refresh
