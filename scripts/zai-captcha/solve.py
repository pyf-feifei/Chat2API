#!/usr/bin/env python3
"""Solve Aliyun captcha for Z.ai accounts and update captcha_verify_param."""
from __future__ import annotations
import argparse, base64, io, json, os, random, sys, time
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from patchright.sync_api import sync_playwright

ZAI_URL = "https://chat.z.ai"
CHROME_PATH = os.environ.get("CHROME_PATH", "")
if not CHROME_PATH:
    for candidate in [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]:
        if os.path.isfile(candidate):
            CHROME_PATH = candidate
            break
    else:
        CHROME_PATH = "chromium"
ARTIFACT_DIR = Path(os.environ.get("ZAI_CAPTCHA_ARTIFACT_DIR", r"C:\my\Chat2API\scripts\zai-captcha"))

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--token", default="", help="Z.ai JWT token (only needed for --mode captcha)")
    p.add_argument("--account-id", help="Account ID for management API update")
    p.add_argument("--management-url", default="http://127.0.0.1:8080")
    p.add_argument("--management-secret", default="admin123")
    p.add_argument("--headless", action="store_true")
    p.add_argument("--wait-seconds", type=int, default=45)
    p.add_argument("--mode", choices=["captcha", "signin"], default="captcha",
                  help="captcha: harvest captcha_verify_param from a chat session; "
                       "signin: drive the email/password login form to mint a fresh JWT")
    p.add_argument("--email", help="Login email for --mode signin")
    p.add_argument("--password", help="Login password for --mode signin (sent plaintext, matching the web client)")
    p.add_argument("--signin-method", choices=["login-form", "chat-captcha"], default="login-form",
                   help="login-form: solve the OAuth login page slider then read the session JWT; "
                        "chat-captcha: harvest captcha_verify_param from a chat session then POST "
                        "/auths/signin in the same session (needs a working token to trigger the captcha)")
    p.add_argument("--allow-human", action="store_true",
                   help="If the automated slider solve fails, leave the browser open so a human can drag it")
    p.add_argument("--human-timeout", type=int, default=180,
                   help="Seconds to wait for a human to complete the captcha (default 180)")
    return p.parse_args()

def decode_data_image(source: str) -> bytes:
    if not source.startswith("data:") or "," not in source:
        raise RuntimeError("Not a data URL")
    header, payload = source.split(",", 1)
    if ";base64" not in header:
        raise RuntimeError("Not base64")
    return base64.b64decode(payload)

def image_bytes_from_locator(page, locator) -> bytes:
    result = locator.evaluate("""async image => {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const src = image.currentSrc || image.src || '';
        const errors = [];
        const encode = drawable => {
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const context = canvas.getContext('2d', {willReadFrequently: true});
            if (!context) throw new Error('no canvas');
            context.drawImage(drawable, 0, 0, width, height);
            return canvas.toDataURL('image/png');
        };
        try { return {dataUrl: encode(image), src, width, height, errors}; }
        catch (error) { errors.push('canvas: ' + String(error)); }
        for (const options of [{credentials: 'include', mode: 'cors'}, undefined]) {
            try {
                const response = options ? await fetch(src, options) : await fetch(src);
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const bitmap = await createImageBitmap(await response.blob());
                return {dataUrl: encode(bitmap), src, width, height, errors};
            } catch (error) { errors.push('fetch: ' + String(error)); }
        }
        return {dataUrl: null, src, width, height, errors};
    }""")
    if result.get("dataUrl"):
        return decode_data_image(result["dataUrl"])
    src = result.get("src", "")
    if src.startswith("http"):
        try:
            resp = page.context.request.get(src)
            if resp.ok:
                return resp.body()
        except Exception:
            pass
    raise RuntimeError("Cannot get image (" + "; ".join(result.get("errors") or []) + ")")

def read_puzzle_left(page):
    try:
        box = page.locator("#aliyunCaptcha-puzzle").bounding_box()
        return float(box["x"]) if box else None
    except Exception:
        return None

def _template_match_target(bg_rgb: np.ndarray, pz_rgba: np.ndarray):
    """Locate the hole by sliding the puzzle piece's own shape across the
    background and scoring where its content best continues the picture.

    Z.ai inpaints the hole, so there is no dark notch to find - but the piece
    was cut from the SAME picture, so at the cut location the piece's interior
    pixels line up with the surrounding photo far better than anywhere else.
    We correlate the piece's edge/interior against every x position and take
    the argmax. Returns (target_x_in_bg_pixels, match_score, used) where
    `used` is False when cv2 is unavailable so the caller can fall back."""
    try:
        import cv2
    except Exception:
        return None, 0.0, False

    mask = pz_rgba[:, :, 3] > 24
    if mask.sum() < 100:
        return None, 0.0, False

    alpha_y, alpha_x = np.where(mask)
    y0, y1 = int(alpha_y.min()), int(alpha_y.max()) + 1
    x0, x1 = int(alpha_x.min()), int(alpha_x.max()) + 1

    # Crop the piece to its own bounding box so the template is tight.
    piece = pz_rgba[y0:y1, x0:x1, :3].astype(np.uint8)
    piece_mask = mask[y0:y1, x0:x1].astype(np.uint8) * 255

    if piece.shape[0] < 10 or piece.shape[1] < 10:
        return None, 0.0, False

    bg_u8 = np.clip(bg_rgb, 0, 255).astype(np.uint8)

    # TM_CCORR_NORMED with a mask: correlate piece pixels (only inside the
    # shape) against every position. The cut point lights up because the
    # piece's content continues the photo there.
    try:
        res = cv2.matchTemplate(bg_u8, piece, cv2.TM_CCORR_NORMED, mask=piece_mask)
    except Exception:
        # Some OpenCV builds reject mask+CCORR; fall back to SQDIFF on the
        # bounding rect (still far better than 'find the flattest strip').
        try:
            res = cv2.matchTemplate(bg_u8, piece, cv2.TM_SQDIFF_NORMED)
            _, min_val, _, min_loc = cv2.minMaxLoc(res)
            return float(min_loc[0]), float(1.0 - min_val), True
        except Exception:
            return None, 0.0, False

    _, max_val, _, max_loc = cv2.minMaxLoc(res)
    # max_loc is the top-left of the best match window = the hole's left edge.
    return float(max_loc[0]), float(max_val), True


