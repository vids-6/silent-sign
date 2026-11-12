"""
Silent Sign - train the ISL static-alphabet classifier used by the live app.

Pipeline
  1. Audit ISL_Dataset/ (class folders, unreadable files, exact duplicates,
     duplicates carrying conflicting labels, class balance).
  2. Run MediaPipe Hands on every image and cache the hand landmarks.
  3. Convert landmarks to features with backend/features.py (the exact same
     code the live backend uses).
  4. Group near-duplicate images (many dataset images are the same cut-out
     hand pasted on different backgrounds) so that copies of one photo never
     sit in both the training and the test split.
  5. Hold out a grouped, stratified TEST split (about 20%).
  6. Choose the confidence threshold with grouped cross-validation on the
     TRAINING split only.
  7. Train an ExtraTrees classifier on the training split with landmark-space
     augmentation, then evaluate it once on the held-out test split.
  8. Save model/isl_landmark_model.joblib + model/model_meta.json and reports.

The shipped model is exactly the model whose test metrics are reported.

Run from the project root (the folder containing index.html):
    python training/train_landmark_model.py
"""

import hashlib
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import joblib
import numpy as np
import sklearn
from sklearn.ensemble import ExtraTreesClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import StratifiedGroupKFold

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from features import FEATURE_DIM, FEATURE_VERSION, landmarks_to_features  # noqa: E402

DATASET_DIR = PROJECT_ROOT / "ISL_Dataset"
MODEL_DIR = PROJECT_ROOT / "model"
OUTPUT_DIR = PROJECT_ROOT / "training" / "output"
CACHE_PATH = OUTPUT_DIR / "landmark_cache.json"

SEED = 42
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
# Dataset images are small (128x128) composites, so detection is run with a
# lower confidence than the live webcam path uses.
TRAIN_DETECTION_CONFIDENCE = 0.3
AUGMENT_COPIES = 10
NEAR_DUPLICATE_DISTANCE = 0.35
TARGET_ACCEPTED_ACCURACY = 0.90


def header(title):
    print("\n" + "=" * 72 + f"\n{title}\n" + "=" * 72)


def md5(path):
    return hashlib.md5(path.read_bytes()).hexdigest()


# ----------------------------------------------------------------------------
# 1. Dataset audit
# ----------------------------------------------------------------------------
def audit_dataset():
    header("1. DATASET AUDIT")
    if not DATASET_DIR.is_dir():
        raise SystemExit(f"Dataset folder not found: {DATASET_DIR}")

    records, ignored, unreadable = [], [], []
    for folder in sorted(DATASET_DIR.iterdir(), key=lambda p: p.name.upper()):
        if not folder.is_dir():
            continue
        files = sorted(
            f for f in folder.iterdir()
            if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS
        )
        if not files:
            ignored.append(folder.name)
            continue
        for f in files:
            img = cv2.imread(str(f))
            if img is None:
                unreadable.append(str(f.relative_to(PROJECT_ROOT)))
                continue
            records.append({
                "path": f,
                "cls": folder.name.upper(),
                "md5": md5(f),
                "h": int(img.shape[0]),
                "w": int(img.shape[1]),
            })

    labels_by_hash = defaultdict(set)
    for r in records:
        labels_by_hash[r["md5"]].add(r["cls"])
    conflicting = {h for h, labels in labels_by_hash.items() if len(labels) > 1}
    same_label_dupes = sum(
        1 for h, labels in labels_by_hash.items()
        if len(labels) == 1 and sum(r["md5"] == h for r in records) > 1
    )

    classes = sorted({r["cls"] for r in records})
    counts = Counter(r["cls"] for r in records)
    print(f"Ignored non-class folders : {ignored or 'none'}")
    print(f"Unreadable images         : {len(unreadable)}")
    print(f"Images read               : {len(records)}")
    print(f"Classes ({len(classes)})              : {' '.join(classes)}")
    print(f"Missing A-Z letters       : "
          f"{' '.join(c for c in map(chr, range(65, 91)) if c not in classes)}")
    print(f"Exact-duplicate sets, same label       : {same_label_dupes}")
    print(f"Exact-duplicate sets, CONFLICTING label: {len(conflicting)}")
    for h in sorted(conflicting):
        files = [str(r["path"].relative_to(DATASET_DIR)) for r in records if r["md5"] == h]
        print("   ", " == ".join(files))
    print(f"Images per class: min {min(counts.values())}, "
          f"max {max(counts.values())}")

    # Images whose identical copy carries a different label cannot be
    # trusted for either label, so they are excluded.
    kept = [r for r in records if r["md5"] not in conflicting]
    print(f"Excluded (conflicting labels): {len(records) - len(kept)} images")

    audit = {
        "ignored_folders": ignored,
        "unreadable": unreadable,
        "images_read": len(records),
        "classes": classes,
        "per_class": dict(counts),
        "conflicting_duplicate_files": sorted(
            str(r["path"].relative_to(DATASET_DIR)) for r in records if r["md5"] in conflicting
        ),
        "same_label_duplicate_sets": same_label_dupes,
    }
    return kept, classes, audit


