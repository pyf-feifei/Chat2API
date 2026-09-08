#!/usr/bin/env python3
"""Solve Aliyun captcha for Z.ai accounts and update captcha_verify_param."""
from __future__ import annotations
import argparse, base64, io, json, os, random, sys, time
from pathlib import Path
import numpy as np
from PIL import Image
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
    p.add_argument("--token", required=True, help="Z.ai JWT token")
    p.add_argument("--account-id", help="Account ID for management API update")
    p.add_argument("--management-url", default="http://127.0.0.1:8080")
    p.add_argument("--management-secret", default="admin123")
    p.add_argument("--headless", action="store_true")
    p.add_argument("--wait-seconds", type=int, default=45)
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
    piece_right = int(alpha_x.max())
    piece_width = max(8, piece_right - piece_left + 1)
    eroded = mask.copy()
    eroded[1:, :] &= mask[:-1, :]
    eroded[:-1, :] &= mask[1:, :]
    eroded[:, 1:] &= mask[:, :-1]
    eroded[:, :-1] &= mask[:, 1:]
    boundary = mask & ~eroded
    gray = 0.299 * bg[:,:,0] + 0.587 * bg[:,:,1] + 0.114 * bg[:,:,2]
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[1:-1,1:-1] = (-gray[:-2,:-2]+gray[:-2,2:]-2*gray[1:-1,:-2]+2*gray[1:-1,2:]-gray[2:,:-2]+gray[2:,2:])
    gy[1:-1,1:-1] = (-gray[:-2,:-2]-2*gray[:-2,1:-1]-gray[:-2,2:]+gray[2:,:-2]+2*gray[2:,1:-1]+gray[2:,2:])
    edges = np.sqrt(gx*gx + gy*gy)
    boundary_y, boundary_x = np.where(boundary)
    relative_x = boundary_x - piece_left
    maximum_x = max(10, bg.shape[1] - piece_width - 2)
    scores = []
    for cx in range(10, maximum_x + 1):
        sx = cx + relative_x
        valid = (sx > 0) & (sx < bg.shape[1]-1) & (boundary_y > 0) & (boundary_y < bg.shape[0]-1)
        if not valid.any():
            continue
        ev = edges[boundary_y[valid], sx[valid]]
        br = gray[boundary_y[valid], sx[valid]]
        score = float(ev.mean()*1.15 - br.std()*0.4 - br.mean()*0.1)
        scores.append((score, cx))
    scores.sort(reverse=True)
    if not scores:
        raise RuntimeError("No captcha candidates")
    score, target_x = scores[0]
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
    print(f"  target_x={target_x} piece_left={piece_left} display_x={target_display_x:.1f} max_travel={max_travel:.1f} score={score:.2f}")
    return {"target_display_x": float(target_display_x), "target_puzzle_left": float(target_puzzle_left), "max_travel": float(max_travel)}

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

def solve_captcha(token: str, headless: bool, wait_seconds: int) -> str:
    captcha_result = {"value": None}
    with sync_playwright() as pw:
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

        print("Injecting token...")
        context.add_cookies([{"name": "token", "value": token, "domain": "chat.z.ai", "path": "/", "secure": True, "httpOnly": False}])
        page.evaluate("(t) => { localStorage.setItem('token', t); }", token)
        page.reload(wait_until="domcontentloaded", timeout=60000)
        time.sleep(5)

        dismiss_modals(page)

        print("Sending message to trigger captcha flow...")
        if not send_chat_message(page):
            dismiss_modals(page)
            time.sleep(1)
            if not send_chat_message(page):
                page.screenshot(path=str(ARTIFACT_DIR / "send-failed.png"))
                browser.close()
                raise RuntimeError("Could not send chat message to trigger captcha")

        deadline = time.time() + wait_seconds
        slider_solved = False
        while time.time() < deadline:
            if captcha_result["value"]:
                time.sleep(1)
                browser.close()
                return captcha_result["value"]
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
                    raise RuntimeError("Slider solve failed after all attempts")
            time.sleep(0.7)

        page.screenshot(path=str(ARTIFACT_DIR / "timeout.png"))
        browser.close()
        raise RuntimeError(f"No captcha_verify_param captured within {wait_seconds}s")

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
    captcha_param = solve_captcha(args.token, headless=args.headless, wait_seconds=args.wait_seconds)
    print(f"SUCCESS: captcha_verify_param captured ({len(captcha_param)} chars)")
    print(f"Value prefix: {captcha_param[:80]}...")
    if args.account_id:
        update_account(args.management_url, args.management_secret, args.account_id, captcha_param)
    print(json.dumps({"captcha_verify_param": captcha_param, "account_id": args.account_id}))

if __name__ == "__main__":
    main()