def captcha_target_geometry(page) -> dict:
    bg_loc = page.locator("#aliyunCaptcha-img")
    pz_loc = page.locator("#aliyunCaptcha-puzzle")
    bg_bytes = image_bytes_from_locator(page, bg_loc)
    pz_bytes = image_bytes_from_locator(page, pz_loc)
    bg = np.asarray(Image.open(io.BytesIO(bg_bytes)).convert("RGB"), dtype=np.float32)
    pz = np.asarray(Image.open(io.BytesIO(pz_bytes)).convert("RGBA"), dtype=np.uint8)
    mask = pz[:, :, 3] > 24
    if mask.sum() < 100:
        raise RuntimeError("Puzzle alpha mask empty")
    alpha_y, alpha_x = np.where(mask)
    piece_left = int(alpha_x.min())
    gray = 0.299 * bg[:,:,0] + 0.587 * bg[:,:,1] + 0.114 * bg[:,:,2]
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[1:-1,1:-1] = (-gray[:-2,:-2]+gray[:-2,2:]-2*gray[1:-1,:-2]+2*gray[1:-1,2:]-gray[2:,:-2]+gray[2:,2:])
    gy[1:-1,1:-1] = (-gray[:-2,:-2]-2*gray[:-2,1:-1]-gray[:-2,2:]+gray[2:,:-2]+2*gray[2:,1:-1]+gray[2:,2:])
    edges = np.sqrt(gx*gx + gy*gy)

    # Z.ai inpaints the hole instead of leaving a shadowed gap, so there is no
    # visible notch to line up. What inpainting does leave behind is a patch
    # that is far smoother than the photo around it: measured on a real
    # captcha, std 2.8 inside the hole against ~50 elsewhere.
    #
    # The previous matcher scored each candidate by how much *edge* energy sat
    # on the piece outline - the right idea for a captcha with a dark gap, and
    # exactly backwards for an inpainted one. It reliably picked the busiest
    # part of the picture.
    row0 = int(alpha_y.min())
    row1 = int(alpha_y.max()) + 1
    shape = mask[row0:row1, :]
    span = shape.shape[1]
    max_cx = max(1, bg.shape[1] - span)
    min_cx = piece_left + 8  # the hole is never sitting under the piece already

    # The widget draws the source picture into a square canvas, and whatever
    # margin it leaves over is perfectly flat - smoother than any real hole, so
    # it wins every time and the matcher keeps answering "the hole is at the
    # left edge". Only accept windows whose every column carries picture down
    # its whole height, not just across the piece's rows.
    full_std = gray.std(axis=0)
    content = full_std > max(2.0, 0.15 * float(np.median(full_std)))
    admissible = np.convolve(content.astype(float), np.ones(span) / span, mode="valid") >= 1.0

    def scan(accept) -> dict:
        found = {}
        for cx in range(min_cx, max_cx + 1):
            if not accept(cx):
                continue
            patch_gray = gray[row0:row1, cx:cx + span]
            vals = patch_gray[shape]
            if vals.size < 50:
                continue
            patch_edges = edges[row0:row1, cx:cx + span][shape]
            # Smoothness dominates; edge energy breaks ties between flat regions.
            found[cx] = float(vals.std()) + 0.25 * float(patch_edges.mean())
        return found

    flatness = scan(lambda cx: cx >= len(admissible) or admissible[cx])
    if not flatness:
        # The margin filter ruled out everything (it does when the picture is
        # narrower than the piece). A noisy answer still beats no answer at
        # all - the drag can be retried, a missing drag cannot.
        print("  margin filter excluded every window, scanning the whole strip")
        flatness = scan(lambda cx: True)
    if not flatness:
        raise RuntimeError("No captcha candidates")

    # Preferred detector: slide the puzzle piece's own shape across the
    # background and take the argmax of the content match. The piece was cut
    # from this same picture, so at the cut point its pixels continue the photo
    # far better than anywhere else - which beats 'find the flattest strip',
    # especially on pictures with big flat areas (cabinets, balloons).
    tm_x, tm_score, tm_used = _template_match_target(bg, pz)
    if tm_used and tm_x is not None:
        target_x = int(round(tm_x))
        confidence = float(np.clip(tm_score, 0.0, 1.0))
        score = tm_score
        print(f"  template-match x={target_x} score={tm_score:.3f}")
    else:
        # Judge each candidate against the picture as a whole.
        #
        # Scoring against each candidate's immediate neighbourhood instead was tried
        # and measured worse (0/4 against 1/3 on live captchas): it lets a patch of
        # plain background win whenever that background happens to be smoother than
        # the few pixels either side of it.
        typical = float(np.median(np.array([flatness[c] for c in sorted(flatness)]))) or 1.0
        scored = [(flatness[cx] / typical, cx) for cx in flatness]
        scored.sort()
        ratio, target_x = scored[0]
        score = flatness[target_x]
        # Near 0 the winner is much flatter than everything around it; near 1 the
        # picture is uniformly smooth and the answer is a guess.
        confidence = float(np.clip(1.0 - ratio, 0.0, 1.0))
    image_box = page.locator("#aliyunCaptcha-img-box").bounding_box() or page.locator("#aliyunCaptcha-img").bounding_box()
    puzzle_box = page.locator("#aliyunCaptcha-puzzle").bounding_box()
    track_box = page.locator("#aliyunCaptcha-sliding-body").bounding_box()
    slider_box = page.locator("#aliyunCaptcha-sliding-slider").bounding_box()
    if not all([image_box, puzzle_box, track_box, slider_box]):
        raise RuntimeError("Captcha geometry incomplete")
    scale_x = image_box["width"] / max(1, bg.shape[1])
    target_left_natural = max(0, target_x - piece_left)
    target_display_x = target_left_natural * scale_x
    target_puzzle_left = image_box["x"] + target_display_x
    max_travel = max(20, track_box["width"] - slider_box["width"] - 2)
    print(f"  target_x={target_x} piece_left={piece_left} display_x={target_display_x:.1f} "
          f"max_travel={max_travel:.1f} score={score:.2f} confidence={confidence:.2f}")
    return {"target_display_x": float(target_display_x), "target_puzzle_left": float(target_puzzle_left),
            "max_travel": float(max_travel), "confidence": confidence}

