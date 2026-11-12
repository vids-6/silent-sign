# Silent Sign — usage tips, manual test and troubleshooting

_Carried over from the original project notes. Commands use Windows paths; on macOS/Linux use `python` inside the activated `.venv` instead of `.\.venv\Scripts\python.exe`._

## How to sign so it works

- Sit so **both hands** are inside the frame at about chest height, with your palm facing the camera as in the dataset photos.
- Use **even light** on your hands, and a plain background if possible.
- **Hold one letter still** until the progress ring fills. The letter is then added to the caption.
- To **repeat a letter** (the second L in "HELLO"), lower your hands out of view for half a second, then sign it again. Holding a sign never adds the same letter twice.
- Use **Add space** (or the `S` key) between words. The app does not guess word boundaries.
- If you sign with your **left hand as dominant**, turn on that option under *Recognition settings*. It mirrors frames before recognition.
- If letters are added too quickly or too slowly, change **Hold time** in *Recognition settings*.

Keyboard shortcuts: `P` pause/resume, `S` space, `Backspace` delete last letter, `C` copy caption, `1`–`3` pick a suggested word.

The **Letters this model knows** panel shows which letters are supported. A dashed outline marks letters that were often confused in testing. H, J and Y are not in the dataset and can never be recognized. Select any letter to see its sign.

---

## Manual webcam test (do this once on your machine)

The automated tests use a simulated camera. This checks your real one:

1. Start the server and open http://127.0.0.1:5000.
2. Select **Start camera** and allow access. Check that you see yourself mirrored and the camera pill says *Camera on*.
3. Raise one hand. Green tracking lines should appear on it, and the chip in the corner should say *1 hand tracked*.
4. Sign **V** (a strongly recognized letter) and hold it. The ring should fill and **V** should appear in the caption once.
5. Keep holding. No more V's should be added. Lower your hands, sign V again, and a second V should be added.
6. Try **Pause recognition**, **Add space**, **Delete last**, **Clear caption** (then **Undo** in the pop-up), **Copy text**, and **Read aloud**.
7. Select **Stop camera**. Your webcam light should turn off.
8. Stop the server with Ctrl+C while the camera is on. A red banner should say the server is offline. Start it again, and the app reconnects by itself.
9. Spell the start of a word, for example **G O**, and check that suggestions appear. Press `1`.
10. Type `good help` under *Show letters to the signer*, select **Show signs**, then **Play one at a time**.
11. Open **Dashboard**. Your letters, corrections and session should be there. Select **Download transcript**.
12. Select **Log out**, then open http://127.0.0.1:5000 again. You should be sent to the login page.

If a letter you sign well is never accepted, look at the confidence bar. That shows the model's real confidence for your hands, lighting and background.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `py` is not recognized | Install Python 3.12 from python.org (the `py` launcher is included). Reopen VS Code. |
| `No matching distribution found for mediapipe==0.10.21` | The venv was made with the wrong Python (usually 3.13). Delete the `.venv` folder and repeat step 3 with `py -3.12`. |
| `ImportError: DLL load failed` when starting | Install the **Microsoft Visual C++ Redistributable 2015–2022 (x64)** from Microsoft (search "vc_redist.x64.exe"), then restart the terminal. |
| `ModuleNotFoundError: No module named 'flask'` (or similar) | You started it with a different Python. Use `.\.venv\Scripts\python.exe backend\app.py` exactly. |
| Port 5000 already in use | Run `.\.venv\Scripts\python.exe backend\app.py --port 5050` and open http://127.0.0.1:5050. |
| Page says "Opened as a file" or "Wrong address" | Open http://127.0.0.1:5000 (served by `backend\app.py`), not the file or Live Server. |
| "Camera access is blocked" | Select the camera icon in the address bar, choose Allow, then **Retry camera**. Also check Windows **Settings → Privacy & security → Camera**: camera access on, and "Let desktop apps access your camera" on. |
| "The camera is busy" | Close Zoom, Teams, the Windows Camera app or any other app using the webcam. |
| Several cameras (e.g. an IR camera) | After starting, choose the right one from the camera menu beside the buttons. |
| Hands tracked but letters never added | Improve the lighting, face your palm to the camera, and keep both hands in frame. Check the confidence bar and the "Also possible" line. The letter may be one of the weak ones. |
| Letters added too eagerly or too slowly | Change **Hold time** in *Recognition settings*. |
| Server says model not loaded | `model/isl_landmark_model.joblib` or `model/model_meta.json` is missing. Retrain with the command above. |
| Forgot your password | There is no email reset because accounts are local. Create a new account, or, to remove **all** accounts and history and start fresh, stop the server and delete the `instance` folder. |
| "Too many wrong passwords" | Wait one minute, then try again. |
| History says "Not saved yet: server unreachable" | Captions keep working. The app retries automatically once the server is running again; nothing is lost while the page stays open. |
| Logged out after restarting the server | Tick **Keep me logged in** when you log in. Without it, the login lasts until you close the browser. |

---

