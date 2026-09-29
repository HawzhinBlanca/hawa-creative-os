# Moving Hawdesign production off the laptop

**Status:** plan for the owner's decision. Nothing here has been bought, changed or deployed.
**Written:** 2026-09-29. Prices and stock were checked on 2026-09-29 unless a row says otherwise.
**Scope:** where production runs. Development, tests and the chaos stacks stay on the MacBook.

---

## 1. Recommendation

**Rent one small Linux server with an Arm processor (arm64) and 32 GB of memory, in a German data
centre. Put the Desk behind Cloudflare Tunnel and Cloudflare Access so the team can open it in a
browser. Move production with the nightly backup and restore that were already proven on a clean
host (ADR-134).**

The first choice is **netcup VPS 4000 ARM G12.5**: 12 cores, 32 GB, 512 GB of fast disk, €45.36 a
month on a monthly contract, or less on a 12-month term. Take **Hetzner CAX41** instead if it is back
in stock when you order: 16 cores, 32 GB, €40.99 a month. Add about €3–4 a month for a second place to
keep backups. The total is **about €50 a month and no hardware to buy**.

Why this option:

- It keeps running through office power cuts, internet cuts, exam-day shutdowns, the Mac going to
  sleep and heavy use of your own apps.
- The team gets a normal `https://` address for the Desk.
- The server sits about 80 ms from Erbil, and about as close to Telegram, Canva and OpenAI as the
  office is today or closer.

Arm matters. Production's images are built for arm64. The Restate part of the nightly backup, which
holds the requests still in progress, can only be restored onto the same processor type (section 5.2).
An Arm server lets you use the proven procedure without changes. An Intel/AMD (x86) server would need a
new, unproven step.

**If the card you use to pay OpenAI, Anthropic and Canva is refused by netcup and Hetzner, or if a
client needs its data kept in the office:** buy a **Mac mini with 32 GB (about $1,500 plus Iraqi retail
margin) and a 1500 VA UPS**, and run production on it in the office. It reuses everything that already
works on the Mac. The weak points are office power, office internet and physical risk, and it needs
auto-login, which means turning FileVault off (section 4.1).

**Do not keep production on the MacBook** beyond the few weeks the move takes (section 4.3).

### Comparison

| | **B. Arm cloud server (recommended)** | **A. Mac mini in the office** | **C. Keep the MacBook, hardened** |
|---|---|---|---|
| What | netcup VPS 4000 ARM G12.5, or Hetzner CAX41 when in stock (Germany) | Mac mini M6, 32 GB / 512 GB, plus UPS | Today's MacBook |
| One-off cost | €0 (a domain is about $10 a year) | ≈ $1,500 Mac (US price; 24 GB = $1,299) + ≈ $250–350 UPS + optional ≈ $100–150 4G backup router. Iraqi retail is likely 10–25% higher *(estimate)* | ≈ $0–350 (optional UPS) |
| Monthly cost | ≈ €45 server + ≈ €3–4 off-site backup storage (+ VAT if charged) | Electricity and existing internet only | none |
| Memory and CPU | 32 GB, 12–16 Arm cores, nothing else running on it | 32 GB (Docker gets ~24 GB), 12 cores | 36 GB shared with your own apps; load 12–20 seen on 2026-09-29 |
| Survives office power cut | Yes | Only as long as the UPS lasts, then down until someone logs in | No |
| Survives office internet cut or exam-day shutdown | Yes: keeps working on messages that reach Telegram | No | No |
| Survives the Mac sleeping or being carried away | Yes | Yes (never moves) | No |
| Team opens the Desk in a browser | Yes, 24/7 | Yes, while the office is online | Only while the laptop is open and online |
| Repository changes | Moderate: launchd to systemd, two Linux fixes, backup copy off the server, host-neutral wording (section 6) | Small (section 6) | Small |
| Migration risk | Low to medium: same processor type, proven restore; new operating system | Low: same operating system and tools | none |
| Main risks | Paying from Iraq, provider stock, Linux upkeep | Power, internet, FileVault/auto-login, theft or damage, one box in one room | Everything that happens today |
| Verdict | **Do this** | Fallback | Stop-gap only |

x86 servers were also checked. Hetzner CX53 has 32 GB for €29.49 and is sometimes in stock. They are
cheaper, but moving the in-flight Restate state onto them is unproven (section 5.2), so they are not
recommended unless you accept draining all in-flight work first.

---

## 2. Words used in this plan

| Word | Meaning here |
|---|---|
| Production | The copy of Hawdesign that serves real clients: Telegram in, Canva designs out |
| Container | One program in its own sealed box (Postgres, Restate, Core, …). Docker runs them |
| Docker Desktop | The Mac app that runs containers inside a hidden Linux machine (on the MacBook, a 20 GB one) |
| arm64 / x86 | Two processor families. Apple chips and the recommended servers are arm64. Most older servers are x86 |
| VM / VPS | A rented virtual computer in a data centre |
| Restate | The part that remembers every request in progress, even across restarts |
| Paired backup | One night's database dump, file store and Restate copy, locked together so they restore as one set |
| launchd / systemd | The macOS and Linux schedulers that run the watchdog and the nightly backup |
| Cloudflare Tunnel | A program on the server that connects out to Cloudflare. The Desk gets a public `https://` address, but no port on the server is opened |
| Cloudflare Access | A login page in front of that address. Only people you list (by email) get through |
| Tailscale | A private network between your devices and the server, used for maintenance logins (SSH) |
| UPS | A battery box that keeps a computer running through a power cut |
| RPO / RTO | How much recent work a restore can lose / how long it takes to be back |

---

## 3. What production needs, measured on 2026-09-29

### 3.1 The stack

From `infra/docker/docker-compose.prod.yml`, project `hawa-production`:

