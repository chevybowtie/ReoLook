# ReoLook: not yet complete

What is being worked on or waiting, and is **not** finished. What is done, and how it was
verified, is in `docs/roadmap.md`. Status as of 2026-11-11 (version 0.0.1, from `package.json`).

## In progress

### Vehicle and animal detection
- [ ] **Appearance check is watching only.** It learns the marked Yes from the picture and scores
  every event, but it cannot cause or stop an alert. Last trained on 12 Yes / 15 No (recognised 12 of
  12 and rejected 15 of 15 on pictures it had not seen); the mail truck rule now has **24 Yes / 18 No**,
  so retrain it (Settings > Detection > *Train from my Yes / No marks*). The target for letting it
  decide is in `docs/roadmap.md` (*Detection: how many marks before the appearance check may decide*):
  at least 40 Yes and 30 No with a picture, low-light, rain/snow and look-alike coverage, a winter of
  data, no missed Yes on leave-one-out, and a 4-week shadow period. Retrain in between whenever 10 new
  marks have been added. Keep size and zone as the first filter.
- [ ] **Mail truck rule: one known false alarm.** A truck about 20% tall at 80–85% confidence
  (seen four times) passes size and confidence. The appearance check scores it 1–11%, so this ends
  once the check decides.
- [ ] **Mail truck rule is tuned on one camera and 12 real deliveries** over about 16 months. Winter
  dusk, rain, snow and a different carrier or vehicle are untested. Night recognition is shown by
  one delivery only (74%). The rule's hours are a daytime window.
- [ ] **Peacock rules:** 40 of 40 detections were real, but misses cannot be seen from events. The
  three rules (on three cameras) have different "seen for" times (2 s and 7 s). Compare them, and
  replay the old recordings of those cameras (`detect replay --save`) to find what they missed. Only
  the mail truck camera has been replayed so far.
- [ ] **Replay covers a daytime window on the mail truck camera only.** A delivery outside that
  window would not show up in the history.

### Notifications and outputs
- [ ] **MQTT has only been tested against a small fake broker.** Needs a real run: broker address,
  `REOLOOK_MQTT_USER` / `REOLOOK_MQTT_PASS` in `~/.config/reolook/env`, then "Send a test event".
  TLS (`mqtts://`) and Home Assistant discovery have not been tried against anything real.
- [ ] **Apple TV pop-up (HomeKit) is not working yet.** Homebridge is running in Docker
  (`contrib/homebridge/`). Still to do: install `homebridge-camera-ffmpeg`, add the camera, pair in
  the Home app, turn on Apple TV notifications for the camera, put the doorbell/motion address in a
  rule's web address, press "Send a test event". `docs/homekit.md` is written from the projects'
  documentation and has not been run end to end.

