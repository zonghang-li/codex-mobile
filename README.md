# codex-mobile fork

This fork packages the upstream `codexapp` UI as two commands:

- `codex-mobile` keeps the upstream-compatible behavior, including LAN binding and optional Cloudflare tunneling.
- `codex-mobile-safe` is the recommended command for daily use. It binds to loopback, requires password authentication, uses conservative Codex sandbox defaults, and exposes the service only through an explicit Tailscale Serve command.

## Install from this fork

Node.js 18+ and pnpm are required. Clone the repository so later updates remain an ordinary Git pull:

```bash
git clone https://github.com/zonghang-li/codex-mobile.git
cd codex-mobile
pnpm install
pnpm run install:local
```

The local installer builds the current checkout and installs both commands under `${HOME}/.local` by default. Ensure `${HOME}/.local/bin` is on `PATH`. This is the foreground/manual installation path; it does not install or refresh the systemd user unit.

Start the safe command in the foreground:

```bash
codex-mobile-safe start /path/to/project \
  --no-open
```

While that foreground process remains running, use a second terminal for exposure and status commands:

```bash
codex-mobile-safe expose tailscale
codex-mobile-safe status
codex-mobile-safe urls
```

On the first foreground start, omit `--password-file`: the safe CLI generates a password, stores it in `~/.codex/codex-mobile-safe-password` with mode `0600`, and prints only the generated file path. Read the password locally from that file when signing in; do not pass it as `--password` or copy it into logs. Later foreground restarts can reuse the generated credential with `--password-file ~/.codex/codex-mobile-safe-password`.

For a persistent Linux user service:

```bash
pnpm run service:install
pnpm run service:status
```

The service listens only on `127.0.0.1:5900`. `service:install` creates a mode-`0600` password file when one does not exist, installs the unit, and starts it. Tailscale exposure remains a separate, explicit action:

```bash
codex-mobile-safe expose tailscale
```

If the service should survive logout, enable user lingering once with `loginctl enable-linger "$USER"`.

For quick runtime switching on Linux, use the network mode helper:

```bash
codex-mobile-network lan      # LAN-only: http://192.168.x.x:5900, Tailscale stopped
codex-mobile-network tailnet  # Tailnet HTTPS through Tailscale Serve
codex-mobile-network stop     # Stop managed services and remove Tailscale Serve
codex-mobile-network status   # Show service, listener, LAN URLs, and Tailscale state
```

The same commands are also available from the repository checkout:

```bash
pnpm run network:lan      # LAN-only: http://192.168.x.x:5900, Tailscale stopped
pnpm run network:tailnet  # Tailnet HTTPS through Tailscale Serve
pnpm run network:stop     # Stop managed services and remove Tailscale Serve
pnpm run network:status   # Show service, listener, LAN URLs, and Tailscale state
```

The helper starts transient user services instead of editing the installed unit. Both LAN and Tailnet modes default to `--sandbox-mode workspace-write --approval-policy never`, reuse `~/.codex/codex-mobile-safe-password`, and keep password authentication enabled. LAN mode binds `0.0.0.0:5900`, removes Tailscale Serve, and runs `tailscale down` so only the local network remains. Tailnet mode binds `127.0.0.1:5900`, runs `tailscale up`, and recreates Tailscale Serve. Override the project or policy only through explicit environment variables:

```bash
CODEX_MOBILE_PROJECT_DIR=/path/to/project pnpm run network:lan
CODEX_MOBILE_SANDBOX_MODE=danger-full-access pnpm run network:tailnet
```

To update a foreground/manual installation that has already completed its first safe start:

```bash
cd /path/to/codex-mobile
git pull --ff-only
pnpm install
pnpm run install:local
codex-mobile-safe stop
codex-mobile-safe start /path/to/project \
  --password-file ~/.codex/codex-mobile-safe-password \
  --no-open
```

If the generated password file does not exist, omit `--password-file` on that start so the safe CLI creates it securely; never replace this with a plaintext password in the command line.