| Service | What it is | Notes for a new host |
|---|---|---|
| `nginx` (1.27-alpine-slim) | Front door, port 8080 on `127.0.0.1` only (`HAWA_BIND_IP`) | Keep it loopback-only. On Linux, Docker's published ports bypass the ufw firewall |
| `desk` | The Desk web app, built by `Dockerfile.desk` | Built on the host by `deploy.sh` |
| `core` | The API. Needs librsvg, the Microsoft core fonts (Verdana) and the fonts in the repo | `Dockerfile.core` compiles the Pango text-measure helper in its builder stage, so it works on either processor type |
| `worker-blue` / `worker-green` | The worker (Telegram poller, Restate handlers). Only one runs except during a deploy | Blue/green switch through Restate (`infra/docker/README.md`) |
| `cutout` | Person cut-outs: BiRefNet ONNX model on the CPU, 4 threads, `mem_limit: 12g` | The model files live in `~/.hawa/models` (portrait model 0.97 GB and YuNet face model, pinned by sha256). `requirements.txt` notes Linux arm64 and x86_64 wheels for every package |
| `postgres` (pgvector/pgvector:pg17) | Database, external volume `hawa-production_postgres_data`, port `127.0.0.1:54332` | Multi-architecture image |
| `restate` (1.7.10) | Durable workflows, external volume `hawa-production_restate_data`, node name `hawa-restate-prod-1` | Multi-architecture image |
| `vector` (0.58.0, pinned by digest) | Copies container logs to `~/.hawa/logs/containers` through the Docker socket | The digest is a multi-architecture index (checked: amd64, arm64, arm/v7) |

Also checked: the Restate helper image digest used by the nightly backup
(`ghcr.io/restatedev/restate@sha256:5cef31…`) and `pgvector/pgvector:pg17` are multi-architecture
(amd64 and arm64).

### 3.2 Resource use

`docker stats --no-stream` on 2026-09-29, with production idle:

| Container | Memory |
|---|---|
| cutout | 2.19 GiB (limit 12 GiB) |
| restate | 945 MiB |
| postgres | 604 MiB |
| vector | 100 MiB (limit 192 MiB) |
| core | 89 MiB |
| worker-blue | 64 MiB |
| nginx + desk | 15 MiB |
| **Production total, idle** | **≈ 4.0 GiB** |

The Docker VM on the MacBook has 8 CPUs and 20.2 GiB. The test Postgres (292 MiB) also runs there and
would stay on the MacBook.

Peaks that decide the size of the host:

- **One cut-out takes about 8 GB at its peak** (ADR-032, measured; `services/cutout/hawa_cutout/core.py`).
  During a cut, production uses about **10 GB**.
- **A deploy runs the cut-out tests in a separate container limited to 12 GB** (`deploy.sh`, step 7).
  It also builds the images and briefly runs two worker colours. If a real cut happens during a deploy,
  memory can reach **16–18 GB** *(estimate from the figures above)*.
- On 2026-09-18 the Mac ran out of memory, Docker's VM was swapped out and production Postgres crashed
  twice in 45 minutes. A host that runs nothing else removes that cause.

So: **16 GB works but is tight** (use swap, and do not deploy while a cut is running). **32 GB leaves
headroom.** CPU matters only for cut-outs and image builds. A cut takes 4–8 s per person on the Mac
(ADR-032). On a shared Arm server it may take 2–4 times as long *(estimate; measure it in the
rehearsal, section 7.3)*. Cut-outs are optional: without the service a photo is placed in a frame.

### 3.3 Disk

`docker system df` and `du` on 2026-09-29:

| Item | Size |
|---|---|
| Postgres volume | 1.34 GB |
| Restate volume | 5.3 MB |
| File store `~/.hawa/blobs` | ≈ 0 (pictures are still in the database: `refs_without_row=186` in `backup.log`) |
| Models `~/.hawa/models` | 2.0 GB (only the portrait model and YuNet, ≈ 1 GB, are used) |
| Production images | ≈ 2.6 GB (core 818 MB, worker 660 MB, cutout 573 MB, restate 512 MB, …) |
| Pre-deploy dumps `infra/backup/snapshots` | 2.5 GB (`disk_cleanup.sh` keeps the newest ten) |
| Nightly archive | 172 MB. A night's dump is ≈ 48 MB (`hawa_20260929T003004Z`); 14 nights are kept |
| Logs | 72 MB (capped at 2 GB) |
| Docker build cache | 29 GB on the MacBook, shared with development. Budget about 20 GB on a server |

**At least 80 GB of disk; 160 GB or more is comfortable.** Both recommended servers have 320–512 GB.

Traffic: 1,613 tasks and 2,092 task events in total (`backup.log`, 2026-09-29). That is light: the
size of the host is set by memory, not by load.

### 3.4 The Mac-only parts

| Piece | Where | Mac-specific because |
|---|---|---|
| Watchdog, every 5 min and at login | `infra/ops/install_launch_agents.sh` → `~/Library/LaunchAgents/design.hawa.watchdog.plist` | launchd user agents run only while this user is logged in |
| Nightly backup at 03:30, including the Restate paired archive | `design.hawa.nightly-backup` (`HAWA_RESTATE_BACKUP_ENABLED=on` since 2026-09-29; the first paired night was `20260929T003004Z`) | launchd, and the archive goes to **iCloud Drive** (`HAWA_BACKUP_ARCHIVE_DEST=~/Library/Mobile Documents/com~apple~CloudDocs/HawaBackups`) |
| Weekly schema drill (Sun 04:00) and monthly data drill (1st, 05:00) | `design.hawa.backup-restore-drill`, `design.hawa.restore-drill` | launchd |
| Keep-awake | `design.hawa.keepawake` (`caffeinate -s`) | Holds off idle sleep on mains power only; the lid and battery still sleep the Mac |
| Starting Docker | `watchdog.sh` step 1: `open -ga Docker` | Docker Desktop is a Mac app |
| Archive passphrase | `~/.hawa/backup_passphrase` (0600) | Just a file; it moves with the host |

### 3.5 Outside services and their addresses

Only the variable **names** in `infra/docker/.env.production` were read, never the values.

