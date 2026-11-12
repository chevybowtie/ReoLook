# ReoLook roadmap

Goal: a Linux client that looks and behaves like the Reolink Windows app.

## Principles

- **Capability-driven, never model-pinned.** The development cameras (RLC-410-5MP, firmware
  v3.0.0.136) have no PTZ, floodlight, siren, AI detection, Wi-Fi or battery. ReoLook must still
  plan for all of those, because newer cameras have them. Every control is shown or hidden from
  what the specific camera reports, so a new camera gains its features without a rewrite.
- **Be honest about what is verified.** Each area below says whether it has been exercised against
  real hardware. Anything marked *unverified* comes from Reolink's documented HTTP API or the
  original app's behaviour and must be confirmed on a camera that has it before it is relied on.
- **Reads first, writes carefully.** Read-only pages come before editing, and every write goes
  through one safe-write pipeline (below).
- **Nothing the original does is out of scope** unless it needs a protocol ReoLook does not speak
  (see *Not planned*).

## Done

- Live view grid (1/4/9), per-device main/sub streams, shared stream hub
- Playback: day picker, 24 h timeline with zoom, per-channel tracks, clip playback
- Add / remove device (probed over the HTTP API, saved additively)
- Motion-triggered recorder service, stall watchdog, mount guard, remux, retention
- `reolook open` launcher (Chromium app mode)
- Live toolbar as far as the cameras allow: snapshot and manual record
- Download queue and clip export (stream copy, joins across clips)
- Autostart: `reolook service install` (systemd user unit, plan-first, restarts on failure)
- README
- Settings window: General, Recording, Storage (disk meter, folders, expire old recordings with a
  preview), System (start at boot); hot reload of recording and retention
