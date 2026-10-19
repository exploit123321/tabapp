# FramePad

A pen-first sketching app for Android tablets (built and tested for the Lenovo Idea Tab Pro + Lenovo Tab Pen Plus, in Chrome).
It's a Progressive Web App: plain HTML/JS with no build step. You install it from Chrome and it runs full screen and offline.

## Modes
- **Big board**: an infinite dotted canvas, like a whiteboard.
- **Frames 16:9 / 9:16**: storyboard mode. Draw a frame, press **▶** to go to the next one (on the last frame ▶ adds a new frame), and **◀** to go back.
  You can also insert, duplicate, reorder and delete frames, use onion skin (shows the previous frame faintly) and a thumbnail strip, and switch between 16:9 and 9:16.

## Pen & touch
| Input | Action |
|---|---|
| Pen | Draw (pressure sensitive) |
| Pen side button / eraser end | Erase |
| One finger | Pan |
| Two fingers | Pan + pinch zoom |
| Two-finger tap / three-finger tap | Undo / redo |

Touches are ignored while the pen is drawing or hovering (palm rejection). Before a pen is detected, a finger draws. Once the pen is seen, fingers only navigate (you can change this in ⋯ Settings).

## Keyboard
| Key | Action |
|---|---|
| ← / → | Previous / next frame (→ on the last frame adds one) |
| 1–6 | Colours |
| N | New frame after the current one |
| Delete / Backspace | Delete current frame |
| P / H / E | Pen / highlighter / eraser |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| V | Voice commands on / off |

## Voice commands
Tap the 🎤 button in the top bar (or press V), allow the microphone, then just talk. It uses Chrome's speech recognition, which needs internet and English phrases:
- "colour 1" … "colour 6", or "black / red / blue / green / orange / white"
- "undo", "undo 3 times", "redo"
- "next", "back", "new frame", "delete frame", "duplicate", "frame 5", "first frame", "last frame"
- "pen", "highlighter", "eraser", "size 1" … "size 4", "bigger", "smaller"
- "onion on / off", "show / hide previews", "clear frame", "export", "stop listening"
- Chain commands with "and", e.g. "red and next frame".

The frame preview strip at the bottom is open by default and updates after every stroke. Minimize it with ⌄ and bring it back with **▴ Previews** in the frame bar.
**Onion skin** shows the previous frame faintly under the current one, so you can line up the next drawing.

## Export
- **AI pack (.zip)**:
  - `sheets/`: contact sheets with N frames each (default 4), kept at ≤1568 px on the long edge and about 1.15 MP, so vision models don't downscale them.
  - `frames/`: every frame at full resolution (1920×1080 or 1080×1920), with "N / total" burned into a header band.
  - The strip PNG.
  - `SEQUENCE.md` and `sequence.json`, which spell out the order.
- **Share sheets…**: sends the sheets straight to an app (Claude, ChatGPT…) through the Android share sheet.
- **Strip (.png)**: every frame in one numbered image with arrows between frames. If it's too big for a single image, it's split into balanced, consecutive parts named like `…_part1of2_frames01-15.png`.
- Current frame PNG, board PNG, and a project backup (.json) that you can import again.

Drawings are saved automatically in the browser (IndexedDB).

## Install on the tablet
1. In the repo settings, go to **Pages → Source** and choose **GitHub Actions**. Then merge to `main`, or run the "Deploy FramePad to GitHub Pages" workflow.
2. On the tablet, open `https://exploit123321.github.io/tabapp/` in Chrome, then go to **⋮ → Add to home screen / Install app**.

## Run locally
```
npx http-server app -p 8080
```