def drag_slider(page, slider, target_puzzle_left, max_travel, bias=0):
    slider_box = slider.bounding_box()
    if not slider_box:
        raise RuntimeError("No slider box")
    start_x = slider_box["x"] + min(14, slider_box["width"]/2)
    start_y = slider_box["y"] + slider_box["height"]/2
    page.mouse.move(start_x, start_y, steps=5)
    page.wait_for_timeout(random.randint(90, 160))
    page.mouse.down()
    page.wait_for_timeout(random.randint(60, 120))
    initial_left = read_puzzle_left(page)
    if initial_left is None:
        raise RuntimeError("No puzzle box")
    estimated = max(12, min(max_travel, target_puzzle_left - initial_left + bias))
    estimated = min(max_travel, estimated * 1.03 + 3)
    current_x = start_x
    steps = random.randint(30, 37)
    for step in range(1, steps + 1):
        progress = step / steps
        eased = 1 - (1 - progress) ** 3
        current_x = start_x + estimated * eased + np.sin(progress * np.pi * 2) * random.uniform(0.1, 0.55)
        y = start_y + np.sin(progress * np.pi) * random.uniform(-0.8, 0.8)
        page.mouse.move(current_x, y)
        page.wait_for_timeout(random.randint(7, 18))
    for _ in range(14):
        cl = read_puzzle_left(page)
        if cl is None:
            break
        error = target_puzzle_left - cl
        if abs(error) <= 0.9:
            break
        correction = max(-6, min(6, error * 0.9))
        current_x = max(start_x, min(start_x + max_travel, current_x + correction))
        page.mouse.move(current_x, start_y + random.uniform(-0.3, 0.3), steps=2)
        page.wait_for_timeout(random.randint(16, 34))
    for _ in range(4):
        cl = read_puzzle_left(page)
        if cl is None:
            break
        error = target_puzzle_left - cl
        if abs(error) <= 0.45:
            break
        current_x = max(start_x, min(start_x + max_travel, current_x + error))
        page.mouse.move(current_x, start_y)
        page.wait_for_timeout(random.randint(18, 36))
    page.wait_for_timeout(random.randint(80, 150))
    page.mouse.up()
    return current_x - start_x

def slider_visible(page) -> bool:
    try:
        return page.locator("#aliyunCaptcha-sliding-slider").first.is_visible()
    except Exception:
        return False

def solve_slider(page, max_attempts=3) -> bool:
    for attempt in range(max_attempts):
        print(f"  Slider solve attempt {attempt+1}...")
        try:
            geo = captcha_target_geometry(page)
            slider = page.locator("#aliyunCaptcha-sliding-slider")
            drag_slider(page, slider, geo["target_puzzle_left"], geo["max_travel"])
            time.sleep(2.5)
            if not slider_visible(page):
                print("  Slider disappeared -> likely success")
                return True
            print("  Slider still visible -> likely failed, retrying")
            time.sleep(1.5)
        except Exception as e:
            print(f"  Attempt {attempt+1} error: {e}")
            time.sleep(2)
    return False

def dismiss_modals(page):
    try:
        page.keyboard.press("Escape")
        time.sleep(0.8)
    except Exception:
        pass
    for sel in ['[data-dialog-overlay]', '.fixed.inset-0.z-10000']:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=1000):
                page.keyboard.press("Escape")
                time.sleep(0.5)
                break
        except Exception:
            pass

def send_chat_message(page) -> bool:
    selectors = ["#chat-input", "textarea#chat-input", "textarea", "[contenteditable='true']"]
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            loc.click(timeout=5000)
            loc.fill("hello", timeout=3000)
            time.sleep(0.5)
            page.keyboard.press("Enter")
            print(f"  Message sent via {sel}")
            return True
        except Exception as e:
            print(f"  {sel} failed: {str(e)[:120]}")
    return False

def looks_like_jwt(token: str) -> bool:
    return token.startswith("eyJ") and token.count(".") == 2


