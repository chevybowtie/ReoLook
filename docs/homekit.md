# Showing a camera on an Apple TV when something is detected

ReoLook decides *when* (a peacock walked in, the mail truck stopped). Apple's Home system decides
*how it is shown*: a HomeKit camera that reports an event pops up as a small live picture over
whatever the Apple TV is playing (YouTube, the DirecTV app, anything). Something has to present your
cameras to HomeKit; ReoLook does not, on purpose (see "Why a separate bridge" below).

```
ReoLook (detection rules) --web address / MQTT--> bridge container --HomeKit--> Apple TV pop-up
```

> **What is verified.** ReoLook's side (the web address call, MQTT, the test button) is tested.
> The `homekit` command is tested. The bridge and Apple TV side below follows each project's documentation but has **not** been
> run on your network by the author. Plugin settings change between versions: when a name here
> disagrees with the plugin's own README, the README wins.

## 1. Apple side (once)

1. In the **Home** app on an iPad or iPhone, create a home if you have none.
2. Your Apple TV becomes a **home hub** automatically when it is signed in to the same Apple ID.
   Check in the Home app: Home Settings, Home Hubs and Bridges. With several Apple TVs, Apple
   picks one active hub and keeps the rest as stand-bys; nothing to arrange.
3. The PC running the bridge and the Apple TV must be on the **same network segment** (Bonjour
   discovery does not cross VLANs).

## 2. A bridge in Docker (Homebridge example)

Homebridge needs host networking on Linux so that Apple devices can discover it. The file is
already in this repository at `contrib/homebridge/docker-compose.yml`; this is its content:

```yaml
# docker-compose.yml
services:
  homebridge:
    image: homebridge/homebridge:latest
    restart: always
    network_mode: host
    volumes:
      - ./data:/homebridge
```

```sh
cd contrib/homebridge
docker compose up -d
```

Open `http://localhost:8581`, finish the setup wizard (the first login is `admin` / `admin`; you
are asked to change it), then **Plugins**: install `homebridge-camera-ffmpeg`.

### Let ReoLook write the camera settings

ReoLook already knows your cameras' names, addresses and sign-in, so it can produce the plugin's
settings for all of them:

```sh
node bin/reolook.mjs homekit --bridge-host 192.168.1.10      # print them
node bin/reolook.mjs homekit --write contrib/homebridge/data/config.json   # or merge them in
```

* **Printing** gives the `Camera-ffmpeg` block as JSON on standard output (the notes go to standard
  error, so `> file` or a pipe gets only the JSON). Paste it into the plugin's settings in the
  Homebridge UI (JSON config), or merge it into `config.json`.
* **`--write FILE`** merges it into Homebridge's `config.json` for you. It adds the cameras that
  are missing, refreshes the two addresses of one that is already there (its other settings are
  left alone), and sets the trigger port only if none is set. Everything else in the file is kept,
  a `.bak` of the original is made the first time, and running it again changes nothing. The file
  must already exist (start Homebridge once). If Docker created it, it is owned by root and
  ReoLook will say so; either paste the printed block into the Homebridge UI, or give yourself the
  file (`sudo chown $USER contrib/homebridge/data/config.json contrib/homebridge/data`).
* Names are ReoLook's camera names exactly, which is what a rule's `{camera}` needs.
* It uses each camera's **sub stream** for live video, which is small enough to transcode
  comfortably, and the camera's own **snapshot address** for stills. A still taken from the video
  stream waits for a clean picture and can take so long that Homebridge logs "the image snapshot
  handler didn't respond".
* `--http-port N` changes the trigger port (default 8080). The plugin starts its web server only
  when this port is set. `--config FILE` reads a ReoLook configuration other than the default.
* The camera password is in the result in plain text; a view-only camera account is enough, and
  the file should stay private.

