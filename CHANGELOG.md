# Changelog

All notable changes to ReoLook are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.0.1] - 2026-11-11

The first version. What it does is described in [README.md](README.md); what is verified on real
cameras and what is not is in [docs/roadmap.md](docs/roadmap.md) and [TODO.md](TODO.md).

### Added

- **Live view** in 1, 4 or 9 tiles, one shared stream per camera, with per-tile snapshot, manual
  record, a motion-zone overlay, a link to the camera's own web page and a reboot button, a health dot
  per camera (green, red or grey), and controls for PTZ, floodlight and siren on cameras that have them.
- **Playback** by day on a 24-hour timeline with zoom and speed, clip downloads with a task list, and
  range export without re-encoding.
- **Recorder service**: records on the camera's own motion detection or continuously, on a weekly
  schedule, with a stall watchdog, crash-safe files remuxed on close, a mount guard and disk
  retention that only reports until switched on.
- **Device settings** (administrator sign-in): name, on-screen display, time and NTP, night vision,
  picture, exposure, orientation, encoding, motion area and sensitivity, alarm actions, network,
  user accounts, and copying settings between devices. Every change is reviewed, verified by
  reading it back, and undoable where it can be.
- **Motion zone editor**, device **capability profile**, network scan that finds a device that
  changed address, and main-stream resolution change.
- **Vehicle and animal detection** (optional) with an open model running on your machine: rules per
  camera, events on the timeline, MQTT, web-address outputs, Home Assistant discovery, replay over
  existing recordings, and a watch-only appearance check.
- **Demo mode** (`reolook demo`) with four simulated cameras, a `reolook open` launcher, and a systemd
  user unit installer.
- **Settings > About** showing the version.
- `THIRD-PARTY-NOTICES.md`, `CONTRIBUTING.md`, `SECURITY.md`, and issue and pull request templates.
- No dependencies, no cloud account and no telemetry; the server listens on `127.0.0.1` only.

### Fixed or improved during development of this version

- Recordings no longer fail with `dimensions not set`: ffmpeg now probes the stream longer before
  recording starts.
- A camera that connects and then goes silent no longer holds a recording open: ffmpeg gives up after
  10 seconds of silence, and the stall watchdog allows a slow start extra time.
- Camera passwords are masked in ffmpeg's error text, so they do not reach logs or the status page.
- One signed-in client per camera is shared by the recorder, detection and the page; camera reads
  are limited in how many run at once; live-view decoding is limited to two threads; the clip-info
  cache is bounded and duplicate `ffprobe` and thumbnail runs are shared.

[Unreleased]: https://github.com/chevybowtie/ReoLook/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/chevybowtie/ReoLook/releases/tag/v0.0.1
