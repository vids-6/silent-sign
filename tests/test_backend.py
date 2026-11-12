"""
Silent Sign backend tests. Uses the real trained model and real dataset images.

Run from the project root:
    python -m unittest discover -s tests -v
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Use a throwaway database and key so tests never touch real accounts.
_TMP = tempfile.mkdtemp(prefix="silent-sign-tests-")
os.environ.setdefault("SILENT_SIGN_DB", os.path.join(_TMP, "test.db"))
os.environ.setdefault("SILENT_SIGN_SECRET_KEY", "test-secret-key")

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from features import FEATURE_DIM, landmarks_to_features  # noqa: E402
from inference import Recognizer  # noqa: E402
import app as server  # noqa: E402

META = json.loads((ROOT / "model" / "model_meta.json").read_text(encoding="utf-8"))
DATASET = ROOT / "ISL_Dataset"


def sample_images(per_class=3):
    for cls in META["classes"]:
        files = sorted((DATASET / cls).glob("*.jpg"))
        for f in files[:: max(1, len(files) // per_class)][:per_class]:
            yield cls, f


class FeatureTests(unittest.TestCase):
    def test_no_hands_gives_zero_vector(self):
        f = landmarks_to_features([], 640, 480)
        self.assertEqual(f.shape, (FEATURE_DIM,))
        self.assertFalse(f.any())

    def test_translation_and_scale_invariance_of_hand_shape(self):
        rng = np.random.default_rng(0)
        hand = rng.uniform(0.3, 0.5, size=(21, 3)).astype(np.float32)
        moved = hand.copy()
        moved[:, :2] = (moved[:, :2] - 0.4) * 1.5 + 0.55
        moved[:, 2] *= 1.5
        a = landmarks_to_features([hand], 500, 500)
        b = landmarks_to_features([moved], 500, 500)
        np.testing.assert_allclose(a, b, atol=1e-5)

    def test_hand_order_does_not_matter(self):
        rng = np.random.default_rng(1)
        left = rng.uniform(0.1, 0.3, size=(21, 3))
        right = rng.uniform(0.6, 0.8, size=(21, 3))
        np.testing.assert_allclose(
            landmarks_to_features([left, right], 640, 480),
            landmarks_to_features([right, left], 640, 480),
        )

    def test_rejects_bad_shapes(self):
        with self.assertRaises(ValueError):
            landmarks_to_features([np.zeros((20, 3))], 100, 100)


class RecognizerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rec = Recognizer(static_images=True, detection_confidence=0.3)

    def test_model_metadata_consistent(self):
        self.assertEqual(len(self.rec.classes), len(set(self.rec.classes)))
        self.assertEqual(self.rec.model.n_features_in_, FEATURE_DIM)
        self.assertTrue(0 < self.rec.threshold < 1)

    def test_blank_frame_returns_no_prediction(self):
        out = self.rec.predict_frame(np.full((480, 640, 3), 40, np.uint8))
        self.assertEqual(out["hands_detected"], 0)
        self.assertIsNone(out["prediction"])
        self.assertFalse(out["accepted"])

    def test_dataset_images_produce_valid_predictions(self):
        detected = correct = 0
        for cls, path in sample_images():
            out = self.rec.predict_file(path)
            if out["prediction"] is None:
                continue
            detected += 1
            p = out["prediction"]
            self.assertIn(p["label"], self.rec.classes)
            self.assertTrue(0.0 <= p["confidence"] <= 1.0)
            self.assertEqual(len(out["top"]), 3)
            self.assertEqual(len(out["landmarks"]), out["hands_detected"])
            correct += p["label"] == cls
        self.assertGreater(detected, 20)
        # These images include training data, so this only checks the wiring
        # (a broken class mapping would score ~1/23), not generalisation.
        self.assertGreater(correct / detected, 0.5)

    def test_mirror_flag_keeps_overlay_in_input_coordinates(self):
        cls, path = next(sample_images())
        for _, path in sample_images():
            plain = self.rec.predict_file(path)
            if plain["hands_detected"]:
                break
        mirrored = self.rec.predict_file(path, mirror=True)
        if mirrored["hands_detected"]:
            xs_plain = sorted(p[0] for h in plain["landmarks"] for p in h)
            xs_mirror = sorted(p[0] for h in mirrored["landmarks"] for p in h)
            self.assertAlmostEqual(np.mean(xs_plain), np.mean(xs_mirror), delta=0.08)


HDR = {"X-Silent-Sign": "1"}


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.load_recognizer()
        cls.client = server.app.test_client()
        r = cls.client.post("/api/auth/signup", headers=HDR,
                            json={"username": "api_tester", "password": "correct-horse-1"})
        if r.status_code == 409:
            cls.client.post("/api/auth/login", headers=HDR,
                            json={"username": "api_tester", "password": "correct-horse-1"})

    def jpeg(self, path):
        ok, buf = cv2.imencode(".jpg", cv2.imread(str(path)))
        self.assertTrue(ok)
        return buf.tobytes()

    def test_health(self):
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertTrue(body["model_loaded"])
        self.assertEqual(body["classes"], META["classes"])
        self.assertIn("test_accuracy", body["metrics"])

    def test_frontend_files_served(self):
        for url in ("/", "/dashboard", "/css/style.css", "/js/app.js", "/js/words.js",
                    "/assets/letters/A.jpg"):
            r = self.client.get(url)
            self.assertEqual(r.status_code, 200, url)
            r.close()

    def test_predict_real_image(self):
        r = self.client.post("/api/predict", data=self.jpeg(DATASET / "V" / "V (1).jpg"),
                             content_type="image/jpeg", headers=HDR)
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        for key in ("hands_detected", "landmarks", "prediction", "top", "accepted",
                    "threshold", "latency_ms"):
            self.assertIn(key, body)
        if body["prediction"]:
            self.assertIn(body["prediction"]["label"], META["classes"])

    def test_predict_rejects_garbage(self):
        r = self.client.post("/api/predict", data=b"not an image", content_type="image/jpeg", headers=HDR)
        self.assertEqual(r.status_code, 400)
        self.assertFalse(r.get_json()["ok"])

    def test_predict_rejects_empty(self):
        r = self.client.post("/api/predict", data=b"", content_type="image/jpeg", headers=HDR)
        self.assertEqual(r.status_code, 400)

    def test_predict_rejects_wrong_type(self):
        r = self.client.post("/api/predict", json={"x": 1}, headers=HDR)
        self.assertEqual(r.status_code, 415)

    def test_predict_rejects_oversized(self):
        r = self.client.post("/api/predict", data=b"\xff" * (4 * 1024 * 1024),
                             content_type="image/jpeg", headers=HDR)
        self.assertEqual(r.status_code, 413)

    def test_reset(self):
        self.assertEqual(self.client.post("/api/reset", headers=HDR).status_code, 200)

    def test_predict_requires_login(self):
        anon = server.app.test_client()
        r = anon.post("/api/predict", data=self.jpeg(DATASET / "V" / "V (1).jpg"),
                      content_type="image/jpeg", headers=HDR)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(anon.get("/").status_code, 302)

    def test_predict_requires_csrf_header(self):
        r = self.client.post("/api/predict", data=self.jpeg(DATASET / "V" / "V (1).jpg"),
                             content_type="image/jpeg")
        self.assertEqual(r.status_code, 403)

    def test_dataset_and_model_not_served(self):
        self.assertEqual(self.client.get("/model/model_meta.json").status_code, 404)
        self.assertEqual(self.client.get("/ISL_Dataset/A/A%20(1).jpg").status_code, 404)


if __name__ == "__main__":
    unittest.main()
