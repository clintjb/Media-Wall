# Media Wall

A full-screen widget for [Homepage](https://gethomepage.dev/) (or any kiosk
display / iframe) that cycles through a folder of photos and periodically
cuts to a cinematic "now showing" slide pulled from Jellyfin and/or
Jellyseerr/Overseerr.

## What it does

- Serves photos from a mounted folder in random order, Ken Burns pan/zoom,
  cross-fade transitions.
- Every **N** photos (default 5, set via `MOVIE_EVERY`), it shows one movie
  slide instead: poster, blurred backdrop, title, rating, runtime, genres,
  and overview — laid out like a cinema lobby poster case.
- Movie data can come from:
  - **Jellyfin** — recently added movies on your own server.
  - **Jellyseerr or Overseerr** — recently requested + trending titles
    (same API, so either works with the same env vars).
  - **Both** — sources are interleaved.
- If only one source (or neither) is configured, it degrades gracefully:
  photos-only mode still works with zero media server configured.

## Setup

1. Copy `.env.example` to `.env` and fill in:
   - `PHOTOS_HOST_PATH` — folder on your host with images (jpg/jpeg/png/webp,
     subfolders are scanned recursively).
   - `JELLYFIN_URL` + `JELLYFIN_API_KEY` (optional) — generate an API key in
     Jellyfin under Dashboard → API Keys.
   - `SEERR_URL` + `SEERR_API_KEY` (optional) — generate an API key in
     Jellyseerr/Overseerr under Settings → General.
   - In Portainer, set these as stack environment variables instead of a
     `.env` file if you prefer.

2. Deploy:
   ```
   docker compose up -d --build
   ```

3. Point Homepage at it with an iframe widget, e.g.:
   ```yaml
   - Media Wall:
       widget:
         type: iframe
         src: http://your-host:8088
   ```

## Tuning

- `MOVIE_EVERY` — how many photos between each movie slide.
- `MOVIE_SOURCE` — `jellyfin`, `seerr`, or `both`.
- Photo slide duration and movie slide duration are set in
  `public/index.html` (`PHOTO_DURATION` / `MOVIE_DURATION`, in ms) if you
  want to adjust pacing beyond the defaults (8s / 14s).

## Notes

- Jellyfin images and API key never reach the browser — the server proxies
  them through `/api/image/jellyfin/...`.
- Seerr/TMDB poster and backdrop images are served directly from TMDB's
  CDN (no API key required for images).

## Status checks (Portainer, cron-job.org, wifi points)

This container also exposes three small JSON status endpoints, meant to be
consumed by Homepage's `customapi` widget. Each is independent and
optional — leave the related env vars blank to disable it (the endpoint
will still respond, just with `enabled: false`).

### Portainer container health

Checks every container in a given Portainer environment and reports how
many are running, unhealthy/restarting, or stopped.

**Setup:**
1. In Portainer, go to your user icon → **My account** → **Access tokens**
   → **Add access token**. Copy the token — it's only shown once.
2. Find your environment/endpoint ID: click into the environment in
   Portainer and check the URL, e.g. `.../endpoints/1/docker/...` → `1`.
3. Set in `.env`:
   ```
   PORTAINER_URL=http://192.168.178.169:9000
   PORTAINER_API_KEY=ptr_xxxxxxxxxxxxxxxxxxxx
   PORTAINER_ENDPOINT_ID=1
   ```

**Endpoint:** `GET /api/status/portainer`
```json
{
  "enabled": true,
  "summary": "All healthy",
  "running": 14,
  "unhealthy": 0,
  "stopped": 1,
  "total": 15,
  "issues": "None"
}
```

**services.yaml:**
```yaml
- Container Health:
    icon: sh-docker.svg
    widget:
      type: customapi
      url: http://192.168.178.169:8088/api/status/portainer
      refreshInterval: 60000
      mappings:
        - field: summary
          label: Status
        - field: running
          label: Running
        - field: unhealthy
          label: Unhealthy
        - field: stopped
          label: Stopped
        - field: issues
          label: Issues
```

There's also a plain `GET /api/health/portainer` endpoint for Homepage's
`siteMonitor`, which only checks the HTTP status code rather than reading
JSON fields. It returns `200` when every container is healthy/running (or
when Portainer isn't configured, so it doesn't falsely show as down), and
`503` when something's wrong or Portainer is unreachable:

```yaml
- Container Health:
    icon: sh-docker.svg
    siteMonitor: http://192.168.178.169:8088/api/health/portainer
    statusStyle: dot
```

This can be used alongside or instead of the `customapi` card above — the
`siteMonitor` version just gives you a quick up/down dot, while the
`customapi` version shows the actual counts and issue details.

### cron-job.org — last N runs

Checks the most recent executions across every job in your cron-job.org
account (or a single job, if you set `CRONJOB_JOB_ID`) and reports any
failures among the last `CRONJOB_LOOKBACK` runs (default 5).

**Setup:**
1. Go to [console.cron-job.org](https://console.cron-job.org) → **Settings**
   → generate an API key.
2. Set in `.env`:
   ```
   CRONJOB_API_KEY=your-api-key-here
   CRONJOB_JOB_ID=            # optional - leave blank to check all jobs
   CRONJOB_LOOKBACK=5
   ```

**Endpoint:** `GET /api/status/cronjob`
```json
{
  "enabled": true,
  "summary": "All OK",
  "checked": 5,
  "failed": 0,
  "lastRun": "2026-09-19T08:00:11.000Z",
  "issues": "None"
}
```

**services.yaml:**
```yaml
- Cron Jobs:
    icon: mdi-clock-check-outline
    widget:
      type: customapi
      url: http://192.168.178.169:8088/api/status/cronjob
      refreshInterval: 60000
      mappings:
        - field: summary
          label: Status
        - field: checked
          label: Checked
        - field: failed
          label: Failed
        - field: lastRun
          label: Last Run
          format: relativeDate
        - field: issues
          label: Issues
```

Note: cron-job.org's free tier allows 100 API requests/day. Checking
"all jobs" fetches the job list once plus one history call per job on
every refresh, so keep `refreshInterval` generous (60000ms/1min shown
above = 1,440 job-list calls/day alone if you have many jobs) — adjust
upward, or set `CRONJOB_JOB_ID` to a single job, if you're near the
limit.

### Wifi points / router ping checks

Pings a list of hosts (e.g. your access points) and reports how many are
up or down.

**Setup:** set in `.env` as a comma separated list of `name=host` pairs:
```
WIFI_POINTS=Lounge=192.168.178.112,Office=192.168.178.113,Attic=192.168.178.114,Pub=192.168.178.115
```

**Endpoint:** `GET /api/status/wifi`
```json
{
  "enabled": true,
  "summary": "All up",
  "up": 4,
  "down": 0,
  "total": 4,
  "issues": "None"
}
```

**services.yaml:**
```yaml
- Wifi Points:
    icon: sh-tp-link.svg
    widget:
      type: customapi
      url: http://192.168.178.169:8088/api/status/wifi
      refreshInterval: 30000
      mappings:
        - field: summary
          label: Status
        - field: up
          label: Up
        - field: down
          label: Down
        - field: issues
          label: Issues
```

This gives you one card with an at-a-glance up/down count. If you still
want the four individual APs shown with their own status dots (as
covered earlier), keep those as separate `ping:`-based services — the
two approaches aren't mutually exclusive.