- Capability profile per device and administrator sign-in (device settings foundations 1 and 2)
- Safe-write pipeline with the device name as its first editor (foundation 3): plan with exact diff, verified apply, history and undo
- Motion detection zone overlay (read-only): what each camera watches, drawn over the live picture, plus a map and the sensitivity windows in Settings > Devices. Verified on real footage: the ignored area follows the edge of a hedge in the scene.
- Motion zone editor: paint or erase watched cells over a current snapshot, with undo/redo, a reviewed diff, verified apply and undo. **Verified on a real RLC-410: a 4-cell edit applied, verified by an independent read, and undone to a byte-identical state.**
- Network discovery: scan the subnet over the HTTP API, match moved devices by hardware address, re-point with confirmation; storage write check with a loud banner. **Scan verified on the real network** (found all cameras that were powered).
- Recording schedule: a weekly 7 x 24 grid (off / on motion / continuous per hour, local time), painted by dragging; the recorder follows it, closes a clip when its hour ends, and does not poll the camera in off hours. Stored as `record.schedule`; absent means the fixed mode all week.
- Sound on motion (the original's Alarm Beep): the page polls each device's own motion decision and plays a tone made with Web Audio (chime, double beep or alert), with volume, a per-device cooldown and a device choice; the tile is outlined while motion lasts. Per browser; works while ReoLook is open. Verified in a real browser engine with a simulated detection edge (one sound per new detection, none while sustained or inside the cooldown).
- Themes: Follow system, Light or Dark (Settings > General), kept per browser; video areas stay black in both. Verified in a real browser engine against forced and emulated OS preferences.
- Detected features (Settings > Devices > Features): per device, an icon for each capability. Lit when confirmed by a real read; dashed when only reported; gray when absent, unconfirmed or unreadable, with the reason on hover.
- **Stopped-vehicle detection (mail truck)**: YOLOX-s (Apache-2.0) through onnxruntime in a private Python environment, driven by a small JSON-lines helper; frames are taken from the camera's own snapshot only while it reports motion or a vehicle is being followed. A zone polygon, a stop timer (a vehicle that drives through never counts), classes, hours and confidence are set per device; events carry a tag ("mail truck 14:12"), the frame, and a Yes/No verdict for tuning; they appear on the Playback timeline and are published over a dependency-free MQTT 3.1.1 client (event JSON, ON/OFF state, last-will status). **Verified on a real frame from an outdoor camera (it finds the parked pickup, the van and the person; about 150 ms per frame on the CPU), and against fakes for the tracker, service, events and broker. Not yet seen against a real mail truck.** The model recognises "truck", not which carrier; a look-based classifier waits for the footage being gathered this week.
- **Detection generalised**: a device has a list of rules (up to 8), each *stops* or *appears*, with its own name, types (vehicles, 7 animal classes, person), optional zone, smallest size (to leave small animals such as squirrels out), hours and confidence; events and MQTT topics are per rule. The first saved shape (one flat rule) is migrated on load. The model has `bird` but no peafowl class, so a peacock relies on `bird` plus size; untested until one visits.
- **Detection outputs**: per-rule web address (GET/POST, `{placeholders}`, a second address for "gone"), Home Assistant MQTT discovery, and a *Send a test event* button that uses the real path with the settings as typed (test events set no retained state). `docs/homekit.md` shows the Apple TV pop-up route through a Homebridge container; **the bridge and Apple TV side is documented from each project's own docs and has not been run here.**
- **Detection replay and size band**: `detect replay` runs a saved rule over existing recordings and explains each miss; a rule has a largest as well as a smallest size. Both came from a real week: the live rule missed deliveries because the truck creeps through the zone instead of stopping (so the mail-truck rule is now "seen 4 s" rather than "still 5 s") and a garbage truck at the same spot is 30% of the picture height against the mail truck's 22-24%, so the rule uses 20-27%. Replayed over five days, every confirmed delivery fires and the garbage truck does not.
- **Appearance check, observing only**: a second stage that learns what the person marked Yes from the cut-out picture (MobileNetV2 features + a regularised logistic regression written for this, trained in about a second; leave-one-out gives the honest unseen-picture score for every marked event). It adds a `look` score to events and to the page and cannot cause or suppress an alert. **On the real data: 12 Yes / 15 No, leave-one-out recognised 12 of 12 and rejected 15 of 15; vehicles never in the training set scored as expected (a garbage truck 13%, three more deliveries 100%).** The sample is small and one camera, one truck, so it stays watch-only until a few weeks of new events agree with it; making it decide would be a one-line change in the rule's firing condition.
- First run: `reolook init` saves the camera sign-in privately (mode 600; the password is not echoed), `serve` explains what to do when there is none, and the page and CLI say plainly when ffmpeg is missing or the recordings folder is not writable. Found by a clean-clone, clean-home test.
- **Capability-only controls (built to Reolink's documented API, NOT exercised on hardware: none of the development cameras has these; every one is shown with that note):** on a live tile, a controls panel appears only for devices whose capability profile reports PTZ, a floodlight or a siren. *PTZ*: eight directions, zoom in/out and a speed slider (hold to move, release to stop; the server also tells the device to stop after each move, so a dropped page cannot leave it running), saved positions to go to, and saving the current position as a preset (confirmed). *Floodlight*: on/off and brightness through the verified setting path (only the changed field is sent; the lighting mode is untouched). *Siren*: sounds once after an explicit confirmation, with a stop. *Battery*: percentage, charging and temperature when the device reports them. *AI detection sensitivity* (people, vehicle, animal) is a setting editor that writes the object as read; a device that disagrees is reported unverified. Not built: auto-tracking, patrol/cruise, guard position, 3D zoom/pinpoint, focus, siren schedules. Every request shape is checked by tests against a fake that records exactly what it receives; the first real PTZ, floodlight or siren camera is the real test.
- Network (Settings > Devices > Network, plus cards under Change settings): a read-only summary (address and where it comes from, mask, gateway, DNS, hardware address, all ports, UPnP, Reolink cloud and its device ID, dynamic DNS, Wi-Fi), and editors for **UPnP**, **the Reolink cloud connection (P2P)** and **the IP address**. The address is the high-risk one: a fixed address is validated (dotted quad, contiguous mask, gateway on the same network, not the network or broadcast address, not the gateway, DNS required if not automatic), the new address is probed so one that already answers is refused, and the new address must be typed to apply. After the write ReoLook looks for the device again (at the new address, or by scanning for its hardware address when going back to DHCP) and re-points itself. Ports are shown but not editable: moving the web or RTSP port would orphan ReoLook's stored address. **Verified on a real RLC-410-5MP: the cloud connection turned off and back on, and the address switched from DHCP to Static at the same address and back to DHCP; the camera stayed reachable at the same address throughout.** A different static address was not tried on hardware, and UPnP was not turned on (it asks the router to open ports); its write shape was accepted with the current value only. Going back to DHCP dropped the second DNS entry the camera had been showing, because the DHCP server supplies one. All four cameras have the Reolink cloud connection on.
- Picture orientation (mirror, rotate 180°) in the image editors: **verified on a real RLC-410-5MP: each toggled, read back, and undone with the camera and its motion area byte-identical** (the camera turns its own motion area with the picture).
- Main stream resolution (Settings > Devices > Main stream resolution): the sizes the device lists, typed confirmation, then ReoLook changes it, waits for the camera to come back, signs in again, and checks. **Verified on a real RLC-410-5MP, including the hazards this found:** the camera goes silent for about 45 s and drops every session; the motion area is reset to *everything watched*; and a change to another picture shape (4:3 to 16:9) changes the motion grid itself (80x60 to 80x45), so the old area cannot be written back. ReoLook therefore saves the area first, puts it back when the grid is unchanged, and for a shape change keeps the saved layout in the history and restores it when the picture returns to that shape. Bit rate and frame rate are kept when the new size allows them, otherwise the size's defaults. Not undoable as such: choose the old size to go back.
- User accounts (Settings > Devices > User accounts): list, add, set a password, delete. High risk, so: the administrator session is required, destructive operations need the account name typed, and these are refused: deleting or re-passwording the account ReoLook views with, deleting or re-passwording the account you are signed in with, and deleting the last administrator. Names and passwords are validated first (the device's own length limits). New or changed passwords are verified by actually signing in with them; history records what happened and never a password. Nothing here can be undone. **Verified on a real RLC-410-5MP with a throwaway account: add, set password, sign in with it, delete; the camera is back to its two original accounts.** Changing an account's level is not offered: the camera accepts a `level` in ModifyUser and silently ignores it (delete and re-add instead).
- Copy settings (Settings > Devices > Copy settings): choose a source device, the settings, and the targets; ReoLook reads each setting from the source and plans it on every target, shows the exact differences per device (or "already the same", "not available", or why it cannot be copied), and applies only what is ticked, each verified and undoable like any change. Not copied: device name, clock, motion area (they belong to one device); on-screen name and credentials/"configured" facts are left as they are. A target's own limits still apply (its list of valid values, its capabilities). Planning on a real second and third camera showed true differences and refusals; nothing was applied to cameras in that run.
- Alarm actions: *Push notifications* (on/off), *Email alerts* and *FTP upload* (on/off and interval, from the device's own list). Turning email or FTP on is refused until the device has a server and account, and credentials are never read into the page or rewritten. **Verified on a real RLC-410-5MP: push on/off, email interval and FTP interval each applied, read back and undone to a byte-identical state; enabling email/FTP was correctly refused as nothing is configured.** The weekly tables are carried through unchanged (which day they start on is unconfirmed). `Alarm.action.push`/`mail` cannot be written: `SetAlarm` accepts and ignores them, so the real controls are the push, email and FTP schedules' `enable`. Not built: server, recipients and credentials (secrets), and the email/FTP test buttons.
- Encoding editor: bit rate, frame rate and profile of the main and sub streams, and audio, offered only as the values the device lists for the resolution in use, with a disk-use estimate. Resolution is shown, not editable yet. **Verified on a real RLC-410-5MP: sub frame rate, sub profile, main bit rate, main frame rate and audio each applied, read back, and undone to a byte-identical state.** `SetEnc` refuses a stream object of only the changed fields and accepts the stream as read with the changes applied; a profile change takes the camera's web service away for roughly ten seconds, during which a read-back made at once can be unverified or fail (the value is right when it returns).
- Image editors (Settings > Devices > Change settings): *Picture* (brightness, contrast, hue, saturation, sharpness) and *Day/night and exposure* (day/night mode, anti-flicker, back light control or dynamic range with its level, 3D noise reduction). Ranges and allowed values come from the device. **Verified on a real RLC-410-5MP: each applied, read back by an independent read, undone to a byte-identical state.** Mirroring, rotation, exposure mode, gain, shutter and white balance are read but not editable yet (mirroring and rotation also turn the motion area over).
- Motion sensitivity editor: one value per time-of-day window (1 to 50 as the device reports). **Verified on a real RLC-410-5MP: a window changed 10 to 11 through the pipeline, read back by an independent read, and undone to byte-identical state.** Written through `SetAlarm`; `SetMdAlarm` accepts a `sens` or `newSens` array and silently changes nothing, so reports of success are not trusted without a read-back. Which direction is "more sensitive" and whether the camera acts on these windows have not been tested with real motion.
- Night-vision (IR) lights editor: Auto / Off as the device itself lists them. **Verified on a real RLC-410-5MP: `SetIrLights` Auto to Off was read back by an independent read, then restored to Auto.**
- Editors on that pipeline: device name, on-screen display (name, time, positions, watermark), time zone and daylight saving, device clock (set to this computer's time), and NTP. **Device name, OSD position, NTP interval and time zone have each been changed and undone on a real RLC-410 and verified by an independent read; the clock editor has only run against a fake camera (the cameras are within a second already).**

- **Live view health and tile tools (2026-11):** each camera in the list has a dot (green answering, red not responding, grey unknown) with a teal ring on the selected one; a tile's hover tools gained a **Web page** link (the camera's own page) and a **Reboot** button (administrator sign-in, confirmed, server-side capability check; `POST /api/devices/:id/reboot`). Both verified in a real browser engine against demo cameras and by tests against a fake camera; the reboot request itself was used on a real RLC-410 by script.
- **Settings > About** (2026-11): the build's version (semantic versioning, from `package.json`), licence and Node.js version.
- **Recorder reliability (2026-11):** probe window before recording (fixes `dimensions not set`), a 10 s RTSP silence timeout, a start-up grace for the stall watchdog, a race fixed where a poll in flight could start ffmpeg after `stop()`, and camera passwords masked in ffmpeg's error text. Each was measured on the real cameras' own journal before and after; the silence timeout and the watchdog grace are unconfirmed over several days (see `TODO.md`).
- **Speed and structure pass (2026-11), no behaviour change:** one shared signed-in client per camera (`ClientPool`) so the recorder, detection and the page do not each sign in; bounded concurrency for camera reads; a shared motion-state cache; the server's routes split into groups; a bounded clip-info cache that shares duplicate `ffprobe` and thumbnail runs; live-view decoder limited to two threads (about 30 to 40 MB less per sub-stream process); every function documented. Backed by a fake Reolink camera and a command-line sandbox in `test/support/`, which grew the suite to about 480 tests, run before and after each change.

## Next: app settings follow-ups


## Device settings

The original's largest area is per-device configuration. ReoLook has none of it yet.

### Foundations (build before any editing)

1. **Capability profile per device. Built** (`src/capabilities.mjs`, `reolook capabilities`,
   `GET /api/devices/:id/capabilities`). It reconciles two sources, because neither is enough:
   - the camera's own report, `GetAbility`, which the firmware only answers when given the
     account's user name (an empty request returns "not exist"), and whose `permit` values
     describe what *that account* may do, so a `0` can mean "the device lacks it" or "this
     account may not". `permit` is a bitmask, inferred from observation (viewer 4, administrator 6,
     reboot/restore 0 then 1): **4 = read, 2 = write, 1 = execute**, which is what decides whether
     an editor is offered. A setting declares which bit it needs: IR lights are a *control*, and the
     administrator holds read + execute (5) for them, not write, so that editor needs execute;
   - real read commands, because the report can over-claim (the RLC-410 permits a floodlight
     yet refuses `GetWhiteLed`).
   Each feature ends up `supported`, `reported` (no read exists to confirm it), `conflict`,
   `unsupported` (with a flag when the account may be the reason), or `unknown`. Results are cached
   by host, channel, model and firmware, so an upgrade re-probes. Nothing is keyed on a model
   name. Re-reading as administrator resolves the "this device or this account" doubt: on the
   RLC-410 reboot and restore turn out to exist, while siren, PTZ (and presets, patrol), Wi-Fi
   and battery are really absent. Still to do: gating the editors on these states, which belongs
   to the device settings shell (item 4).
2. **Admin sign-in for writes. Built** (`src/admin.mjs`, `/api/admin/*`, Settings > Devices). The
   viewing account may be read-only (the `observer` account here is). Writes use an account that
   can change settings, for the session only: held in the server's memory, never stored in the
   env file or the config, never logged, and not readable by page scripts (the browser only holds
   an opaque HttpOnly, SameSite=Strict, session cookie). Idle timeout 15 minutes, absolute 8 hours,
   forgotten on sign-out or restart. A wrong password is tried on one device only and repeated
   failures lock further attempts for a minute, because cameras may lock the account itself.
3. **Safe-write pipeline** used by every edit:
   read the current value, show a diff of what will change, confirm, write, read back and verify,
   and keep the previous value so the change can be undone in the app. Surface the device's own
   error text. A "restart required" notice where the device says so. **Built**
   (`src/safe-write.mjs`, `src/device-settings.mjs`, `src/change-log.mjs`, Settings > Devices >
   Change settings). A setting is a small declarative descriptor (read, write, validate, risk,
   which fields are secret), and one generic pipeline does the rest:
   - a plan is the exact diff and is single-use, bound to the signing-in session, and expires in
     five minutes; a plan never writes;
   - apply re-reads first and refuses if the device changed since the plan;
   - after writing it reads back and reports `verified` only if the device holds the new value, so
     a device that silently ignores or normalises a write is reported as *unverified*, not as success;
   - every attempt (applied, unverified, refused) goes to an append-only log (mode 600) that holds
     no credentials; secret fields are redacted and such settings are not undoable;
   - undo writes the previous value back, and refuses if the device has been changed again since;
   - writes to one device are serialised.
   Descriptors can also resolve their target at apply time, use their own conflict check and
   verification tolerance, and be marked volatile (a clock is compared with tolerance, written
   with the time of the click rather than of the review, and is never undone). The first
   descriptor is the device name. **Verification so far:** the pipeline, API and UI were exercised end to end against a fake camera, and
   then on real hardware (an RLC-410, firmware v3.0.0.136): a real rename of the device
   name, then a session of small reversible edits through the running service, each followed by an
   independent read with the viewing account, an Undo through the pipeline, and a second independent
   read proving the camera was exactly as before: OSD name position, NTP interval, time zone, and
   four cells of the motion area. `SetDevName`, `SetOsd`, `SetNtp`, `SetTime` (time zone) and
   `SetMdAlarm` are therefore proven on that model and firmware, and so is Undo. `SetTime` for the
   clock itself has not been exercised on hardware.
4. **Device settings shell**, matching the original's remote-config layout: a device picker, a
   left list of areas, and a form on the right, with an "unavailable on this device" state.
5. **Copy settings to other devices. Built** (above). **Sync a schedule to other channels** is not (it needs multi-channel recorders, which these cameras are not). Depends on 1 and 3; each target is checked against its own capability profile.

### Areas

*A check marks a command that was read successfully on the RLC-410. Write commands (`Set…`) have
been exercised on a real camera for one command only (`SetDevName`, writing the current value back). "Unverified" means not testable on the development
cameras, and command names without a check were written from memory of Reolink's HTTP API
documentation: some may be inexact (for example `GetAiCfg`, `GetPir`, `GetPerformance`). Confirm
each against a real device, or the capability profile, before building on it.*

| Area | What the original offers | HTTP API (per Reolink's docs) | On RLC-410 | Risk to edit |
|---|---|---|---|---|
| **General** | Device name, model, firmware, UID | `GetDevInfo` ✓, `GetDevName` ✓ / `SetDevName` ✓ | read ✓, write ✓ (real rename verified) | low |
| **Date, time, NTP** | Time zone, DST, NTP server, sync | `GetTime` ✓ / `SetTime`, `GetNtp` ✓ / `SetNtp` | read ✓, write ✓ (time zone and NTP interval changed and undone on hardware; clock not exercised) | low |
| **Image** | Day/night, exposure, gain range, BLC, DRC, anti-flicker, brightness etc., mirror/rotate | `GetIsp` ✓ / `SetIsp`, `GetImage` ✓ / `SetImage` | read ✓, write ✓ for picture, day/night, anti-flicker, back light, noise reduction, mirror and rotate (`SetImage`, `SetIsp` take only the changed fields; verified on hardware) | medium |
| **OSD and privacy masks** | On-screen name and time, mask regions | `GetOsd` ✓ / `SetOsd`, `GetMask` ✓ / `SetMask` | read ✓, OSD write ✓ (position changed and undone on hardware; on this firmware the on-screen name follows the device name, seen once); masks not built | low |
| **Encoding** | Resolution, FPS, bitrate, profile, audio on/off | `GetEnc` ✓ / `SetEnc` | read ✓, write ✓ for bit rate, frame rate, profile, audio, and main resolution (`SetEnc` with the whole stream object; resolution has its own flow because the device restarts its video and resets the motion area) | medium (changes recordings) |
| **Night vision / IR** | IR lights on a schedule or off; day/night mode | `GetIrLights` ✓ / `SetIrLights` (device range: `Auto`, `Off`, no `On`); day/night is separate, in `GetIsp` / `SetIsp` | read ✓; IR editor built, write ✓ (Auto to Off and back verified on hardware); day/night mode not built | low |
| **Motion detection** | Zone grid, sensitivity per time-of-day schedule | `GetAlarm` ✓, `GetMdAlarm` ✓ / `SetMdAlarm` ✓ | read ✓ (80×60 grid), area write ✓ via `SetMdAlarm` (verified on hardware); sensitivity ✓ via `SetAlarm` (verified on hardware); the newer scheduled table is not editable | medium |
| **AI detection** | People, vehicle, animal, pet, face, package; per-type sensitivity, size limits, no-alarm zones | `GetAiAlarm` / `SetAiAlarm`, `GetAiCfg` | unverified (not on this camera) | medium |
| **Alarm actions and schedule** | What an alarm does: push, email, FTP upload, record, siren; when it is armed | `GetPush` ✓ / `SetPush`, `GetEmail` ✓ / `SetEmail`, `GetFtp` ✓ / `SetFtp` | read ✓, write ✓ for on/off and interval of push, email and FTP (credentials and server not editable yet) | medium |
| **Siren / audio alarm** | Siren on alarm, manual trigger, volume, schedule | `GetAudioAlarm` / `SetAudioAlarm`, `AudioAlarmPlay` | unverified | low |
| **Floodlight / spotlight** | Auto, schedule, brightness, on-demand | `GetWhiteLed` / `SetWhiteLed` | unverified | low |
| **PTZ** | Pad, zoom, focus, presets, patrol/cruise, guard (return to position), 3D zoom, pinpoint | `PtzCtrl`, `GetPtzPreset` / `SetPtzPreset`, `GetPtzPatrol` / `SetPtzPatrol`, `GetPtzGuard` / `SetPtzGuard`, `GetPtzCheckState` | unverified | low to medium |
| **Auto-tracking** | Follow detected targets (PTZ models) | `GetAiAlarm` tracking fields, `SetAiAlarm` | unverified | medium |
| **On-camera recording** | Schedule, pre-record, overwrite, stream type | `GetRec` ✓ / `SetRec`, `GetRecV20` / `SetRecV20` | partly (no card to test with) | medium |
| **Storage** | Card / disk status, capacity, format | `GetHddInfo` ✓ / `Format` | read ✓ (empty: no card) | **high** (erases data) |
| **Network** | IP mode, ports, UPnP, DDNS, Wi-Fi scan and join | `GetLocalLink` ✓ / `SetLocalLink`, `GetNetPort` ✓ / `SetNetPort`, `GetUpnp` ✓ / `SetUpnp`, `GetDdns` ✓ / `SetDdns`, `GetWifi` / `SetWifi` | read ✓ except Wi-Fi (wired); IP mode (DHCP/Static + address) ✓ and UPnP / P2P editors (verified on hardware as above); ports, DDNS, Wi-Fi not editable | **high** (can lock you out) |
| **Users** | List, add, remove, change level and password | `GetUser` ✓ / `AddUser`, `DelUser`, `ModifyUser` | read ✓, add / set password / delete ✓ (verified on hardware with a throwaway account); level change not possible in place | **high** |
| **Maintenance** | Reboot, scheduled auto-reboot, restore defaults | `Reboot`, `GetAutoMaint` ✓ / `SetAutoMaint`, `Restore` | read ✓ | reboot: low; restore: **high** |
| **Firmware** | Check for and install updates | `CheckFirmware`, `UpgradeOnline` | check **not** supported on this firmware | **high** |
| **Battery / low-power** | Charge, power schedule, PIR sensitivity, wake settings | `GetBatteryInfo`, `GetPowerLed`, `GetPir` | unverified | low |
| **Diagnostics** | Read-only device and performance info for troubleshooting | `GetDevInfo` ✓, `GetPerformance`, `GetLog` | partly | none |

### Order of work

1. Foundations 1–4 above, then **read-only pages for every area**, gated by the capability profile.
2. **Writes, lowest risk first** (device name, OSD, time zone, clock and NTP are done, against a fake camera): IR mode, then encoding,
   then alarm actions and notifications.
3. **Capability-only features** (PTZ pad and presets, floodlight, siren, AI detection,
   auto-tracking, battery): built against the documented API with their controls present in the
   UI only on cameras that report them, and shipped as *unverified* until tested on such a camera.
4. **High-risk areas last**, each with a typed confirmation and no bulk "apply": network ports,
   users, storage format, restore defaults, firmware.

### Motion zone editor (requested)

Data model confirmed on the RLC-410: `GetAlarm {Alarm:{channel,type:"md"}}` returns
`scope: {cols:80, rows:60, table:"<4800 × 0/1>"}`, and `GetMdAlarm` returns per-schedule
sensitivity (`newSens.sens[]` with begin/end hour, sensitivity, enable). Newer cameras may use a
different grid size, so the editor reads `cols` and `rows` from the device instead of assuming
80×60. **The read-only overlay is built** (`src/motion.mjs`, `GET /api/devices/:id/motion`, the
zones button on a live tile, and a map in Settings > Devices). The parser is strict: a table of the
wrong length, or with values other than 0 and 1, is reported as a problem and never repaired. The
`enable` field reads `1602` on these cameras, so it is not interpreted as on/off, and the older and
newer sensitivity tables are both shown with their ambiguity noted. Real zones differ per camera
(73%, 92% and 100% of the picture on the three RLC-410s). **The editor is built** as a descriptor
on the safe-write pipeline (`motionZones`) with a painter in Settings > Devices. Guard rails: at
least one cell must stay watched (otherwise the camera never reports motion and ReoLook records
nothing), the grid size cannot change, a warning appears below 10% coverage, and editing is
refused if the device's two reports of the area disagree. It writes `SetMdAlarm { MdAlarm: { channel, scope, sens } }`, carrying `sens` through as read, and
reports *unverified* if the read-back differs or if only one of the two reports changed. **How that
shape was found, because the obvious ones were refused:** `SetAlarm` with the alarm object as read
(including the unusual `enable: 1602`) and `SetMdAlarm` with the whole `MdAlarm` object both
returned `param error`; the camera's own web UI has no motion-area editor to copy from; and
`GetAlarmArea` / `SetAlarmArea` are not supported on this firmware. Shapes were then tried from
the most conservative, each with a 4-cell corner change that was read back, compared field by
field against the original and undone at once. `{ channel, scope, sens }` was the first accepted
and was clean: both reports updated, nothing else changed. A refusal changed nothing. Zones drawn
in the Windows app use the same grid, so they should round-trip; the edit above was on a
camera whose zones came from that app.

## Later

- **Time lapse** (original has scenes, a schedule and size estimates).
- **Event log / smart-detection timeline** where a camera exposes it.
- **Doorbell, chime and hub devices** (the original has dedicated flows for these).
- **Multi-language UI** (the original ships about 30 locales).
- **Electron shell** if a tray icon or the original's custom title bar becomes important.
- **Test buttons for FTP, email and third-party cloud** that send a test file, like the original.

## Not planned

- **ZoneMinder compatibility** (explicitly out of scope).
- **Firmware upload from a local file.** Online check and install may come with the Firmware
  area, behind the same high-risk confirmation; flashing arbitrary files is not planned.
- **UID / P2P connect, Baichuan-protocol discovery and two-way talk**: these need Reolink's proprietary
  Baichuan protocol, which ReoLook does not implement. They are large and uncertain, and are
  revisited only if that changes.
