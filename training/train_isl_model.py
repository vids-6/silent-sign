"""
Silent Sign — Indian Sign Language (ISL) classifier training.

Uses the existing project structure:

SE PROJ/
├── ISL_Dataset/
│   ├── A/
│   ├── B/
│   └── ...
└── training/
    └── train_isl_model.py

The script:
1. Discovers only folders that actually contain images.
2. Creates a stratified train/validation split.
3. Trains a MobileNetV2 transfer-learning classifier.
4. Fine-tunes the last part of MobileNetV2.
5. Produces a classification report and confusion matrix.
6. Exports a browser-ready TensorFlow.js model.
7. Copies the exported model to /model/isl_model_tfjs/.

IMPORTANT:
This dataset is a static alphabet/fingerspelling dataset. The resulting
model recognizes the static classes represented by the folders; it is not
a continuous sentence-level ISL video model.
"""

from pathlib import Path
import json
import shutil
import subprocess
import sys

import numpy as np

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import tensorflow as tf
from tensorflow import keras
from tensorflow.keras import layers
from tensorflow.keras.applications import MobileNetV2

from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.utils.class_weight import compute_class_weight


# ============================================================
# CONFIG
# ============================================================

SEED = 42

IMG_SIZE = 224
BATCH_SIZE = 16

HEAD_EPOCHS = 20
FINE_TUNE_EPOCHS = 20

VALIDATION_SPLIT = 0.20

# The browser will later use this threshold.
CONFIDENCE_THRESHOLD = 0.80

IMAGE_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".bmp",
    ".webp",
}


# ============================================================
# PATHS
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent

DATASET_DIR = PROJECT_ROOT / "ISL_Dataset"

TRAINING_DIR = PROJECT_ROOT / "training"

OUTPUT_DIR = TRAINING_DIR / "output"

EXPORT_DIR = TRAINING_DIR / "export"

BROWSER_MODEL_DIR = (
    PROJECT_ROOT / "model" / "isl_model_tfjs"
)

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
EXPORT_DIR.mkdir(parents=True, exist_ok=True)
BROWSER_MODEL_DIR.mkdir(parents=True, exist_ok=True)


# ============================================================
# REPRODUCIBILITY
# ============================================================

tf.keras.utils.set_random_seed(SEED)
np.random.seed(SEED)


# ============================================================
# HELPERS
# ============================================================

def clear_directory(directory: Path):
    """Delete everything inside a directory but keep the directory."""
    directory.mkdir(parents=True, exist_ok=True)

    for item in directory.iterdir():
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()


def image_files_in(folder: Path):
    """Return image files directly inside a class folder."""
    return sorted(
        [
            file
            for file in folder.iterdir()
            if file.is_file()
            and file.suffix.lower() in IMAGE_EXTENSIONS
        ]
    )


def print_header(title: str):
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)
    print()


# ============================================================
# STARTUP
# ============================================================

print_header("SILENT SIGN — REAL ISL MODEL TRAINING")

print("TensorFlow:", tf.__version__)

gpus = tf.config.list_physical_devices("GPU")

if gpus:
    print("GPU detected:")
    for gpu in gpus:
        print("  ", gpu)
else:
    print("No GPU detected. TensorFlow will use the CPU.")

print()


# ============================================================
# DATASET CHECK
# ============================================================

if not DATASET_DIR.exists():
    raise SystemExit(
        f"ERROR: Dataset folder was not found:\n{DATASET_DIR}\n\n"
        "Expected:\n"
        "SE PROJ/ISL_Dataset/A/\n"
        "SE PROJ/ISL_Dataset/B/\n"
        "..."
    )


# Only folders containing at least one supported image become classes.
# This deliberately ignores accidental folders such as "css".
class_dirs = []

for folder in DATASET_DIR.iterdir():

    if not folder.is_dir():
        continue

    files = image_files_in(folder)

    if not files:
        print(
            f"Ignoring non-class folder: {folder.name}"
        )
        continue

    class_dirs.append(folder)


class_dirs.sort(
    key=lambda folder: folder.name.upper()
)

CLASS_NAMES = [
    folder.name.upper()
    for folder in class_dirs
]

NUM_CLASSES = len(CLASS_NAMES)


if NUM_CLASSES < 2:
    raise SystemExit(
        "ERROR: Fewer than two image classes were found."
    )


# ============================================================
# DISCOVER IMAGES
# ============================================================

print_header("DATASET")

print("Dataset:", DATASET_DIR)
print()
print("Classes:")