| Integration | How it connects | What changes with a new host |
|---|---|---|
| Telegram | The live worker colour long-polls (ADR-135). No inbound webhook | Nothing. **Never let two hosts poll the same bot**: they would fight over updates and could send messages twice. Core pins `api.telegram.org` to `149.154.167.99` (`extra_hosts`); keep it, and remember it is pinned |
| Canva Connect | OAuth. `CANVA_REDIRECT_URI` → `/v1/integrations/canva/callback`. Tokens are stored in Postgres, sealed with `CANVA_TOKEN_ENCRYPTION_KEY` | The tokens move with the database. If the same key moves too, **no reconnect is needed**. For a reconnect later, see section 5.4 |
| Google Drive / Sheets | Service account key (`GOOGLE_SERVICE_ACCOUNT_KEY`), outbound only | Nothing |
| OpenAI, Anthropic, Gemini | API keys, outbound only | Nothing. The same keys are used from a new address |
| Desk links in Telegram messages | `HAWA_PUBLIC_URL`, then `HAWA_DESK_BASE_URL` (`apps/core/src/app.ts`, `desk-review-link.ts`, `telegram-bridge.ts`). Both are `http://127.0.0.1:8080` today | Set both to `https://desk.<your-domain>` so the links work for the team |
| Named Google sign-in (ADR-064) | `HAWA_GOOGLE_OIDC_CLIENT_ID/_SECRET/_REDIRECT_URI/_HOSTED_DOMAINS`, **not set today** | Needs an `https://…/auth/google/callback` address and a **Google Workspace** domain: the code rejects accounts without a Workspace domain (the `hd` claim), so plain Gmail accounts cannot sign in. Setting any one of the four switches the Desk into named-review mode (`namedOfficeReviewMode`), so set all four together or none |

### 3.6 Two Linux problems found and checked

Both were found while reading the scripts and confirmed in a throwaway Debian container with GNU
coreutils 9.7 (built from the `hawa-cutout:1` image; no production container was touched):

1. **`deploy.sh` would stop on Linux.** It runs `infra/security/local_state_audit.sh`, which reads file
   modes with `stat -f '%Lp' … || stat -c '%a' …`. On Linux, `stat -f` means "file-system status": it
   prints several lines and returns an error, and both outputs end up in the variable. The next line
   (`$((8#$mode & 8#077))`) then fails with `invalid integer constant` under `set -e`.
2. **The nightly backup would fail on Linux.** In `infra/backup/nightly_backup.sh` line 116, the same
   pattern fills `SIZE` with several lines, so the size check fails the night. Line 163 (`BLOB_BYTES`)
   has no fallback at all.

Also:

- `infra/docker/.postgres_volume_created` and `.restate_volume_created` are **tracked in git**, and they
  hold the MacBook's volume creation times. On any new host `deploy.sh` steps 1b/1c refuse to deploy
  ("creation timestamp changed"). Editing them makes the checkout dirty, which `deploy.sh` also
  refuses.
- `deploy.sh` step 4 runs `scripts/validate_pack.py`. It fails in a fresh clone because it links to a
  gitignored file under `output/audits/` that exists only in the main checkout (a known trap, noted in
  memory on 2026-09-28).

---

## 4. The options in detail

### 4.1 Option A: a Mac mini kept on in the office

