#!/usr/bin/env python3
"""
Object detector helper for ReoLook. Reads one JSON request per line on stdin and answers one JSON
line on stdout:

  in : {"id": 1, "file": "/path/frame.jpg"}
  out: {"id": 1, "ms": 87, "width": 1920, "height": 1080,
        "detections": [{"label": "truck", "score": 0.81, "box": [x1, y1, x2, y2]}]}

Boxes are fractions of the image (0..1). Model: YOLOX (Apache-2.0) exported to ONNX, COCO classes.
Only onnxruntime, numpy and Pillow are needed. Nothing is sent anywhere.

A second request kind describes what a detected thing *looks like*, for the appearance check:

  in : {"id": 2, "op": "embed", "file": "/path/frame.jpg", "box": [x1, y1, x2, y2]}
  out: {"id": 2, "features": [... 1000 numbers ...], "colour": [white, blue, red, dark, brightness]}

The numbers are the output of a small image-recognition network (MobileNetV2, Apache-2.0) run on the
cut-out; a classifier trained on the person's own Yes/No marks works on them.
"""
import json
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

NAMES = ("person bicycle car motorcycle airplane bus train truck boat traffic_light fire_hydrant stop_sign "
         "parking_meter bench bird cat dog horse sheep cow elephant bear zebra giraffe backpack umbrella handbag "
         "tie suitcase frisbee skis snowboard sports_ball kite baseball_bat baseball_glove skateboard surfboard "
         "tennis_racket bottle wine_glass cup fork knife spoon bowl banana apple sandwich orange broccoli carrot "
         "hot_dog pizza donut cake chair couch potted_plant bed dining_table toilet tv laptop mouse remote keyboard "
         "cell_phone microwave oven toaster sink refrigerator book clock vase scissors teddy_bear hair_drier "
         "toothbrush").split()
SIZE = 640
CONF = 0.30
NMS_IOU = 0.45


def load(model_path, threads=4):
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    return ort.InferenceSession(model_path, opts, providers=["CPUExecutionProvider"])


def grids():
    out = []
    for stride in (8, 16, 32):
        n = SIZE // stride
        xv, yv = np.meshgrid(np.arange(n), np.arange(n))
        g = np.stack((xv, yv), 2).reshape(-1, 2)
        out.append((g, np.full((g.shape[0], 1), stride)))
    return np.concatenate([g for g, _ in out]).astype(np.float32), np.concatenate([s for _, s in out]).astype(np.float32)


GRID, STRIDES = grids()


def preprocess(img):
    """Letterbox to SIZE x SIZE (pad 114), BGR float32 CHW, as YOLOX expects."""
    w, h = img.size
    r = min(SIZE / w, SIZE / h)
    nw, nh = int(round(w * r)), int(round(h * r))
    resized = img.resize((nw, nh), Image.BILINEAR)
    canvas = np.full((SIZE, SIZE, 3), 114, dtype=np.uint8)
    canvas[:nh, :nw] = np.asarray(resized)
    bgr = canvas[:, :, ::-1]
    return np.ascontiguousarray(bgr.transpose(2, 0, 1), dtype=np.float32)[None], r


def nms(boxes, scores, iou_thr):
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(boxes[i, 0], boxes[rest, 0])
        yy1 = np.maximum(boxes[i, 1], boxes[rest, 1])
        xx2 = np.minimum(boxes[i, 2], boxes[rest, 2])
        yy2 = np.minimum(boxes[i, 3], boxes[rest, 3])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        a = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        b = (boxes[rest, 2] - boxes[rest, 0]) * (boxes[rest, 3] - boxes[rest, 1])
        iou = inter / np.maximum(a + b - inter, 1e-9)
        order = rest[iou <= iou_thr]
    return keep