def solve_captcha(
    token: str,
    headless: bool,
    wait_seconds: int,
    keep_session: bool = False,
    inject_token: bool = True,
):
    """Harvest captcha_verify_param. When keep_session=True returns
    (param, browser, context, page) with the live session left open so the
    caller can issue a follow-up request bound to the same fingerprint —
    required for /auths/signin, whose captcha param is session-bound."""
    captcha_result = {"value": None}
    pw = sync_playwright().start()
    launch_args = {"headless": headless, "args": ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]}
    if CHROME_PATH and os.path.isfile(CHROME_PATH):
        launch_args["executable_path"] = CHROME_PATH
    browser = pw.chromium.launch(**launch_args)
    context = browser.new_context(
        viewport={"width": 1366, "height": 900},
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    )
    page = context.new_page()

    def handle_request(route, request):
        if "chat/completions" in request.url:
            try:
                body = json.loads(request.post_data or "{}")
                cvp = body.get("captcha_verify_param")
                if cvp and not captcha_result["value"]:
                    print(f"  Intercepted captcha_verify_param ({len(cvp)} chars)")
                    captcha_result["value"] = cvp
            except Exception:
                pass
        route.abort()

    page.route("**/chat/completions**", handle_request)

    print("Loading chat.z.ai...")
    page.goto(ZAI_URL, wait_until="domcontentloaded", timeout=60000)
    time.sleep(3)

    # A revoked/garbage token makes the SPA fail to render the composer, so the
    # captcha can never be triggered. Only inject when it is actually JWT-shaped;
    # otherwise continue as a guest, whose chat input is always available.
    if inject_token and looks_like_jwt(token):
        print("Injecting token...")
        context.add_cookies([{"name": "token", "value": token, "domain": "chat.z.ai", "path": "/", "secure": True, "httpOnly": False}])
        page.evaluate("(t) => { localStorage.setItem('token', t); }", token)
        page.reload(wait_until="domcontentloaded", timeout=60000)
        time.sleep(5)
    else:
        print("No usable JWT - harvesting captcha from a guest session")

    dismiss_modals(page)

    print("Sending message to trigger captcha flow...")
    if not send_chat_message(page):
        dismiss_modals(page)
        time.sleep(1)
        if not send_chat_message(page):
            page.screenshot(path=str(ARTIFACT_DIR / "send-failed.png"))
            browser.close()
            pw.stop()
            raise RuntimeError("Could not send chat message to trigger captcha")

    deadline = time.time() + wait_seconds
    slider_solved = False
    while time.time() < deadline:
        if captcha_result["value"]:
            time.sleep(1)
            param = captcha_result["value"]
            if keep_session:
                return param, browser, context, page, pw
            browser.close()
            pw.stop()
            return param
        if slider_visible(page):
            print("Captcha slider visible, solving...")
            if solve_slider(page):
                slider_solved = True
                time.sleep(2)
                if not send_chat_message(page):
                    print("  Could not resend message after slider solve")
            else:
                page.screenshot(path=str(ARTIFACT_DIR / "slider-failed.png"))
                browser.close()
                pw.stop()
                raise RuntimeError("Slider solve failed after all attempts")
        time.sleep(0.7)

    page.screenshot(path=str(ARTIFACT_DIR / "timeout.png"))
    browser.close()
    pw.stop()
    raise RuntimeError(f"No captcha_verify_param captured within {wait_seconds}s")


def signin_in_session(page, context, email: str, password: str, captcha_param: str) -> dict:
    """POST /api/v1/auths/signin inside the harvested browser session so the
    captcha param validates against the fingerprint it was minted for.

    Mirrors the web app's own call: `credentials: 'include'` sends the session
    cookies (the risk-control fingerprint is bound to them) and X-Device-ID
    carries the _arms_uid the Aliyun SDK wrote into localStorage. Dropping
    either gets the signin rejected even when the captcha param is fresh.
    Returns {token, cookies, detail} — token empty on failure."""
    print("Posting /api/v1/auths/signin inside the captcha session...")
    result = page.evaluate(
        """async ({email, password, captcha_verify_param}) => {
            try {
                const headers = {'Content-Type': 'application/json'};
                try {
                    const devId = localStorage.getItem('_arms_uid');
                    if (devId) headers['X-Device-ID'] = devId;
                } catch (_) {}
                const resp = await fetch('/api/v1/auths/signin', {
                    method: 'POST',
                    headers,
                    credentials: 'include',
                    body: JSON.stringify({email, password, captcha_verify_param}),
                });
                const body = await resp.json().catch(() => ({}));
                return {status: resp.status, body};
            } catch (e) {
                return {status: 0, body: {detail: String(e)}};
            }
        }""",
        {"email": email, "password": password, "captcha_verify_param": captcha_param},
    )
    status = result.get("status")
    body = result.get("body") or {}
    token = body.get("token") or (body.get("data") or {}).get("token") or ""
    detail = body.get("detail") or body.get("message") or ""
    cookies = "; ".join(f"{c['name']}={c['value']}" for c in context.cookies("https://chat.z.ai"))
    print(f"  signin status={status} token_len={len(token)} detail={detail[:120]}")
    return {"status": status, "token": token, "cookies": cookies, "detail": detail}

# ---- Email/password login flow -------------------------------------------------
# The z.ai SPA only exposes email+password on the OAuth authorize page. The plain
# /auth route is phone+SMS. Signing in there mints a fresh JWT for an existing
# account, which is what "token refresh" means for z.ai (its JWTs carry no exp
# and are only ever revoked, never expired).
ZAI_OAUTH_URL = os.environ.get(
    "ZAI_OAUTH_URL",
    "https://chat.z.ai/auth?response_type=code"
    "&client_id=client_lS94_Ka2ycE9IwCNYisudg"
    "&redirect_uri=https%3A%2F%2Fz.ai%2Flogin%2Fcallback%3Fredirect%3D%2525252Fchat"
    "&state=1788023701043",
)


