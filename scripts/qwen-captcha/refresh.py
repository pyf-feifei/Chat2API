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
    from PIL import Image, ImageFilter
except ImportError:
    Image = None
    ImageFilter = None

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

# Artifact dump tag, updated per solver attempt so late attempts cannot
# overwrite a live captcha's diagnostics with post-crash states.
CAPTURE_TAG = ["run"]
RUN_COUNTER = [0]


def parse_args():
    p = argparse.ArgumentParser(description="Refresh a Qwen account's risk session cookies")
    p.add_argument("--token", required=True, help="Qwen JWT token")
    p.add_argument("--cookies", default="", help="Existing web session cookie string (k=v; k2=v2)")
    p.add_argument("--account-id", default="")
    p.add_argument("--headless", action="store_true")
    p.add_argument("--wait-seconds", type=int, default=75)
    p.add_argument("--punish-url", default="", help="Optional aliyun punish URL to enter the captcha deliberately")
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


# ---------------------------------------------------------------- #
# Icon-connect captcha ("Please connect them in order")
#
# The aliyun baxia widget renders the question strip as
# #connect-question-canvas (355x48, four symbols) and the choices as
# #connect-grid-0..#connect-grid-8 (nine 117x117 canvases). Everything is
# same-origin canvas, so element screenshots give clean per-tile pixels.
# The symbols are the same line drawings at different scales over a
# speckle-texture wash: median-filter away the speckle, threshold the
# stroke mass, crop, normalize, and match strip-to-grid by normalized
# cross-correlation. Clicks go through the patchright-driven mouse with
# human-ish pacing.
# ---------------------------------------------------------------- #

CONNECT_CONTAINER = ".connect-captcha-container"
CONNECT_QUESTION = "#connect-question-canvas"
CONNECT_GRID = "#connect-grid-{index}"
CONNECT_REFRESH = "#connect-refresh"


def connect_captcha_visible(page) -> bool:
    try:
        return page.locator(CONNECT_CONTAINER).count() > 0
    except Exception:
        return False


def _glyph_mask(image):
    """Unified stroke-mask pipeline shared by strip and grid glyphs.

    Representing both sides identically (binary opened mask) matters more
    than any per-side tuning: normalized cross-correlation degrades fast
    when one side is binary and the other is continuous ink (measured
    2026-10-14: same-glyph pairs scored 0.1-0.3 mixed with non-pairs).
    """
    smoothed = image.filter(ImageFilter.MedianFilter(3))
    gray = np.asarray(smoothed, dtype=np.float32)
    low = float(np.percentile(gray, 3))
    high = float(np.percentile(gray, 97))
    if high - low < 8:
        return None
    dark = (gray < low + (high - low) * 0.5).astype(np.uint8) * 255
    opened = Image.fromarray(dark).filter(ImageFilter.MinFilter(3)).filter(
        ImageFilter.MaxFilter(3))
    mask = np.asarray(opened, dtype=np.float32) / 255.0
    ys, xs = np.where(mask > 0)
    if len(xs) < 60:
        return None
    return mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def tile_png_mask(page, selector: str):
    """Element screenshot -> (unified stroke mask, centroid in cell)."""
    locator = page.locator(selector)
    if locator.count() == 0:
        return None
    png = locator.screenshot()
    image = Image.open(io.BytesIO(png)).convert("L")
    mask = _glyph_mask(image)
    if mask is None:
        return None
    ys, xs = np.where(mask > 0)
    centroid = (float(xs.min() + xs.max()) / 2.0, float(ys.min() + ys.max()) / 2.0)
    return mask, centroid


def normalized(mask, size: int = 48) -> np.ndarray:
    image = Image.fromarray((np.clip(mask, 0, 1) * 255).astype("uint8")).resize(
        (size, size), Image.LANCZOS)
    out = np.asarray(image.filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float32) / 255.0
    out -= out.mean()
    norm = float(np.sqrt((out * out).sum()))
    return out / norm if norm > 0 else out