# ----------------------------------------------------------------------------
# 2. Landmark extraction (cached)
# ----------------------------------------------------------------------------
def extract_landmarks(records):
    header("2. HAND LANDMARK EXTRACTION (MediaPipe Hands)")
    import mediapipe as mp

    cache = {}
    if CACHE_PATH.exists():
        cached = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        if cached.get("detection_confidence") == TRAIN_DETECTION_CONFIDENCE \
                and cached.get("mediapipe") == mp.__version__:
            cache = cached["items"]

    todo = [r for r in records if r["md5"] not in cache]
    print(f"Cached: {len(records) - len(todo)}   To process: {len(todo)}")
    if todo:
        hands_model = mp.solutions.hands.Hands(
            static_image_mode=True,
            max_num_hands=2,
            model_complexity=1,
            min_detection_confidence=TRAIN_DETECTION_CONFIDENCE,
        )
        start = time.time()
        for i, r in enumerate(todo, 1):
            rgb = cv2.cvtColor(cv2.imread(str(r["path"])), cv2.COLOR_BGR2RGB)
            result = hands_model.process(rgb)
            cache[r["md5"]] = [
                [[p.x, p.y, p.z] for p in lm.landmark]
                for lm in (result.multi_hand_landmarks or [])
            ]
            if i % 100 == 0:
                print(f"  {i}/{len(todo)}  ({time.time() - start:.0f}s)")
        hands_model.close()
        CACHE_PATH.write_text(json.dumps({
            "detection_confidence": TRAIN_DETECTION_CONFIDENCE,
            "mediapipe": mp.__version__,
            "items": cache,
        }), encoding="utf-8")

    for r in records:
        r["hands"] = [np.asarray(h, dtype=np.float32) for h in cache[r["md5"]]]

    n_hands = Counter(len(r["hands"]) for r in records)
    print(f"Hands found -> 0: {n_hands[0]}, 1: {n_hands[1]}, 2: {n_hands[2]}")
    usable = [r for r in records if r["hands"]]
    print(f"Usable images (>=1 hand detected): {len(usable)} / {len(records)}")
    return usable, dict(n_hands)


# ----------------------------------------------------------------------------
# 3-4. Features and near-duplicate groups
# ----------------------------------------------------------------------------
def build_groups(features, labels, hashes):
    """Union-find over same-label images with near-identical hand shapes."""
    n = len(labels)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    shapes = features[:, :126]
    for i in range(n):
        dist = np.linalg.norm(shapes - shapes[i], axis=1)
        for j in np.where((dist < NEAR_DUPLICATE_DISTANCE) & (labels == labels[i]))[0]:
            parent[find(i)] = find(j)
    first_by_hash = {}
    for i, h in enumerate(hashes):
        if h in first_by_hash:
            parent[find(i)] = find(first_by_hash[h])
        else:
            first_by_hash[h] = i
    return np.array([find(i) for i in range(n)])


# ----------------------------------------------------------------------------
# Augmentation in landmark space
# ----------------------------------------------------------------------------
def augment(hands, w, h, copies, rng):
    out = []
    for _ in range(copies):
        angle = np.deg2rad(rng.uniform(-12, 12))
        scale = rng.uniform(0.85, 1.15)
        rot = np.array([[np.cos(angle), -np.sin(angle)],
                        [np.sin(angle), np.cos(angle)]], dtype=np.float32)
        centre = np.concatenate([p[:, :2] for p in hands]).mean(axis=0)
        new_hands = []
        for pts in hands:
            q = pts.copy()
            q[:, :2] = (q[:, :2] - centre) @ rot.T * scale + centre
            q[:, :2] += rng.normal(0, 0.004, size=(21, 2))
            new_hands.append(q)
        # Simulate the detector missing one hand of a two-handed sign, which
        # happens regularly on live webcam frames.
        if len(new_hands) == 2 and rng.random() < 0.25:
            new_hands = [new_hands[int(rng.integers(2))]]
        out.append(landmarks_to_features(new_hands, w, h))
    return out


