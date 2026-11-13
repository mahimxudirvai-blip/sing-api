# sing-api

Best working sing API. YouTube (yt-dlp) first, JioSaavn fallback. Zero npm dependencies.

## Endpoints

- `GET /sing?q=<song>` — audio bytes directly (yt-dlp stream, or a 302 to the Saavn MP3)
- `GET /sing?q=<song>&info=1` — JSON `{ ok, title, artist, duration, source }`
- `GET /health` — `{ ok, ytdlp, cookies, proxy, deno }`

## Env vars

| Var | Purpose |
| --- | ------- |
| `PORT` | Railway sets this automatically (default 3000) |
| `YTDLP_PROXY` | Residential proxy URL — fixes YouTube 403 on datacenter IPs |
| `YTDLP_COOKIES` | Cookie file contents (saved to /tmp at startup, never logged) |
| `YTDLP_PATH` | yt-dlp binary (default `yt-dlp`) |
| `DENO_PATH` | deno binary (default `/usr/local/bin/deno`) |
| `SAAVN_API_URL` | Override the Saavn fallback endpoint |

## Deploy (Railway)

New Service → GitHub repo → `sing-api`. Railway builds the Dockerfile automatically.
Set `YTDLP_PROXY` and/or `YTDLP_COOKIES` in Variables if YouTube 403s.
