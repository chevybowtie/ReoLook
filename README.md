# ReoLook

A Linux client for Reolink cameras, styled after the Reolink Windows app: a live grid, playback
with a 24-hour timeline, clip download and export, and a motion-triggered recorder that runs as
a service. It talks to the cameras directly over their HTTP API and RTSP, with no cloud account.

ReoLook started because I wanted to know when the peacocks showed up in the yard. The vehicle and
animal detection (below) is where that began.

ReoLook is an independent project and is not affiliated with or endorsed by Reolink. It contains
no Reolink code or assets.

![ReoLook live view, running in demo mode](docs/images/live.png)

## Try it without a camera

```
node bin/reolook.mjs demo
```

then open http://127.0.0.1:8788/. Demo mode runs the whole interface against four simulated cameras
(generated pictures, a generated day of recordings, working settings pages; sign in as `admin` with
password `demo` to change settings). It needs only Node.js and `ffmpeg`, touches none of your own
configuration or recordings, and cleans up when you stop it with Ctrl-C.

![Playback timeline in demo mode](docs/images/playback.png)

## What it does

- **Live view** in 1, 4 or 9 tiles. Tiles use each camera's sub stream; one tile (or a
  double-click) uses the main stream. One shared stream per camera feeds every open window.
- **Per-tile tools**, shown on hover: snapshot, manual record, the motion zones the camera
  watches, a link to the camera's own web page, a reboot button (administrator sign-in, asks
  first) and, on cameras that have them, pan/tilt/zoom, floodlight and siren controls.
- **Camera health at a glance**: each camera in the Live View list has a dot, green when it is
  answering, red when it is not responding and grey when that is not known yet. A teal ring around the
  dot marks the selected camera.
- **Playback** by day with per-channel tracks on a 24 h ruler, zoom, speed, and previous/next clip.
- **Downloads**: copy whole clips to a folder, with a task list, progress and cancel.
- **Export a range**: drag across a channel's track, and it is cut (and joined across clips) into
  one MP4 without re-encoding.
- **Recorder service**: records on the camera's own motion detection (the zones you set in the
  Reolink app), or continuously, with disk retention that only reports until you turn it on.
- **Add or remove devices** from the page; the device is checked over its API before it is added,
  and a network scan finds a device that has changed address.
- **Device settings** (with an administrator sign-in): name, on-screen display, time and NTP,
  night vision, picture, day/night and exposure, orientation, encoding and resolution, motion
  area and sensitivity, push/email/FTP, network, user accounts, and copying settings between
  devices. Every change is reviewed first, verified by reading it back, and undoable where it can be.
- **Per-device feature icons** showing what each camera was found to support.
- **Stopped-vehicle detection** (optional): an open object detector runs on this computer on the
  camera's own motion events. Draw a zone (the road in front of the mailbox), and a vehicle that
  stops there is tagged ("mail truck 14:12") on the Playback timeline, shown with its picture, and
  sent to an MQTT broker. You confirm each detection with **Yes / No** buttons, which keeps the
  timeline honest and trains an optional appearance check. Frames never leave the machine.
- **Weekly recording schedule**, sound on motion, and a light/dark/system theme.
- **Controls for PTZ, floodlight and siren** on cameras that have them (written to Reolink's
  documented API; not yet tried on such a camera).
- **Autostart** through a systemd user unit.
- **Settings > About** shows the build's version (semantic versioning, set in `package.json`).

It is a web page served from your own machine and shown in a Chromium app window, not a
cloud service.

## Requirements

- Linux with Node.js 22 or newer
- `ffmpeg` and `ffprobe` (live view, recording, thumbnails, export)
- A Chromium-family browser for `open` (Brave, Chromium or Chrome); any browser works if you
  open the address yourself
- Cameras reachable on your network, with an account that can sign in over HTTP
  (a read-only user is enough for viewing; recording and snapshots use the same account)

No `npm install` is needed: ReoLook has no dependencies.

## Quick start