# ---- Vision-model assistance -------------------------------------------------
# Local pixel matching is unreliable here: Aliyun serves the background as
# `inpainted_with_mask.png`, i.e. the hole is filled in, so there is no gap to
# detect. A vision model can still locate the strip, but it is bad at absolute
# pixel distances and good at READING numbers, so we draw a labelled ruler and
# ask which tick the strip starts at. Stage 1 is coarse (20px ticks over the
# whole image), stage 2 crops around that estimate, upscales 5x and uses 10px
# ticks (=2px of the original). Any implausible answer is rejected so the
# caller can fall back instead of dragging wildly.
_VISION_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
COARSE_PROMPT = ("A ruler along the bottom has ticks labelled every 20px. A vertical strip "
                 "was cut out of the photo and filled with flat grey, leaving a full-height "
                 "grey bar. Reply with ONLY the tick label closest to the LEFT edge of that "
                 "grey bar. Nothing else.")
FINE_PROMPT = ("A ruler along the bottom has ticks labelled every 10px. A vertical strip was "
               "cut out of the photo and filled with flat grey, leaving a full-height grey "
               "bar. Reply with ONLY the tick label closest to the LEFT edge of that grey "
               "bar. Nothing else.")


def vision_enabled() -> bool:
    return bool(os.environ.get("ZAI_VISION_API_URL") and os.environ.get("ZAI_VISION_API_KEY"))


def _to_rgb(image: Image.Image) -> Image.Image:
    """Flatten any alpha channel onto white.

    Measured on the real Aliyun bitmap: the SAME 300x300 image returned
    finish_reason='length' with empty content as RGBA, but finish_reason='stop'
    with content='220' as RGB. The alpha channel makes the model spend far more
    reasoning tokens and it exhausts the budget before it ever answers.
    """
    if image.mode == "RGB":
        return image
    if image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        flat = Image.new("RGB", rgba.size, (255, 255, 255))
        flat.paste(rgba, mask=rgba.split()[-1])
        return flat
    return image.convert("RGB")


def _vision_ask(image: Image.Image, prompt: str):
    """Returns the last integer in the model's reply, or None."""
    import re
    import urllib.request

    base = os.environ.get("ZAI_VISION_API_URL", "").rstrip("/")
    model = os.environ.get("ZAI_VISION_MODEL", "inclusionai/ling-3.0-flash-vl:free")
    buf = io.BytesIO()
    _to_rgb(image).save(buf, format="PNG")
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url",
                 "image_url": {"url": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()}},
            ],
        }],
        # This model is a reasoning model: the chain of thought is billed before
        # the answer, so a small budget yields content=null (finish_reason=length).
        # 4000 was enough for RGB input but left almost no headroom (3431 used).
        "max_tokens": int(os.environ.get("ZAI_VISION_MAX_TOKENS", "8000")),
        "temperature": 0,
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {os.environ.get('ZAI_VISION_API_KEY', '')}",
            "Content-Type": "application/json",
            # Cloudflare rejects the default urllib UA with 403 / error 1010.
            "User-Agent": _VISION_UA,
        },
    )
    with urllib.request.urlopen(req, timeout=int(os.environ.get("ZAI_VISION_TIMEOUT", "180"))) as resp:
        body = json.loads(resp.read())
    choice = (body.get("choices") or [{}])[0]
    # A truncated reply means the reasoning ate the whole budget. Treat it as
    # "no answer" rather than parsing a half-written number.
    if choice.get("finish_reason") == "length":
        print("  vision: reply truncated (finish_reason=length)")
        return None
    message = choice.get("message", {})
    text = (message.get("content") or "").strip()
    nums = re.findall(r"-?\d+", text)
    return int(nums[-1]) if nums else None


def _draw_ruler(image: Image.Image, step: int) -> Image.Image:
    w, h = image.size
    d = ImageDraw.Draw(image)
    d.rectangle([0, h - 26, w, h], fill=(255, 255, 255))
    for v in range(0, w, step):
        d.line([v, h - 26, v, h - 12], fill=(0, 0, 0), width=1)
        d.text((v + 2, h - 12), str(v), fill=(0, 0, 0))
    return image


def vision_target_x(bg: Image.Image):
    """Locate the strip's left edge, in bg-image pixels. None if unusable."""
    if not vision_enabled():
        return None
    w, h = bg.size
    try:
        coarse = _vision_ask(_draw_ruler(bg.copy(), 20), COARSE_PROMPT)
        if coarse is None or not (0 <= coarse < w):
            print(f"  vision: coarse rejected ({coarse})")
            return None
        left = max(0, min(w - 1, coarse - 30))
        crop = bg.crop((left, 0, min(w, left + 60), h))
        zoom = 5
        crop = crop.resize((crop.width * zoom, crop.height * zoom), Image.LANCZOS)
        fine = _vision_ask(_draw_ruler(crop, 10), FINE_PROMPT)
        # Strict: the label must exist on the drawn ruler, else it hallucinated.
        if fine is None or not (0 <= fine <= crop.width):
            print(f"  vision: fine rejected ({fine})")
            return None
        target = left + fine / zoom
        print(f"  vision: coarse={coarse} fine={fine} -> x={target:.1f}")
        return target
    except Exception as e:
        print(f"  vision unavailable: {str(e)[:120]}")
        return None