for index, class_name in enumerate(CLASS_NAMES):
    print(f"  {index:02d} -> {class_name}")

print()
print("Number of classes:", NUM_CLASSES)

image_paths = []
labels = []

print()
print(f"{'CLASS':<10}{'IMAGES':>10}")
print("-" * 20)

for class_index, class_dir in enumerate(class_dirs):

    files = image_files_in(class_dir)

    print(
        f"{class_dir.name:<10}"
        f"{len(files):>10}"
    )

    for file in files:
        image_paths.append(str(file))
        labels.append(class_index)


image_paths = np.asarray(image_paths)
labels = np.asarray(labels, dtype=np.int32)

print("-" * 20)
print(f"{'TOTAL':<10}{len(image_paths):>10}")


if len(image_paths) < 100:
    raise SystemExit(
        "ERROR: Too few images were found."
    )


# ============================================================
# STRATIFIED SPLIT
# ============================================================

print_header("TRAIN / VALIDATION SPLIT")

train_paths, val_paths, train_labels, val_labels = train_test_split(
    image_paths,
    labels,
    test_size=VALIDATION_SPLIT,
    random_state=SEED,
    stratify=labels,
)

print("Training images:", len(train_paths))
print("Validation images:", len(val_paths))


# ============================================================
# CLASS WEIGHTS
# ============================================================

# The dataset is imbalanced (some classes have ~20 images and others
# have ~40+), so the loss gives slightly more importance to rare classes.
class_weight_values = compute_class_weight(
    class_weight="balanced",
    classes=np.arange(NUM_CLASSES),
    y=train_labels,
)

CLASS_WEIGHTS = {
    index: float(weight)
    for index, weight in enumerate(class_weight_values)
}

print()
print("Class weights:")

for index, class_name in enumerate(CLASS_NAMES):
    print(
        f"  {class_name}: "
        f"{CLASS_WEIGHTS[index]:.3f}"
    )


# ============================================================
# IMAGE PIPELINE
# ============================================================

def load_image(path, label):

    image = tf.io.read_file(path)

    image = tf.io.decode_image(
        image,
        channels=3,
        expand_animations=False,
    )

    image.set_shape([None, None, 3])

    image = tf.image.resize(
        image,
        [IMG_SIZE, IMG_SIZE],
        method="bilinear",
    )

    image = tf.cast(
        image,
        tf.float32,
    )

    return image, label


train_ds = tf.data.Dataset.from_tensor_slices(
    (train_paths, train_labels)
)

val_ds = tf.data.Dataset.from_tensor_slices(
    (val_paths, val_labels)
)


train_ds = (
    train_ds
    .shuffle(
        buffer_size=len(train_paths),
        seed=SEED,
        reshuffle_each_iteration=True,
    )
    .map(
        load_image,
        num_parallel_calls=tf.data.AUTOTUNE,
    )
    .batch(BATCH_SIZE)
    .prefetch(tf.data.AUTOTUNE)
)


val_ds = (
    val_ds
    .map(
        load_image,
        num_parallel_calls=tf.data.AUTOTUNE,
    )
    .batch(BATCH_SIZE)
    .prefetch(tf.data.AUTOTUNE)
)


# ============================================================
# AUGMENTATION
# ============================================================

# NOTE:
# We intentionally DO NOT use RandomFlip("horizontal").
# Mirroring a sign can change its meaning/configuration, so a horizontal
# flip is not a safe augmentation for a sign-language classifier.

augmentation = keras.Sequential(
    [
        layers.RandomRotation(0.08),
        layers.RandomZoom(
            height_factor=0.12,
            width_factor=0.12,
        ),
        layers.RandomTranslation(
            height_factor=0.08,
            width_factor=0.08,
        ),
        layers.RandomContrast(0.15),
    ],
    name="isl_augmentation",
)


# ============================================================
# MOBILE NET V2 MODEL
# ============================================================

print_header("BUILDING MOBILENETV2 MODEL")

base_model = MobileNetV2(
    input_shape=(IMG_SIZE, IMG_SIZE, 3),
    include_top=False,
    weights="imagenet",
)

# Stage 1: train only our ISL classifier head.
base_model.trainable = False


inputs = keras.Input(
    shape=(IMG_SIZE, IMG_SIZE, 3),
    name="image",
)

x = augmentation(inputs)

# MobileNetV2 expects input values in [-1, 1].
x = tf.keras.applications.mobilenet_v2.preprocess_input(x)

x = base_model(
    x,
    training=False,
)

