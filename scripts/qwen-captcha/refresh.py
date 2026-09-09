"""
Qwen risk-session refresher (x5sec harvest).

When chat.qwen.ai answers a request with the RGV587 envelope
(FAIL_SYS_USER_VALIDATE + "被挤爆啦"), the account's web session is sitting
behind an aliyun baxia challenge. Passing the slider once re-issues the risk
cookies (x5sec family) bound to the account; carrying them on subsequent API
requests clears the challenge until the session ages out again.

Flow: launch chromium with the account's JWT + web cookies -> open
chat.qwen.ai -> if the punish page / aliyun captcha slider appears, solve it
(same aliyunCaptcha widget family as the z.ai solver) -> otherwise send a
minimal probe turn to surface any latent challenge -> harvest all .qwen.ai
cookies + the localStorage token and print them as the last JSON line on
stdout. The Node wrapper updates the stored account credentials.
"""

import argparse
import base64
import io
import json
import os
import random
import time
import urllib.parse

import numpy as np
from patchright.sync_api import sync_playwright

try:
    from PIL import Image
except ImportError:
    Image = None

CHROME_PATH = os.environ.get("CHROME_PATH", "")
for candidate in [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
]:
    if os.path.isfile(candidate):
        CHROME_PATH = candidate
        break
if not CHROME_PATH:
    try:
        import shutil

        located = shutil.which("chromium") or shutil.which("chromium-browser")
        if located:
            CHROME_PATH = located
    except Exception:
        pass
if not CHROME_PATH:
    CHROME_PATH = "chromium"

QWEN_URL = "https://chat.qwen.ai/"
ARTIFACT_DIR = os.environ.get("QWEN_CAPTCHA_ARTIFACT_DIR") or "/tmp/qwen-captcha"
os.makedirs(ARTIFACT_DIR, exist_ok=True)

RISK_MARKERS = ("RGV587", "FAIL_SYS_USER_VALIDATE", "punish", "x5sec", "被挤爆", "请稍后重试")


def parse_args():
    p = argparse.ArgumentParser(description="Refresh a Qwen account's risk session cookies")
    p.add_argument("--token", required=True, help="Qwen JWT token")
    p.add_argument("--cookies", default="", help="Existing web session cookie string (k=v; k2=v2)")
    p.add_argument("--account-id", default="")
    p.add_argument("--headless", action="store_true")
    p.add_argument("--wait-seconds", type=int, default=75)
    return p.parse_args()


def decode_data_image(source: str) -> bytes:
    if not source.startswith("data:") or "," not in source:
        raise RuntimeError("Not a data URL")
    return base64.b64decode(source.split(",", 1))


