
"""
Silent Sign - shared hand-landmark feature extraction.

This module is imported by BOTH the training script and the live inference
backend, so the preprocessing used at training time is guaranteed to be the
same as the preprocessing used on webcam frames.

Input : up to two hands, each 21 MediaPipe landmarks (x, y, z) in MediaPipe's
        normalised image coordinates (x, y in [0, 1]).
Output: a fixed-length float32 vector of FEATURE_DIM values.

Layout of the vector
  [0:63)    hand #1 shape  (wrist-centred, scale-normalised x,y,z)
  [63:126)  hand #2 shape  (zeros if only one hand was detected)
  [126:168) hand #1 x,y in a frame shared by both hands
  [168:210) hand #2 x,y in that shared frame (zeros if absent)
  [210]     1 if exactly one hand was detected
  [211]     1 if two hands were detected
  [212]     wrist-to-wrist distance in the shared frame (two hands only)

Hands are ordered by their wrist position in the image (image-left first),
not by MediaPipe's "Left"/"Right" label, because that label flips when an
image is mirrored and is unreliable on the small dataset images.
"""

import numpy as np

FEATURE_VERSION = 1
NUM_LANDMARKS = 21
FEATURE_DIM = 2 * 63 + 2 * 42 + 3  # = 213


def _hand_shape(points):
    """(21, 3) -> 63 values, centred on the wrist and scaled to unit size."""
    centred = points - points[0]
    scale = float(np.max(np.linalg.norm(centred[:, :2], axis=1)))
    if scale <= 1e-6:
        scale = 1.0
    return (centred / scale).reshape(-1)


def landmarks_to_features(hands, image_width, image_height):
    """
    hands        : list of array-likes shaped (21, 3); extra hands are ignored.
    image_width  : pixel width of the image the landmarks came from.
    image_height : pixel height of that image.
    """
    if image_width <= 0 or image_height <= 0:
        raise ValueError("image dimensions must be positive")

    prepared = []
    longest = float(max(image_width, image_height))
    for hand in list(hands)[:2]:
        pts = np.asarray(hand, dtype=np.float32).copy()
        if pts.shape != (NUM_LANDMARKS, 3):
            raise ValueError(f"each hand must be (21, 3), got {pts.shape}")
        # MediaPipe normalises x by width and y by height; undo that so a
        # 640x480 webcam frame and a 128x128 dataset image give comparable
        # (un-squashed) hand shapes.
        pts[:, 0] *= image_width / longest
        pts[:, 1] *= image_height / longest
        prepared.append(pts)

    prepared.sort(key=lambda p: float(p[0, 0]))

    features = np.zeros(FEATURE_DIM, dtype=np.float32)
    if not prepared:
        return features

    all_xy = np.concatenate([p[:, :2] for p in prepared])
    centre = all_xy.mean(axis=0)
    spread = float(np.max(np.abs(all_xy - centre)))
    if spread <= 1e-6:
        spread = 1.0

    for k, pts in enumerate(prepared):
        features[k * 63:(k + 1) * 63] = _hand_shape(pts)
        features[126 + k * 42:126 + (k + 1) * 42] = (
            (pts[:, :2] - centre) / spread
        ).reshape(-1)

    features[210] = 1.0 if len(prepared) == 1 else 0.0
    features[211] = 1.0 if len(prepared) == 2 else 0.0
    if len(prepared) == 2:
        delta = prepared[1][0, :2] - prepared[0][0, :2]
        features[212] = float(np.linalg.norm(delta)) / spread

    return features