```sh
git clone https://github.com/chevybowtie/ReoLook.git && cd ReoLook

# 1. Camera sign-in (asks for the password without showing it; saved private, mode 600).
#    A view-only camera account is enough for everything except changing device settings.
node bin/reolook.mjs init --user viewer

# 2. Where recordings live and which cameras to use:
cat > ~/.config/reolook/config.json <<'JSON'
{
  "root": "/mnt/videos/ReoLook",
  "cameras": [
    { "name": "Front porch", "host": "192.168.1.20" },
    { "name": "Garage",      "host": "192.168.1.21" }
  ]
}
JSON

# 3. Open it (starts the server if needed, then opens an app window):
node bin/reolook.mjs open
```

You can also add devices from the page (the round **+** in the device list), which edits
`config.json` for you.

**Recording schedule:** Settings > Recording has a weekly grid (Sunday first, one cell per hour,
local time). Paint hours as *not recording*, *on motion* or *continuously*; click a day or an hour
to fill it. With a schedule, the recorder follows it exactly; without one it uses *When to record*
all week. It is stored in `config.json` as `record.schedule`, 168 characters of `0`, `m` and `c`.

**Sound on motion:** Settings > General > Sound on motion plays a tone when a device reports new
motion while ReoLook is open, and outlines its tile. Choose the sound, volume, devices and a
minimum gap. Browsers only allow sound after you have clicked the page once.

**Copy settings:** Settings > Devices > Copy settings applies chosen settings from one device to
others (time, NTP, on-screen display, night vision, picture, image mode, encoding, alarm actions,
motion sensitivity). It shows every difference per device first, applies only what you tick, and
each change is verified and can be undone from the history.

**Theme:** Settings > General > Appearance: follow the system, light, or dark (per browser).

**Detected features:** Settings > Devices > Features shows, for every device, an icon per capability. Lit
icons were confirmed by actually reading the setting from the device; dashed ones are only claimed
by the device; gray ones are absent, unconfirmed or could not be read (hover for the reason).

**If a device changes address** (a new DHCP lease, a replaced router), open Settings > Devices >
*Find on the network*. It sends one unauthenticated request per address on your subnet (a Reolink
answers `please login first`; nothing else is expected to), then signs in once to each device it finds 
to read its name and hardware address. A device that has moved is matched by hardware address and offered 
as "Use <new address>". Nothing changes until you click it, and ReoLook refuses to point a device at a
different one without confirmation. If the account is refused, no further sign-ins are attempted.
The device list also marks a device that is not responding.

## Using it