def image_bytes_from_locator(page, locator) -> bytes:
    result = locator.evaluate("""async image => {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || height || 0;
        const src = image.currentSrc || image.src || '';
        const encode = drawable => {
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = image.naturalHeight || image.height;
            const context = canvas.getContext('2d', {willReadFrequently: true});
            if (!context) throw new Error('no canvas');
            context.drawImage(drawable, 0, 0, width, image.naturalHeight || image.height);
            return canvas.toDataURL('image/png');
        };
        try { return {dataUrl: encode(image), src, errors: []}; }
        catch (error) { return {dataUrl: null, src, errors: [String(error)]}; }
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
    raise RuntimeError("Cannot get captcha image")


def read_puzzle_left(slider_frame):
    try:
        box = slider_frame.locator("#aliyunCaptcha-puzzle").bounding_box()
        return float(box["x"]) if box else None
    except Exception:
        return None


def captcha_target_geometry(slider_frame) -> dict:
    bg_loc = slider_frame.locator("#aliyunCaptcha-img")
    pz_loc = slider_frame.locator("#aliyunCaptcha-puzzle")
    bg = np.asarray(Image.open(io.BytesIO(image_bytes_from_locator(slider_frame, bg_loc))).convert("RGB"), dtype=np.float32)
    pz = np.asarray(Image.open(io.BytesIO(image_bytes_from_locator(slider_frame, pz_loc))).convert("RGBA"), dtype=np.uint8)
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
    gray = 0.299 * bg[:, :, 0] + 0.587 * bg[:, :, 1] + 0.114 * bg[:, :, 2]
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[1:-1, 1:-1] = (-gray[:-2, :-2] + gray[:-2, 2:] - 2 * gray[1:-1, :-2] + 2 * gray[1:-1, 2:] - gray[2:, :-2] + gray[2:, 2:])
    gy[1:-1, 1:-1] = (-gray[:-2, :-2] - 2 * gray[:-2, 1:-1] - gray[:-2, 2:] + gray[2:, :-2] + 2 * gray[2:, 1:-1] + gray[2:, 2:])
    edges = np.sqrt(gx * gx + gy * gy)
    boundary_y, boundary_x = np.where(boundary)
    relative_x = boundary_x - piece_left
    maximum_x = max(10, bg.shape[1] - piece_width - 2)
    scores = []
    for cx in range(10, maximum_x + 1):
        sx = cx + relative_x
        valid = (sx > 0) & (sx < bg.shape[1] - 1) & (boundary_y > 0) & (boundary_y < bg.shape[0] - 1)
        if not valid.any():
            continue
        ev = edges[boundary_y[valid], sx[valid]]
        br = gray[boundary_y[valid], sx[valid]]
        scores.append((float(ev.mean() * 1.15 - br.std() * 0.4 - br.mean() * 0.1), cx))
    scores.sort(reverse=True)
    if not scores:
        raise RuntimeError("No captcha candidates")
    score, target_x = scores[0]
    image_box = slider_frame.locator("#aliyunCaptcha-img-box").bounding_box() or slider_frame.locator("#aliyunCaptcha-img").bounding_box()
    track_box = slider_frame.locator("#aliyunCaptcha-sliding-body").bounding_box()
    slider_box = slider_frame.locator("#aliyunCaptcha-sliding-slider").bounding_box()
    if not all([image_box, track_box, slider_box]):
        raise RuntimeError("Captcha geometry incomplete")
    scale_x = image_box["width"] / max(1, bg.shape[1])
    target_display_x = max(0, target_x - piece_left) * scale_x
    max_travel = max(20, track_box["width"] - slider_box["width"] - 2)
    print(f"  target_x={target_x} display_x={target_display_x:.1f} max_travel={max_travel:.1f} score={score:.2f}")
    return {
        "target_puzzle_left": image_box["x"] + target_display_x,
        "max_travel": float(max_travel),
    }


def drag_slider(slider_frame, slider, target_puzzle_left, max_travel):
    slider_box = slider.bounding_box()
    if not slider_box:
        raise RuntimeError("No slider box")
    start_x = slider_box["x"] + min(14, slider_box["width"] / 2)
    start_y = slider_box["y"] + slider_box["height"] / 2
    slider_frame.page.mouse.move(start_x, start_y, steps=5)
    slider_frame.page.wait_for_timeout(random.randint(90, 160))
    slider_frame.page.mouse.down()
    slider_frame.page.wait_for_timeout(random.randint(60, 120))
    initial_left = read_puzzle_left(slider_frame)
    if initial_left is None:
        raise RuntimeError("No puzzle box")
    estimated = max(12, min(max_travel, target_puzzle_left - initial_left))
    estimated = min(max_travel, estimated * 1.03 + 3)
    current_x = start_x
    steps = random.randint(30, 37)
    for step in range(1, steps + 1):
        progress = step / steps
        eased = 1 - (1 - progress) ** 3
        current_x = start_x + estimated * eased + np.sin(progress * np.pi * 2) * random.uniform(0.1, 0.55)
        y = start_y + np.sin(progress * np.pi) * random.uniform(-0.8, 0.8)
        slider_frame.page.mouse.move(current_x, y)
        slider_frame.page.wait_for_timeout(random.randint(7, 18))
    for _ in range(14):
        cl = read_puzzle_left(slider_frame)
        if cl is None:
            break
        error = target_puzzle_left - cl
        if abs(error) <= 0.9:
            break
        correction = max(-6, min(6, error * 0.9))
        current_x = max(start_x, min(start_x + max_travel, current_x + correction))
        slider_frame.page.mouse.move(current_x, start_y + random.uniform(-0.3, 0.3), steps=2)
        slider_frame.page.wait_for_timeout(random.randint(16, 34))
    for _ in range(4):
        cl = read_puzzle_left(slider_frame)
        if cl is None:
            break
        error = target_puzzle_left - cl
        if abs(error) <= 0.45:
            break
        current_x = max(start_x, min(start_x + max_travel, current_x + error))
        slider_frame.page.mouse.move(current_x, start_y)
        slider_frame.page.wait_for_timeout(random.randint(18, 36))
    slider_frame.page.wait_for_timeout(random.randint(80, 150))
    slider_frame.page.mouse.up()
    return current_x - start_x


def slider_locator(page):
    """Find the aliyun captcha slider on the page or inside any iframe."""
    candidates = [page] + list(page.frames)
    for frame in candidates:
        try:
            locator = frame.locator("#aliyunCaptcha-sliding-slider").first
            if locator.is_visible():
                return frame, locator
        except Exception:
            continue
    return None, None


def page_looks_risky(page) -> bool:
    try:
        url = (page.url or "").lower()
        if "punish" in url or "___tmp___" in url or "captcha" in url:
            return True
        content = page.content()[:20000].lower()
        return any(marker.lower() in content for marker in ("rgv587", "fail_sys_user_validate", "aliyuncaptcha", "被挤爆"))
    except Exception:
        return False


def parse_cookie_string(raw: str):
    cookies = []
    for part in (raw or "").split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, _, value = part.partition("=")
        cookies.append({
            "name": name.strip(),
            "value": value.strip(),
            "domain": ".qwen.ai",
            "path": "/",
        })
    return cookies


def solve_challenge(token: str, cookie_string: str, headless: bool, wait_seconds: int) -> dict:
    with sync_playwright() as pw:
        launch_args = {
            "headless": headless,
            "args": ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        }
        if CHROME_PATH and os.path.isfile(CHROME_PATH):
            launch_args["executable_path"] = CHROME_PATH
        browser = pw.chromium.launch(**launch_args)
        context = browser.new_context(
            viewport={"width": 1366, "height": 900},
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        )
        page = context.new_page()

        print("Loading chat.qwen.ai...")
        page.goto(QWEN_URL, wait_until="domcontentloaded", timeout=60000)
        time.sleep(2)

        print("Injecting account session...")
        context.add_cookies(parse_cookie_string(cookie_string))
        context.add_cookies([{"name": "token", "value": token, "domain": "chat.qwen.ai", "path": "/", "secure": True, "httpOnly": False}])
        page.evaluate("(t) => { try { localStorage.setItem('token', t); } catch (e) {} }", token)
        page.reload(wait_until="domcontentloaded", timeout=60000)
        time.sleep(5)

        solved = False
        deadline = time.time() + wait_seconds
        while time.time() < deadline:
            frame, slider = slider_locator(page)
            if slider:
                print("Captcha slider visible, solving...")
                try:
                    geometry = captcha_target_geometry(frame)
                    drag_slider(frame, slider, geometry["target_puzzle_left"], geometry["max_travel"])
                    solved = True
                    print("  Slider drag complete, waiting for verdict...")
                    time.sleep(3)
                except Exception as error:
                    print(f"  Slider attempt failed: {str(error)[:160]}")
                    try:
                        page.screenshot(path=os.path.join(ARTIFACT_DIR, "slider-failed.png"))
                    except Exception:
                        pass
                    time.sleep(2)
            if solved and not slider_locator(page)[1]:
                break
            time.sleep(0.8)

        risk = page_looks_risky(page)
        cookies = context.cookies("https://chat.qwen.ai")
        cookie_string = "; ".join(f"{c['name']}={c['value']}" for c in cookies if c.get("name"))
        token_value = ""
        try:
            token_value = page.evaluate("() => localStorage.getItem('token') || ''") or token
        except Exception:
            token_value = token

        names = [c["name"] for c in cookies]
        has_x5sec = any("x5sec" in n or "punish" in n for n in names)
        print(f"Harvested {len(cookies)} cookies; risk-page still={risk}; x5sec-family present={has_x5sec}")
        try:
            page.screenshot(path=os.path.join(ARTIFACT_DIR, "final-state.png"))
        except Exception:
            pass
        browser.close()

        if risk and not solved:
            raise RuntimeError("Risk challenge still present and no slider could be solved")
        return {
            "cookies": cookie_string,
            "token": token_value,
            "solved_slider": solved,
            "risk_page": risk,
            "cookie_names": names[:40],
        }


def main():
    args = parse_args()
    print("Qwen Risk Session Refresher")
    print(f"Token prefix: {args.token[:24]}...")
    result = solve_challenge(args.token, args.cookies, headless=args.headless, wait_seconds=args.wait_seconds)
    result["account_id"] = args.account_id
    print("SUCCESS: risk session harvested")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