For a persistent user service, refresh the installed package, rendered unit, systemd daemon state, and running process together:

```bash
cd /path/to/codex-mobile
git pull --ff-only
pnpm install
pnpm run service:install
codex-mobile-safe expose tailscale
```

`service:install` already rebuilds and reinstalls the current checkout before rendering and restarting the unit. Do not substitute `install:local` followed only by `service:restart`; that does not refresh the rendered unit/template or daemon state.

Repeat the applicable foreground or service update sequence after every repository change you want to run locally. Review incoming changes before pulling if the checkout has local modifications.

## Long-task phone notifications

`codex-mobile-safe` can publish an ntfy alert after a Codex turn has run for at least 10 minutes (`600_000` ms). Install the ntfy app on the phone, create an unguessable topic locally, and subscribe the phone to that same topic. Then create the secret URL file without putting the topic in Git, a CLI argument, or a systemd unit:

```bash
install -d -m 700 ~/.codex
install -m 600 /dev/null ~/.codex/codex-mobile-safe-ntfy-url
read -r NTFY_TOPIC
printf 'https://ntfy.sh/%s\n' "$NTFY_TOPIC" > ~/.codex/codex-mobile-safe-ntfy-url
unset NTFY_TOPIC
chmod 600 ~/.codex/codex-mobile-safe-ntfy-url
pnpm run service:restart
```

Enter only the topic name at the `read` prompt; do not paste the example literally. The file must be a current-user-owned regular file with mode `0600` or stricter. Its only accepted value is `https://ntfy.sh/<single-topic>`, where the topic contains letters, numbers, `_`, or `-`; credentials, extra path segments, queries, fragments, other origins, and symlinks are rejected. The real topic file is local configuration and must never be committed.

For a foreground start, the default file is detected automatically. An alternate secure file can be selected by path, without putting its URL in the process arguments:

```bash
codex-mobile-safe start /path/to/project \
  --password-file ~/.codex/codex-mobile-safe-password \
  --ntfy-url-file /path/to/private-ntfy-url-file \
  --no-open
```

This example reuses the password file created by an earlier safe foreground start or `service:install`. If it is absent, omit `--password-file` and let the safe CLI generate it securely.

Qualifying turns use these title prefixes, followed by the conversation name:

| Turn result | Notification title |
| --- | --- |
| Completed | `Codex 任务完成：<会话名称>` |
| Failed | `Codex 任务失败：<会话名称>` |
| Cancelled or another terminal status | `Codex 任务已中断：<会话名称>` |

The name comes from the locally cached desktop/mobile rename first, then the app-server thread name or title. Prompt and preview text are never used as a name. Control characters and repeated whitespace are normalized, and the name is capped at 80 Unicode code points. If no usable name exists, the title uses `未命名会话（<thread ID last 8 characters>）`. The body is the first non-empty sentence of the latest assistant response, with whitespace collapsed and a maximum length of 180 characters. If no assistant response is available, a fixed status-specific sentence is used. This is deterministic and does not make another AI request. Tasks shorter than 10 minutes do not read the final thread for notification purposes and do not notify.

Ordinary duplicate completion events are suppressed with bounded local state. Retries reuse one stable ntfy sequence ID so supported clients treat them as one logical notification. This is not transport-level exactly-once delivery: after an ambiguous network timeout, or a crash after ntfy accepts a request but before local state is committed, the phone may alert again.

Check the installation and service with:

```bash
codex-mobile-safe doctor
codex-mobile-safe status
codex-mobile-safe urls
pnpm run service:status
journalctl --user -u codex-mobile-safe -n 100 --no-pager
```

`doctor` validates packaged safety wiring; `status` and `urls` report the managed runtime. Notification errors in the journal are intentionally redacted and must not contain the URL, topic, or message body. To disable notifications, remove only the URL file and restart the service:

```bash
rm ~/.codex/codex-mobile-safe-ntfy-url
pnpm run service:restart
```