x = layers.GlobalAveragePooling2D(
    name="global_average_pool",
)(x)

x = layers.Dropout(
    0.35,
    name="dropout_1",
)(x)

x = layers.Dense(
    256,
    activation="relu",
    name="classifier_features",
)(x)

x = layers.Dropout(
    0.25,
    name="dropout_2",
)(x)

outputs = layers.Dense(
    NUM_CLASSES,
    activation="softmax",
    name="isl_probabilities",
)(x)


model = keras.Model(
    inputs,
    outputs,
    name="silent_sign_isl",
)


model.compile(
    optimizer=keras.optimizers.Adam(
        learning_rate=1e-3,
    ),
    loss="sparse_categorical_crossentropy",
    metrics=["accuracy"],
)


model.summary()


# ============================================================
# CALLBACKS
# ============================================================

best_model_path = (
    OUTPUT_DIR / "best_model.keras"
)

callbacks = [
    keras.callbacks.ModelCheckpoint(
        filepath=str(best_model_path),
        monitor="val_accuracy",
        mode="max",
        save_best_only=True,
        verbose=1,
    ),

    keras.callbacks.EarlyStopping(
        monitor="val_accuracy",
        mode="max",
        patience=6,
        restore_best_weights=True,
        verbose=1,
    ),

    keras.callbacks.ReduceLROnPlateau(
        monitor="val_loss",
        factor=0.3,
        patience=3,
        min_lr=1e-7,
        verbose=1,
    ),
]


# ============================================================
# STAGE 1 — CLASSIFIER HEAD
# ============================================================

print_header("STAGE 1 — TRAINING CLASSIFIER HEAD")

history_head = model.fit(
    train_ds,
    validation_data=val_ds,
    epochs=HEAD_EPOCHS,
    callbacks=callbacks,
    class_weight=CLASS_WEIGHTS,
)


# ============================================================
# STAGE 2 — FINE TUNING
# ============================================================

print_header("STAGE 2 — FINE TUNING")

base_model.trainable = True

# Freeze the majority of MobileNetV2.
# Only the final ~30 layers are fine-tuned.
for layer in base_model.layers[:-30]:
    layer.trainable = False


model.compile(
    optimizer=keras.optimizers.Adam(
        learning_rate=1e-5,
    ),
    loss="sparse_categorical_crossentropy",
    metrics=["accuracy"],
)


history_fine = model.fit(
    train_ds,
    validation_data=val_ds,
    epochs=FINE_TUNE_EPOCHS,
    callbacks=callbacks,
    class_weight=CLASS_WEIGHTS,
)


# ============================================================
# RESTORE BEST CHECKPOINT
# ============================================================

if best_model_path.exists():
    print()
    print("Restoring best validation checkpoint...")
    model = keras.models.load_model(
        best_model_path
    )


# ============================================================
# SAVE KERAS MODEL
# ============================================================

final_keras_path = (
    OUTPUT_DIR / "isl_model.keras"
)

model.save(
    final_keras_path
)


# ============================================================
# EVALUATION
# ============================================================

print_header("FINAL VALIDATION")

val_loss, val_accuracy = model.evaluate(
    val_ds,
    verbose=1,
)

print()
print(
    f"Validation accuracy: "
    f"{val_accuracy * 100:.2f}%"
)
print(
    f"Validation loss: "
    f"{val_loss:.4f}"
)


# ============================================================
# PREDICTIONS
# ============================================================

y_true = []
y_pred = []
y_confidence = []


for images, labels_batch in val_ds:

    probabilities = model.predict(
        images,
        verbose=0,
    )

    predictions = np.argmax(
        probabilities,
        axis=1,
    )

    confidence = np.max(
        probabilities,
        axis=1,
    )

    y_true.extend(
        labels_batch.numpy()
    )

    y_pred.extend(
        predictions
    )

    y_confidence.extend(
        confidence
    )


y_true = np.asarray(y_true)
y_pred = np.asarray(y_pred)
y_confidence = np.asarray(y_confidence)


# ============================================================
# CLASSIFICATION REPORT
# ============================================================

report = classification_report(
    y_true,
    y_pred,
    labels=np.arange(NUM_CLASSES),
    target_names=CLASS_NAMES,
    zero_division=0,
)


print_header("CLASSIFICATION REPORT")

print(report)


report_path = (
    OUTPUT_DIR /
    "classification_report.txt"
)

report_path.write_text(
    report,
    encoding="utf-8",
)