def resolve_target(page):
    """Target x in page coordinates.

    The local smoothness matcher leads: it is deterministic, costs nothing, and
    on real captchas separates the hole from the photo by roughly 10x. Vision is
    only consulted when the image is so uniformly smooth that the local matcher
    cannot tell the hole apart from the rest.
    """
    geo = captcha_target_geometry(page)
    if geo.get("confidence", 0.0) >= 0.55:
        return geo["target_puzzle_left"], geo["max_travel"]
    print(f"  local matcher unsure (confidence={geo.get('confidence', 0):.2f}), asking vision")
    try:
        bg_bytes = image_bytes_from_locator(page, page.locator("#aliyunCaptcha-img").first)
        bg = Image.open(io.BytesIO(bg_bytes))
        vx = vision_target_x(bg)
        if vx is not None:
            box = (page.locator("#aliyunCaptcha-img-box").bounding_box()
                   or page.locator("#aliyunCaptcha-img").bounding_box())
            scale_x = box["width"] / max(1, bg.size[0])
            return box["x"] + vx * scale_x, geo["max_travel"]
    except Exception as e:
        print(f"  vision path failed, using local matcher: {str(e)[:120]}")
    return geo["target_puzzle_left"], geo["max_travel"]


def expand_captcha(page) -> bool:
    """The widget renders collapsed as a '点击开始验证' bar; the slider only
    exists after this is clicked."""
    for sel in ["#aliyunCaptcha-captcha-body", "#captcha-element",
                "#aliyunCaptcha-captcha-wrapper"]:
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible(timeout=2000):
                loc.click(timeout=4000)
                time.sleep(2.5)
                if slider_visible(page):
                    return True
        except Exception:
            continue
    return slider_visible(page)


def drag_slider_closed_loop(page, target_puzzle_left: float, max_travel: float) -> float:
    """Drag with continuous closed-loop control.

    One behaviour matters here: holding the button still for more than ~1s
    makes the widget spring the piece back to the origin, so the cursor must
    never idle mid-drag.

    The track is 1:1 with the image, so required travel is just how far the
    piece has to go - see the note below before "correcting" it with a gain.
    """
    slider = page.locator("#aliyunCaptcha-sliding-slider")
    box = slider.bounding_box()
    if not box:
        raise RuntimeError("No slider box")
    start_x = box["x"] + min(14, box["width"] / 2)
    start_y = box["y"] + box["height"] / 2

    # A hand hovers, then presses. Grabbing the handle in the same frame the
    # cursor arrives is a tell.
    page.mouse.move(start_x - random.uniform(2, 6), start_y + random.uniform(-2, 2), steps=3)
    page.wait_for_timeout(random.randint(90, 220))
    page.mouse.move(start_x, start_y, steps=6)
    page.wait_for_timeout(random.randint(120, 260))
    page.mouse.down()
    page.wait_for_timeout(random.randint(80, 180))

    base = read_puzzle_left(page)
    if base is None:
        page.mouse.up()
        raise RuntimeError("No puzzle box")

    needed = target_puzzle_left - base
    needed = max(0.0, min(max_travel, needed))
    print(f"  drag: piece {base:.1f} -> {target_puzzle_left:.1f} (travel {needed:.1f})")

    # The widget scores the trajectory, not just where the piece lands. A clean
    # easing curve with uniform steps reads as a bot even when it lands dead on.
    # A real hand is messy: irregular sampling, mid-drag hesitations, vertical
    # jitter that drifts, and a visible overshoot-and-settle at the end.
    #
    # Build the path as a list of (x_offset, dwell_ms) with variable spacing so
    # no two runs share a cadence. Velocity follows a noisy ease: slow off the
    # mark, a burst through the middle, braking into the target.
    mouse = 0.0
    # Random waypoint count + jittered per-step progress instead of s/steps.
    n_steps = max(18, min(50, int(needed / random.uniform(3.2, 5.5)) + random.randint(10, 22)))
    # Pick 1-2 random points where the hand pauses like it's re-aiming.
    hesitations = set(random.sample(range(3, max(4, n_steps - 3)), k=random.choice([1, 1, 2])))
    y_drift = 0.0
    for s in range(1, n_steps + 1):
        t = s / n_steps
        # Noisy ease-in-out: base cubic-ish profile + per-step noise so the
        # velocity isn't a textbook curve.
        eased = 3 * t * t - 2 * t * t * t  # smoothstep
        noise = random.uniform(-0.018, 0.018) * needed
        target_pos = needed * eased + noise
        step_dx = target_pos - mouse
        mouse = target_pos

        # Hand tremor: a slowly wandering y offset plus per-step jitter.
        y_drift += random.uniform(-0.9, 0.9)
        y_drift = max(-3.5, min(3.5, y_drift))
        page.mouse.move(start_x + mouse, start_y + y_drift + random.uniform(-0.7, 0.7))

        # Mostly quick, occasionally the hand stalls like it's adjusting grip.
        if s in hesitations:
            page.wait_for_timeout(random.randint(120, 340))
        else:
            # Braking near the end: later steps dwell longer.
            base_delay = 6 + int(30 * t * t) + random.randint(0, 14)
            page.wait_for_timeout(base_delay)

    # Humans almost always overshoot and pull back. Make it obvious: push past
    # the target by a few px, dwell, then wobble back to settle.
    if needed > 16:
        overshoot = random.uniform(4.0, 12.0)
        page.mouse.move(start_x + needed + overshoot, start_y + y_drift + random.uniform(-0.6, 0.6), steps=random.randint(2, 4))
        page.wait_for_timeout(random.randint(90, 200))
        # Drift back with a couple of small corrections, not one clean hop.
        back = needed + overshoot
        while back - needed > 1.2:
            back -= random.uniform(1.5, 4.5)
            page.mouse.move(start_x + back, start_y + y_drift + random.uniform(-0.5, 0.5))
            page.wait_for_timeout(random.randint(40, 120))
        mouse = needed
    page.wait_for_timeout(random.randint(300, 650))  # let the animation catch up

    # Small corrections, each followed by a real settle wait. The piece lags the
    # cursor, so this closes whatever gap the first pass left.
    best_err = None
    for i in range(12):
        cur = read_puzzle_left(page)
        if cur is None:
            break
        err = target_puzzle_left - cur
        if best_err is None or abs(err) < abs(best_err):
            best_err = err
        if abs(err) <= 1.5:
            break
        remain = max_travel - mouse
        if abs(err) > remain:
            print(f"  drag: cannot close err={err:.1f} (remain={remain:.1f})")
            break
        step = max(-8, min(8, err))
        mouse += step
        # Nudge with a small jittered move, then a human-scale pause to recheck.
        page.mouse.move(start_x + mouse, start_y + random.uniform(-0.9, 0.9), steps=random.randint(1, 3))
        page.wait_for_timeout(random.randint(160, 320))
        if i % 4 == 0:
            print(f"  drag fix i={i} mouse={mouse:6.1f} pos={cur:7.1f} err={err:6.1f}")

    page.wait_for_timeout(random.randint(120, 260))
    page.mouse.up()
    page.wait_for_timeout(2500)
    return abs(best_err) if best_err is not None else 999.0


