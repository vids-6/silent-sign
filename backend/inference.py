"""
Silent Sign - inference engine.

Loads the trained landmark classifier once and turns a single BGR frame into
a structured prediction:

    frame -> MediaPipe Hands (up to 2 hands) -> features.py -> ExtraTrees

The engine never invents a prediction: if no hand is found, "prediction" is
None and the caller is told that no hands were detected.
"""

import json
import threading
import time
from pathlib import Path

import cv2
import joblib
import numpy as np

from features import FEATURE_DIM, FEATURE_VERSION, landmarks_to_features

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = PROJECT_ROOT / "model"
META_PATH = MODEL_DIR / "model_meta.json"

MAX_FRAME_SIDE = 960  # larger frames are downscaled before hand detection


class ModelNotReady(RuntimeError):
    pass


class Recognizer:
    def __init__(self, static_images=False, detection_confidence=0.5):
        if not META_PATH.exists():
            raise ModelNotReady(
                f"Missing {META_PATH}. Train the model first: "
                "python training/train_landmark_model.py"
            )
        self.meta = json.loads(META_PATH.read_text(encoding="utf-8"))
        model_path = MODEL_DIR / self.meta["model_file"]
        if not model_path.exists():
            raise ModelNotReady(f"Missing model file {model_path}")
        if self.meta.get("feature_version") != FEATURE_VERSION \
                or self.meta.get("feature_dim") != FEATURE_DIM:
            raise ModelNotReady(
                "Model was trained with a different feature layout; retrain it."
            )

        self.model = joblib.load(model_path)
        if hasattr(self.model, "n_jobs"):
            self.model.n_jobs = 1  # single-frame inference: threads only add overhead
        self.classes = list(self.meta["classes"])
        # model.classes_ holds the integer class indices it was trained on.
        self._columns = [int(c) for c in self.model.classes_]
        if max(self._columns) >= len(self.classes):
            raise ModelNotReady("Model outputs do not match the class list in model_meta.json")
        self.threshold = float(self.meta["confidence_threshold"])

        self._static = static_images
        self._detection_confidence = detection_confidence
        self._lock = threading.Lock()
        self._hands = None
        self._make_hands()

    # ------------------------------------------------------------------
    def _make_hands(self):
        import mediapipe as mp

        if self._hands is not None:
            self._hands.close()
        self._hands = mp.solutions.hands.Hands(
            static_image_mode=self._static,
            max_num_hands=2,
            model_complexity=1,
            min_detection_confidence=self._detection_confidence,
            min_tracking_confidence=0.5,
        )

    def reset(self):
        """Forget hand-tracking state (e.g. after the camera restarts)."""
        with self._lock:
            self._make_hands()

    # ------------------------------------------------------------------
    def predict_frame(self, bgr, mirror=False):
        if bgr is None or bgr.ndim != 3 or bgr.shape[2] != 3:
            raise ValueError("frame must be an HxWx3 BGR image")
        started = time.perf_counter()

        h, w = bgr.shape[:2]
        longest = max(h, w)
        if longest > MAX_FRAME_SIDE:
            s = MAX_FRAME_SIDE / longest
            bgr = cv2.resize(bgr, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
            h, w = bgr.shape[:2]
        if mirror:
            # "Left-handed" mode: mirror the frame so a left-dominant signer's
            # handshapes match the (right-dominant) training data.
            bgr = cv2.flip(bgr, 1)

        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        with self._lock:
            result = self._hands.process(rgb)

        hands = [
            np.array([[p.x, p.y, p.z] for p in lm.landmark], dtype=np.float32)
            for lm in (result.multi_hand_landmarks or [])
        ]

        response = {
            "hands_detected": len(hands),
            # Landmark x,y for drawing an overlay, always in the coordinate
            # system of the frame the client sent (un-mirrored).
            "landmarks": [
                [[round(float(1.0 - x) if mirror else float(x), 4), round(float(y), 4)]
                 for x, y, _ in hand]
                for hand in hands
            ],
            "prediction": None,
            "top": [],
            "accepted": False,
            "threshold": self.threshold,
        }

        if hands:
            features = landmarks_to_features(hands, w, h).reshape(1, -1)
            raw = self.model.predict_proba(features)[0]
            probs = np.zeros(len(self.classes), dtype=np.float64)
            probs[self._columns] = raw
            order = np.argsort(probs)[::-1][:3]
            response["top"] = [
                {"label": self.classes[i], "confidence": round(float(probs[i]), 4)}
                for i in order
            ]
            best = order[0]
            response["prediction"] = {
                "label": self.classes[best],
                "confidence": round(float(probs[best]), 4),
            }
            response["accepted"] = bool(probs[best] >= self.threshold)

        response["latency_ms"] = round((time.perf_counter() - started) * 1000, 1)
        return response

    def predict_file(self, path, mirror=False):
        bgr = cv2.imread(str(path))
        if bgr is None:
            raise ValueError(f"could not read image {path}")
        return self.predict_frame(bgr, mirror=mirror)

    def info(self):
        return {
            "classes": self.classes,
            "missing_letters": self.meta.get("missing_letters", []),
            "threshold": self.threshold,
            "model_type": self.meta.get("model_type"),
            "task": self.meta.get("task"),
            "metrics": self.meta.get("metrics", {}),
            "per_class_test": self.meta.get("per_class_test", {}),
            "data": self.meta.get("data", {}),
            "trained_at": self.meta.get("trained_at"),
        }
