# Silent Sign — Indian Sign Language Fingerspelling Recognition

Silent Sign is an academic team project that uses computer vision and machine learning to recognize **23 static Indian Sign Language (ISL) alphabet handshapes** through a webcam and convert predictions into text captions.

The application runs locally and includes a simple interface for communication between signers and people who do not know ISL. It is a fingerspelling prototype, **not a complete sign-language translator**.

## Features

- Webcam-based recognition using MediaPipe hand landmarks and a scikit-learn ExtraTrees classifier
- Live captions with editing, copying, text download and text-to-speech
- Word suggestions and a reference-photo display for spelling replies
- Local accounts, session history and a progress dashboard
- Adjustable recognition hold time and left-handed mode

## Tech stack

**Frontend:** HTML, CSS, JavaScript  
**Backend:** Python, Flask, SQLite  
**Machine learning:** MediaPipe, scikit-learn, OpenCV, NumPy

## Run locally

Requires Python 3.11 or 3.12 and a webcam.

```bash
git clone https://github.com/vids-6/silent-sign.git
cd silent-sign
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python backend/app.py
```

Open **http://127.0.0.1:5000** in your browser, create an account and allow camera access.

On Windows, activate the virtual environment with `.venv\Scripts\activate` instead.

## Model performance and limitations

The saved model's recorded held-out test accuracy is **71.9%** on dataset images. Live webcam performance can vary with lighting, hand position and signer. The current model recognizes 23 static letters; H, J and Y, moving signs, full words and sentence grammar are not supported.

## Project context

Developed as an **academic team project** at Mukesh Patel School of Technology Management & Engineering (NMIMS).

The project is intended for local educational and prototype use, not production deployment. Dataset images and reference photos require appropriate redistribution permission from their original owners.
