# Training the Silent Sign letter model

The live app uses the model produced by **`train_landmark_model.py`**. Run it from the project root:

```powershell
.\.venv\Scripts\python.exe training\train_landmark_model.py
```

It takes about a minute on a laptop CPU and needs no GPU, no TensorFlow and no internet.

## What the script does

1. **Audits `ISL_Dataset/`.** It lists class folders, ignores folders with no images, reports unreadable files and exact duplicates, and excludes duplicates filed under different letters. The current dataset has 8 identical images in both `O/` and `Q/`.
2. **Extracts hand landmarks** with MediaPipe Hands (up to 2 hands per image) and caches them in `output/landmark_cache.json`. Delete that file to force re-extraction.
3. **Builds features** with `backend/features.py`. The live server uses the same file.
4. **Groups near-duplicates.** Same-letter images with almost identical hand shapes (the same cut-out hand on different backgrounds) are grouped so that a photo and its copies never end up in both training and testing.
5. **Holds out a grouped test split** (about 20%). The deterministic rule is the first of five grouped folds that contains every letter.
6. **Chooses the confidence threshold** with grouped 5-fold cross-validation on the training split only. The threshold is the lowest one where at least 90% of accepted predictions are correct.
7. **Trains** an ExtraTrees classifier with landmark-space augmentation. The augmentation adds small rotation, scale and jitter, and sometimes drops one hand of a two-handed sign to imitate webcam detection misses. The script then evaluates the model once on the test split.

The shipped model is exactly the model whose test metrics are reported. It is not retrained on the test data afterwards.

## Outputs

| File | Content |
|---|---|
| `model/isl_landmark_model.joblib` | the classifier loaded by `backend/inference.py` |
| `model/model_meta.json` | classes, threshold, feature version, all metrics, per-letter test results |
| `training/output/landmark_report.txt` | per-letter precision / recall on the held-out test set |
| `training/output/landmark_confusion_matrix.png` | test confusion matrix |
| `training/output/dataset_audit.json` | dataset audit results |

Results are reproducible: running it twice gives identical metrics.

## Adding data

Put images into `ISL_Dataset/<LETTER>/` (a new folder adds a new class) and rerun the script. Add images from **new signers** rather than more copies of existing photos, because signer variety is what the current data lacks most. Images where MediaPipe finds no hand are skipped automatically; the script prints how many.

## `train_isl_model.py` (previous approach, not used by the app)

This is the earlier MobileNetV2 image classifier. Its saved model (`output/isl_model.keras`) scored 42.6% validation accuracy against 88.6% on its training images, so it was replaced. It also needs TensorFlow, and its TensorFlow.js export step depends on the `tensorflowjs` converter, which failed to install on Windows / Python 3.13. It is kept for reference and is not needed to run Silent Sign.