### Live view picture damage
- [ ] **Watch for damaged live pictures.** ReoLook restarts a stream when its decoder reports bad
  data and writes each repair to `~/.local/state/reolook/live-repairs.jsonl` (`node bin/reolook.mjs
  repairs`). The cause found so far is a main stream raised to a higher resolution, which leaves the
  camera's sub stream (the grid tiles) short; lowering the sub stream's frame rate fixed it (see the
  README's troubleshooting table), and the live decoder was limited to two threads. Repairs are only
  counted while a Live page is open, so a quiet log means little unless a page was open; keep an eye
  on the sub streams that show up most often in the log.

### Recorder reliability (2026-11-11)
- [x] Recordings failing with `dimensions not set` (ffmpeg probing from the middle of a picture
  group): the recorder now probes for 15 s / 32 MB first.
- [x] A camera that connects and then goes silent held a recording open for up to 20 s: ffmpeg now
  ends by itself after 10 s of silence. The stall watchdog allows a recording 15 s more before its
  first byte, so a slow start is not mistaken for a stall.
- [ ] **Confirm on the real cameras over a few days** that `no data for Ns, restarting` and `dimensions
  not set` stay gone from `journalctl --user -u reolook`. one outdoor camera was stalling about every
  5 minutes before.
- [ ] **One test camera recorded nothing for a day after 2026-11-10.** Its video service (port 554) accepted
  connections and never answered; its web API worked. It was rebooted on 2026-11-11 and answers again,
  but no motion has been seen on it since. Check that `[<camera name>] saved` appears for it; if it wedges again,
  look at its encoding settings and firmware.

### Running it
- [x] **Runs as the normal `reolook` systemd unit with the `www-data` group** (done 2026-11-11 after
  a reboot; before that a hand-started copy ran under `sg www-data`). Restart it with
  `systemctl --user restart reolook`.
- [x] **Start at boot is on** (lingering is enabled).
- [ ] **Retention only reports.** About 1.3 TB / 26,000 clips. Decide
  whether to turn on deletion (Settings > Storage) and with which rule.
- [ ] **About 800 recordings start per day** across four outdoor cameras, mostly short. Worth
  looking at which camera produces most and whether motion zones or sensitivity should change.

## Publishing on GitHub

Done: demo mode (`reolook demo`, with README screenshots), MIT `LICENSE`, no `private` flag,
history cleaned (author email, tracked files, example addresses).

- [ ] **Create the repository and push** `master` and the `v0.0.1` tag (nothing has been pushed).
  The version is 0.0.1 in `package.json`; the old `v0.2.0-alpha.1` tag was removed. Add the repository
  description and topics (reolink, camera, nvr, linux, rtsp, mqtt).
- [x] **CI workflow** (GitHub Actions; not yet run on GitHub): `npm test` on Node 22 with ffmpeg installed.
- [ ] **Dockerfile / compose file** for running ReoLook in a container (needs the recordings folder,
  the config folder and, for detection, the Python helper).
- [x] **`SECURITY.md`**: how to report a problem privately, and what ReoLook protects (listens on
  127.0.0.1 only, credentials kept private, admin sessions in memory).
- [x] **`CONTRIBUTING.md`** and **issue / pull request templates** (`.github/`: a bug report asking for the
  camera model and firmware, the output of `capabilities` and a reminder to remove passwords and
  addresses; a feature request; a pointer to private security reporting; a pull request checklist).
- [x] **`CHANGELOG.md`**, starting at 0.0.1.
- [x] **Third-party notices** for the detection models and the Python packages the helper installs
  (`THIRD-PARTY-NOTICES.md`).
- [ ] **README restructure**: shorter front page, a settings screenshot, and a clear statement
  that the project is not affiliated with Reolink.
- [ ] **Offer the demo in a browser-only form** (optional): a short screen recording or GIF of the
  demo for the README.

## Built but never tried on real hardware or a real service

These follow the manufacturer's documentation and are tested against fakes that check the exact
requests. The first real use is the test.

- [ ] PTZ (move, zoom, presets), floodlight, siren, battery, AI detection sensitivity. The test
  cameras have none of these.
- [ ] The **Reboot** and **Web page** buttons on a live tile. The reboot request is the same one sent
  to a test camera by script on 2026-11-11, which worked; the button itself, its confirmation and the
  administrator check are tested against a fake camera only.
- [ ] Turning UPnP **on**; setting a **different** fixed IP address (DHCP to Static at the same
  address and back was tried).
- [ ] Turning email or FTP on (no server is configured on any camera, and the editor refuses).
- [ ] The device clock editor (the cameras are within a second, so there was nothing to set).
- [ ] Sound on motion with a real motion event while the page was open (tested with a simulated
  detection edge).
- [ ] Light theme on the playback, zone painter and download screens (checked visually on Live,
  Recording, Features and Detection only).

## Not built yet

- [ ] Auto-tracking, PTZ patrol / cruise / guard position, focus, 3D zoom; siren schedules;
  floodlight lighting modes.
- [ ] Editing the weekly alarm schedules of push, email and FTP (which day they start on is
  unconfirmed), and editing email and FTP servers, recipients and credentials, plus their test buttons.
- [ ] Editing ports, DDNS and Wi-Fi (ports could lock ReoLook out of a camera).
- [ ] Copying the motion area between devices (deliberately left out so far).
- [ ] Reaching ReoLook from an iPad or phone. It listens on `127.0.0.1` only, on purpose; this
  would need a tunnel and care with the Host and Origin checks.
- [ ] From the roadmap's "Later": time lapse, event log timeline from the cameras, doorbell / chime
  / hub devices, multi-language UI, an Electron shell for a tray icon.

## Left out on purpose (build only if asked)

- Storage formatting, restore to factory defaults, firmware update.
- Reolink's own P2P / UID protocol and two-way talk.

## Known problems

- [ ] With 9 live tiles, a browser still limits connections to one address, so some tiles can wait.
  The first four tiles use a second loopback name to leave room for the page's own requests.
- [ ] The page itself has no automated tests; it has been checked by hand in a real browser engine.
- [ ] Recording clip sizes: some older recordings have broken timestamps and may not seek in a browser.
- [ ] The job queue for downloads is in memory and forgotten when the server restarts.
