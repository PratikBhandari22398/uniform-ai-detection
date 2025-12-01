# newmycode.py
# Full file — patched loader + Flask API to serve POST /api/detect

import cv2
import numpy as np
import tensorflow as tf
from tensorflow.keras.models import load_model as tf_load_model

# try to import standalone keras loader too (optional; may be absent)
try:
    from keras.models import load_model as keras_load_model
except Exception:
    keras_load_model = None

from PIL import Image, ImageOps
from flask import Flask, request, jsonify
from datetime import datetime
from io import BytesIO
from pymongo import MongoClient
import traceback
import os

# ----------------- PATCH DepthwiseConv2D 'groups' -----------------
def patch_depthwise_in(target_module):
    try:
        Depthwise = getattr(target_module.layers, "DepthwiseConv2D", None)
        if Depthwise is None:
            return False
        _orig = getattr(Depthwise, "from_config", None)

        def _from_config_strip_groups(config, custom_objects=None):
            # remove unknown 'groups' key if present
            if isinstance(config, dict) and "groups" in config:
                config = dict(config)
                config.pop("groups", None)
            if _orig is None:
                return Depthwise(**config)
            try:
                return _orig(config, custom_objects)
            except TypeError:
                return _orig(config)

        # apply patched from_config
        Depthwise.from_config = staticmethod(_from_config_strip_groups)
        try:
            setattr(Depthwise, "from_config", staticmethod(_from_config_strip_groups))
        except Exception:
            pass

        print(f"[patch] Patched DepthwiseConv2D.from_config in {target_module.__name__}")
        return True
    except Exception as e:
        print(f"[patch] Failed to patch {getattr(target_module, '__name__', str(target_module))}: {e}")
        traceback.print_exc()
        return False

# apply patch to tf.keras
patched_tf = patch_depthwise_in(tf.keras)
# also try standalone keras if present
try:
    import keras
    patched_keras = patch_depthwise_in(keras)
except Exception:
    patched_keras = False

# ----------------- MODEL SETUP -----------------

MODEL_PATH = "keras_model.h5"
LABELS_PATH = "labels.txt"
INPUT_SIZE = (224, 224)  # adjust if model expects different input

# choose loader (prefer tf.keras)
MODEL_LOADER = tf_load_model
# optional: if you want to use standalone keras loader when available, uncomment:
# if keras_load_model is not None:
#     MODEL_LOADER = keras_load_model

# sanity check model file presence
if not os.path.exists(MODEL_PATH):
    raise FileNotFoundError(f"Model file not found: {MODEL_PATH}")

# load model (will use patched from_config above)
model = MODEL_LOADER(MODEL_PATH, compile=False)
print("[info] model loaded using loader:", MODEL_LOADER.__module__)

# load labels
if not os.path.exists(LABELS_PATH):
    raise FileNotFoundError(f"Labels file not found: {LABELS_PATH}")

with open(LABELS_PATH, "r") as f:
    raw_labels = [line.strip() for line in f.readlines() if line.strip()]

# keep human-readable label part after index, if present
class_names = [line.split(" ", 1)[1] if " " in line else line for line in raw_labels]

# ----------------- PREDICTION HELPERS -----------------

def predict_image_pil(pil_img):
    """Run prediction on a PIL image and return (class_name, confidence)."""
    img = ImageOps.fit(pil_img, INPUT_SIZE, Image.Resampling.LANCZOS)
    img_array = np.asarray(img).astype(np.float32) / 255.0
    img_array = np.expand_dims(img_array, axis=0)

    preds = model.predict(img_array)
    idx = int(np.argmax(preds))
    class_name = class_names[idx] if idx < len(class_names) else str(idx)
    confidence = float(preds[0][idx])
    return class_name, confidence

def predict_frame_bgr(frame_bgr):
    """Helper for webcam debugging (not used by frontend)."""
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    pil_img = Image.fromarray(rgb)
    return predict_image_pil(pil_img)

# ----------------- MONGODB SETUP -----------------

MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017/")
MONGO_DB_NAME = os.environ.get("MONGO_DB_NAME", "college_safety")
MONGO_COLLECTION = os.environ.get("MONGO_COLLECTION", "detections")

# Connect to Mongo: if Mongo not running or you don't want DB writes, comment out insert line below.
try:
    mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=3000)
    # test connection (will raise if can't connect)
    mongo_client.server_info()
    db = mongo_client[MONGO_DB_NAME]
    detections_col = db[MONGO_COLLECTION]
    print("[info] Connected to MongoDB:", MONGO_URI)
except Exception as e:
    print("[warn] Could not connect to MongoDB. DB writes will be skipped. Error:", e)
    detections_col = None

# ----------------- FLASK API -----------------

app = Flask(__name__)

@app.route("/api/detect", methods=["POST"])
def detect_uniform_id():
    """
    POST /api/detect
    Form-data: file = image
    Returns JSON with class and confidence.
    """
    if "file" not in request.files:
        return jsonify({"status": "error", "error": "No file field in request"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"status": "error", "error": "Empty filename"}), 400

    try:
        img_bytes = file.read()
        pil_img = Image.open(BytesIO(img_bytes)).convert("RGB")

        class_name, confidence = predict_image_pil(pil_img)

        now_utc = datetime.utcnow()
        doc = {
            "class": class_name,
            "confidence": float(confidence),
            "timestamp": now_utc,
        }

        # store to Mongo if available
        if detections_col is not None:
            try:
                detections_col.insert_one(doc)
            except Exception as e:
                print("[warn] failed to insert into Mongo:", e)

        return jsonify({
            "status": "success",
            "class": class_name,
            "confidence": float(confidence),
            "timestamp": now_utc.isoformat() + "Z",
        })
    except Exception as e:
        print("[error] detect exception:", e)
        traceback.print_exc()
        return jsonify({"status": "error", "error": str(e)}), 500

# ----------------- OPTIONAL: WEBCAM TEST -----------------

def webcam_test():
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("Error: cannot open camera.")
        return

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("Failed to grab frame.")
                break

            class_name, confidence = predict_frame_bgr(frame)
            label = f"{class_name} ({confidence*100:.1f}%)"
            color = (0, 255, 0) if class_name.lower() == "uniform" else (0, 0, 255)

            cv2.putText(frame, label, (20, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, color, 2)
            cv2.imshow("Webcam Test - press 'q' to quit", frame)

            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
    finally:
        cap.release()
        cv2.destroyAllWindows()

# ----------------- MAIN -----------------

if __name__ == "__main__":
    # Run Flask API
    app.run(host="0.0.0.0", port=5000, debug=True)

    # If you prefer to run webcam test instead of API, comment the line above and uncomment:
    # webcam_test()