# ============================================================
# CONFUSION MATRIX
# ============================================================

cm = confusion_matrix(
    y_true,
    y_pred,
    labels=np.arange(NUM_CLASSES),
)


plt.figure(
    figsize=(13, 11)
)

plt.imshow(
    cm,
    interpolation="nearest",
)

plt.title(
    "ISL Validation Confusion Matrix"
)

plt.colorbar()

ticks = np.arange(NUM_CLASSES)

plt.xticks(
    ticks,
    CLASS_NAMES,
    rotation=90,
)

plt.yticks(
    ticks,
    CLASS_NAMES,
)

plt.xlabel("Predicted")
plt.ylabel("Actual")

plt.tight_layout()

confusion_path = (
    OUTPUT_DIR /
    "confusion_matrix.png"
)

plt.savefig(
    confusion_path,
    dpi=180,
    bbox_inches="tight",
)

plt.close()


# ============================================================
# TRAINING CURVES
# ============================================================

train_accuracy = (
    history_head.history["accuracy"]
    + history_fine.history["accuracy"]
)

val_accuracy_history = (
    history_head.history["val_accuracy"]
    + history_fine.history["val_accuracy"]
)

train_loss = (
    history_head.history["loss"]
    + history_fine.history["loss"]
)

val_loss_history = (
    history_head.history["val_loss"]
    + history_fine.history["val_loss"]
)

epochs = np.arange(
    1,
    len(train_accuracy) + 1,
)


plt.figure(
    figsize=(10, 6)
)

plt.plot(
    epochs,
    train_accuracy,
    label="Training",
)

plt.plot(
    epochs,
    val_accuracy_history,
    label="Validation",
)

plt.xlabel("Epoch")
plt.ylabel("Accuracy")
plt.title("ISL Model Accuracy")
plt.legend()
plt.grid(alpha=0.2)
plt.tight_layout()

plt.savefig(
    OUTPUT_DIR / "accuracy_curve.png",
    dpi=180,
)

plt.close()


plt.figure(
    figsize=(10, 6)
)

plt.plot(
    epochs,
    train_loss,
    label="Training",
)

plt.plot(
    epochs,
    val_loss_history,
    label="Validation",
)

plt.xlabel("Epoch")
plt.ylabel("Loss")
plt.title("ISL Model Loss")
plt.legend()
plt.grid(alpha=0.2)
plt.tight_layout()

plt.savefig(
    OUTPUT_DIR / "loss_curve.png",
    dpi=180,
)

plt.close()


# ============================================================
# SAVE METADATA
# ============================================================

metadata = {
    "classes": CLASS_NAMES,
    "num_classes": NUM_CLASSES,
    "image_size": [IMG_SIZE, IMG_SIZE],
    "confidence_threshold": CONFIDENCE_THRESHOLD,
    "validation_accuracy": float(val_accuracy),
    "dataset_images": int(len(image_paths)),
    "training_images": int(len(train_paths)),
    "validation_images": int(len(val_paths)),
}


metadata_path = (
    OUTPUT_DIR /
    "class_names.json"
)

metadata_path.write_text(
    json.dumps(
        metadata,
        indent=4,
    ),
    encoding="utf-8",
)


# ============================================================
# TENSORFLOW.JS EXPORT
# ============================================================

print_header("EXPORTING TENSORFLOW.JS MODEL")

clear_directory(EXPORT_DIR)
clear_directory(BROWSER_MODEL_DIR)


# The deployed model needs the exact preprocessing expected by
# MobileNetV2, but NOT training-time augmentation.
#
# The trained base_model weights are reused.
deployment_input = keras.Input(
    shape=(IMG_SIZE, IMG_SIZE, 3),
    name="image",
)

deployment_x = (
    tf.keras.applications.mobilenet_v2.preprocess_input(
        deployment_input
    )
)

deployment_x = base_model(
    deployment_x,
    training=False,
)

deployment_x = layers.GlobalAveragePooling2D()(
    deployment_x
)

deployment_x = layers.Dropout(0.35)(
    deployment_x
)

deployment_x = layers.Dense(
    256,
    activation="relu",
)(
    deployment_x
)

deployment_x = layers.Dropout(0.25)(
    deployment_x
)

deployment_output = layers.Dense(
    NUM_CLASSES,
    activation="softmax",
    name="isl_probabilities",
)(
    deployment_x
)

deployment_model = keras.Model(
    deployment_input,
    deployment_output,
    name="silent_sign_isl_deployment",
)