def captcha_image_signature(page) -> str:
    try:
        return page.locator("#aliyunCaptcha-img").first.get_attribute("src") or ""
    except Exception:
        return ""


def wait_for_new_captcha(page, previous: str, timeout: float = 12.0) -> bool:
    """After a failed drag the widget swaps in a fresh image.

    Re-solving without waiting means dragging against the puzzle we just failed
    on, or worse against a half-loaded one - which is what produced the
    confidence-0.4, "target x=0" attempts that did nothing at all.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if not slider_visible(page):
                return False  # widget closed - either passed or gave up
            sig = captcha_image_signature(page)
            if sig and sig != previous:
                time.sleep(1.5)  # let the new image finish decoding
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def solve_slider_login(page, max_attempts: int = 3) -> bool:
    for attempt in range(max_attempts):
        print(f"  Login captcha attempt {attempt+1}/{max_attempts}...")
        before = captcha_image_signature(page)
        try:
            target_left, max_travel = resolve_target(page)
            err = drag_slider_closed_loop(page, target_left, max_travel)
            print(f"  residual error={err:.2f}px")
            page.screenshot(path=str(ARTIFACT_DIR / f"login-captcha-attempt{attempt+1}.png"))
            if not slider_visible(page):
                print("  Slider dismissed -> captcha passed")
                return True
            print("  Slider still visible, waiting for a fresh captcha")
        except Exception as e:
            print(f"  Attempt {attempt+1} error: {e}")
            try:
                page.screenshot(path=str(ARTIFACT_DIR / f"login-captcha-err{attempt+1}.png"))
            except Exception:
                pass
        if not wait_for_new_captcha(page, before, 12.0):
            time.sleep(1.5)
    return False


# Best-effort selectors for the little circular-arrow button that hands out a
# fresh puzzle. Aliyun renames this between widget builds, so we try several and
# simply carry on when none match - a human can click it by hand.
CAPTCHA_REFRESH_SELECTORS = (
    "#aliyunCaptcha-refresh",
    "#aliyunCaptcha-refresh-btn",
    "#aliyunCaptcha-refresh-button",
    ".aliyunCaptcha-refresh",
    "#aliyunCaptcha-captcha-body [class*='refresh']",
    "#aliyunCaptcha-captcha-body [class*='reset']",
    "#aliyunCaptcha-captcha-body [aria-label*='刷新']",
    "#aliyunCaptcha-captcha-body [aria-label*='重试']",
)


def refresh_captcha_for_human(page) -> bool:
    """Give the human a fresh slider after the bot burned the current one.

    Without this the window can be sitting on a 'verification failed, please
    retry' state that no amount of dragging will clear.
    """
    for sel in CAPTCHA_REFRESH_SELECTORS:
        try:
            loc = page.locator(sel).first
            if loc.count() and loc.is_visible(timeout=1200):
                loc.click(timeout=2500)
                time.sleep(2.5)
                print(f"  Refreshed the captcha widget via {sel}")
                return True
        except Exception:
            continue
    return False


def _jwt_email(token: str) -> str:
    """Decode the email claim without verifying the signature - we only need to
    tell our account's JWT apart from the guest session the page already had."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("email", "")
    except Exception:
        return ""


def read_session_token(page, context, max_seconds: int = 20, email: str = "") -> str:
    """Read the JWT the SPA stored after a successful signin.

    A z.ai page always carries a *guest* JWT, so "some JWT exists" proves
    nothing. When `email` is given only accept a token whose email claim matches
    the account we just logged in with - otherwise a rejected signin would be
    reported as a success carrying the worthless guest token."""
    deadline = time.time() + max_seconds
    while time.time() < deadline:
        candidates = []
        try:
            candidates.append(page.evaluate("() => localStorage.getItem('token') || ''"))
        except Exception:
            pass
        candidates.extend(c.get("value", "") for c in context.cookies() if c.get("name") == "token")
        for token in candidates:
            if not looks_like_jwt(token or ""):
                continue
            if email and _jwt_email(token).lower() != email.lower():
                continue
            return token
        time.sleep(1)
    return ""


