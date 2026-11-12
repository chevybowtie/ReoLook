# Third-party notices

ReoLook's own code is under the [MIT licence](LICENSE). It has no npm dependencies and **bundles no
third-party code or model files**: this repository contains none. The pieces below are fetched or
used at run time, on your machine, and each stays under its own licence.

## Downloaded by `reolook detect setup` (optional vehicle and animal detection)

Nothing here is installed unless you run that command. Both model files are checked against a fixed
SHA-256 hash before they are kept (see `src/detect/helper-client.mjs`), and they are stored under
`~/.local/share/reolook/detector`, not in this repository.

| Component | What ReoLook uses it for | Licence | Source |
|---|---|---|---|
| **YOLOX-s** (`yolox_s.onnx`, 36 MB) | Finds vehicles, animals and people in a camera picture | Apache-2.0, Copyright 2021-2022 Megvii Inc. | https://github.com/Megvii-BaseDetection/YOLOX (release 0.1.1rc0) |
| **MobileNetV2** (`mobilenetv2-12.onnx`, 14 MB) | Describes what a detected object looks like, for the optional appearance check | Apache-2.0 (ONNX Model Zoo) | https://github.com/onnx/models (`validated/vision/classification/mobilenet`) |
| **onnxruntime** (Python package) | Runs the two models on the CPU | MIT | https://pypi.org/project/onnxruntime/ |
| **NumPy** (Python package) | Array maths for the detector helper | BSD-3-Clause (the package also carries notices for parts it includes) | https://pypi.org/project/numpy/ |
| **Pillow** (Python package) | Reads and crops the pictures | MIT-CMU (HPND style) | https://pypi.org/project/pillow/ |

The Python packages are installed from PyPI into a private virtual environment, so each one's own
licence file travels with it there. The Apache-2.0 text is at https://www.apache.org/licenses/LICENSE-2.0 .

**Training data.** YOLOX-s was trained on the COCO dataset (annotations under CC BY 4.0,
https://cocodataset.org) and MobileNetV2 on ImageNet. The licences above cover the model files; the
datasets have their own terms, which are the models' publishers' to meet, not something ReoLook
redistributes.

**No endorsement.** ReoLook is an independent project. It is not affiliated with, or endorsed by, Megvii, the
ONNX project, or any other party named here, and it is not affiliated with Reolink.

## Programs ReoLook runs but does not include

These are separate programs found on your system, called as commands; ReoLook neither bundles nor
modifies them, and their licences are those of the build you installed.

- **ffmpeg** and **ffprobe**: live view, recording, thumbnails and export. Licensed under the LGPL or
  GPL depending on how your distribution built it (https://ffmpeg.org/legal.html).
- **Node.js** (MIT) runs ReoLook itself.
- **A Chromium-family browser** (Brave, Chromium or Chrome) is only used to show the page, when you
  run `reolook open`.

## Optional example, not part of ReoLook

`contrib/homebridge/docker-compose.yml` and `docs/homekit.md` describe running
[Homebridge](https://github.com/homebridge/homebridge) (Apache-2.0) with
[homebridge-camera-ffmpeg](https://github.com/homebridge-plugins/homebridge-camera-ffmpeg) (Apache-2.0) to
show a camera on an Apple TV. ReoLook includes none of their code; the compose file only names the
container image.

## Trademarks

Reolink is a trademark of its owner. It is used here only to say which cameras ReoLook works with.