# Transfer the classifier-head weights from the trained model.
# The base model is already shared, so its weights are present.
trained_dense_layers = [
    layer
    for layer in model.layers
    if isinstance(
        layer,
        layers.Dense,
    )
]

deployment_dense_layers = [
    layer
    for layer in deployment_model.layers
    if isinstance(
        layer,
        layers.Dense,
    )
]

for source, target in zip(
    trained_dense_layers,
    deployment_dense_layers,
):
    target.set_weights(
        source.get_weights()
    )


deployment_model.compile(
    optimizer="adam",
    loss="sparse_categorical_crossentropy",
    metrics=["accuracy"],
)


# Save a SavedModel first. This is the most reliable route for modern
# TensorFlow/Keras versions when producing TensorFlow.js artifacts.
saved_model_dir = (
    EXPORT_DIR / "saved_model"
)

if saved_model_dir.exists():
    shutil.rmtree(saved_model_dir)

saved_model_dir.mkdir(
    parents=True,
    exist_ok=True,
)

try:

    # Keras 3 / modern TensorFlow.
    deployment_model.export(
        str(saved_model_dir)
    )

except AttributeError:

    # Older TensorFlow/Keras fallback.
    tf.saved_model.save(
        deployment_model,
        str(saved_model_dir)
    )


# Convert SavedModel -> TensorFlow.js.
tfjs_output_dir = (
    EXPORT_DIR / "isl_model_tfjs"
)

tfjs_output_dir.mkdir(
    parents=True,
    exist_ok=True,
)


converter_command = [
    sys.executable,
    "-m",
    "tensorflowjs.converters.converter",
    "--input_format=tf_saved_model",
    "--output_format=tfjs_graph_model",
    "--saved_model_tags=serve",
    "--signature_name=serving_default",
    str(saved_model_dir),
    str(tfjs_output_dir),
]


print(
    "Running TensorFlow.js converter..."
)

result = subprocess.run(
    converter_command,
    capture_output=True,
    text=True,
)


if result.returncode != 0:

    print(result.stdout)
    print(result.stderr)

    raise RuntimeError(
        "TensorFlow.js conversion failed. "
        "The training model itself completed successfully."
    )


# Copy metadata beside model.json.
(
    tfjs_output_dir / "class_names.json"
).write_text(
    json.dumps(
        metadata,
        indent=4,
    ),
    encoding="utf-8",
)


# ============================================================
# COPY DEPLOYMENT MODEL TO /model
# ============================================================

for item in tfjs_output_dir.iterdir():

    destination = (
        BROWSER_MODEL_DIR / item.name
    )

    if item.is_file():
        shutil.copy2(
            item,
            destination,
        )

    elif item.is_dir():
        shutil.copytree(
            item,
            destination,
        )


# ============================================================
# TRAINING REPORT
# ============================================================

training_report = f"""
SILENT SIGN — ISL TRAINING REPORT
=================================

Dataset:
{DATASET_DIR}

Classes:
{", ".join(CLASS_NAMES)}

Number of classes:
{NUM_CLASSES}

Total images:
{len(image_paths)}

Training images:
{len(train_paths)}

Validation images:
{len(val_paths)}

Image size:
{IMG_SIZE} x {IMG_SIZE}

Model:
MobileNetV2 transfer learning + fine tuning

Validation accuracy:
{val_accuracy * 100:.2f}%

Confidence threshold for browser:
{CONFIDENCE_THRESHOLD}

IMPORTANT:
This model recognizes the static classes represented by the supplied
ISL alphabet image dataset. It is not a continuous sentence-level
video recognition model.
"""

(
    OUTPUT_DIR / "training_report.txt"
).write_text(
    training_report,
    encoding="utf-8",
)


# ============================================================
# FINAL OUTPUT
# ============================================================

print_header("TRAINING COMPLETE")

print(
    f"Classes:             {NUM_CLASSES}"
)

print(
    f"Images:              {len(image_paths)}"
)

print(
    f"Training images:     {len(train_paths)}"
)

print(
    f"Validation images:   {len(val_paths)}"
)

print(
    f"Validation accuracy: "
    f"{val_accuracy * 100:.2f}%"
)

print()

print(
    "Keras model:"
)

print(
    final_keras_path
)

print()

print(
    "TensorFlow.js model:"
)

print(
    BROWSER_MODEL_DIR
)

print()

print(
    "Next step:"
)

print(
    "Connect /model/isl_model_tfjs/model.json "
    "to the webcam inference pipeline."
)

print()