def similarity(a: np.ndarray, b: np.ndarray) -> float:
    return float((a * b).sum())


def _strip_ink_map(page):
    """Unified glyph masks for the question strip, split by column gaps."""
    locator = page.locator(CONNECT_QUESTION)
    if locator.count() == 0:
        return None
    png = locator.screenshot()
    image = Image.open(io.BytesIO(png)).convert("L")
    smoothed = image.filter(ImageFilter.MedianFilter(3))
    gray = np.asarray(smoothed, dtype=np.float32)
    low = float(np.percentile(gray, 3))
    high = float(np.percentile(gray, 97))
    if high - low < 8:
        return None
    dark = (gray < low + (high - low) * 0.5).astype(np.uint8) * 255
    opened = Image.fromarray(dark).filter(ImageFilter.MinFilter(3)).filter(
        ImageFilter.MaxFilter(3))
    mask = np.asarray(opened, dtype=np.float32) / 255.0
    try:
        tag = CAPTURE_TAG[0]
        image.save(os.path.join(ARTIFACT_DIR, f"strip-native-{tag}.png"))
        Image.fromarray(mask.astype("uint8")).save(
            os.path.join(ARTIFACT_DIR, f"strip-mask-{tag}.png"))
    except Exception:
        pass
    return mask


def segment_strip(page) -> list:
    """Split the question strip into per-symbol stroke masks by column gaps."""
    ink = _strip_ink_map(page)
    if ink is None:
        return []
    # The strip lays out 3-5 symbols of roughly even width; walk the column
    # profile and keep runs where strokes exist, then require the run to look
    # like a glyph (wide enough, enough stroke pixels) rather than residue.
    height = float(ink.shape[0])
    column_ink = ink.sum(axis=0) / height
    profile = np.convolve(column_ink, np.ones(3) / 3.0, mode="same")
    active = profile > 0.10
    segments = []
    start = None
    for index, flag in enumerate(active):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            segments.append((start, index))
            start = None
    if start is not None:
        segments.append((start, len(active)))
    merged = []
    for seg in segments:
        if merged and seg[0] - merged[-1][1] < 5:
            merged[-1] = (merged[-1][0], seg[1])
        else:
            merged.append(seg)
    masks = []
    for left, right in merged:
        if right - left < 12:
            continue
        block = ink[:, left:right]
        ys, xs = np.where(block > 0)
        if len(xs) < 90:
            continue
        masks.append(block[ys.min():ys.max() + 1, xs.min():xs.max() + 1])
    return masks


def human_click(page, x: float, y: float) -> None:
    page.mouse.move(
        x - random.randint(24, 48), y - random.randint(30, 55),
        steps=random.randint(6, 12),
    )
    time.sleep(random.uniform(0.08, 0.2))
    page.mouse.move(x + random.randint(-2, 2), y + random.randint(-2, 2),
                    steps=random.randint(8, 16))
    time.sleep(random.uniform(0.15, 0.4))
    page.mouse.down()
    time.sleep(random.uniform(0.04, 0.12))
    page.mouse.up()