**Hardware and price** (US prices from Apple's 2026 line, checked 2026-09-29):

- Mac mini M6, 16 GB / 256 GB: $899. 24 GB / 512 GB: $1,299
  ([MacRumors](https://www.macrumors.com/roundup/mac-mini/),
  [Tom's Hardware](https://www.tomshardware.com/desktops/mini-pcs/apple-price-hikes-continue-as-mac-mini-with-16gb-ram-and-256gb-is-now-usd899-1tb-storage-option-adds-usd500-to-entry-level-headless-system)).
- 32 GB costs $400 more than 16 GB ([Macworld](https://www.macworld.com/article/2964754/2026-mac-mini-m5-pro-design-specs-release-date.html)),
  so **32 GB / 512 GB ≈ $1,499** *(estimate; confirm with the Erbil reseller, and expect a local margin)*.
- **16 GB is not enough.** macOS takes 3–4 GB, which leaves Docker about 12 GB against a 10 GB cut-out
  peak and a 12 GB deploy test. **24 GB is the minimum and 32 GB is recommended.**
- UPS: a 1500 VA line-interactive or sine-wave unit, the 230 V model for Iraq. The APC BR1500MS2 (the
  120 V model) is listed at $339.99
  ([Staples](https://www.staples.com/apc-back-ups-pro-1500va-battery-backup-and-surge-protector-10-outlets-black-br1500ms2/product_24323531)).
  Budget about **$250–350** locally *(estimate)*. Plug the Mac mini **and the internet router/ONT** into
  it. Connect it by USB so macOS shuts down cleanly when the battery runs low.
- Optional: a 4G/5G router as a backup internet line (≈ $100–150 plus a SIM; *estimate*).

**Power and internet in Erbil.** The Runaki programme reports more than 85% of the Kurdistan Region on
24-hour grid power as of April 2026, with Erbil neighbourhoods still being added
([KRG Ministry of Electricity](https://gov.krd/moel-en/activities/news-and-press-releases/2026/april/nearly-55-million-citizens-now-enjoy-24-hour-electricity-through-the-runaki-initiative/),
[Rudaw](https://www.rudaw.net/english/kurdistan/230420265)). Cuts and generator switch-overs still
happen, so a UPS is required, not optional. Iraq also switched the internet off for exams again in
2026: 06:00–07:30 on 11 June, and events that hit only Kurdistan-region operators until 8 July
([ISOC Pulse](https://pulse.internetsociety.org/en/shutdowns/exams-shutdown-iraq-11-june-2026/),
[964media](https://en.964media.com/47757/)). An office host is offline during those windows. A cloud
host keeps working, although the team and clients in Iraq are offline too.

**What must be set on the Mac mini:**

- Energy settings: prevent sleep, "Start up automatically after a power failure"
  (`sudo pmset -a autorestart 1 sleep 0 disksleep 0`), and no automatic macOS update restarts.
- **Auto-login.** The launch agents are per-user and run only after login
  (`install_launch_agents.sh`: "Agents run only while this user is logged in"). After a power cut the
  Mac restarts to the login window and production stays down until someone types the password, unless
  auto-login is on. **macOS allows auto-login only with FileVault (disk encryption) turned off.**
  Choose one:
  - FileVault off, with the Mac in a locked room. The disk then holds client data unencrypted.
  - FileVault on, and someone logs in after every unplanned restart.
  - Move Docker and the jobs to system-wide LaunchDaemons. That is extra work, and it is untested with
    Docker Desktop.
- Docker Desktop: "Start when you sign in", and give its VM 20–24 GB of memory.
- Docker Desktop licence: free for businesses under 250 employees and under $10 M in revenue.
- Tailscale for remote maintenance, and `cloudflared` for the Desk (it can run as a system
  LaunchDaemon, so it works before login).

**Pros:**

- Same operating system and tools: launchd, iCloud, `caffeinate` and Docker Desktop all work as they
  do today.
- Same arm64 images, so the proven clean-host restore applies unchanged.
- Data stays in the office.
- Bought once, and paid in cash locally, so no foreign card is needed.

**Cons:**

- Office power, internet, exam shutdowns, theft, fire and any damage to the building.
- It is still one box, like the laptop.
- Someone in the office has to attend to it after long cuts.
- The iCloud archive then syncs from the same building it backs up, so it only helps if iCloud really
  uploads. The script itself says "a synchronized folder does not establish off-host durability".

### 4.2 Option B: a small cloud server

**Why Arm (arm64):**

1. Today's images are built and proven on arm64. `deploy.sh` builds on the host, so either processor
   type would build.
2. **The Restate restore checks that the archived Restate image ID is present locally**
   (`infra/backup/restate_restore_rehearsal.py` lines 112–130). An image ID differs between arm64 and
   x86 builds of the same release, so on x86 the proven procedure refuses. Getting past that means
   emulating arm64 or trusting that Restate's on-disk data moves across processor types. Neither has
   been tested. The alternative is to finish or cancel all in-flight work first, which is hard: a
   request waiting for review keeps its state in Restate for days.

**Candidates** (EUR, before VAT, checked 2026-09-29):

| Plan | CPU | RAM | Disk | Price per month | In stock? | Source |
|---|---|---|---|---|---|---|
| **netcup VPS 4000 ARM G12.5** | 12 Arm vCores (Ampere Altra Max, shared) | 32 GB | 512 GB NVMe | **€45.36** (monthly contract; 12- and 24-month terms show −13% / −26%) | Orderable on netcup's page | [netcup ARM servers](https://www.netcup.com/en/server/arm-server); third-party list with €38.11 on a 12-month term: [netcupvoucher, 2026-09-23](https://netcupvoucher.com/blog/netcup-pricing-2026) |
| netcup VPS 2000 ARM G12.5 | 8 Arm vCores | 16 GB | 256 GB NVMe | €26.92 | Orderable | same |
| **Hetzner CAX41** | 16 Arm vCPU (Ampere, shared) | 32 GB | 320 GB | **€40.99** (+ IPv4) | **Out of stock since 2 Sep 2026** in all locations | [Hetzner price adjustment, 15 June 2026](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/); [stackvaluelab](https://stackvaluelab.com/hetzner-cx-cax-unavailable/); [live tracker](https://radar.iodev.org/cloud-status) |
| Hetzner CAX31 | 8 Arm vCPU | 16 GB | 160 GB | €20.99 | Out of stock | same |
| Hetzner CX53 (x86) | 16 vCPU (shared) | 32 GB | 320 GB | €29.49 | Comes and goes (FSN/HEL seen hours before this check) | same |
| Hetzner CX43 (x86) | 8 vCPU | 16 GB | 160 GB | €15.99 | Comes and goes | same |
| Hetzner CPX42 (x86) | 8 vCPU | 16 GB | 320 GB | €69.49 | In stock | same |
| AWS EC2 t4g.xlarge (Arm), for reference | 4 vCPU (burstable) | 16 GB | EBS extra | ≈ $98 (us-east-1) + disk + traffic | In stock | [economize.cloud](https://www.economize.cloud/resources/aws/pricing/ec2/t4g.xlarge/) |
| Oracle Cloud Always Free Arm | 2 OCPU | 12 GB | — | €0 | **Rejected**: the free allowance was cut from 24 GB to 12 GB on 15 June 2026, and idle machines can be reclaimed | [InfoQ](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/) |

Hetzner raised prices twice in 2026, citing memory and SSD costs, and its cost-optimised line has been
unavailable since 2 September 2026. Both netcup and Hetzner offer Arm only in Europe: netcup in
Nuremberg and Vienna, Hetzner in Falkenstein, Nuremberg and Helsinki.

**Distance from Erbil.** Measured on 2026-09-29 from the owner's MacBook, assumed to be on the office
connection. TCP connect time is the median of three tries:

| Destination | Time |
|---|---|
| Hetzner Nuremberg | 84 ms (ping 82 ms to Falkenstein) |
| Hetzner Falkenstein | 90 ms |
| Hetzner Helsinki | 103 ms (ping 103 ms) |
| AWS Frankfurt | 76 ms |
| **AWS UAE (me-central-1)** | **189 ms** |
| Telegram API | 81 ms |
| Canva API | 85 ms |
| OpenAI API | 86 ms |

Germany is closer, in network terms, than the Gulf. A server there sits next to the APIs Hawdesign
calls, so a design run should be no slower and probably faster. The team opening the Desk from Erbil
will see about 80–100 ms per request, which is fine for a web page.

**Paying from Iraq.** This is the most likely blocker.

- Hetzner takes Visa, Mastercard, AMEX, UnionPay, PayPal and bank transfer
  ([Hetzner docs](https://docs.hetzner.com/general/billing-and-account-management/billing-at-hetzner/payment-overview/)).
  New accounts may be asked for an ID photo or a PayPal verification payment.
- netcup takes cards, PayPal, SEPA and bank transfer
  ([netcup](https://www.netcup.com/en/about-netcup/payment-methods)). It skips document checks for most
  card and PayPal sign-ups, but sends flagged ones to manual checks
  ([guide](https://netcup.best/blog/how_to_pass_netcup_kys_verification/)). Private customers outside
  the EU may be charged German VAT (19%).
- First Iraqi Bank currently states that **international card settlement is suspended**
  ([FIB notice](https://fib.iq/update-on-our-international-card-usage/)).

Use whichever card already pays OpenAI, Anthropic and Canva. netcup offers a 30-day money-back
guarantee, which lowers the risk of trying.

**Where the data lives.** Client briefs, photos and designs would be stored in Germany or Austria,
under EU (GDPR-grade) rules. They already travel to OpenAI, Anthropic, Canva and Google, all outside
Iraq. This plan did not research Iraqi law. If a client contract requires data to stay in Iraq, choose
option A.

**Pros:**

- No power, internet or physical risk in the office.
- 32 GB for this stack alone.
- A normal `https://` address for the team.
- Provider snapshots, and cheap off-site storage in the same data centre.

**Cons:**

- Paying from Iraq.
- Provider stock.
- The Mac-specific scheduling has to be ported to Linux (section 6).
- Linux security updates need a monthly check.
- The owner depends on the provider keeping the account in good standing: pay on time, keep contact
  details current.

### 4.3 Option C: keep the MacBook, hardened

What could be done:

- Keep it on mains power and never close the lid (clamshell mode needs an external display), or
  `sudo pmset -c sleep 0 disablesleep 1`.
- Add a UPS on the desk.
- Close heavy apps.
- Run `cloudflared` so the team can reach the Desk.

Why it is not viable as the production host:

- It is the owner's working computer. It travels, sleeps on battery (23:31 and 23:37 on 2026-09-19),
  and shares 36 GB with the owner's own apps: load reached 12–20 on 2026-09-29, and memory pressure
  crashed production Postgres on 2026-09-18.
- It also runs the test Postgres, the chaos stacks and agent sessions, which compete for the same
  Docker VM.
- The team's Desk would work only when the owner's laptop is open and online, which defeats the
  purpose.

Use it only as the host during the move, and as the rollback target for two weeks afterwards.

---

## 5. How the team reaches the Desk, and other access

### 5.1 The Desk: Cloudflare Tunnel with Cloudflare Access (recommended)

1. **Domain.** The owner buys or moves a domain to Cloudflare DNS. A `.com` costs about $10–11 a year
   *(estimate)*. `HAWA_DOMAIN` already exists in `.env.production`; its value was not read.
2. **Tunnel.** Install `cloudflared` on the host as a system service (it is already installed on the
   MacBook). Route `desk.<domain>` → `http://127.0.0.1:8080`. **No inbound port is opened on the
   server.** nginx stays bound to `127.0.0.1`.
3. **Login page.** Add a Cloudflare Access application for `desk.<domain>`. Allow the named team
   members by email, with a one-time PIN by email, or with Google as the login provider (plain Gmail
   works here, unlike ADR-064's sign-in).
4. **Price.** Cloudflare Tunnel is free. Zero Trust Access is free for up to 50 users (checked
   2026-09-29 on third-party summaries: [zerometric](https://zerometric.net/research/cloudflare-zero-trust-free-plan-limits-2026/),
   [costbench](https://costbench.com/software/business-vpn/cloudflare-zero-trust/); confirm on
   cloudflare.com when signing up).
5. **HTTPS.** Cloudflare provides the certificate. Core's session cookies are `Secure` and need HTTPS,
   and nginx already sends HSTS.
6. **Addresses.** Set `HAWA_PUBLIC_URL` and `HAWA_DESK_BASE_URL` to `https://desk.<domain>`. Keep
   `HAWA_BIND_IP=127.0.0.1`.
7. **Exceptions.** The comparison judge links (`/judge/<token>`, `HAWA_JUDGE_BASE_URL`) are meant for
   people outside the office. Either list those people in Access, or add an Access "bypass" rule for
   `/judge/*`: the token in the link already guards it.
8. **Test before going live.** Sign in, approve and reject from the Desk through the tunnel, and check
   that Core's CSRF and origin checks accept `https://desk.<domain>`. nginx passes the original
   `Host` header through.

Cloudflare Access controls who can reach the page. The Desk's own login still decides what each
person may do.

### 5.2 Maintenance: Tailscale

Put the server on the owner's tailnet. Allow SSH (key only, no password) **only over Tailscale**, and
close SSH on the public address once Tailscale works. Deploys, backups and restores are run over this
link.

The free Personal plan allows 6 users, but its terms are for personal use
([Tailscale pricing](https://tailscale.com/pricing)). For an office, Standard costs about $8 per user
per month; one admin user is enough.

### 5.3 Named Google sign-in (ADR-064)

Named sign-in needs:

- an owner-created Google OAuth client,
- a **Google Workspace** domain (`HAWA_GOOGLE_OIDC_HOSTED_DOMAINS`),
- the callback `https://desk.<domain>/auth/google/callback`. The code refuses any callback that is not
  `https` and does not end in `/auth/google/callback`.

The move makes this possible, but it is **not part of the move**. It has its own rollout and tests
(ADR-064, "Rollout and proof").

### 5.4 Canva reconnect, only if it is ever needed

The connection's tokens move with the database. If the owner has to connect Canva again later, there
are two ways:

- **No change at Canva.** Keep `CANVA_REDIRECT_URI` at `http://127.0.0.1:8080/v1/integrations/canva/callback`
  and connect from the MacBook through a tunnel: `ssh -L 8080:127.0.0.1:8080 <server>`, then open the
  Desk at `http://127.0.0.1:8080`. Canva sends the browser back to `127.0.0.1:8080`, which the tunnel
  forwards to the server. The laptop's own stack must be stopped so that port 8080 is free.
- **Change at Canva.** Add `https://desk.<domain>/v1/integrations/canva/callback` in the Canva
  Developer Portal and set `CANVA_REDIRECT_URI` to it. Canva allows `http://127.0.0.1` for development
  but asks public integrations to remove local addresses
  ([Canva docs](https://www.canva.dev/docs/connect/creating-integrations/)).

---

## 6. What changes in the repository

AGENTS.md: "Add an ADR before changing a selected foundation." The production host is one, so the
move needs **a new ADR (next free number; 140 on this branch, check other branches first: ADR numbers
have collided before)**, recording the choice and the reasons in this plan.

### 6.1 Needed for option B (Linux server)

| File | Change | Why |
|---|---|---|
| `infra/security/local_state_audit.sh` | Portable `mode_of`/`size_of`: use `stat -c` on Linux, `stat -f` on macOS (choose by `uname`), not `a \|\| b` | Section 3.6: it stops `deploy.sh` on Linux (verified) |
| `infra/backup/nightly_backup.sh` (lines 116, 163) | Same portable size helper | Section 3.6: it fails every night on Linux (verified) |
| `infra/docker/.postgres_volume_created`, `.restate_volume_created`, `deploy.sh` steps 1b/1c | Keep the stamps per host, outside git (for example `~/.hawa/volume-stamps/`). Take them out of git and add them to `.gitignore` | Tracked stamps from the MacBook make every other host refuse to deploy, and fixing them by hand makes the tree dirty |
| New `infra/ops/systemd/` units and `infra/ops/install_systemd_units.sh` | `hawa-watchdog.timer` (at boot, then every 5 min); `hawa-nightly-backup.timer` (`OnCalendar=*-*-* 03:30 Asia/Baghdad`, `Persistent=true`); weekly drill (Sun 04:00); monthly drill (1st, 05:00). Each runs the same script as the launch agent. Backup settings come from `/etc/hawa/backup.env` (mode 0600, root-owned): `HAWA_BACKUP_ARCHIVE_DEST`, `_KEYFILE`, `_KEEP`, `HAWA_RESTATE_BACKUP_ENABLED`, `HAWA_RESTATE_BACKUP_HELPER_IMAGE`. Logs go to `~/.hawa/logs/*.log` as today | launchd does not exist on Linux. Keep `install_launch_agents.sh` for Macs |
| `infra/ops/watchdog.sh` | Step 1: on Linux, check `systemctl is-active docker` and report, instead of `open -ga Docker`. Make the disk alert text host-neutral (it tells the owner to open "System Settings, General, Storage") | Mac wording and a Mac-only command |
| New `infra/backup/offsite_copy.sh` plus a timer (for example 05:30) | Copies the encrypted archive to a second place, holding `archive_lock.py --mode shared` while copying. The second place is a Hetzner Storage Box (1 TB, about €3.20 a month per [a third-party listing](https://www.whtop.com/plans/hetzner.com/128269); [BX11](https://www.hetzner.com/storage/storage-box/bx11/); SFTP/rsync), in a different data centre from the server, and optionally a pull to the MacBook's iCloud folder over Tailscale. It compares checksums after copying and alerts on Telegram when the copy is missing or late (`backup_status.py` style) | The archive must not live only on the server it protects. The script already says the local archive is not an off-host copy. Everything in it is encrypted with the office passphrase |
| `runbooks/10_backup_restore.md` | Add Linux equivalents: `systemctl stop hawa-*.timer` in place of `launchctl bootout`; the new archive and off-site locations; "office Mac" → "production host" | The restore steps name launchd |
| `infra/ops/README.md`, `infra/docker/README.md`, `docs/25_OPERATIONS_RUNBOOK.md` | Host-neutral wording; how to deploy over SSH | They say "on the office Mac" |
| `deploy.sh` | No logic change expected beyond steps 1b/1c. Run its pre-flight on the server during the rehearsal and fix what it finds. It needs `git`, `node` 22 and `pnpm` (for `npx tsx` in blue/green, `upgrade.ts` and the receipt), `python3`, `curl`, `openssl` and `shasum` (from `perl`) on the host | Found by reading it; the rehearsal is the proof |
| `infra/docker/nginx.conf` | Nothing required | Tunnel traffic arrives as plain HTTP on `127.0.0.1:8080`, like today |
| Host-only files (not in git) | `infra/docker/.env` and `.env.production` copied as they are, then `HAWA_PUBLIC_URL`, `HAWA_DESK_BASE_URL`, `HAWA_DOMAIN` (and later the ADR-064 variables) changed; `~/.hawa/backup_passphrase`; `~/.hawa/models/{BiRefNet-portrait-epoch_150.onnx,face_detection_yunet_2023mar.onnx}`; `output/audits/…` for `validate_pack.py`; the `cloudflared` tunnel token | Secrets and large files stay out of git. Copy them only over SSH/Tailscale, never by chat or email |

### 6.2 Needed for option A (Mac mini)

- Host-local volume stamps (the same change as above).
- Docs wording.
- Optionally, a `cloudflared` LaunchDaemon example.

Everything else (launch agents, iCloud archive, keep-awake, Docker Desktop) runs as it is. The
archive goes to iCloud from the Mac mini's own Apple ID session; decide whether that is the owner's
Apple ID or an office one.

### 6.3 Firewall (option B)

- Provider firewall, where offered, plus nftables/ufw on the host: **no inbound ports at all** except
  SSH until Tailscale works, then none.
- Cloudflare Tunnel and Tailscale both connect outwards.
- Keep `HAWA_BIND_IP=127.0.0.1` and Postgres on `127.0.0.1:54332`. Docker's published ports bypass ufw,
  so binding to `0.0.0.0` would expose them no matter what the firewall says.

---

## 7. Migration steps (option B; option A is the same without the Linux work)

The move is the **nightly paired backup followed by the clean-host restore**. ADR-134 proved this on
disposable stacks on 2026-09-28: 47/47 checks, 34.5 s to healthy on small data, and in-flight
requests finished exactly once. Production's first paired night was `20260929T003004Z` (`backup.log`:
`restate=paired_archive`).

### 7.1 Owner decisions and purchases (about a day)

1. Choose the option. For B: order the server (Ubuntu 24.04 LTS arm64) with the card that pays the AI
   providers.
2. Buy or move a domain to Cloudflare and create a free Zero Trust account.
3. Order the off-site storage (Storage Box).
4. Give the list of team emails for Access.

### 7.2 Prepare the host (agent; about 1 day, no effect on production)

1. Create a user `hawa` in the `docker` group. Set up SSH keys. Set the timezone to `Asia/Baghdad`.
   Enable unattended security updates with reboots off (schedule them).
2. Add an 8 GB swap file as a safety net, with a low `vm.swappiness`.
3. Install Docker Engine and the Compose plugin from docker.com. **Check the Compose version**: the
   blue/green profile behaviour was verified on Compose 5.5.1 (`infra/docker/README.md`), so use that
   version or newer and repeat the profile check on a scratch project.
4. Install Node 22 and pnpm, python3, git, openssl, perl, and the build tools (`build-essential`,
   `pkg-config`, `libpango1.0-dev`) for `pnpm build` in the checkout. The monthly drill needs
   `apps/core/dist`.
5. Install Tailscale, cloudflared (tunnel created but not routed yet) and the firewall.
6. Clone the repository with a read-only deploy key, at the release commit that production runs
   (`fccf43ca`, receipt `deploy_20260929T004504Z_fccf43caf2f1.json`), or at the release that carries
   section 6's changes. Run `pnpm install --frozen-lockfile` and `pnpm build`. Copy the `output/audits`
   file for `validate_pack.py`.
7. Copy the secrets and models over Tailscale (section 6.1). Alternatively, download the two model files
   from their publishers and let the pinned sha256 check them.
8. Merge and release section 6's repository changes, with tests, before the rehearsal.

### 7.3 Rehearsal on the new host (agent; about half a day; nothing real is sent)

**Warning: the rehearsal must never start a worker colour, and must never start Core with the real
Telegram token.** It would poll the same bot as production and could send real messages.

1. Copy last night's paired set (dump, `.blobs` manifest, blob packs and index, `restate_*` files,
   `hawa_<stamp>.restate.json`) to the server.
2. Check it: `restate_nightly.py --verify-pair …`, then
   `restate_restore_rehearsal.py --pair … --apply`. The second one boots the restored Restate on a
   throwaway volume with no network (ADR-057) and **proves the Restate image ID check passes on this
   host**.
3. Restore the dump into a scratch Postgres (the monthly-drill method) and run `blob-verify`.
4. Build all images (`docker compose … build core desk cutout worker-blue`) so the cutover does not wait
   for builds. Run the cut-out tests in the image. **Time one real cut on a sample photo.** If it takes
   more than about 30 s per person, decide whether that is acceptable, or set `CUTOUT_THREADS` higher
   on a 12–16-core server.
5. Run `bash infra/docker/deploy.sh` (pre-flight, not `--apply`) against empty rehearsal volumes. Fix
   whatever it reports.
6. Delete every rehearsal volume and container. `--restore-into` needs an empty volume, and nothing
   named `hawa-restate-prod-1` may be running.
7. Test the tunnel against a harmless page before routing the Desk.

### 7.4 Cutover (maintenance window of about 45–90 minutes, in a quiet evening)

1. Tell the team. In the Desk and the Restate admin, check that no design is running. Requests waiting
   for review are fine: they move with Restate.
2. **On the MacBook, unload the watchdog and the backup and drill agents first**
   (`launchctl bootout gui/$(id -u)/design.hawa.watchdog`, and the same for the other three). If the
   watchdog stays loaded, it restarts the laptop stack within five minutes and you have two live
   hosts.
3. Run the final paired backup by hand with the nightly agent's settings (`nightly_backup.sh`; about
   30 s, intake paused about 14 s). **As soon as it finishes, stop the laptop's worker colours, Core
   and Restate**, so nothing new is confirmed after the capture. The ADR-134 drill froze the source
   worker before the capture: repeat its exact order from `packages/testkit/chaos/r10-restore.ts`. Keep
   the laptop volumes untouched: they are the rollback.
4. Copy that night's set to the server (≈ 200 MB) and check the pair there.
5. Set `HAWA_PUBLIC_URL` and `HAWA_DESK_BASE_URL` in the server's `.env.production` first, so no second
   restart is needed.
6. On the server, follow `runbooks/10_backup_restore.md`, "Restoring Restate on a clean host" and
   "Restoring for real":
   1. Create the two external volumes.
   2. Start `postgres` alone. The init scripts create the roles from `DATABASE_URL`.
   3. Run the restore-swap block and wait for `restore-check=ok`.
   4. Unpack the file packs and run `blob-verify` (`missing` must be 0).
   5. Run `--restore-into hawa-production_restate_data`.
   6. Start Restate alone and list `sys_invocation`.
   7. Start Core, then the worker colour the restored deployment names, then the rest with
      `deploy.sh --apply` from the same commit.
   8. Write the host-local volume stamps.
7. Install and start the systemd timers. Run `watchdog.sh --announce` and `watchdog.sh --status`.
8. Route the tunnel to `127.0.0.1:8080` and turn on Access.
9. **Smoke test:**
   - Send a brief from the owner's Telegram.
   - See it reach review, and approve it at `https://desk.<domain>`.
   - Check delivery and the Drive/Sheet row.
   - Check that `/v1/health` shows Canva, Telegram, Restate and the model provider as healthy.
10. The next morning, check that `backup.log` ends `OK … restate=paired_archive` and that the off-site
    copy is verified.

**Downtime:** 30–60 minutes of no replies *(estimate; images prebuilt, office upload speed unknown)*.
Client messages sent in the window are **not lost**: they wait in Telegram, which keeps unconfirmed
updates for about 24 hours, and the new worker picks them up when it starts polling.

**What can be lost:** only work done on the laptop after the final capture (ADR-134, "Recovery
point"). The freeze in step 3 keeps that close to zero.

### 7.5 After the move

- Keep the laptop's production volumes for **14 days**, with its agents unloaded and its stack stopped.
- After the first monthly restore drill passes on the server (`hawa.backup_drills`), the owner may
  remove them.
- Update the vault (`projects/hawa-production-runbook.md`, `synthesis/open-todos.md`: "Move production
  off the laptop") and the production memory notes, which name the Mac.

---

## 8. Rollback

- **Before the server has handled any real message:** stop the server's stack and timers. Reload the
  laptop agents (`bash infra/ops/install_launch_agents.sh`). The watchdog starts the laptop stack from
  its untouched volumes. Nothing is lost.
- **After the server has handled work:** take a paired backup on the server, stop its stack, and
  restore that set onto the laptop with the same clean-host procedure. The processor type and image IDs
  are the same, so the Restate check passes. Downtime is about the same as the cutover.
- **A bad release on the new host** rolls back as today: deploy the previous release
  (`infra/docker/README.md`).
- **Never run both hosts at once.** Two pollers on one bot, and two Delivery and Canva paths, cause
  duplicates.

---

## 9. Risks and what to do about them

| Risk | Option | Likelihood | What to do |
|---|---|---|---|
| The card is refused or ID verification stalls | B | Medium | Use the card that already pays the AI providers. Try netcup (money back within 30 days), then Hetzner. Fall back to option A |
| No Arm server in stock | B | Medium (Hetzner CAX is out; netcup ARM is orderable today) | netcup first. Do not switch to x86 without a new Restate-move proof |
| Cut-outs slower on shared Arm cores | B | Medium | Measure in the rehearsal (7.3 step 4). Cut-outs are optional |
| Linux-specific surprises in the scripts | B | Medium; two already found and verified | Fix section 3.6 first. Run `deploy.sh` pre-flight and one full nightly on the server before cutover |
| Two hosts live at once (duplicate sends, poll conflict) | A, B | Low if the steps are followed | Unload the laptop watchdog before stopping the stack (7.4 step 2). Never start workers in the rehearsal |
| Off-site copy silently missing | A, B | Medium without monitoring | `offsite_copy.sh` verifies checksums and alerts |
| Losing the archive passphrase | all | Low, fatal | It must be in the owner's password manager as well as on the host (runbook, ADR-134 checklist) |
| Office power or internet cut, exam shutdown | A, C | High | UPS plus a 4G backup line (A). Not needed for B |
| Unplanned restart waits at the FileVault login | A | High after long cuts | Decide on FileVault/auto-login consciously (section 4.1) |
| Theft, fire or damage in the office | A, C | Low, total | Off-site encrypted archive. B avoids it |
| Provider outage or account suspension | B | Low | Off-site archive in a second data centre plus the laptop copy. The clean-host restore works on any arm64 host, including a Mac |
| Unpatched server | B | Medium over time | Unattended security updates. SSH only over Tailscale. No open ports |
| Monthly cost creeps up (2026 price rises) | B | Medium | Rescaling at Hetzner applies new prices; a 12-month netcup term fixes the price |

---

## 10. What only the owner can do

1. Choose A or B. Agree to about €50 a month (B) or about $1,800–2,200 one-off (A).
2. Pay the provider and pass any ID check. Buy the domain and set up the Cloudflare account.
3. Store the archive passphrase in the password manager, if that is not already done.
4. Give the team list for Access. Later, create the Google OAuth client and Workspace domain for
   ADR-064.
5. Approve the maintenance window for the cutover.
6. For A: decide on FileVault and auto-login. Buy the UPS and, optionally, the 4G line.

---

## Sources

All checked on 2026-09-29.

- Repository: `infra/docker/docker-compose.prod.yml`, `infra/docker/deploy.sh`, `infra/docker/README.md`,
  `infra/docker/Dockerfile.{core,worker,desk,cutout}`, `infra/ops/{install_launch_agents,watchdog}.sh`,
  `infra/backup/nightly_backup.sh`, `infra/backup/restate_restore_rehearsal.py`,
  `infra/security/local_state_audit.sh`, `runbooks/10_backup_restore.md`, ADR-032, ADR-064, ADR-134,
  `infra/backup/release-receipts/deploy_20260929T004504Z_fccf43caf2f1.json`,
  `infra/backup/snapshots/backup.log`.
- Measurements: `docker stats --no-stream`, `docker system df -v`, `docker buildx imagetools inspect`,
  TCP connect times and pings from the MacBook, and a GNU `stat` test in a throwaway container.
- Hetzner prices (15 June 2026 adjustment):
  https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- Hetzner plans: https://www.hetzner.com/cloud/cost-optimized/
- Hetzner CX/CAX out of stock: https://stackvaluelab.com/hetzner-cx-cax-unavailable/ and
  https://radar.iodev.org/cloud-status
- Hetzner payment methods:
  https://docs.hetzner.com/general/billing-and-account-management/billing-at-hetzner/payment-overview/
- Hetzner Storage Box: https://www.hetzner.com/storage/storage-box/bx11/ ; price (third party):
  https://www.whtop.com/plans/hetzner.com/128269
- netcup ARM: https://www.netcup.com/en/server/arm-server ; pricing overview (third party):
  https://netcupvoucher.com/blog/netcup-pricing-2026 ; payment:
  https://www.netcup.com/en/about-netcup/payment-methods ; verification:
  https://netcup.best/blog/how_to_pass_netcup_kys_verification/
- AWS t4g.xlarge: https://www.economize.cloud/resources/aws/pricing/ec2/t4g.xlarge/
- Oracle free tier cut: https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/
- Mac mini 2026: https://www.macrumors.com/roundup/mac-mini/ ;
  https://www.macworld.com/article/2964754/2026-mac-mini-m5-pro-design-specs-release-date.html ;
  https://www.tomshardware.com/desktops/mini-pcs/apple-price-hikes-continue-as-mac-mini-with-16gb-ram-and-256gb-is-now-usd899-1tb-storage-option-adds-usd500-to-entry-level-headless-system
- UPS: https://www.staples.com/apc-back-ups-pro-1500va-battery-backup-and-surge-protector-10-outlets-black-br1500ms2/product_24323531
- Kurdistan power (Runaki):
  https://gov.krd/moel-en/activities/news-and-press-releases/2026/april/nearly-55-million-citizens-now-enjoy-24-hour-electricity-through-the-runaki-initiative/ ;
  https://www.rudaw.net/english/kurdistan/230420265
- Exam internet shutdowns: https://pulse.internetsociety.org/en/shutdowns/exams-shutdown-iraq-11-june-2026/ ;
  https://en.964media.com/47757/
- FIB international cards: https://fib.iq/update-on-our-international-card-usage/
- Cloudflare Zero Trust free tier: https://zerometric.net/research/cloudflare-zero-trust-free-plan-limits-2026/ ;
  https://costbench.com/software/business-vpn/cloudflare-zero-trust/
- Tailscale: https://tailscale.com/pricing
- Canva redirect URLs: https://www.canva.dev/docs/connect/creating-integrations/ ;
  https://www.canva.dev/docs/connect/authentication/
