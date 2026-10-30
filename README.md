# Reader

Offline-first EPUB reader with AI chat (page / highlight / general context) and cross-device sync.

## Run

```bash
npm install
npm start                    # http://127.0.0.1:3000
```

Env vars: `PORT` (3000), `HOST` (127.0.0.1), `DATA_DIR` (./data).

## Multi-device + offline (recommended: Tailscale)

The offline app cache (service worker) only works on **HTTPS or localhost**. Serve it over your tailnet with a real cert:

```bash
# on the machine running the server (laptop or Pi)
npm start                                   # listens on 127.0.0.1:3000
tailscale serve --bg 3000                   # https://<machine>.<tailnet>.ts.net
```

(Enable HTTPS certificates in the Tailscale admin console once.) Open that URL on each device; on phones use "Add to Home Screen".

Plain `http://<tailscale-ip>:3000` (with `HOST=0.0.0.0`) also works, but then the app shell can't load when the server is unreachable.

Run as a service (systemd, Linux Mint / Raspberry Pi OS):

```ini
# /etc/systemd/system/reader.service
[Unit]
Description=EPUB reader
After=network.target
[Service]
WorkingDirectory=/home/YOU/epub-reader
ExecStart=/usr/bin/node server.js
Restart=always
User=YOU
[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now reader`

## How it works

| Concern | Behaviour |
|---|---|
| Books | Added on any device → stored in IndexedDB immediately, uploaded when the server is reachable, auto-downloaded to every other device on its next sync. |
| Offline | App code cached by the service worker (network-first: latest code whenever the server answers within 3 s, saved copy otherwise); books, positions, chats and keys live in IndexedDB. Everything except AI chat works with no network. Changes queue and sync on reconnect. The top bar shows **Offline copy** when the app itself was loaded from the saved copy; **Settings → Connection & device** shows where the app was loaded from, whether the server is reachable now, and the last successful sync. |
| Position | Each device keeps its **own** current page (saved as an EPUB CFI on every page turn/jump, not on resize or reopen, so it never drifts). The latest position from any device is synced: when another device has read more recently, you get "iPad is at p. 120 (ahead) — Jump"; nothing moves unless you tap Jump. A device opening a book for the first time starts at the latest position. |
| Furthest read | Advances only on forward page turns, so a TOC/scrubber jump to the end doesn't count as "read". "Furthest read ›" appears when you're behind it; "↩ Back" returns you after any jump. |
| Last book | Reopened automatically on load, on any device. |
| Pages | "p. N / M" = fixed ~1200-character locations, identical on every device and screen size (screen pages vary with layout). Generated once per book and cached. |
| Chats | Per book. Each stores its context snapshot: type (General / Page / Highlight), chapter, page, %, page text, highlighted text + CFI. Each question also records the page it was asked on (click to jump). Highlight chats are drawn in the book; click a highlight to reopen its chat. |
| AI providers | Anthropic, OpenAI, OpenRouter, Gemini, Ollama, any OpenAI-compatible endpoint. Pick per chat. Calls go directly from the browser to the provider (streamed). |
| API keys | Entered once in Settings, synced to the server's `data/db.json` (mode 600) and cached on each device. |
| Reading settings | Theme, text size and columns are per device and never synced. |
| Dark mode | Light boxes in the book (code blocks, tables, call-outs) are inverted so they stay readable and keep syntax colours; dark text set by the book's CSS is lightened keeping its hue. |
| Merge rules | Progress: newest "latest position", max furthest. Chats: union of messages. AI settings/last book: newest wins. Deletes use tombstones. |

## Notes

- Ollama: set `OLLAMA_ORIGINS=*` (or your reader URL) so the browser may call it.
- Backup = copy `data/`.
- Keys: `←/→/Space` turn pages, `L` library, `T` contents, `C` chat, swipe on touch.
