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
