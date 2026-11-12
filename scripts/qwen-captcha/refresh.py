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
from contextlib import contextmanager
import io
import json
import os
import random
import re
import select
import shutil
import subprocess
import tempfile
import time
import uuid
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
    CHROME_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    os.path.join(os.environ.get("PROGRAMFILES", "C:/Program Files"), "Google/Chrome/Application/chrome.exe"),
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google/Chrome/Application/chrome.exe"),
]:
    if candidate and os.path.isfile(candidate):
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
ARTIFACT_DIR = os.environ.get("QWEN_CAPTCHA_ARTIFACT_DIR") or os.path.join(tempfile.gettempdir(), "qwen-captcha")
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
    return base64.b64decode(source.split(",", 1)[1])


def image_bytes_from_locator(page, locator) -> bytes:
    result = locator.evaluate("""async image => {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height || 0;
        const src = image.currentSrc || image.src || '';
        const encode = drawable => {
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const context = canvas.getContext('2d', {willReadFrequently: true});
            if (!context) throw new Error('no canvas');
            context.drawImage(drawable, 0, 0, width, height);
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
            context = page.page.context if hasattr(page, "page") else page.context
            resp = context.request.get(src)
            if resp.ok:
                return resp.body()
        except Exception:
            pass
    raise RuntimeError("Cannot get captcha image")


def read_puzzle_left(slider_frame):
    try:
        box = slider_frame.locator('#aliyunCaptcha-puzzle, .puzzle-captcha-puzzle').first.bounding_box()
        return float(box["x"]) if box else None
    except Exception:
        return None


def captcha_target_geometry(slider_frame) -> dict:
    modern = slider_frame.locator('#puzzle-captcha-question-img').count() > 0
    bg_loc = slider_frame.locator('#puzzle-captcha-question-img' if modern else '#aliyunCaptcha-img')
    pz_loc = slider_frame.locator('.puzzle-captcha-puzzle img' if modern else '#aliyunCaptcha-puzzle')
    bg = np.asarray(Image.open(io.BytesIO(image_bytes_from_locator(slider_frame, bg_loc))).convert("RGB"), dtype=np.float32)
    pz = np.asarray(Image.open(io.BytesIO(image_bytes_from_locator(slider_frame, pz_loc))).convert("RGBA"), dtype=np.uint8)
    Image.fromarray(bg.astype('uint8')).save(os.path.join(ARTIFACT_DIR, 'puzzle-bg.png'))
    Image.fromarray(pz).save(os.path.join(ARTIFACT_DIR, 'puzzle-piece.png'))
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
    if modern:
        bg_box = bg_loc.bounding_box()
        piece_box = pz_loc.bounding_box()
        if not bg_box or not piece_box:
            raise RuntimeError('Puzzle image geometry incomplete')
        # This widget uses a cropped 50px tile positioned with CSS top, not
        # the old full-height transparent image. Sample the matching bg rows.
        natural_scale = bg.shape[1] / bg_box['width']
        boundary_y = np.rint(boundary_y * (piece_box['height'] * natural_scale / pz.shape[0])
                             + (piece_box['y'] - bg_box['y']) * natural_scale).astype(int)
        boundary_x = np.rint(boundary_x * (piece_box['width'] * natural_scale / pz.shape[1])).astype(int)
        piece_left = int(round(piece_left * piece_box['width'] * natural_scale / pz.shape[1]))
        piece_width = max(8, int(round(piece_width * piece_box['width'] * natural_scale / pz.shape[1])))
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
    image_box = bg_loc.bounding_box()
    slider = slider_frame.locator('#puzzle-captcha-btn' if modern else '#aliyunCaptcha-sliding-slider')
    slider_box = slider.bounding_box()
    track_box = (slider.locator('xpath=..').bounding_box() if modern
                 else slider_frame.locator('#aliyunCaptcha-sliding-body').bounding_box())
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
    final_left = read_puzzle_left(slider_frame)
    print(f'  Puzzle landing error={None if final_left is None else round(target_puzzle_left-final_left, 2)}')
    slider_frame.page.wait_for_timeout(random.randint(80, 150))
    slider_frame.page.mouse.up()
    return current_x - start_x


def slider_locator(page):
    """Find the aliyun captcha slider on the page or inside any iframe."""
    for frame in visible_frames(page):
        try:
            locator = first_visible(frame, '#aliyunCaptcha-sliding-slider, #puzzle-captcha-btn')
            if locator is not None:
                return frame, locator
        except Exception:
            continue
    return None, None


# The screenshot's Baxia no-captcha bar is a DIFFERENT widget from the
# aliyunCaptcha puzzle above. Selectors follow qwen-flow-test/clear_slider.mjs;
# do not use a guessed 300px distance or assume the challenge is top-level.
BAR_HANDLE = '[id^="nc_"][id$="_n1z"]:not(.btn_ok), .nc_iconfont.btn_slide, .nc_scale .btn_slide'
BAR_TRACK = '.nc_scale, [id^="nc_"][id$="_n1t"]'


def visible_frames(page):
    for frame in page.frames:
        try:
            ancestor = frame
            visible = True
            while ancestor.parent_frame is not None:
                if not ancestor.frame_element().is_visible():
                    visible = False
                    break
                ancestor = ancestor.parent_frame
            if visible:
                yield frame
        except Exception:
            # A challenge iframe can detach while its success callback runs.
            continue


def first_visible(frame, selector):
    for locator in frame.locator(selector).all():
        if locator.is_visible():
            return locator
    return None


def bar_slider_locator(page):
    for frame in visible_frames(page):
        try:
            handle = first_visible(frame, BAR_HANDLE)
            if handle is not None:
                return frame, handle
        except Exception:
            continue
    return None, None


def drag_bar_slider(page, frame, handle):
    """Drag the full-width bar; completion is NOT a successful verdict."""
    handle.scroll_into_view_if_needed(timeout=2000)
    # Resolve the handle's own rail, not another hidden/loading nc instance.
    track = handle.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," nc_scale ")][1]')
    if track.count() == 0:
        track = first_visible(frame, BAR_TRACK)
    h = handle.bounding_box()
    t = track.bounding_box() if track is not None else None
    if not h or not t or t['width'] <= h['width']:
        raise RuntimeError('Verification bar geometry incomplete')
    start_x, start_y = h['x'] + h['width'] / 2, h['y'] + h['height'] / 2
    end_x = t['x'] + t['width'] - h['width'] / 2 + 5
    page.mouse.move(start_x, start_y, steps=8)
    page.wait_for_timeout(180)
    page.mouse.down()
    try:
        page.wait_for_timeout(100)
        for step in range(1, 36):
            progress = step / 35
            eased = 1 - (1 - progress) ** 2
            page.mouse.move(start_x + (end_x - start_x) * eased, start_y)
            page.wait_for_timeout(15)
        page.wait_for_timeout(180)
    finally:
        page.mouse.up()
    page.wait_for_timeout(100)


def reset_bar_error(page):
    for frame in visible_frames(page):
        try:
            link = first_visible(frame, '.errloading a')
            if link is not None:
                link.click(timeout=2000)
                return True
        except Exception:
            continue
    return False


PROBE_MARKDOWN = '.qwen-markdown, [class*="markdown"]'


def probe_reply_visible(page, marker):
    # A fresh random marker avoids counting an old chat, the composer, or an
    # echoed user prompt as the reply. No answer text is written to logs.
    try:
        return page.locator(PROBE_MARKDOWN).evaluate_all('''(nodes, marker) =>
            nodes.some(n => (n.innerText || '').trim() === marker &&
                !n.closest('[contenteditable="true"], [data-role="user"], [data-message-role="user"]'))''', marker)
    except Exception:
        return False


def dismiss_probe_overlay(page):
    # Do not invent a birth year or submit account settings. Close a late age /
    # welcome overlay only; if Qwen requires onboarding, the probe fails closed.
    for dialog in page.locator('[role="dialog"]').all():
        if not dialog.is_visible():
            continue
        text = dialog.inner_text(timeout=1000)
        known_overlay = re.search(
            r'请确认你的年龄|confirm your age|欢迎使用\s*Qwen|welcome to Qwen|'
            r'Qwen[\d.]+[-\s]*Max(?:[-\s]*Preview)?\s+is now in preview|'
            r'Qwen[\d.]+[-\s]*Max.{0,24}(?:预览|抢先体验)', text, re.I)
        if known_overlay:
            close = first_visible(dialog, 'button[aria-label="Close"], button[aria-label="关闭"]')
            if close is not None:
                close.click(timeout=2000)
                print('Verification overlay dismissed')
                return True
    return False


def normalize_probe_model(value):
    text = str(value or '').strip().lower()
    if text in ('qwen4-max-preview', 'qwen4.0-max-preview'):
        return 'qwen4.0-max-preview'
    return text


def probe_model_matches(observed, model, mode):
    return normalize_probe_model(observed.get('model')) == normalize_probe_model(model) and (
        not mode or str(observed.get('thinking_mode', '')).lower() == mode.lower()
    )


def select_probe_model(page, model, mode=''):
    """Select existing UI options only; never silently substitute a model."""
    target = normalize_probe_model(model)
    if not target:
        return True
    try:
        trigger = first_visible(page, '.wms-trigger__text')
        if trigger is None:
            return False
        if normalize_probe_model(trigger.inner_text()) != target:
            trigger.click(timeout=2000)
            candidates = page.locator('.wms-list__name-text').all()
            selected = next((item for item in candidates if item.is_visible()
                             and normalize_probe_model(item.inner_text()) == target), None)
            if selected is None:
                return False
            selected.click(timeout=2000)
        if mode:
            selector = first_visible(page, '.qwen-chat-v2-dropdown-menu-select-label')
            if selector is None:
                return False
            if selector.inner_text().strip().lower() != mode.lower():
                selector.click(timeout=2000)
                options = page.locator('.qwen-chat-v2-dropdown-menu-item-label').all()
                selected = next((item for item in options if item.is_visible()
                                 and item.inner_text().strip().lower() == mode.lower()), None)
                if selected is None:
                    return False
                selected.click(timeout=2000)
        return normalize_probe_model(trigger.inner_text()) == target
    except Exception:
        return False


def send_probe(page, marker):
    try:
        composer = first_visible(page, 'textarea, [contenteditable="true"]')
        if composer is None:
            return False
        composer.fill(f'Reply with exactly {marker} and nothing else.', timeout=2000)
        # The composer can render before React installs its Enter handler.
        # Prefer the actual send button and confirm that submission consumed
        # the input; otherwise the loop may retry instead of waiting forever.
        page.wait_for_timeout(300)
        button = first_visible(page, 'button[aria-label="发送"], button[aria-label="Send"], button[aria-label="Send message"]')
        if button is not None:
            if not button.is_enabled():
                return False
            button.click(timeout=2000)
        else:
            composer.press('Enter', timeout=2000)
        page.wait_for_timeout(300)
        remaining = composer.evaluate("el => 'value' in el ? el.value : el.innerText")
        if marker in (remaining or ''):
            return False
        print('Verification probe sent')
        return True
    except Exception:
        return False


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
        return first_visible(page, CONNECT_CONTAINER) is not None
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
    page = page.page if hasattr(page, 'page') else page
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
    if bar_slider_locator(page)[1] is not None or slider_locator(page)[1] is not None:
        return True
    for frame in visible_frames(page):
        try:
            if connect_captcha_visible(frame):
                return True
            # Inspect rendered text, not SDK source / stale error strings.
            text = frame.locator('body').inner_text(timeout=1000)
            if re.search(r'RGV587|FAIL_SYS_USER_VALIDATE|被挤爆|Please slide to verify|'
                         r'Please drag the slider below|请按住滑块|拖动到最右|出错了.{0,12}刷新', text, re.I):
                return True
            if frame == page.main_frame and re.search(r'/punish|___tmp___', frame.url, re.I):
                return True
        except Exception:
            # An unreadable current frame is not evidence of recovery.
            if frame == page.main_frame:
                return True
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


def session_cookies(token, cookie_string):
    cookies = parse_cookie_string(cookie_string)
    try:
        payload = token.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    except (ValueError, IndexError, UnicodeDecodeError, base64.binascii.Error):
        claims = {}
    # Modern access tokens are Bearer-only; an old token= cookie shadows them.
    if claims.get('type') == 'access_token':
        return [c for c in cookies if c['name'] != 'token']
    return [c for c in cookies if c['name'] != 'token'] + [{
        'name': 'token', 'value': token, 'domain': '.qwen.ai', 'path': '/',
        'secure': True, 'httpOnly': False,
    }]


def run_verification(page, wait_seconds, punish_url=''):
    """Bounded challenge loop followed by a real, uniquely identified reply."""
    marker = 'C2A_VERIFY_' + uuid.uuid4().hex[:16]
    deadline = time.monotonic() + wait_seconds
    attempts = 0
    max_attempts = 3
    challenge_seen = False
    probe_sent = False
    overlay_dismissals = 0
    verified = False
    requested_model = normalize_probe_model(os.environ.get('QWEN_RECOVERY_PROBE_MODEL', ''))
    requested_mode = os.environ.get('QWEN_RECOVERY_PROBE_MODE', '').strip()
    probe_request = {}

    def observe_probe_request(request):
        if '/api/v2/chat/completions' not in request.url:
            return
        try:
            payload = request.post_data_json
            messages = payload.get('messages', [])
            if not any(marker in str(message.get('content', '')) for message in messages):
                return
            feature = messages[-1].get('feature_config', {}) if messages else {}
            probe_request.update(model=payload.get('model', ''), thinking_mode=feature.get('thinking_mode', ''))
        except Exception:
            return

    if requested_model:
        page.on('request', observe_probe_request)
    if punish_url:
        page.goto(punish_url, wait_until='domcontentloaded', timeout=30000)
    while time.monotonic() < deadline:
        frame, bar = bar_slider_locator(page)
        puzzle_frame, puzzle = slider_locator(page)
        connect_frame = next((f for f in visible_frames(page) if connect_captcha_visible(f)), None)
        active = bar is not None or puzzle is not None or connect_frame is not None
        if active:
            challenge_seen = True
            if attempts >= max_attempts:
                break
            attempts += 1
            print(f'Verification challenge attempt {attempts}/{max_attempts}')
            try:
                if bar is not None:
                    drag_bar_slider(page, frame, bar)
                elif puzzle is not None:
                    geometry = captcha_target_geometry(puzzle_frame)
                    drag_slider(puzzle_frame, puzzle, geometry['target_puzzle_left'], geometry['max_travel'])
                elif Image is not None:
                    RUN_COUNTER[0] += 1
                    solve_connect_captcha(connect_frame, max_attempts=1, run_no=RUN_COUNTER[0])
            except Exception as error:
                print(f'Verification interaction failed ({type(error).__name__})')
            # Allow the SERVER verdict / iframe removal to arrive before retry.
            page.wait_for_timeout(3000)
            continue
        if reset_bar_error(page):
            challenge_seen = True
            if attempts >= max_attempts:
                break
            page.wait_for_timeout(1500)
            continue
        if punish_url and re.search(r'/punish|___tmp___', page.url, re.I):
            accepted = any(first_visible(f, '.nc_scale .btn_ok') is not None for f in visible_frames(page))
            if accepted:
                page.goto(QWEN_URL, wait_until='domcontentloaded', timeout=30000)
                probe_sent = False
                continue
        risk = page_looks_risky(page)
        if not risk and getattr(page, '_qwen_auth_state', {}).get('rejected'):
            print('Verification stopped: upstream rejected the browser login session')
            break
        if not risk and overlay_dismissals < 3 and dismiss_probe_overlay(page):
            overlay_dismissals += 1
            probe_sent = False
            page.wait_for_timeout(500)
            continue
        if not risk and not probe_sent:
            if requested_model and not select_probe_model(page, requested_model, requested_mode):
                page.wait_for_timeout(800)
                continue
            probe_sent = send_probe(page, marker)
        model_verified = not requested_model or probe_model_matches(probe_request, requested_model, requested_mode)
        if probe_sent and model_verified and probe_reply_visible(page, marker) and not page_looks_risky(page):
            verified = True
            break
        page.wait_for_timeout(800)
    if requested_model:
        page.remove_listener('request', observe_probe_request)
    return {
        **({'probe_model': requested_model, 'probe_mode': requested_mode,
            'probe_model_verified': probe_model_matches(probe_request, requested_model, requested_mode)} if requested_model else {}),
        'solved_slider': challenge_seen and verified,
        'probe_verified': verified,
        'risk_page': page_looks_risky(page),
        'challenge_attempts': attempts,
        'overlay_dismissals': overlay_dismissals,
        'probe_sent': probe_sent,
    }


def verification_failure_diagnostics(page, evidence):
    """Only counts/booleans/codes: never log page text, URLs or account data."""
    try:
        visible_dialogs = sum(dialog.is_visible() for dialog in page.locator('[role="dialog"]').all())
    except Exception:
        visible_dialogs = 0
    return {
        'error_code': 'probe_unverified',
        'probe_sent': evidence.get('probe_sent') is True,
        'probe_verified': evidence.get('probe_verified') is True,
        'risk_page': evidence.get('risk_page') is True,
        'challenge_attempts': evidence.get('challenge_attempts', 0),
        'overlay_dismissals': evidence.get('overlay_dismissals', 0),
        'visible_dialogs': visible_dialogs,
        'auth_rejected': getattr(page, '_qwen_auth_state', {}).get('rejected') is True,
    }


def needs_browser_login(evidence, auth_rejected):
    # A stale/anonymous UI may never emit the watched auth response. Retry the
    # saved login once when no probe could be submitted, not after a rejected
    # challenge or a sent probe that simply has not answered.
    return not evidence.get('probe_verified') and (
        auth_rejected or (evidence.get('probe_sent') is False and evidence.get('risk_page') is False)
    )


def browser_login_state(page):
    """Distinguish a signin form from an already-authenticated redirect."""
    if '/auth' not in urllib.parse.urlparse(page.url).path:
        composer = page.locator('textarea,[contenteditable="true"]').first
        if composer.count() and composer.is_visible() and page.evaluate("() => Boolean(localStorage.getItem('token'))"):
            return 'session'
    email = page.locator('input[name=email],input[type=email],input[type=text]').first
    if '/auth' in urllib.parse.urlparse(page.url).path and email.count() and email.is_visible():
        return 'form'
    return None


def await_browser_login_state(page, timeout_ms=15000):
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        state = browser_login_state(page)
        if state:
            return state
        page.wait_for_timeout(250)
    raise RuntimeError('Qwen browser login route did not settle')


def browser_password_login(page):
    email = os.environ.get('QWEN_LOGIN_EMAIL', '')
    password = os.environ.get('QWEN_LOGIN_PASSWORD', '')
    if not email or not password:
        return False
    print('Browser session rejected; attempting saved login in the same isolated context')
    page._qwen_recovery_stage = 'login_navigation'
    page.goto(QWEN_URL + 'auth?mode=login', wait_until='domcontentloaded', timeout=30000)
    page._qwen_recovery_stage = 'login_route'
    if await_browser_login_state(page) == 'session':
        # Renewal can finish while navigation is pending. The site redirects
        # authenticated sessions away from /auth; no password toggle exists on
        # the chat home. The caller still requires a NEW verified probe reply.
        print('Browser login redirected to an existing session; verifying again')
        return True
    page._qwen_recovery_stage = 'login_antibot_ready'
    page.wait_for_function('''() => {
        const m=window.__baxia__?.getFYModule;
        if(!window.baxiaInitialized||!m)return false;
        try{return Boolean(m.getUidToken?.()&&m.getFYToken?.())}catch{return false}
    }''', timeout=20000)
    if browser_login_state(page) == 'session':
        print('Browser login redirected to an existing session; verifying again')
        return True
    page._qwen_recovery_stage = 'login_email'
    page.locator('input[name=email],input[type=email],input[type=text]').first.fill(email, timeout=10000)
    page._qwen_recovery_stage = 'login_password_toggle'
    password_mode = page.get_by_text(re.compile('^(使用密码登录|Sign in with (?:a )?password|Log in with (?:a )?password)$', re.I)).first
    try:
        password_mode.click(timeout=10000)
    except Exception:
        # The auth check may redirect AFTER the email field was filled. Handle
        # that race too; a missing password button alone is not auth failure.
        if browser_login_state(page) == 'session':
            print('Browser login redirected to an existing session; verifying again')
            return True
        page.screenshot(path=os.path.join(ARTIFACT_DIR, 'login-form.png'))
        print('Browser login password toggle missing')
        raise
    page._qwen_recovery_stage = 'login_submit'
    field = page.locator('input[type=password]').first
    field.wait_for(state='visible', timeout=10000)
    field.fill(password)
    field.press('Enter')
    page.wait_for_timeout(4000)
    if getattr(page, '_qwen_auth_state', {}).get('rejected'):
        return False
    return bool(page.evaluate("() => localStorage.getItem('token')"))


@contextmanager
def verification_display(headless):
    # Headless login was geometrically correct but rejected; the same account
    # passed under Xvfb. Prefer a real Chromium window on a private virtual
    # display when the container already has Xvfb. Never require xauth or leave
    # a display process running after the child exits.
    executable = shutil.which('Xvfb') if os.name != 'nt' else None
    enabled = os.environ.get('QWEN_CAPTCHA_XVFB', '1').lower() not in ('0', 'false', 'off')
    if not headless or not executable or not enabled:
        yield None
        return
    process = subprocess.Popen([executable, '-displayfd', '1', '-screen', '0', '1366x900x24', '-nolisten', 'tcp'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        if not select.select([process.stdout], [], [], 5)[0]:
            raise RuntimeError('Virtual display startup timed out')
        number = process.stdout.readline().strip()
        if not number.isdigit() or process.poll() is not None:
            raise RuntimeError('Virtual display startup failed')
        print('Verification browser using private virtual display')
        yield ':' + number
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def solve_challenge(token: str, cookie_string: str, headless: bool, wait_seconds: int, punish_url: str = "") -> dict:
    with sync_playwright() as pw, verification_display(headless) as display:
        launch_args = {
            "headless": headless and not display,
            "args": ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        }
        if display:
            launch_args['env'] = {**os.environ, 'DISPLAY': display}
        if CHROME_PATH and os.path.isfile(CHROME_PATH):
            launch_args["executable_path"] = CHROME_PATH
        browser = pw.chromium.launch(**launch_args)
        try:
            context = browser.new_context(viewport={"width": 1366, "height": 900})
            context.add_cookies(session_cookies(token, cookie_string))
            context.add_init_script('''if (location.hostname === 'chat.qwen.ai' &&
                !sessionStorage.getItem('c2a_session_seeded')) {
                localStorage.setItem('token', %s);
                sessionStorage.setItem('c2a_session_seeded', '1');
            }''' % json.dumps(token))
            page = context.new_page()
            auth_state = {'rejected': False}

            def observe_auth(response):
                path = urllib.parse.urlparse(response.url).path.rstrip('/')
                if path not in ('/api/v1/auths', '/api/v2/auths'):
                    return
                try:
                    body = response.json()
                    auth_state['rejected'] = body.get('success') is False
                except Exception:
                    # HTML/non-JSON may itself be a challenge: the visible
                    # challenge handler, not an auth assumption, decides next.
                    return

            page.on('response', observe_auth)
            page._qwen_auth_state = auth_state
            print('Loading Qwen with isolated account session')
            page._qwen_recovery_stage = 'navigation'
            page.goto(QWEN_URL, wait_until='domcontentloaded', timeout=60000)
            page._qwen_recovery_stage = 'verification'
            evidence = run_verification(page, wait_seconds, punish_url)
            if needs_browser_login(evidence, auth_state['rejected']):
                auth_state['rejected'] = False
                if browser_password_login(page) or page_looks_risky(page):
                    # Signin itself can open a puzzle/iframe before it writes
                    # the JWT. Drive that challenge instead of demanding the
                    # token before the verification has even run.
                    auth_state['rejected'] = False
                    page._qwen_recovery_stage = 'verification_after_login'
                    evidence = run_verification(page, wait_seconds)
            try:
                page.screenshot(path=os.path.join(ARTIFACT_DIR, 'final-state.png'))
            except Exception as error:
                print(f'Final screenshot failed ({type(error).__name__})')
            if not evidence['probe_verified'] or evidence['risk_page']:
                print(json.dumps({'diagnostics': verification_failure_diagnostics(page, evidence)}), flush=True)
                raise RuntimeError('Qwen risk-session verification failed: no confirmed probe reply')
            cookies = context.cookies('https://chat.qwen.ai')
            token_value = page.evaluate("() => localStorage.getItem('token') || ''")
            if not token_value or auth_state['rejected']:
                raise RuntimeError('Qwen browser session is not authenticated after verification')
            print(f'Verified probe reply; harvested {len(cookies)} cookies')
            return {
                **evidence,
                'cookies': '; '.join('{}={}'.format(c['name'], c['value']) for c in cookies if c.get('name')),
                'token': token_value,
                'cookie_names': [c['name'] for c in cookies][:40],
            }
        except Exception as error:
            screenshot_written = False
            try:
                if 'page' in locals():
                    page.screenshot(path=os.path.join(ARTIFACT_DIR, 'failure.png'), timeout=5000)
                    screenshot_written = True
            except Exception:
                pass
            # Only local stage names and a boolean; never exception messages,
            # page body, URLs, cookies, token values or browser argv.
            error.qwen_failure_stage = getattr(locals().get('page'), '_qwen_recovery_stage', 'browser_start')
            error.qwen_failure_screenshot = screenshot_written
            raise
        finally:
            browser.close()


def main():
    args = parse_args()
    print("Qwen Risk Session Refresher")
    print('Credential supplied:', bool(args.token))
    try:
        result = solve_challenge(
            args.token,
            args.cookies,
            headless=args.headless,
            wait_seconds=args.wait_seconds,
            punish_url=(args.punish_url or "").strip(),
        )
    except Exception as error:
        # Exceptions can precede the probe diagnostic (navigation/login/browser
        # startup). Emit a fixed category only; tracebacks may carry secrets.
        code = 'browser_timeout' if type(error).__name__ == 'TimeoutError' else 'browser_failure'
        if str(error) != 'Qwen risk-session verification failed: no confirmed probe reply':
            print(json.dumps({'diagnostics': {
                'error_code': code,
                'stage': getattr(error, 'qwen_failure_stage', 'browser_start'),
                'screenshot_written': getattr(error, 'qwen_failure_screenshot', False),
            }}), flush=True)
        raise SystemExit(1) from None
    result["account_id"] = args.account_id
    print("SUCCESS: risk session harvested")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