def solve_connect_captcha(page, max_attempts: int = 4, run_no: int = 1) -> bool:
    """Match the strip symbols to grid cells and connect them in order."""
    for attempt in range(1, max_attempts + 1):
        try:
            # The strip paints progressively right after the widget renders;
            # acting on a half-drawn strip yields garbage segments (measured:
            # 9 fragment segments at t=0 vs 4 clean segments a second later).
            stable = None
            for _ in range(8):
                masks_now = segment_strip(page)
                signature = tuple(round(float(m.sum()), 1) for m in masks_now)
                if 3 <= len(masks_now) <= 6 and signature == stable:
                    strip_masks = [normalized(m) for m in masks_now]
                    break
                stable = signature
                time.sleep(0.8)
            else:
                strip_masks = []
            try:
                page.locator(CONNECT_QUESTION).screenshot(
                    path=os.path.join(ARTIFACT_DIR, f"strip-attempt-{attempt}.png"))
            except Exception:
                pass
            if not strip_masks:
                strip_masks = [normalized(m) for m in segment_strip(page)]
            grid_tiles = []
            for index in range(9):
                selector = CONNECT_GRID.format(index=index)
                tile = tile_png_mask(page, selector)
                box = page.locator(selector).bounding_box()
                if tile is None or box is None:
                    continue
                mask, centroid = tile
                grid_tiles.append((index, normalized(mask), box, centroid))
                try:
                    page.locator(selector).screenshot(
                        path=os.path.join(ARTIFACT_DIR,
                                          f"grid-{CAPTURE_TAG[0]}-{index}.png"))
                except Exception:
                    pass
            if not strip_masks or len(grid_tiles) < len(strip_masks):
                print(f"  connect attempt {attempt}: strip={len(strip_masks)} grid={len(grid_tiles)}, too few tiles")
                time.sleep(1.5)
                continue
            order = []
            used = set()
            for strip_mask in strip_masks:
                best = None
                for index, grid_mask, box, centroid in grid_tiles:
                    if index in used:
                        continue
                    score = similarity(strip_mask, grid_mask)
                    if best is None or score > best[0]:
                        best = (score, index, box, centroid)
                if best is None:
                    break
                used.add(best[1])
                order.append(best)
            print(f"  connect attempt {attempt}: strip={len(strip_masks)} matched "
                  f"{[(round(s, 3), i) for s, i, _, _ in order]}")
            if len(order) < len(strip_masks):
                time.sleep(1.5)
                continue
            for _, _, box, centroid in order:
                human_click(page, box["x"] + centroid[0], box["y"] + centroid[1])
                time.sleep(random.uniform(0.25, 0.6))
            time.sleep(2.5)
            if not connect_captcha_visible(page):
                print("  connect captcha accepted")
                return True
            print("  connect captcha still up after clicks")
        except Exception as error:
            print(f"  connect attempt {attempt} failed: {str(error)[:160]}")
        refresh_box = None
        try:
            refresh_locator = page.locator(CONNECT_REFRESH)
            if refresh_locator.count() > 0:
                refresh_box = refresh_locator.bounding_box()
        except Exception:
            refresh_box = None
        if refresh_box:
            human_click(page, refresh_box["x"] + refresh_box["width"] / 2,
                        refresh_box["y"] + refresh_box["height"] / 2)
        time.sleep(2)
    return False


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


def solve_challenge(token: str, cookie_string: str, headless: bool, wait_seconds: int, punish_url: str = "") -> dict:
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

        # When the egress IP carries an aliyun risk flag, the API-shaped requests
        # are punished while a real browser passes invisibly — so the organic
        # login flow never encounters a slider and no x5sec is ever issued. A
        # punish URL captured from a punished request drops this same browser
        # straight into the baxia challenge, where solving it yields the x5sec
        # the cookie-less API path needs (community/official-doc verified: a
        # passed slider whitelists the client for ~30 minutes).
        if punish_url:
            print(f"Navigating to punish URL: {punish_url[:90]}...")
            try:
                page.goto(punish_url, wait_until="domcontentloaded", timeout=60000)
                time.sleep(3)
            except Exception as error:
                print(f"  punish navigation failed (continuing): {str(error)[:160]}")

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
            elif Image is not None and connect_captcha_visible(page):
                print("Icon-connect captcha visible, solving...")
                RUN_COUNTER[0] += 1
                if solve_connect_captcha(page, run_no=RUN_COUNTER[0]):
                    solved = True
                try:
                    page.screenshot(path=os.path.join(ARTIFACT_DIR, "connect-after.png"))
                except Exception:
                    pass
            if solved and not slider_locator(page)[1] and not connect_captcha_visible(page):
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
    result = solve_challenge(
        args.token,
        args.cookies,
        headless=args.headless,
        wait_seconds=args.wait_seconds,
        punish_url=(args.punish_url or "").strip(),
    )
    result["account_id"] = args.account_id
    print("SUCCESS: risk session harvested")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