After `--write`, restart Homebridge (`docker restart homebridge`). The log should then show
`Setting up HTTP server on port 8080...`. ReoLook finishes by listing the web addresses to give a
detection rule for each camera:

```
http://<the PC>:8080/doorbell?Front%20Porch        # present it as a doorbell press
http://<the PC>:8080/motion?Front%20Porch          # present it as motion
http://<the PC>:8080/motion/reset?Front%20Porch    # it has gone
```

### Writing it by hand

If you would rather not use the command, add each camera to the plugin's `cameras` list yourself.
The plugin runs its ffmpeg commands without a shell, so **do not put quotes around an address**, and
percent-encode a password that holds characters such as `@`, `:`, `/` or `#`:

```json
{
  "platform": "Camera-ffmpeg",
  "porthttp": 8080,
  "cameras": [
    {
      "name": "Front Porch",
      "motion": true,
      "doorbell": true,
      "videoConfig": {
        "source": "-rtsp_transport tcp -i rtsp://viewer:PASSWORD@192.168.1.242:554/h264Preview_01_sub",
        "stillImageSource": "-i http://192.168.1.242/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=reolook&user=viewer&password=PASSWORD -frames:v 1",
        "maxWidth": 1280, "maxHeight": 720, "maxFPS": 15
      }
    }
  ]
}
```

Pair in the Home app on your iPad (Add Accessory, More options, then pick the camera and enter
the setup code shown in the Homebridge UI or log). This plugin publishes each camera as its **own
accessory**, so the log says `Please add [Front Porch ...] manually in Home app. Setup Code: ...`;
pair the camera itself. Then open the camera in the Home app, Settings, Status and Notifications,
and turn on activity notifications and the Apple TV option. Doorbell events give the most reliable
pop-up; Apple may throttle motion notifications.

**Phone on a different VLAN.** Pairing finds the accessory by Bonjour (mDNS), which does not cross
VLANs, and the Home app cannot be given an IP address. Either join the phone to a network on the
bridge's VLAN just for pairing (afterwards the Apple TV hub relays everything, and the phone can be
anywhere, the same as when away from home), or run an mDNS reflector between the VLANs (avahi, or a
"Bonjour gateway" option on the router) and allow TCP from the phone's VLAN to the PC. The Apple TV
and the bridge must stay on the same segment either way.

## 3. ReoLook: point a rule at the bridge

Settings > Detection, in the rule (for example "peacock"):

| Field | Value |
|---|---|
| Also call a web address | `http://<the PC>:8080/doorbell?{camera}` (or `/motion?{camera}`) |
| Second box (optional) | `http://<the PC>:8080/motion/reset?{camera}` |
| Method | GET |

`{camera}` is replaced by the device's name from ReoLook, which must therefore match the camera
name in the bridge (`Front Porch`). Then press **Send a test event**: ReoLook sends the event, then
"gone" 1.5 seconds later, and reports what each channel answered. If everything shows
"delivered" and nothing appears on the TV, the problem is on the Apple side (steps 1 and 2).

## Alternatives

* **Scrypted** (`koush/scrypted`, also with `network_mode: host`) is built for cameras and has a
  good HomeKit plugin, lower latency, and an MQTT plugin that can follow ReoLook's topics. The
  rule's MQTT output is the usual way to drive it; set it up with that project's documentation.
* **Home Assistant** reads ReoLook's MQTT directly. Turn on *Home Assistant discovery* in
  Settings > Detection and each rule appears as a sensor. Its HomeKit Bridge integration can then
  expose the camera and those sensors to the Home app. This is the route if you later move your
  SmartThings devices as well.

## Why a separate bridge

Presenting a camera to HomeKit means implementing Apple's accessory protocol (its own pairing
cryptography, encrypted sessions, live video over SRTP) and keeping up with every iOS and tvOS
change. Homebridge, Scrypted and Home Assistant already do that and are maintained for it. ReoLook
has no dependencies and does one job; it announces events and lets the bridge be replaceable.
