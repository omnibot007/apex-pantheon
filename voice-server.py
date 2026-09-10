"""voice-server.py - persistent Kokoro voice daemon. Loads once, serves fast.

Cold speak.py pays full model load per reply (~40s+). This process loads the
pipeline ONCE and serves POST /speak over localhost, so replies cost synth
time only (~2s). stdlib HTTP + kokoro/soundfile/winsound. No secrets, no
remote exposure (binds 127.0.0.1 only).

  python voice-server.py [--port 17840]      # foreground
  Start-Process python voice-server.py -WindowStyle Hidden   # background
  GET  /health -> {"ok": true, ...}
  POST /speak {"text": "...", "voice": "bm_lewis", "play": true}
"""
import json
import os
import re
import sys
import tempfile
import time
import winsound
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("FAM_VOICE_PORT", "17840"))
DEFAULT_VOICE = os.environ.get("FAM_VOICE", "bm_lewis")
T0 = time.time()
PIPE = None


def clean(text):
    text = re.sub(r"```.*?```", " code block omitted. ", text, flags=re.S)
    text = re.sub(r"https?://\S+", " link omitted. ", text)
    text = re.sub(r"[#*_`>|~]", "", text)
    text = re.sub(r"[\U00010000-\U0010ffff]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def chunks(text, limit=600):
    parts, cur = [], ""
    for sent in re.split(r"(?<=[.!?])\s+", text):
        if len(cur) + len(sent) > limit and cur:
            parts.append(cur)
            cur = ""
        cur = (cur + " " + sent).strip()
    if cur:
        parts.append(cur)
    return parts or [text]


def get_pipe():
    global PIPE
    if PIPE is None:
        from kokoro import KPipeline

        PIPE = KPipeline(lang_code="b")
    return PIPE


def speak(text, voice, play):
    import soundfile as sf

    pipe = get_pipe()
    wavs = []
    for i, part in enumerate(chunks(text)):
        for _, _, audio in pipe(part, voice=voice):
            path = os.path.join(tempfile.gettempdir(), f"fam-srv-{i}.wav")
            sf.write(path, audio, 24000)
            wavs.append(path)
            break
    if play:
        for w in wavs:
            winsound.PlaySound(w, winsound.SND_FILENAME)
    return wavs


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json({"ok": True, "voice": DEFAULT_VOICE,
                        "uptime_s": round(time.time() - T0, 1),
                        "warm": PIPE is not None})
        else:
            self._json({"ok": False, "error": "unknown path"}, 404)

    def do_POST(self):
        if self.path != "/speak":
            return self._json({"ok": False, "error": "unknown path"}, 404)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        except Exception:
            return self._json({"ok": False, "error": "bad json"}, 400)
        text = clean(str(body.get("text", "")))
        if not text:
            return self._json({"ok": False, "error": "empty text"}, 400)
        t0 = time.time()
        try:
            wavs = speak(text, str(body.get("voice", DEFAULT_VOICE)),
                         bool(body.get("play", True)))
        except Exception as e:
            return self._json({"ok": False, "error": str(e)[:200]}, 500)
        self._json({"ok": True, "ms": int((time.time() - t0) * 1000),
                    "chars": len(text), "parts": len(wavs)})


if __name__ == "__main__":
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else PORT
    print(f"voice-server on 127.0.0.1:{port} (cold load on first request)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