def decode(raw, ratio, width, height, conf=CONF):
    out = raw[0].astype(np.float32)
    out[:, :2] = (out[:, :2] + GRID) * STRIDES
    out[:, 2:4] = np.exp(out[:, 2:4]) * STRIDES
    cls = out[:, 5:]
    ids = cls.argmax(1)
    scores = out[:, 4] * cls[np.arange(cls.shape[0]), ids]
    m = scores >= conf
    if not m.any():
        return []
    out, ids, scores = out[m], ids[m], scores[m]
    xyxy = np.empty((out.shape[0], 4), dtype=np.float32)
    xyxy[:, 0] = out[:, 0] - out[:, 2] / 2
    xyxy[:, 1] = out[:, 1] - out[:, 3] / 2
    xyxy[:, 2] = out[:, 0] + out[:, 2] / 2
    xyxy[:, 3] = out[:, 1] + out[:, 3] / 2
    xyxy /= ratio
    dets = []
    for c in np.unique(ids):                     # class-aware suppression
        idx = np.where(ids == c)[0]
        for k in nms(xyxy[idx], scores[idx], NMS_IOU):
            j = idx[k]
            x1, y1, x2, y2 = xyxy[j]
            dets.append({"label": NAMES[int(c)], "score": round(float(scores[j]), 3),
                         "box": [round(float(np.clip(x1 / width, 0, 1)), 4), round(float(np.clip(y1 / height, 0, 1)), 4),
                                 round(float(np.clip(x2 / width, 0, 1)), 4), round(float(np.clip(y2 / height, 0, 1)), 4)]})
    dets.sort(key=lambda d: -d["score"])
    return dets


def detect(session, path, conf=CONF):
    img = Image.open(path).convert("RGB")
    width, height = img.size
    blob, ratio = preprocess(img)
    raw = session.run(None, {session.get_inputs()[0].name: blob})[0]
    return {"width": width, "height": height, "detections": decode(raw, ratio, width, height, conf)}


MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def embed(session, path, box):
    """Features of the part of the picture inside `box` (fractions), with a small margin."""
    img = Image.open(path).convert("RGB")
    w, h = img.size
    x1, y1, x2, y2 = [float(v) for v in box]
    mx, my = (x2 - x1) * 0.05, (y2 - y1) * 0.05
    crop = img.crop((int(max(0, (x1 - mx)) * w), int(max(0, (y1 - my)) * h), int(min(1, (x2 + mx)) * w), int(min(1, (y2 + my)) * h)))
    if crop.size[0] < 8 or crop.size[1] < 8:
        raise ValueError("the box is too small to look at")
    arr = (np.asarray(crop.resize((224, 224), Image.BILINEAR), dtype=np.float32) / 255.0 - MEAN) / STD
    logits = session.run(None, {session.get_inputs()[0].name: arr.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
    a = np.asarray(crop.resize((64, 64), Image.BILINEAR), dtype=np.float32) / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    hi, lo = a.max(-1), a.min(-1)
    sat = (hi - lo) / (hi + 1e-6)
    colour = [float(((lo > 0.62) & (sat < 0.22)).mean()), float(((b > r + 0.08) & (b > g) & (hi > 0.25)).mean()),
              float(((r > g + 0.15) & (r > b + 0.15) & (hi > 0.3)).mean()), float((hi < 0.25).mean()), float(hi.mean())]
    return {"features": [round(float(v), 4) for v in logits], "colour": [round(c, 4) for c in colour]}


def main():
    model = sys.argv[1]
    session = load(model, int(sys.argv[2]) if len(sys.argv) > 2 else 4)
    embedder = load(sys.argv[3], int(sys.argv[2]) if len(sys.argv) > 2 else 4) if len(sys.argv) > 3 else None
    print(json.dumps({"ready": True, "model": model, "embedder": bool(embedder)}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            t0 = time.time()
            if req.get("op") == "embed":
                if embedder is None:
                    raise RuntimeError("the appearance model is not installed")
                res = embed(embedder, req["file"], req["box"])
            else:
                res = detect(session, req["file"], float(req.get("conf", CONF)))
            res.update({"id": req.get("id"), "ms": int((time.time() - t0) * 1000)})
        except Exception as e:  # keep serving; report the failure for this frame
            res = {"id": req.get("id"), "error": str(e)[:200]}
        print(json.dumps(res), flush=True)


if __name__ == "__main__":
    main()