Use `codex-mobile-safe stop` for a foreground managed process, `codex-mobile-safe unexpose` to remove the Tailscale Serve mapping, and `pnpm run service:uninstall` to disable and remove the Linux user service. The service uninstaller intentionally preserves the password file and Tailscale Serve configuration, so run `unexpose` first when removing remote access.

The notification feature is outbound-only. It does not expose the web UI. Keep the service on `127.0.0.1:5900`, use `codex-mobile-safe expose tailscale`, and open the HTTPS URL only from devices logged into the intended tailnet. Password authentication remains required. Do not use `--lan`, Tailscale Funnel, Cloudflare/public tunnels, or the upstream Telegram integration for the safe deployment.

| Command | Default listener | Remote exposure |
| --- | --- | --- |
| `codex-mobile-safe` | `127.0.0.1:5900` | None until `expose tailscale`; never Cloudflare Funnel |
| `codex-mobile` | `0.0.0.0` | Upstream-compatible behavior; may start Cloudflare unless disabled |

Use `codex-mobile-safe doctor` to inspect security invariants. A mobile `RPC thread/resume failed with HTTP 502` normally means the local backend stopped or its reverse proxy cannot reach port 5900. Check `pnpm run service:status` and `journalctl --user -u codex-mobile-safe -n 100` before changing Tailscale configuration.

Agents modifying or operating this fork must read [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md).

## Upstream documentation

The remaining README describes upstream `codexapp`. Its `npx codexapp`, Telegram, LAN, and Cloudflare tunnel examples run the upstream-compatible behavior, not this fork's safe module. Do not apply those exposure examples to a `codex-mobile-safe` deployment.

# 🔥 codexapp

### 🚀 Run Codex App UI Anywhere: Linux, Windows, or Termux on Android 🚀