def make_model():
    return ExtraTreesClassifier(
        n_estimators=500, random_state=SEED, n_jobs=-1, class_weight="balanced"
    )


def fit_with_augmentation(records, X, y, idx, rng):
    extra_x, extra_y = [], []
    for i in idx:
        r = records[i]
        for f in augment(r["hands"], r["w"], r["h"], AUGMENT_COPIES, rng):
            extra_x.append(f)
            extra_y.append(y[i])
    model = make_model()
    model.fit(np.concatenate([X[idx], np.stack(extra_x)]),
              np.concatenate([y[idx], np.asarray(extra_y)]))
    return model


def threshold_table(probs, y_true):
    rows = []
    conf = probs.max(axis=1)
    pred = probs.argmax(axis=1)
    for t in np.round(np.arange(0.10, 0.91, 0.05), 2):
        accepted = conf >= t
        cov = float(accepted.mean())
        acc = float((pred[accepted] == y_true[accepted]).mean()) if accepted.any() else float("nan")
        rows.append({"threshold": float(t), "coverage": cov, "accepted_accuracy": acc})
    return rows


def plot_confusion(cm, classes, path, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(11, 9.5))
    im = ax.imshow(cm, cmap="viridis")
    ax.set_xticks(range(len(classes)), classes)
    ax.set_yticks(range(len(classes)), classes)
    ax.set_xlabel("Predicted")
    ax.set_ylabel("Actual")
    ax.set_title(title)
    for i in range(len(classes)):
        for j in range(len(classes)):
            if cm[i, j]:
                ax.text(j, i, int(cm[i, j]), ha="center", va="center",
                        color="white" if cm[i, j] < cm.max() / 2 else "black", fontsize=8)
    fig.colorbar(im)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED)

    records, classes, audit = audit_dataset()
    usable, hand_counts = extract_landmarks(records)
    class_index = {c: i for i, c in enumerate(classes)}

    X = np.stack([landmarks_to_features(r["hands"], r["w"], r["h"]) for r in usable])
    y = np.array([class_index[r["cls"]] for r in usable])
    assert X.shape[1] == FEATURE_DIM
    groups = build_groups(X, y, [r["md5"] for r in usable])

    header("3. LEAKAGE-AWARE SPLIT")
    print(f"{len(usable)} usable images form {len(set(groups))} near-duplicate groups")
    # Some letters (C, O) consist of a few large near-duplicate groups, so a
    # grouped fold can end up with no test samples for them. Deterministic
    # rule: take the first fold whose test split contains every class. The
    # rule looks only at labels, never at model performance.
    outer = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=SEED)
    folds = list(outer.split(X, y, groups))
    train_idx, test_idx = next(
        ((a, b) for a, b in folds if len(set(y[b])) == len(classes)), folds[0]
    )
    assert not set(groups[train_idx]) & set(groups[test_idx])
    print(f"Train: {len(train_idx)}   Test (held out): {len(test_idx)}   "
          f"shared groups: 0")
    missing_in_test = [c for i, c in enumerate(classes) if i not in set(y[test_idx])]
    if missing_in_test:
        print(f"Classes with no test samples: {missing_in_test}")

    header("4. THRESHOLD SELECTION (grouped 5-fold CV on TRAIN only)")
    oof = np.zeros((len(train_idx), len(classes)))
    inner = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=SEED + 1)
    for k, (a, b) in enumerate(inner.split(X[train_idx], y[train_idx], groups[train_idx]), 1):
        m = fit_with_augmentation(usable, X, y, train_idx[a], rng)
        p = m.predict_proba(X[train_idx[b]])
        full = np.zeros((len(b), len(classes)))
        full[:, m.classes_] = p
        oof[b] = full
        print(f"  fold {k}: accuracy {accuracy_score(y[train_idx[b]], full.argmax(1)):.3f}")
    cv_acc = accuracy_score(y[train_idx], oof.argmax(1))
    cv_table = threshold_table(oof, y[train_idx])
    print(f"CV accuracy (all predictions): {cv_acc:.3f}")
    print(f"{'thresh':>7} {'coverage':>9} {'acc_of_accepted':>16}")
    for row in cv_table:
        print(f"{row['threshold']:>7.2f} {row['coverage']:>9.3f} {row['accepted_accuracy']:>16.3f}")
    candidates = [r for r in cv_table if r["accepted_accuracy"] >= TARGET_ACCEPTED_ACCURACY
                  and r["coverage"] >= 0.25]
    threshold = candidates[0]["threshold"] if candidates else 0.5
    print(f"Chosen per-frame confidence threshold: {threshold:.2f}")

    header("5. FINAL TRAINING + HELD-OUT TEST")
    model = fit_with_augmentation(usable, X, y, train_idx, rng)
    probs = np.zeros((len(test_idx), len(classes)))
    probs[:, model.classes_] = model.predict_proba(X[test_idx])
    pred = probs.argmax(1)
    y_test = y[test_idx]
    test_acc = accuracy_score(y_test, pred)
    test_table = threshold_table(probs, y_test)
    at_t = next(r for r in test_table if abs(r["threshold"] - threshold) < 1e-6)
    report = classification_report(
        y_test, pred, labels=list(range(len(classes))), target_names=classes, zero_division=0
    )
    print(report)
    per_class = classification_report(
        y_test, pred, labels=list(range(len(classes))), target_names=classes,
        zero_division=0, output_dict=True,
    )
    print(f"Test accuracy (every prediction)     : {test_acc:.3f}")
    print(f"At threshold {threshold:.2f}: coverage {at_t['coverage']:.3f}, "
          f"accuracy of accepted {at_t['accepted_accuracy']:.3f}")

    cm = confusion_matrix(y_test, pred, labels=list(range(len(classes))))
    plot_confusion(cm, classes, OUTPUT_DIR / "landmark_confusion_matrix.png",
                   f"Held-out test confusion matrix (n={len(test_idx)})")

    model_path = MODEL_DIR / "isl_landmark_model.joblib"
    joblib.dump(model, model_path, compress=3)

    import mediapipe as mp
    meta = {
        "model_file": model_path.name,
        "model_type": "ExtraTreesClassifier on MediaPipe hand-landmark features",
        "task": "static ISL alphabet (single-frame handshape) classification",
        "classes": classes,
        "missing_letters": [c for c in map(chr, range(65, 91)) if c not in classes],
        "feature_version": FEATURE_VERSION,
        "feature_dim": FEATURE_DIM,
        "confidence_threshold": threshold,
        "sklearn_version": sklearn.__version__,
        "mediapipe_version": mp.__version__,
        "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "data": {
            "images_read": audit["images_read"],
            "excluded_conflicting_labels": len(audit["conflicting_duplicate_files"]),
            "no_hand_detected": hand_counts.get(0, 0),
            "usable": len(usable),
            "near_duplicate_groups": int(len(set(groups))),
            "train": int(len(train_idx)),
            "test": int(len(test_idx)),
        },
        "metrics": {
            "cv_accuracy_train": round(float(cv_acc), 4),
            "test_accuracy": round(float(test_acc), 4),
            "test_coverage_at_threshold": round(at_t["coverage"], 4),
            "test_accuracy_at_threshold": round(at_t["accepted_accuracy"], 4),
            "note": "Measured on dataset images where MediaPipe found a hand. "
                    "Grouped split: near-duplicate composites never cross train/test. "
                    "Real webcam accuracy depends on signer, lighting and framing "
                    "and must be verified live.",
        },
        "per_class_test": {
            c: {
                "precision": round(per_class[c]["precision"], 3),
                "recall": round(per_class[c]["recall"], 3),
                "support": int(per_class[c]["support"]),
            }
            for c in classes
        },
        "cv_threshold_table": cv_table,
        "test_threshold_table": test_table,
    }
    (MODEL_DIR / "model_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (OUTPUT_DIR / "dataset_audit.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
    (OUTPUT_DIR / "landmark_report.txt").write_text(
        f"Silent Sign landmark model - held-out test report\n"
        f"Trained: {meta['trained_at']}\n\n{json.dumps(meta['data'], indent=2)}\n\n"
        f"Grouped CV accuracy on train: {cv_acc:.4f}\n"
        f"Test accuracy (all predictions): {test_acc:.4f}\n"
        f"Threshold {threshold:.2f}: coverage {at_t['coverage']:.4f}, "
        f"accepted accuracy {at_t['accepted_accuracy']:.4f}\n\n{report}\n",
        encoding="utf-8",
    )
    header("DONE")
    print(f"Model   : {model_path}")
    print(f"Metadata: {MODEL_DIR / 'model_meta.json'}")


if __name__ == "__main__":
    main()