| Where | What |
|---|---|
| Nav bar | **Live View** and **Playback** tabs. The right side shows recorder status (`● Recording 2`, `Watching 3 device(s)`, or `Recorder off`). |
| Live bottom bar | Layout (1/4/9 views), previous/next page, reload streams, full screen |
| Live tile (hover) | Snapshot (saves a JPEG), Record (manual recording, red REC badge), Motion zones (tints the part of the picture the camera watches, with its coverage and sensitivity; its legend links to the editor), **Web page** (opens the camera's own page, `http://<its address>/`, in a new tab), **Reboot** (asks first; needs the administrator sign-in from Settings > Devices; the camera is away for about a minute), and a controls button on cameras with PTZ, floodlight or siren |
| Playback bar | Day picker, previous/next clip, play, speed (`1x`→`2x`→`4x`→`8x`→`0.5x`), scissors, downloads, full screen |
| Timeline | Click a track to play from that point; **+/−** zoom; mouse wheel pans when zoomed; **Space** plays/pauses |
| Scissors | Turns on range mode: drag on a channel's track, then **Export…** |
| Downloads icon | Pick clips, choose the folder, **Download**; the task list shows progress and the saved path |

Exports and downloads are written to the folder you choose (default `~/Videos/ReoLook`, or
`exportDir` in the config). They never overwrite, and the folder cannot be inside the
recordings library.

## Settings

The **gear** in the top right opens Settings.

| Section | What it controls | Stored in |
|---|---|---|
| General | Theme (follow system, light, dark), sound on motion, open Live View on start, default layout, fit/fill video in tiles | this browser |
| Recording | Record on/off, motion or continuous, **weekly schedule**, stream, keep-recording time, longest file, which devices, "only if drive is mounted" | `config.json` |
| Storage | Disk meter and low-space warning; recordings, downloads/exports and snapshots folders; **expire old recordings** (age, size, free-space rules with a live preview) | `config.json` |
| Devices | **Find on the network**; **administrator sign-in** (session only); a **motion zone editor** (drag over the picture; Toggle, Watch and Ignore brushes, undo/redo, with guard rails; also from a live tile's *Edit zones…* link); **Network** summary; **Change settings** (name, on-screen display, time zone, clock, NTP, night vision, picture, day/night and exposure, orientation, encoding, motion sensitivity, push/email/FTP, UPnP, cloud connection, IP address) with a reviewed diff, a verified write, history and undo; **Main stream resolution**; **User accounts** | server memory; change history in `~/.local/state/reolook/` |
| Detection | Vehicle detection on or off; per device: the zone you draw over a picture, event name, vehicle types, how long it must stay, hours, confidence, a *Look now* test; the MQTT broker and topic; recent events with their pictures and a Yes/No verdict | `config.json` (broker login in `~/.config/reolook/env`) |
| Devices > Features | An icon per capability for the chosen device (lit = confirmed by a read) and the full list with what the account may do | n/a |
| Devices > Copy settings | Apply chosen settings from one device to others, reviewed per device | n/a |
| System | Service state; **Start at boot** (`loginctl enable-linger`, with a confirmation); address and file locations | systemd |
| About | Name, version, licence and the Node.js version this build runs on | `package.json` |

Recording and storage changes apply immediately: open recordings are finished and saved first,
then recording restarts. Expiry shows exactly how many clips and how much space a rule would
free before you can switch it from *Only report* to *Delete automatically*, and asks again.

The camera password is deliberately not editable in Settings; edit `~/.config/reolook/env`.

## Commands

Run as `node bin/reolook.mjs <command>` (add a shell alias if you like).

| Command | Purpose |
|---|---|
| `detect setup` / `detect status` / `detect image FILE` | Install the vehicle detector (a private Python environment and a 36 MB model under `~/.local/share/reolook/detector`), check it, or run it on one picture |
| `demo [--port N]` | Try ReoLook with four simulated cameras; no hardware needed and nothing of yours is touched |
| `init [--user NAME] [--force]` | Save the camera sign-in to `~/.config/reolook/env` (mode 600); the password is asked for without echo, or read from stdin |
| `open [--config F] [--port N] [--browser CMD]` | Open the viewer in an app window, starting the server first if it is not running (or waiting for the service) |
| `serve [--config F] [--port N] [--root DIR] [--camera "Name=IP" …]` | Run the viewer and, if enabled, the recorder, in the foreground |
| `service install [--dry-run] [--yes] [--linger] [--no-start] [--config F]` | Install the systemd user unit; shows its plan and asks first |
| `service status` / `service uninstall` | Check the unit / remove it (keeps your sign-in file and config) |
| `retention [--apply] [--max-age-days N] [--max-size-gb N] [--min-free-gb N]` | Show, or with `--apply` enforce, what retention would delete |
| `record --camera "Name=IP" … --out DIR [--stream main\|sub] [--post-roll S] [--max-minutes N] [--always]` | Standalone recorder, no server |
| `capabilities [--refresh] [--json]` | What a camera can do, from its own report plus real reads; needs `--host IP` |
| `info`, `snapshot`, `days`, `search`, `download`, `live` | Single-camera tools; need `--host IP` |

## Configuration

`~/.config/reolook/config.json`. It never holds credentials.

```json
{
  "root": "/mnt/videos/ReoLook",
  "port": 8787,
  "exportDir": "/home/you/Videos/ReoLook",
  "snapshotDir": "/home/you/Pictures/ReoLook",
  "cameras": [ { "name": "Front porch", "host": "192.168.1.20", "channel": 0 } ],
  "record": {
    "enabled": true, "mode": "motion", "stream": "main",
    "postRollSec": 15, "maxSegmentMin": 30,
    "requireMount": "/mnt/videos"
  },
  "retention": { "minFreeGB": 200, "apply": false }
}
```

| Key | Default | Meaning |
|---|---|---|
| `root` | none | Recordings folder (library). Without it there is no playback or recording. |
| `port` | `8787` | Port on `127.0.0.1` |
| `cameras[]` | `[]` | `name`, `host` (IP or hostname, optionally `:port` for its HTTP port), optional `channel` |
| `exportDir` | `~/Videos/ReoLook` | Default folder offered for downloads and exports |
| `snapshotDir` | none | Save snapshots here; unset means your browser saves them |
| `record.enabled` | `false` | Run the recorder inside `serve` |
| `record.mode` | `motion` | `motion` (the camera's motion state) or `continuous` |
| `record.stream` | `main` | `main` (full resolution) or `sub` |
| `record.postRollSec` | `15` | Keep recording this long after motion stops |
| `record.maxSegmentMin` | `30` | Roll to a new file after this long |
| `record.cameras` | all | Limit recording to these camera ids (the slug of the name, e.g. `front-porch`) |
| `record.requireMount` | none | Refuse to record unless this path is a mount point |
| `retention.maxAgeDays` / `maxSizeGB` / `minFreeGB` | none | Rules; unset rules are ignored |
| `retention.intervalMin` | `60` | How often retention runs |
| `retention.apply` | `false` | **Delete only when `true`**; otherwise it just reports |

## Vehicle detection and MQTT

```sh
node bin/reolook.mjs detect setup     # once: Python environment + model, about 400 MB on disk
```

Then **Settings > Detection**: pick the device and add one or more **rules**. A rule is either
*stops* (a vehicle that arrives and stays in a zone you draw: the mail truck) or *appears*
(anything that turns up, in a zone or in the whole picture: a peacock in the yard, a person at the
gate). Each rule has its own name, types (vehicles, animals such as bird/cat/dog/horse/bear, or
person), smallest size, hours and confidence. *Look now* takes a picture, runs the detector, and
shows every detection with its confidence and its height as a % of the picture, in green when a
rule would count it, so sizes can be set from what is really seen. Then save. While the camera
reports motion, ReoLook takes a frame about every 1.5 s, runs the detector (about 150 ms on a
CPU) and follows vehicles; one that stays inside the zone is an event. It is tagged
`<event name> HH:MM`, appears as a marker on that device's Playback track, and its picture is kept
under `~/.local/share/reolook/detections/`.

**Confirming detections (Yes / No).** Every event is listed under *Recent events* in Settings >
Detection, with its picture, the camera, the type and confidence, and a **Was it?** row with **Yes**
and **No** buttons (and **Delete**). Did the mail truck really stop, or was it something else? Mark
each one:

- Click the picture for a full-size view with the box the detector drew. There, **Yes** and **No**
  work, and so do the keys **Y** and **N**; answering moves on to the next event, **←** and **→**
  move without answering, and **Esc** closes. Click the same answer again to clear it.
- The list starts on *Only the ones I have not marked*, so what still needs a verdict is what you
  see; the line above it counts events marked Yes, marked No and still to review. A menu narrows
  the list to one rule.
- A **Yes** adds *(confirmed)* to the hover text of that event's marker on the Playback track. A
  **No** removes the marker, so false alarms do not clutter the timeline.
- The verdicts are the data for tuning: they show which size, zone and timing settings are right
  (see *Replay* below), and they are what the optional *appearance check* learns from.

**Replay.** To see what a rule would have done on recordings that already exist (a missed delivery,
a false alarm, or the effect of a change) without waiting for tomorrow:

```sh
node bin/reolook.mjs detect replay --camera "Driveway" --date 2026-10-15 --from 14:50 --to 15:10
```

It runs the saved rule over each recording of that device in the time range, looking every 1.5 s
as the live service does, and prints for each clip the best candidate and either `WOULD FIRE` or
the reason it would not (too small, too large, too faint, outside the zone, or in the zone for
less time than the rule needs). `--rule ID` picks one rule; `--all` lists clips with nothing in them.
A rule also has a *largest size* as well as a smallest one, to tell a mail truck from a bigger
garbage truck at the same spot.

**Appearance check (watching only).** Size and zone cannot tell your mail truck from another truck of
the same size at the same spot, so a rule can also learn *what you marked Yes* from the picture
itself. In the rule, press **Train from my Yes / No marks**: ReoLook cuts each marked detection out
of its saved picture, describes it with a small image-recognition network (MobileNetV2, installed by
`detect setup`), and fits a simple model to your marks. It reports how it does on pictures it had
**not** seen (each is scored by a model trained without it), and every event then shows "Looks like
your Yes marks: NN%". It only observes: it never decides whether an event or an alert happens, so it
can be wrong without costing a delivery. On the first real data (12 Yes, 15 No) it recognised all 12 and
rejected all 15 on unseen pictures, and gave a garbage truck it had never been shown 13%. That is a
small set, which is why it is not allowed to decide yet. Retrain after marking more events.

**Animals.** The detector is trained on 80 everyday classes: `bird`, `cat`, `dog`, `horse`, `sheep`,
`cow`, `bear` and a few more, but **not** squirrels or peafowl by name. A peacock is expected to be
reported as `bird` (a large one), which is why a rule has a *smallest size*: set it above what a
squirrel measures and below a peacock, so small animals are left out. Small animals that the
model does mislabel as cat, dog or bird fall below that size. Whether a fanned tail or a night
infrared picture is still recognised as a bird has to be seen on real footage; the Yes/No verdicts
are how that gets tuned.

MQTT (no library, MQTT 3.1.1, `mqtt://` or `mqtts://`) sends, with your topic prefix:

| Topic | Payload |
|---|---|
| `<prefix>/<device id>/event` | JSON: `event` (`mail_truck_stopped`, `peacock_appeared`, `<name>_left`), `label`, `tag`, `camera`, `vehicle`, `score`, `at`, `id` |
| `<prefix>/<device id>/<event name>` | `ON` when it is seen, `OFF` when it has gone (retained if you keep that on) |
| `<prefix>/status` | `online` / `offline` (a last-will, so a dead ReoLook shows as offline) |

**Other outputs.** Each rule can also call a **web address** (GET, or POST with the same JSON) when
it happens and, optionally, another when it has gone, with `{camera}`, `{label}`, `{event}` and
`{tag}` filled in. **Send a test event** in the rule sends a made-up event down exactly that path
(MQTT and web address) and reports what each answered. *Home Assistant discovery* announces each
rule as a sensor. To make a camera pop up over what an Apple TV is playing, see
`docs/homekit.md`.

The detection models and Python packages are downloaded by `detect setup`, not shipped in this
repository; their licences are in `THIRD-PARTY-NOTICES.md`.

A broker that needs a login: add `REOLOOK_MQTT_USER` and `REOLOOK_MQTT_PASS` to
`~/.config/reolook/env` (mode 600). They are never shown or stored in the page.

## Recordings and retention

Files are written as `<root>/MMDDYYYY/<Camera name>-00-HHMMSS-HHMMSS.mp4`, the same layout the
Reolink Windows app uses, so existing recordings from that app show up in Playback.

- Recording is written as a crash-safe `.part` file and remuxed into a regular MP4 (index first)
  when it closes, so clips seek properly. If the remux fails the original file is kept.
- Each saved clip's size is compared with the camera's configured encoding and a mismatch is
  logged.
- A camera that connects but then sends nothing does not hold a recording open. ffmpeg gives up
  after 10 s of silence on the stream and keeps what it had, and a watchdog restarts a recording
  whose file has stopped growing for 20 s (a recording that has not yet written its first byte
  gets 15 s more, while ffmpeg probes the stream). The next poll starts a fresh clip.
- `record.requireMount` is strongly recommended when `root` is on a separate drive: otherwise an
  unmounted drive would be filled on your system disk.
- Retention only ever considers `.mp4` files directly inside `MMDDYYYY` folders, never the last
  hour, and never deletes anything unless `retention.apply` is `true`. **It treats old recordings
  from the Windows app the same as new ones.** Run `node bin/reolook.mjs retention
  --max-age-days 30` first to see what a rule would remove.

Main-stream recording is about 8 Mbit/s, roughly 3.7 GB per hour per camera while recording.

## Run it automatically

```sh
node bin/reolook.mjs service install --dry-run   # preview
node bin/reolook.mjs service install             # asks before writing
journalctl --user -u reolook -f
```

This writes `~/.config/systemd/user/reolook.service` and creates `~/.config/reolook/env` only if
it does not already exist. It starts with your login session. Add `--linger` to start at boot
before you log in (that runs `loginctl enable-linger` and changes a system setting).
The service restarts itself if it fails and finalizes open recordings when stopped.

If the recordings folder belongs to a group (say `www-data` on a shared drive), add yourself to it
and then **restart your user session manager**: a group added after you logged in is not seen by the
services your session already started, even after logging out, when lingering keeps that manager
alive. A reboot, or `sudo systemctl restart user@$(id -u).service` from a text console, does it.

`contrib/reolook.desktop` is an application-menu entry (copy it to
`~/.local/share/applications/` if you want it).

## Security and privacy

- The server listens on `127.0.0.1` only and rejects requests with any other `Host` header.
- State-changing requests (add/remove device, record, export) must come from the page itself;
  cross-origin requests are refused.
- Camera passwords are never written to `config.json` and are passed to ffmpeg inside the RTSP
  URL, which other local users can see in the process list. Use a read-only camera account. The
  password is hidden (`rtsp://user:***@host`) in the error text ffmpeg prints, so it does not reach
  the logs or the status page.
- The administrator sign-in is optional and only needed for changing device settings. The
  password is held in the server's memory only (never written to disk or logged), the browser
  gets an HttpOnly, SameSite=Strict session cookie it cannot read, and it is forgotten after 15
  minutes idle, on sign-out, or when ReoLook restarts. A wrong password is tried on one device
  and repeated failures lock further attempts for a minute.
- The motion zone editor refuses to leave nothing watched (the camera would never detect motion, so nothing would be recorded) and warns when very little is.
- Changing a device setting shows the exact difference first, writes only if the device still
  holds what you reviewed, reads the value back to confirm it, and keeps a history you can undo
  from. A device that silently ignores a write is reported as such.
- Changes that can lock you out or cannot be undone ask you to type what they will do: a new
  IP address, a resolution, an account name. Account passwords are never stored, shown or logged;
  a new password is checked by signing in with it.
- Everything stays on your network: no telemetry, no cloud account. (The cameras themselves may
  keep their own Reolink cloud connection on; Settings > Devices shows and can switch it.)

## Limits

- ReoLook speaks the cameras' HTTP API, RTSP and RTMP. It does **not** implement Reolink's
  proprietary Baichuan/P2P protocol, so UID connect and two-way talk are not available. The
  network scan uses the HTTP API and finds devices on your own subnets only.
- Controls follow what the hardware reports, and the PTZ, floodlight, siren, battery and AI
  controls are built from Reolink's documentation but **have not been tried on a camera that has
  them** (the RLC-410s this was built on have none). Treat the first use as a test.
- Vehicle detection finds *a truck or car that stopped in your zone*. It cannot tell a postal truck
  from a courier van on its own; hours, the zone and the Yes/No verdicts you give are what make
  "mail truck" reliable, and a classifier for the vehicle's look is the next step once there is
  footage to tune on.
- Not built: storage formatting, restore to defaults and firmware update (destructive, and not
  needed for a home setup), auto-tracking and patrol, and editing the weekly alarm schedules.
- Changing the main stream's resolution makes the camera restart its video for a minute or so
  and forget its motion area; ReoLook puts the area back, but changing it from another app will
  not.
- Range export copies streams without re-encoding, so a cut can start a second or two early
  (at the previous keyframe).
- A few recordings made by the Windows app have broken timestamps and may not seek correctly in a
  browser.
- The job queue is in memory: finished downloads are forgotten when the server restarts (the
  files are not).

See `docs/roadmap.md` for what is done and what is left, including which parts are verified on real hardware.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `no camera sign-in yet` / `camera sign-in not found` | Run `node bin/reolook.mjs init`, or set `REOLINK_USER` / `REOLINK_PASS` |
| `ffmpeg not installed` in the header; tiles never connect | Install ffmpeg (`sudo apt install ffmpeg`); live view, recording, thumbnails and export need it |
| `Cannot save recordings` in the header | The recordings folder is not writable by the user running ReoLook; fix its owner, group or mount options, or choose another folder under Settings > Storage |
| A device shows *not responding* | It is off, unplugged or at another address: Settings > Devices > Find on the network |
| `…is readable by other users; run: chmod 600 …` | The env file is group/world readable; ReoLook refuses to read it |
| `EADDRINUSE` / `did not answer on port` | Something else is using the port; change `port`, or check `service status` |
| Tiles stay black or say *Connecting…* | The camera is at its session limit or unreachable. Close other viewers; cameras that accept a session and send nothing are restarted automatically after about 8 s |
| `is not mounted; refusing to record` | `record.requireMount` is set and that drive is not mounted |
| `no data for 20s, restarting` or `ffmpeg exited early … Invalid data found when processing input` for one camera, over and over | The camera accepts the connection on its video port (554) but does not answer, so its video service is stuck. Test with `ffprobe` on its address, or compare with another camera. Rebooting the camera clears it: use the **Reboot** button on its live tile (administrator sign-in) or unplug its PoE port. Its web page (the **Web page** button) usually still works |
| After adding yourself to a group, recordings still fail with `Cannot save recordings` | Your user session manager still has the old groups. Reboot, or restart it (see *Run it automatically*) |
| Recording never starts in `motion` mode | The camera reports no motion; check the zones in the Reolink app, or try `mode: continuous` |
| Export refused: *outside the recordings library* | Choose a folder that is not under `root` |
| Live tiles glitch or drop out after raising the main stream's resolution; `node bin/reolook.mjs repairs` lists many repairs | The camera's encoder is shared by its main and sub streams, and a bigger main stream can leave the sub stream (used by the grid tiles) short, even on a fast wired network. Lower the **sub stream's frame rate** in Settings > Devices > Change settings > Encoding; if that is not enough, lower the main stream's bit rate or frame rate. Repairs are only counted while a Live page is open |

Logs: `journalctl --user -u reolook`, or `~/.cache/reolook/server.log` for a server started by
`open`.

## Development

```sh
npm test         # node --test (about 480 tests, 12 s); needs ffmpeg and ffprobe
```

| Path | Contents |
|---|---|
| `bin/reolook.mjs` | CLI |
| `src/client.mjs`, `src/client-pool.mjs` | Reolink HTTP API client and stream URLs; one signed-in viewer client per device, shared by the recorder, detection and the server |
| `src/recorder.mjs`, `src/gate.mjs`, `src/service.mjs` | Recorder, motion gating, per-camera service |
| `src/library.mjs`, `src/retention.mjs` | Recording index and disk retention |
| `src/live.mjs` | Shared live-stream hub |
| `src/demo.mjs`, `src/ffinput.mjs` | Demo mode: simulated cameras and recordings; ffmpeg input options (RTSP or generated, and the recorder's probe and silence timeout) |
| `src/concurrency.mjs`, `src/byte-range.mjs`, `src/format.mjs` | Small shared helpers: bounded concurrency and shared async work, HTTP byte ranges, text formatting and password masking |
| `src/jobs.mjs`, `src/export.mjs` | Job queue, copy and cut |
| `src/server.mjs` | HTTP server and API |
| `src/launcher.mjs`, `src/credentials.mjs`, `src/service-install.mjs`, `src/prompt.mjs` | `open`, sign-in and `init`, systemd unit, terminal prompts |
| `src/capabilities.mjs` | Per-device capability profile (report plus real reads) |
| `src/device-settings.mjs`, `src/safe-write.mjs`, `src/change-log.mjs` | Setting descriptors and the plan / apply / verify / undo pipeline |
| `src/admin.mjs`, `src/users.mjs`, `src/resolution.mjs`, `src/controls.mjs` | Administrator sessions, accounts, resolution change, live controls |
| `src/discovery.mjs`, `src/net-probe.mjs` | Network scan and address checks |
| `src/motion.mjs`, `src/schedule.mjs` | Motion area parsing, weekly recording schedule |
| `src/detect/*`, `detector/helper.py`, `src/mqtt.mjs` | Vehicle detection: rules and tracker, the Python helper (YOLOX via onnxruntime), the event log, MQTT publisher |
| `src/version.mjs` | This build's version, read from `package.json` |
| `public/index.html` | The whole UI (no build step) |
| `docs/roadmap.md` | What is done and what is next |

To contribute, see `CONTRIBUTING.md`; changes are listed in `CHANGELOG.md`.

The version number (semantic versioning) is set in one place, the `version` field of `package.json`; change it there
for a new build and Settings > About shows it.

The suite runs real ffmpeg for recording, remux and export, and uses fake cameras (a fake Reolink
HTTP server in `test/support/fake-camera.mjs`, and a sandbox for the command line in
`test/support/cli-sandbox.mjs`) and fake `systemctl` elsewhere, so it needs no cameras and changes
nothing on your system.
