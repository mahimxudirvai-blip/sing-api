# sing-api

Best working sing API. Raw JioSaavn first (one HTTP call, direct 320kbps MP3),
YouTube (yt-dlp) fallback. Zero npm dependencies.

## Endpoints

- `GET /sing?q=<song>` — audio bytes directly (Saavn 302 redirect, or yt-dlp stream)
- `GET /sing?q=<song>&info=1` — JSON `{ ok, title, artist, duration, source }`
- `GET /health` — `{ ok, ytdlp, cookies, proxy, deno, des }`

## How it works

1. **JioSaavn (primary):** searches `www.jiosaavn.com/api.php` directly (no
   middleman instance — the public saavn.dev mirrors are dead), decrypts the
   `encrypted_media_url` (DES-ECB, static key), upgrades `_96.mp4` to
   `_320.mp4` when the track has 320kbps, and redirects to the MP3.
   DES-ECB needs `--openssl-legacy-provider` on Node 20+ (see Dockerfile).
2. **YouTube via yt-dlp (fallback):** for songs not on Saavn. Needs cookies
   and/or a residential proxy on datacenter IPs — YouTube blocks format
   extraction otherwise.

## Env vars

| Var | Purpose |
| --- | ------- |
| `PORT` | Railway sets this automatically (default 3000) |
| `YTDLP_PROXY` | Residential proxy URL — fixes YouTube 403 on datacenter IPs |
| `YTDLP_COOKIES` | Cookie file contents (saved to /tmp at startup, never logged) |
| `YTDLP_PATH` | yt-dlp binary (default `yt-dlp`) |
| `DENO_PATH` | deno binary (default `/usr/local/bin/deno`) |

## Deploy (Railway)

New Service → GitHub repo → `sing-api`. Railway builds the Dockerfile automatically.
Set `YTDLP_PROXY` and/or `YTDLP_COOKIES` in Variables if the YouTube fallback 403s.