def email_login(email: str, password: str, headless: bool, wait_seconds: int,
                max_captcha_attempts: int = 3, allow_human: bool = False,
                human_timeout: int = 180) -> dict:
    """Log in with email+password and return the freshly minted JWT.

    The credentials are submitted automatically; only the captcha may need a
    human. When allow_human is set (and the browser is visible) a failed
    automated solve leaves the window open so someone can drag the slider.
    """
    pw = sync_playwright().start()
    launch_args = {"headless": headless, "args": ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]}
    if CHROME_PATH and os.path.isfile(CHROME_PATH):
        launch_args["executable_path"] = CHROME_PATH
    browser = pw.chromium.launch(**launch_args)
    context = browser.new_context(
        viewport={"width": 1366, "height": 900},
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    )
    page = context.new_page()
    detail = ""
    try:
        print("Loading z.ai OAuth login page...")
        page.goto(ZAI_OAUTH_URL, wait_until="domcontentloaded", timeout=60000)
        time.sleep(6)

        # The authorize page defaults to phone+SMS; switch to the email tab.
        for sel in ["text=邮箱", "button:has-text('邮箱')"]:
            try:
                loc = page.locator(sel).first
                if loc.is_visible(timeout=2500):
                    loc.click(timeout=4000)
                    break
            except Exception:
                continue
        time.sleep(3)

        page.fill("input[type=email]", email, timeout=10000)
        page.fill("input[type=password]", password, timeout=10000)
        time.sleep(0.8)
        page.click("button:has-text('登录')", timeout=10000)
        print("Credentials submitted, waiting for captcha...")
        time.sleep(4)

        deadline = time.time() + wait_seconds
        token = ""
        while time.time() < deadline:
            if expand_captcha(page):
                if solve_slider_login(page, max_attempts=max_captcha_attempts):
                    token = read_session_token(page, context, email=email)
                    if token:
                        break
                    # Slider passed but no account JWT appeared - the signin was
                    # rejected (wrong credentials) even though the captcha passed.
                    detail = "captcha passed but no session token (check credentials)"
                    break
                detail = "captcha verification failed"
                if allow_human and not headless:
                    try:
                        page.bring_to_front()
                    except Exception:
                        pass
                    print("=" * 62)
                    print("MANUAL CAPTCHA REQUIRED")
                    print(f"  account: {email}")
                    print("  The automated slider solve failed. A browser window")
                    print("  is open on the z.ai login page - drag the slider to")
                    print("  finish signing in. Credentials are already filled in.")
                    print(f"  Waiting up to {human_timeout}s; Ctrl-C to give up.")
                    print("=" * 62)
                    refresh_captcha_for_human(page)
                    token = read_session_token(page, context, human_timeout, email=email)
                    if token:
                        detail = ""
                    else:
                        detail = f"captcha not completed by human within {human_timeout}s"
                break
            if not page.locator("#aliyunCaptcha-captcha-body").count():
                # No captcha shown - maybe already logged in or creds rejected.
                token = read_session_token(page, context, email=email)
                if token:
                    break
            time.sleep(1)

        if not token and not detail:
            detail = f"no session token within {wait_seconds}s"
        cookies = "; ".join(f"{c['name']}={c['value']}" for c in context.cookies())
        return {"status": 200 if token else 0, "token": token,
                "cookies": cookies, "detail": detail}
    finally:
        browser.close()
        pw.stop()


def update_account(management_url, secret, account_id, captcha_param):
    import urllib.request
    url = f"{management_url}/v0/management/accounts/{account_id}"
    data = json.dumps({"credentials": {"captcha_verify_param": captcha_param}}).encode()
    req = urllib.request.Request(url, data=data, method="PUT")
    req.add_header("Authorization", f"Bearer {secret}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read())
    print(f"Account {account_id} update response: success={result.get('success')}")
    return result

def main():
    args = parse_args()
    print("Z.ai Captcha Solver v2")
    print(f"Token prefix: {args.token[:30]}...")
    if args.mode == "signin":
        if not args.email or not args.password:
            print(json.dumps({"error": "signin mode requires --email and --password"}))
            sys.exit(2)
        if args.signin_method == "chat-captcha":
            # Harvest a captcha_verify_param from the *chat* captcha and POST
            # /auths/signin inside the same session (the param is session-bound).
            # Only works while some token still triggers the chat captcha - a
            # fully revoked token never reaches that point, so the login-form
            # path remains the fallback for a dead session.
            signin = {"status": 0, "token": "", "cookies": "", "detail": ""}
            session = None
            try:
                print("Harvesting captcha from a chat session...")
                session = solve_captcha(
                    args.token,
                    headless=args.headless,
                    wait_seconds=args.wait_seconds,
                    keep_session=True,
                    inject_token=False,
                )
                captcha_param, browser, context, page, pw = session
                signin = signin_in_session(page, context, args.email, args.password, captcha_param)
            except Exception as e:
                signin["detail"] = f"captcha harvest failed: {e}"
            finally:
                if session:
                    try:
                        session[1].close()  # browser
                        session[4].stop()   # playwright
                    except Exception:
                        pass
        else:
            # z.ai only exposes email+password on the OAuth authorize page, and the
            # form is captcha-gated. Drive the real login form and read back the JWT
            # the SPA stores - no separate captcha harvest needed.
            signin = email_login(
                args.email,
                args.password,
                headless=args.headless,
                wait_seconds=args.wait_seconds,
                allow_human=args.allow_human,
                human_timeout=args.human_timeout,
            )
        print(json.dumps({
            "mode": "signin",
            "status": signin["status"],
            "token": signin["token"],
            "cookies": signin["cookies"],
            "account_id": args.account_id,
            "detail": signin["detail"],
        }))
        return
    captcha_param = solve_captcha(args.token, headless=args.headless, wait_seconds=args.wait_seconds)
    print(f"SUCCESS: captcha_verify_param captured ({len(captcha_param)} chars)")
    print(f"Value prefix: {captcha_param[:80]}...")
    if args.account_id:
        update_account(args.management_url, args.management_secret, args.account_id, captcha_param)
    print(json.dumps({"captcha_verify_param": captcha_param, "account_id": args.account_id}))

if __name__ == "__main__":
    main()