[![npm](https://img.shields.io/npm/v/codexapp?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/codexapp)
[![platform](https://img.shields.io/badge/Platform-Linux%20%7C%20Windows%20%7C%20Android-blue?style=for-the-badge)](#-quick-start)
[![node](https://img.shields.io/badge/Node-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![license](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](./LICENSE)

> **Codex UI in your browser. No drama. One command.**
>  
> **Yes, that is your Codex desktop app experience exposed over web UI. Yes, it runs cross-platform.**

```text
 ██████╗ ██████╗ ██████╗ ███████╗██╗  ██╗██╗   ██╗██╗
██╔════╝██╔═══██╗██╔══██╗██╔════╝╚██╗██╔╝██║   ██║██║
██║     ██║   ██║██║  ██║█████╗   ╚███╔╝ ██║   ██║██║
██║     ██║   ██║██║  ██║██╔══╝   ██╔██╗ ██║   ██║██║
╚██████╗╚██████╔╝██████╔╝███████╗██╔╝ ██╗╚██████╔╝██║
 ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝
```

---
<img width="1366" height="900" alt="image" src="https://github.com/user-attachments/assets/1a3578ba-add8-49a2-88b4-08195a7f0140" />

## 🤯 What Is This?
**`codexapp`** is a lightweight bridge that gives you a browser-accessible UI for Codex app-server workflows.

You run one command. It starts a local web server. You open it from your machine, your LAN, or wherever your setup allows.  

**TL;DR 🧠: Codex app UI, unlocked for Linux, Windows, and Termux-powered Android setups.**

---

## ⚡ Quick Start
> **The main event.**

```bash
# 🔓 Run instantly (recommended)
npx codexapp

# 🌐 Then open in browser
# http://localhost:18923
```

By default, `codexapp` now also starts:

```bash
cloudflared tunnel --url http://localhost:<port>
```

It prints the tunnel URL, terminal QR code, and password together in startup output.  
Use `--no-tunnel` to disable this behavior.

If you are using a provider or AI gateway that is already authenticated and do not want `codexapp` to force `codex login` during startup, use:

```bash
npx codexapp --no-login
```

### Linux 🐧
```bash
node -v   # should be 18+
npx codexapp
```

### Windows 🪟 (PowerShell)
```powershell
node -v   # 18+
npx codexapp
```

### Termux (Android) 🤖
```bash
pkg update && pkg upgrade -y
pkg install nodejs -y
npx codexapp
```

Android background requirements:

1. Keep `codexapp` running in the current Termux session (do not close it).
2. In Android settings, disable battery optimization for `Termux`.
3. Keep the persistent Termux notification enabled so Android is less likely to kill it.
4. Optional but recommended in Termux:
```bash
termux-wake-lock
```
5. Open the shown URL in your Android browser. If the app is killed, return to Termux and run `npx codexapp` again.

---

## iPhone / iPad via Tailscale Serve

If you want to use codexUI from iPhone or iPad Safari, serving it over HTTPS is recommended.

A practical private setup is to run codexUI locally and publish it inside your tailnet with Tailscale Serve:

```powershell
npx codexapp --no-tunnel --port 5900
tailscale serve --bg 5900
```

Then open:

```text
https://<your-machine>.<your-tailnet>.ts.net
```

This setup worked well in practice for:

- iPhone Safari access
- Add to Home Screen
- the built-in dictation / transcription feature in the app
- viewing the same projects and conversations from the Windows host

Notes:

- Tailscale Serve keeps access private to your tailnet
- on iOS, HTTPS / secure context appears to be important for mobile browser access and dictation
- some minor mobile Safari CSS issues may still exist, but they do not prevent normal use
- depending on proxying details, authentication behavior may differ from direct remote access
- if conversations created in the web UI do not immediately appear in the Windows app, restarting the Windows app may refresh them

---

## ✨ Features
> **The payload.**

- 🚀 One-command launch with `npx codexapp`
- 🌍 Cross-platform support for Linux, Windows, and Termux on Android
- 🖥️ Browser-first Codex UI flow on `http://localhost:18923`
- 🌐 LAN-friendly access from other devices on the same network
- 🧪 Remote/headless-friendly setup for server-based Codex usage
- 🔌 Works with reverse proxies and tunneling setups
- ⚡ No global install required for quick experimentation
- 🎙️ Built-in hold-to-dictate voice input with transcription to composer draft
- 🤖 Optional Telegram bot bridge: send messages to bot, forward into mapped thread, send assistant reply back to Telegram
- 💾 Project portability: export a project as a ZIP from project or thread menus, including matching Codex chat JSONL history under `.codex-project/chats/`
- 📦 Project import: restore exported project ZIPs from the browser via `Import Project`
- 🔁 Imported chats are rewritten for the destination `CODEX_HOME`, project path, and currently selected provider/model so they can be resumed in the new environment
- ⚙️ Project ZIP performance: exports stream ZIP bytes with response backpressure handling and skip generated/git-ignored folders; imports still buffer the selected ZIP once because the browser upload arrives as a single file

### Telegram Bot Bridge (Optional)

Set these environment variables before starting `codexapp`:

```bash
export TELEGRAM_BOT_TOKEN="<your-telegram-bot-token>"
export TELEGRAM_ALLOWED_USER_IDS="<your-telegram-user-id>,<optional-second-id>"
export TELEGRAM_DEFAULT_CWD="$PWD" # optional, defaults to current working directory
npx codexapp
```

`TELEGRAM_ALLOWED_USER_IDS` is required for safe access. Only allowlisted Telegram user IDs can use the bridge. If no allowed user IDs are configured, incoming Telegram messages are rejected.

To find your Telegram user ID:

1. Send a message to your bot.
2. Run `curl "https://api.telegram.org/bot<your-telegram-bot-token>/getUpdates"`.
3. Read `message.from.id` from the returned update payload.

Bot commands:

- `/start` show quick help and thread picker
- `/threads` list recent threads and pick one
- `/newthread` create and map a new Codex thread for this Telegram chat
- `/thread <threadId>` map current Telegram chat to an existing thread
- `/current` show currently connected thread for this chat
- `/history` show recent history for current thread
- `/status` show bridge/mapping status
- `/whoami` show your Telegram user/chat IDs and authorization state
- `/help` show command reference

Outgoing assistant messages are sent with Telegram `parse_mode=HTML` for formatting, with automatic plain-text fallback if HTML delivery fails.

---

## 🧩 Recent Product Features (from main commits)
> **Not just launch. Actual UX upgrades.**

- 🗂️ Searchable project picker in new-thread flow
- ➕ "Create Project" button next to "Select folder" with browser prompt
- 📌 New projects get pinned to top automatically
- 🧠 Smart default new-project name suggestion via server-side free-directory scan (`New Project (N)`)
- 🔄 Project order persisted globally to workspace roots state
- 🧵 Optimistic in-progress threads preserved during refresh/poll cycles
- 📱 Mobile drawer sidebar in desktop layout (teleported overlay + swipe-friendly structure)
- 🎛️ Skills Hub mobile-friendly spacing/toolbar layout improvements
- 🪟 Skill detail modal tuned for mobile sheet-style behavior
- 🧪 Skills Hub event typing fix for `SkillCard` select emit compatibility
- 🎙️ Voice dictation flow in composer (`hold to dictate` -> transcribe -> append text)

---

## 🌍 What Can You Do With This?

| 🔥 Use Case | 💥 What You Get |
|---|---|
| 💻 Linux workstation | Run Codex UI in browser without depending on desktop shell |
| 🪟 Windows machine | Launch web UI and access from Chrome/Edge quickly |
| 📱 Termux on Android | Start service in Termux and control from mobile browser |
| 🧪 Remote dev box | Keep Codex process on server, view UI from client device |
| 🌐 LAN sharing | Open UI from another device on same network |
| 🧰 Headless workflows | Keep terminal + browser split for productivity |
| 🔌 Custom routing | Put behind reverse proxy/tunnel if needed |
| ⚡ Fast experiments | `npx` run without full global setup |

---

## 🖼️ Screenshots

### Skills Hub
![Skills Hub](docs/screenshots/skills-hub.png)

### Chat
![Chat](docs/screenshots/chat.png)

### Mobile UI
![Skills Hub Mobile](docs/screenshots/skills-hub-mobile.png)
![Chat Mobile](docs/screenshots/chat-mobile.png)

---

## 🏗️ Architecture

```text
┌─────────────────────────────┐
│  Browser (Desktop/Mobile)   │
└──────────────┬──────────────┘
               │ HTTP/WebSocket
┌──────────────▼──────────────┐
│         codexapp            │
│  (Express + Vue UI bridge)  │
└──────────────┬──────────────┘
               │ RPC/Bridge calls
┌──────────────▼──────────────┐
│      Codex App Server       │
└─────────────────────────────┘
```

---

## 🎯 Requirements
- ✅ Node.js `18+`
- ✅ Codex app-server environment available
- ✅ Browser access to host/port
- ✅ Microphone permission (only for voice dictation)

---

## 🐛 Troubleshooting

| ❌ Problem | ✅ Fix |
|---|---|
| Port already in use | Run on a free port or stop old process |
| `npx` fails | Update npm/node, then retry |
| Termux install fails | `pkg update && pkg upgrade` then reinstall `nodejs` |
| Can’t open from other device | Check firewall, bind address, and LAN routing |

---

## 🤝 Contributing
Issues and PRs are welcome.  
Bring bug reports, platform notes, and setup improvements.

---

## ⭐ Star This Repo
If you believe Codex UI should be accessible from **any machine, any OS, any screen**, star this project and share it. ⭐

<div align="center">
Built for speed, portability, and a little bit of chaos 😏
</div>

---

Forked from [pavel-voronin/codex-web-local](https://github.com/pavel-voronin/codex-web-local) by Pavel Voronin.
