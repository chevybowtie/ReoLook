# Showing a camera on an Apple TV when something is detected

ReoLook decides *when* (a peacock walked in, the mail truck stopped). Apple's Home system decides
*how it is shown*: a HomeKit camera that reports an event pops up as a small live picture over
whatever the Apple TV is playing (YouTube, the DirecTV app, anything). Something has to present your
cameras to HomeKit; ReoLook does not, on purpose (see "Why a separate bridge" below).

```
ReoLook (detection rules) --web address / MQTT--> bridge container --HomeKit--> Apple TV pop-up
```

> **What is verified.** ReoLook's side (the web address call, MQTT, the test button) is tested.
> The bridge and Apple TV side below follows each project's documentation but has **not** been
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
      - ./homebridge:/homebridge
```

```sh
cd contrib/homebridge
docker compose up -d
```

Open `http://localhost:8581`, finish the setup wizard, then **Plugins**: install
`homebridge-camera-ffmpeg`. In its settings, add the camera (adjust the address; a view-only
camera account is enough, and its password ends up in this file, so keep the file private):

```json
{
  "platform": "Camera-ffmpeg",
  "cameras": [
    {
      "name": "Front Porch",
      "motion": true,
      "doorbell": true,
      "videoConfig": {
        "source": "-rtsp_transport tcp -i rtsp://viewer:PASSWORD@192.168.1.242:554/h264Preview_01_sub",
        "stillImageSource": "-i rtsp://viewer:PASSWORD@192.168.1.242:554/h264Preview_01_sub -frames:v 1",
        "maxWidth": 1280, "maxHeight": 720, "maxFPS": 15
      }
    }
  ]
}
```

Use the camera's **sub stream** (`..._sub`), which is small enough to transcode comfortably. In
the plugin's global settings enable its **HTTP server** (`"http": true`, default port 8080, check
its README). It then accepts motion triggers such as:

```
http://<the PC>:8080/motion?Front%20Porch          # something happened
http://<the PC>:8080/motion/reset?Front%20Porch    # it has gone
http://<the PC>:8080/doorbell?Front%20Porch        # present it as a doorbell press
```

Add the bridge to the Home app on your iPad (Add accessory, scan the code shown in the Homebridge
UI). In the Home app open the camera, settings, and turn on the notification / show on Apple TV
options.

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
